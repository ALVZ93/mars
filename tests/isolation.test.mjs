import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMars } from '../dist/packages/sdk/src/index.js';
import { FakeProvider, FileSessionStore, applyIsolatedRun, discardIsolatedRun, isolatedDiff, isolatedRunExists, listIsolatedRuns, mergeConfig, loadConfig, saveConfig, projectConfigPath } from '../dist/packages/sdk/src/internal.js';

// Keep isolated worktrees out of the user's data directory.
process.env.MARS_WORKTREES_DIR ??= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'mars-worktrees-'));

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

// Regressions from the Codex review of phase A.
test('isolation: repository hooks and agent-written attributes never run during MARS git operations', async t => {
  const root = await repo(t);
  const outside = await fixture(t);
  const marker = path.join(outside, 'executed.txt').replaceAll('\\', '/');
  await mkdir(path.join(root, 'hooks'));
  await writeFile(path.join(root, 'hooks', 'reference-transaction'), `#!/bin/sh\necho hook >> "${marker}"\n`, { mode: 0o755 });
  git(root, 'config', 'core.hooksPath', 'hooks');
  git(root, 'config', 'filter.spy.clean', `node -e "require('fs').appendFileSync('${marker}','filter');process.stdin.pipe(process.stdout)"`);
  const provider = new FakeProvider([
    write('.mars-no-hooks/reference-transaction', `#!/bin/sh\necho agent >> "${marker}"\n`),
    write('.gitattributes', '* filter=spy\n'),
    answer(),
  ]);
  const mars = await createMars({ workspace: root, provider, model: 'fake', includeProjectContext: false, isolation: 'worktree', sessionId: 'run-hooks' });
  t.after(() => mars.close());
  await mars.run('try to escalate');
  assert.ok(mars.lastRun.isolation.files.includes('.gitattributes'));
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
});

test('isolation: apply ignores diff.noprefix and writes the right paths', async t => {
  const root = await repo(t);
  git(root, 'config', 'diff.noprefix', 'true');
  const mars = await createMars({ workspace: root, provider: new FakeProvider([write('packages/sdk/src/budget.ts', 'export {};\n'), answer()]), model: 'fake', includeProjectContext: false, isolation: 'worktree', sessionId: 'run-prefix' });
  t.after(() => mars.close());
  await mars.run('add file');
  assert.deepEqual(await applyIsolatedRun(root, 'run-prefix'), ['packages/sdk/src/budget.ts']);
  assert.equal(await readFile(path.join(root, 'packages', 'sdk', 'src', 'budget.ts'), 'utf8'), 'export {};\n');
  await assert.rejects(lstat(path.join(root, 'sdk')), { code: 'ENOENT' });
});

test('isolation: MCP servers start inside the worktree, not the user tree', async t => {
  const root = await repo(t);
  const scripts = await fixture(t);
  const server = path.join(scripts, 'server.mjs');
  await writeFile(server, [
    "import { writeFileSync } from 'node:fs';",
    "import { createInterface } from 'node:readline';",
    "writeFileSync('mcp-marker.txt', process.cwd());",
    "const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + String.fromCharCode(10));",
    "createInterface({ input: process.stdin }).on('line', line => {",
    "  const req = JSON.parse(line);",
    "  if (req.method === 'initialize') send(req.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'cwd', version: '1' } });",
    "  if (req.method === 'tools/list') send(req.id, { tools: [] });",
    '});',
  ].join('\n'));
  const mars = await createMars({ workspace: root, provider: new FakeProvider([answer()]), model: 'fake', includeProjectContext: false, isolation: 'worktree', sessionId: 'run-mcp',
    mcpServers: [{ name: 'cwd', command: process.execPath, args: [server], cwd: root, timeoutMs: 5000 }] });
  // Close before fixture cleanup: Windows cannot remove a directory that is a live process's cwd.
  try {
    await assert.rejects(lstat(path.join(root, 'mcp-marker.txt')), { code: 'ENOENT' });
    assert.ok(await readFile(path.join(mars.isolation.root, 'mcp-marker.txt'), 'utf8'));
  } finally { await mars.close(); }
});

test('isolation: resumed sessions stay isolated and fail once the run was discarded', async t => {
  const root = await repo(t);
  const sessionStore = new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const first = await createMars({ workspace: root, provider: new FakeProvider([answer()]), model: 'fake', includeProjectContext: false, isolation: 'worktree', sessionStore });
  await first.run('start');
  await first.close();
  const resumed = await createMars({ workspace: root, provider: new FakeProvider([write('later.txt', 'x\n'), answer()]), model: 'fake', includeProjectContext: false, sessionStore, sessionId: first.id });
  await resumed.run('continue');
  await resumed.close();
  assert.equal(resumed.isolation.id, first.id);
  await assert.rejects(lstat(path.join(root, 'later.txt')), { code: 'ENOENT' });
  await assert.rejects(createMars({ workspace: root, provider: new FakeProvider(), model: 'fake', includeProjectContext: false, sessionStore, sessionId: first.id, isolation: 'none' }), { code: 'ConfigurationError' });
  await discardIsolatedRun(root, first.id);
  await assert.rejects(createMars({ workspace: root, provider: new FakeProvider(), model: 'fake', includeProjectContext: false, sessionStore, sessionId: first.id }), /discarded/);
});

