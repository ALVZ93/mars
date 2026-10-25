import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMars } from '../dist/packages/sdk/src/index.js';
import { FakeProvider, applyIsolatedRun, discardIsolatedRun, isolatedDiff, isolatedRunExists, listIsolatedRuns, mergeConfig, loadConfig, saveConfig, projectConfigPath } from '../dist/packages/sdk/src/internal.js';

const answer = (content = 'done') => ({ role: 'assistant', content, toolCalls: [] });
const write = (file, content, id = `write-${file}-${content.length}`) => ({ role: 'assistant', content: '', toolCalls: [{ id, name: 'write_file', arguments: { path: file, content } }] });
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mars-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}
async function repo(t) {
  const root = await fixture(t);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.mars/\n');
  await writeFile(path.join(root, 'app.txt'), 'committed\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

test('budget: model requests are shared across workflow phases and stop before the next call', async t => {
  const root = await fixture(t);
  const provider = new FakeProvider([answer('plan'), answer('implemented'), answer('review')]);
  const mars = await createMars({ workspace: root, provider, model: 'fake', includeProjectContext: false, budget: { maxModelRequests: 2 } });
  t.after(() => mars.close());
  await assert.rejects(mars.runWorkflow('feature', 'change something'), { code: 'BudgetExceededError' });
  assert.equal(provider.requests.length, 2);
  assert.equal(mars.lastRun.status, 'failed');
  assert.equal(mars.lastRun.error, 'BudgetExceededError');
  assert.deepEqual({ ...mars.lastRun.budget, limits: undefined }, { limits: undefined, modelRequests: 2, tokens: 0, tokensKnown: false, exceeded: 'requests' });
});

test('budget: reported tokens accumulate; missing usage is marked unknown, never zero', async t => {
  const root = await fixture(t);
  const usage = { async *stream() { yield { type: 'done', message: answer('ok'), usage: { inputTokens: 70, outputTokens: 40 } }; }, id: 'metered' };
  const mars = await createMars({ workspace: root, provider: usage, model: 'm', includeProjectContext: false, budget: { maxTokens: 100 } });
  t.after(() => mars.close());
  await mars.run('first');
  assert.equal(mars.lastRun.budget.tokens, 110);
  assert.equal(mars.lastRun.budget.exceeded, undefined);

  const unmetered = await createMars({ workspace: root, provider: new FakeProvider([answer('a')]), model: 'm', includeProjectContext: false, budget: { maxTokens: 100 } });
  t.after(() => unmetered.close());
  await unmetered.run('second');
  assert.equal(unmetered.lastRun.budget.tokensKnown, false);
});

test('budget: token limit stops the following request of the same operation', async t => {
  const root = await fixture(t);
  let calls = 0;
  const provider = { id: 'metered', async *stream() {
    calls++;
    const message = calls === 1 ? { role: 'assistant', content: '', toolCalls: [{ id: 'r1', name: 'search_files', arguments: { query: 'x', path: '.' } }] } : answer('done');
    yield { type: 'done', message, usage: { inputTokens: 90, outputTokens: 20 } };
  } };
  const mars = await createMars({ workspace: root, provider, model: 'm', includeProjectContext: false, budget: { maxTokens: 100 } });
  t.after(() => mars.close());
  await assert.rejects(mars.run('task'), { code: 'BudgetExceededError' });
  assert.equal(calls, 1);
  assert.equal(mars.lastRun.budget.exceeded, 'tokens');
});

test('budget: duration covers checks and is reported as BudgetExceededError, not cancellation', async t => {
  const root = await fixture(t);
  const slow = (_command, _cwd, _timeout, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
  const mars = await createMars({ workspace: root, provider: new FakeProvider([]), model: 'm', includeProjectContext: false, shellPolicy: 'allow', verificationCommands: ['node slow.mjs'], shellExecutor: slow, budget: { maxDurationMs: 50 } });
  t.after(() => mars.close());
  await assert.rejects(mars.verify(), { code: 'BudgetExceededError' });
  assert.equal(mars.lastRun.budget.exceeded, 'duration');
  assert.equal(mars.session.status, 'failed');
});

test('budget: invalid limits and config values are rejected', async t => {
  const root = await fixture(t);
  await assert.rejects(createMars({ workspace: root, provider: new FakeProvider(), model: 'm', budget: { maxTokens: 0 } }), { code: 'ConfigurationError' });
  await assert.rejects(createMars({ workspace: root, provider: new FakeProvider(), model: 'm', budget: { maxCost: 5 } }), { code: 'ConfigurationError' });
  await saveConfig(projectConfigPath(root), { budget: { maxModelRequests: 12 } });
  assert.deepEqual((await loadConfig(root)).config.budget, { maxModelRequests: 12 });
  assert.deepEqual(mergeConfig().budget, {});
  await writeFile(projectConfigPath(root), JSON.stringify({ budget: { maxTokens: -1 } }));
  await assert.rejects(loadConfig(root), { code: 'ConfigurationError' });
});

test('isolation: agent writes land only in the worktree; the diff excludes the user\'s uncommitted work', async t => {
  const root = await repo(t);
  await writeFile(path.join(root, 'app.txt'), 'user edit\n');
  await writeFile(path.join(root, 'notes.txt'), 'untracked user file\n');
  const provider = new FakeProvider([write('feature.txt', 'agent\n'), write('app.txt', 'user edit\nagent line\n'), answer('done')]);
  const mars = await createMars({ workspace: root, provider, model: 'fake', includeProjectContext: false, isolation: 'worktree', sessionId: 'run-1' });
  t.after(() => mars.close());
  await mars.run('implement');
  assert.notEqual(mars.isolation.root, root);
  assert.equal(await readFile(path.join(mars.isolation.root, 'notes.txt'), 'utf8'), 'untracked user file\n');
  await assert.rejects(lstat(path.join(root, 'feature.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'user edit\n');
  assert.deepEqual(mars.lastRun.isolation.files.sort(), ['app.txt', 'feature.txt']);
  const diff = await isolatedDiff(root, 'run-1');
  assert.match(diff, /\+agent line/);
  assert.doesNotMatch(diff, /^-committed/m);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '', 'the base snapshot must not touch the user index');
  assert.doesNotMatch(git(root, 'branch', '--list'), /mars/);

  assert.deepEqual((await applyIsolatedRun(root, 'run-1')).sort(), ['app.txt', 'feature.txt']);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'user edit\nagent line\n');
  assert.equal(await readFile(path.join(root, 'feature.txt'), 'utf8'), 'agent\n');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '', 'apply must not stage changes');
});

test('isolation: apply refuses a diff that no longer applies and changes nothing', async t => {
  const root = await repo(t);
  const mars = await createMars({ workspace: root, provider: new FakeProvider([write('app.txt', 'agent\n'), answer()]), model: 'fake', includeProjectContext: false, isolation: 'worktree', sessionId: 'run-2' });
  t.after(() => mars.close());
  await mars.run('change');
  await writeFile(path.join(root, 'app.txt'), 'diverged\n');
  await assert.rejects(applyIsolatedRun(root, 'run-2'), { code: 'ToolExecutionError' });
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'diverged\n');
});

test('isolation: resume reuses the worktree and accumulates results; discard keeps user data and dependencies', async t => {
  const root = await repo(t);
  await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  const first = await createMars({ workspace: root, provider: new FakeProvider([write('a.txt', 'a\n'), answer()]), model: 'fake', includeProjectContext: false, isolation: 'worktree', sessionId: 'run-3' });
  await first.run('one');
  const worktree = first.isolation.root;
  await first.close();
  assert.ok((await lstat(path.join(worktree, 'node_modules'))).isSymbolicLink());
  const second = await createMars({ workspace: root, provider: new FakeProvider([write('b.txt', 'b\n'), answer()]), model: 'fake', includeProjectContext: false, isolation: 'worktree', sessionId: 'run-3' });
  await second.run('two');
  await second.close();
  assert.equal(second.isolation.root, worktree);
  assert.deepEqual(second.lastRun.isolation.files.sort(), ['a.txt', 'b.txt']);
  assert.doesNotMatch(await isolatedDiff(root, 'run-3'), /node_modules/);
  assert.equal((await listIsolatedRuns(root))[0].id, 'run-3');

  await discardIsolatedRun(root, 'run-3');
  assert.equal(await isolatedRunExists(root, 'run-3'), false);
  await assert.rejects(lstat(worktree), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'committed\n');
});

test('isolation: requires a Git repository with a commit and rejects unsafe run IDs', async t => {
  const plain = await fixture(t);
  await assert.rejects(createMars({ workspace: plain, provider: new FakeProvider(), model: 'm', isolation: 'worktree' }), { code: 'ConfigurationError' });
  const empty = await fixture(t);
  git(empty, 'init', '-q');
  await assert.rejects(createMars({ workspace: empty, provider: new FakeProvider(), model: 'm', isolation: 'worktree' }), { code: 'ConfigurationError' });
  const root = await repo(t);
  await assert.rejects(createMars({ workspace: root, provider: new FakeProvider(), model: 'm', isolation: 'worktree', sessionId: '../escape' }), { code: 'ConfigurationError' });
});