test('isolation: rejects Docker sandbox and repositories with submodules', async t => {
  const root = await repo(t);
  await assert.rejects(createMars({ workspace: root, provider: new FakeProvider(), model: 'fake', isolation: 'worktree', sandbox: { mode: 'docker' } }), /Docker/);
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${git(root, 'rev-parse', 'HEAD')},vendor/lib`);
  git(root, 'commit', '-qm', 'submodule');
  await assert.rejects(createMars({ workspace: root, provider: new FakeProvider(), model: 'fake', isolation: 'worktree' }), /submodules/);
});

test('budget: an operation that outlives its budget during persistence is not recorded as success', async t => {
  const root = await fixture(t);
  const inner = new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const slowStore = { list: inner.list.bind(inner), get: inner.get.bind(inner), save: async session => { await new Promise(resolve => setTimeout(resolve, 60)); return inner.save(session); } };
  const mars = await createMars({ workspace: root, provider: new FakeProvider([answer()]), model: 'fake', includeProjectContext: false, sessionStore: slowStore, budget: { maxDurationMs: 20 } });
  t.after(() => mars.close());
  await assert.rejects(mars.run('quick'), { code: 'BudgetExceededError' });
  assert.equal(mars.lastRun.status, 'failed');
  assert.equal(mars.session.status, 'failed');
  assert.equal(mars.session.lastRun.status, 'failed');
});

// Regressions from the second Codex review (4e9b3a4).
test('isolation: sessions isolated before metadata.isolation existed resume isolated', async t => {
  const root = await repo(t);
  const sessionStore = new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const first = await createMars({ workspace: root, provider: new FakeProvider([answer()]), model: 'fake', includeProjectContext: false, isolation: 'worktree', sessionStore });
  await first.run('start');
  await first.close();
  const legacy = await sessionStore.get(first.id);
  delete legacy.metadata.isolation;
  await sessionStore.save(legacy);
  const resumed = await createMars({ workspace: root, provider: new FakeProvider([write('legacy.txt', 'x\n'), answer()]), model: 'fake', includeProjectContext: false, sessionStore, sessionId: first.id });
  t.after(() => resumed.close());
  await resumed.run('continue');
  assert.equal(resumed.isolation.id, first.id);
  await assert.rejects(lstat(path.join(root, 'legacy.txt')), { code: 'ENOENT' });
});

test('isolation: runs stay listable and discardable after a submodule is added', async t => {
  const root = await repo(t);
  const mars = await createMars({ workspace: root, provider: new FakeProvider([answer()]), model: 'fake', includeProjectContext: false, isolation: 'worktree', sessionId: 'run-sub' });
  await mars.run('start');
  await mars.close();
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${git(root, 'rev-parse', 'HEAD')},vendor/lib`);
  git(root, 'commit', '-qm', 'submodule');
  assert.equal((await listIsolatedRuns(root))[0].id, 'run-sub');
  await discardIsolatedRun(root, 'run-sub');
  assert.equal(await isolatedRunExists(root, 'run-sub'), false);
});

test('budget: the final receipt write is inside the budget', async t => {
  const root = await fixture(t);
  const inner = new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const slowReceipt = { list: inner.list.bind(inner), get: inner.get.bind(inner), save: async session => { if (session.lastRun) await new Promise(resolve => setTimeout(resolve, 120)); return inner.save(session); } };
  const mars = await createMars({ workspace: root, provider: new FakeProvider([answer()]), model: 'fake', includeProjectContext: false, sessionStore: slowReceipt, budget: { maxDurationMs: 60 } });
  t.after(() => mars.close());
  await assert.rejects(mars.run('quick'), { code: 'BudgetExceededError' });
  assert.equal(mars.lastRun.status, 'failed');
  assert.equal(mars.lastRun.budget.exceeded, 'duration');
  assert.equal((await inner.get(mars.id)).lastRun.status, 'failed');
});

test('budget: usage is unknown for responses without usage and for cancelled pending streams', async t => {
  const root = await fixture(t);
  const slowClose = { id: 'slow', async *stream() { yield { type: 'done', message: answer('ok') }; await new Promise(resolve => setTimeout(resolve, 500)); } };
  const first = await createMars({ workspace: root, provider: slowClose, model: 'm', includeProjectContext: false, budget: { maxModelRequests: 5 } });
  t.after(() => first.close());
  await first.run('task');
  assert.equal(first.lastRun.budget.tokensKnown, false);

  const hanging = { id: 'hang', stream() { return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: async () => ({ done: true }) }) }; } };
  const second = await createMars({ workspace: root, provider: hanging, model: 'm', includeProjectContext: false, budget: { maxModelRequests: 5 } });
  t.after(() => second.close());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(second.run('task', controller.signal), { code: 'CancelledError' });
  assert.equal(second.lastRun.budget.tokensKnown, false);
});

test('budget: a stream that fails after partial output leaves token usage unknown', async t => {
  const root = await fixture(t);
  const provider = { id: 'flaky', async *stream() { yield { type: 'text', text: 'partial' }; throw new Error('drop'); } };
  const mars = await createMars({ workspace: root, provider, model: 'm', includeProjectContext: false, budget: { maxModelRequests: 5 } });
  t.after(() => mars.close());
  await assert.rejects(mars.run('task'));
  assert.equal(mars.lastRun.budget.tokensKnown, false);
});
