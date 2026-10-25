import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMars, FileKnowledgeStore } from '../dist/packages/sdk/src/index.js';
import { FakeProvider, FileSessionStore, SkillRegistry, loadConfig, saveConfig, MarsError } from '../dist/packages/sdk/src/internal.js';

const answer = (content = 'done') => ({ role: 'assistant', content, toolCalls: [] });
const call = (id, name, args) => ({ role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] });
const note = (name, content) => ({ kind: 'memory', name, content, source: { origin: 'user' } });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mars-knowledge-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}
const envFor = root => ({ ...process.env, APPDATA: root, XDG_CONFIG_HOME: root, HOME: root, USERPROFILE: root, MARS_MODEL: '', MARS_CREDENTIAL_STORE: 'file' });

test('knowledge proposals require review, revisions supersede and forget removes stored content', async t => {
  const root = await fixture(t);
  const store = new FileKnowledgeStore(root);
  const original = await store.propose(note('project-language', 'Use Spanish for project reports.'));
  assert.equal(original.status, 'pending');
  assert.equal((await store.propose(note('project-language', original.content))).id, original.id);
  await store.review(original.id, 'approve', 'memory');
  await store.review(original.id, 'approve', 'memory');
  const revision = await store.propose(note('project-language', 'Use English for public reports.'));
  assert.equal((await store.load()).entries.find(entry => entry.id === original.id).status, 'approved');
  await store.review(revision.id, 'approve', 'memory');
  assert.equal((await store.load()).entries.find(entry => entry.id === original.id).status, 'superseded');
  await assert.rejects(store.review(revision.id, 'reject', 'memory'), { code: 'ConfigurationError' });
  const rejected = await store.propose(note('draft-note', 'Never injected.'));
  await store.review(rejected.id, 'reject', 'memory');
  await store.review(rejected.id, 'forget', 'memory');
  assert.ok(!(await readFile(path.join(root, '.mars', 'knowledge.json'), 'utf8')).includes('Never injected.'));
  await assert.rejects(store.review(revision.id, 'forget', 'skill'), { code: 'ConfigurationError' });
});

test('independent knowledge writers preserve concurrent proposals and locks are not stolen', async t => {
  const root = await fixture(t);
  const first = new FileKnowledgeStore(root);
  const second = new FileKnowledgeStore(root);
  await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).propose(note(`note-${index}`, `Project convention ${index}.`))));
  assert.equal((await first.load()).entries.length, 8);
  const lock = path.join(root, '.mars', 'knowledge.lock');
  await writeFile(lock, 'another writer');
  await assert.rejects(first.propose(note('blocked-note', 'Do not write.')), /locked/);
  assert.equal(await readFile(lock, 'utf8'), 'another writer');
  assert.equal((await first.load()).entries.length, 8);
});

test('knowledge validates versions, credential shapes, memory budget and workspace ownership without corrupting data', async t => {
  const root = await fixture(t);
  const other = await fixture(t);
  const store = new FileKnowledgeStore(root);
  for (const proposal of [note('../outside', 'no'), note('valid-note', 'sk-' + 'a'.repeat(30)), note('valid-note', 'OPENAI_API_KEY=' + 'b'.repeat(30)), note('valid-note', '\x1b[31m'), { ...note('valid-note', 'no'), source: { origin: 'learning' } }]) await assert.rejects(store.propose(proposal));
  for (let index = 0; index < 7; index++) {
    const entry = await store.propose(note(`budget-${index}`, `${index}`.repeat(1000)));
    await store.review(entry.id, 'approve', 'memory');
  }
  const excess = await store.propose(note('budget-extra', 'extra '.repeat(190)));
  const file = path.join(root, '.mars', 'knowledge.json');
  const before = await readFile(file, 'utf8');
  await assert.rejects(store.review(excess.id, 'approve', 'memory'), { code: 'LimitError' });
  assert.equal(await readFile(file, 'utf8'), before);
  await mkdir(path.join(other, '.mars'));
  await writeFile(path.join(other, '.mars', 'knowledge.json'), before);
  await assert.rejects(new FileKnowledgeStore(other).load(), { code: 'ConfigurationError' });
  await writeFile(file, JSON.stringify({ version: 2, workspace: root, entries: [] }));
  await assert.rejects(store.load(), { code: 'ConfigurationError' });
  await writeFile(file, '{corrupt');
  await assert.rejects(store.propose(note('new-note', 'no')), { code: 'ConfigurationError' });
  assert.equal(await readFile(file, 'utf8'), '{corrupt');
});

test('knowledge storage refuses directory junctions and hardlinked files', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await symlink(outside, path.join(root, '.mars'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new FileKnowledgeStore(root).propose(note('safe-note', 'no')), { code: 'WorkspaceViolationError' });
  const hardRoot = await fixture(t);
  await mkdir(path.join(hardRoot, '.mars'));
  const original = path.join(outside, 'original.json');
  await writeFile(original, '{}');
  await link(original, path.join(hardRoot, '.mars', 'knowledge.json'));
  await assert.rejects(new FileKnowledgeStore(hardRoot).load(), { code: 'WorkspaceViolationError' });
  assert.equal(await readFile(original, 'utf8'), '{}');
});

test('SDK agent memory tool can only propose; approved notes refresh and are removed after forget or resume without integration', async t => {
  const root = await fixture(t);
  const knowledge = new FileKnowledgeStore(root);
  const sessions = new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const provider = new FakeProvider([call('note', 'propose_memory', { name: 'report-format', content: 'Use the PROJECT_NOTE_42 report template.' }), answer(), answer(), answer()]);
  const mars = await createMars({ workspace: root, provider, model: 'scripted', knowledgeStore: knowledge, sessionStore: sessions });
  t.after(() => mars.close());
  await mars.run('Remember the report format.');
  const entry = (await knowledge.load()).entries[0];
  assert.equal(entry.status, 'pending');
  assert.equal(entry.source.origin, 'agent');
  assert.equal(entry.source.sessionId, mars.id);
  assert.ok(!provider.requests[0].tools.some(tool => /approve|forget|reject/.test(tool.name)));
  assert.ok(!provider.requests[1].messages.some(message => message.role === 'system' && message.content.startsWith('MARS reviewed project memory')));
  await knowledge.review(entry.id, 'approve', 'memory');
  await mars.run('Prepare the report.');
  assert.match(provider.requests[2].messages.find(message => message.role === 'system' && message.content.startsWith('MARS reviewed project memory')).content, /PROJECT_NOTE_42/);
  const withoutMemoryProvider = new FakeProvider([answer()]);
  const withoutMemory = await createMars({ workspace: root, provider: withoutMemoryProvider, model: 'scripted', sessionStore: sessions, sessionId: mars.id });
  await withoutMemory.run('Continue without memory while the note remains approved.');
  await withoutMemory.close();
  assert.ok(!withoutMemoryProvider.requests[0].messages.some(message => message.role === 'system' && message.content.startsWith('MARS reviewed project memory')));
  await knowledge.review(entry.id, 'forget', 'memory');
  await mars.run('Prepare another report.');
  assert.ok(!provider.requests[3].messages.some(message => message.role === 'system' && message.content.startsWith('MARS reviewed project memory')));
  const resumedProvider = new FakeProvider([answer()]);
  const resumed = await createMars({ workspace: root, provider: resumedProvider, model: 'scripted', sessionStore: sessions, sessionId: mars.id });
  t.after(() => resumed.close());
  await resumed.run('Continue without project knowledge.');
  assert.ok(!resumedProvider.requests[0].tools.some(tool => tool.name === 'propose_memory'));
  assert.ok(!resumedProvider.requests[0].messages.some(message => message.role === 'system' && message.content.startsWith('MARS reviewed project memory')));
});

test('local learning captures verified actions, preserves source, calls no model and activates only after approval', async t => {
  const root = await fixture(t);
  const sessions = new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const knowledge = new FileKnowledgeStore(root);
  const provider = new FakeProvider([
    call('old-write', 'write_file', { path: 'old-task.txt', content: 'PRIVATE_OLD_FILE_CONTENT' }), answer(),
    call('current-write', 'write_file', { path: 'report.txt', content: 'PRIVATE_NEW_FILE_CONTENT' }), answer(), answer(),
  ]);
  const mars = await createMars({ workspace: root, provider, model: 'scripted', sessionStore: sessions, knowledgeStore: knowledge, shellPolicy: 'allow', verificationCommands: ['node --version'] });
  t.after(() => mars.close());
  await mars.run('Finish an unrelated older task.');
  await mars.run('Prepare a report using report.txt.');
  await mars.verify();
  const sourceBefore = await sessions.get(mars.id);
  assert.equal(sourceBefore.lastRun.verificationStatus, 'passed');
  const requestsBefore = provider.requests.length;
  const entry = await mars.learnFrom(mars.id);
  assert.equal(provider.requests.length, requestsBefore);
  assert.deepEqual(await sessions.get(mars.id), sourceBefore);
  assert.equal(entry.kind, 'skill');
  assert.equal(entry.status, 'pending');
  assert.equal(entry.source.verified, true);
  assert.equal(entry.source.runId, sourceBefore.lastRun.id);
  assert.match(entry.content, /write_file: report.txt/);
  assert.match(entry.content, /node --version/);
  assert.doesNotMatch(entry.content, /PRIVATE_|old-task/);
  await mars.run('Prepare a report using report.txt.');
  assert.ok(!provider.requests.at(-1).messages.some(message => message.role === 'system' && message.content.includes(entry.content)));
  await knowledge.review(entry.id, 'approve', 'skill');
  const nextProvider = new FakeProvider([answer()]);
  const next = await createMars({ workspace: root, provider: nextProvider, model: 'scripted', knowledgeStore: knowledge });
  t.after(() => next.close());
  await next.run('Prepare a report using report.txt.');
  assert.ok(nextProvider.requests[0].messages.some(message => message.role === 'system' && message.content.includes(entry.content)));
});

test('learning rejects unverified, failed, legacy, foreign and cancelled sessions without model calls', async t => {
  const root = await fixture(t);
  const other = await fixture(t);
  const sessions = new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const knowledge = new FileKnowledgeStore(root);
  const provider = new FakeProvider([call('write', 'write_file', { path: 'work.txt', content: 'work' }), answer(), answer()]);
  const mars = await createMars({ workspace: root, provider, model: 'scripted', sessionStore: sessions, knowledgeStore: knowledge, shellPolicy: 'allow', verificationCommands: ['node --version'] });
  t.after(() => mars.close());
  await mars.run('Work.');
  await assert.rejects(mars.learnFrom(mars.id), /passed real checks/);
  await mars.verify();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(mars.learnFrom(mars.id, controller.signal), { code: 'CancelledError' });
  const verified = await sessions.get(mars.id);
  await sessions.save({ ...verified, id: 'foreign-session', workspace: other, lastRun: { ...verified.lastRun, sessionId: 'foreign-session' } });
  await assert.rejects(mars.learnFrom('foreign-session'), /another workspace/);
  await sessions.save({ ...verified, id: 'legacy-session', lastRun: undefined });
  await assert.rejects(mars.learnFrom('legacy-session'), /passed real checks/);
  await mars.run('A new task invalidates old verification.');
  await assert.rejects(mars.learnFrom(mars.id), /passed real checks/);
  const afterRun = await sessions.get(mars.id);
  assert.equal(afterRun.lastRun.verificationStatus, 'not-run');
  assert.equal((await knowledge.load()).entries.length, 0);
  assert.equal(provider.requests.length, 3);
  await assert.rejects(createMars({ workspace: root, provider, model: 'scripted', knowledgeStore: new FileKnowledgeStore(other) }), /another workspace/);
});

test('starting a new task clears the saved verification receipt before effects and persists cancellation', async t => {
  const root = await fixture(t);
  const sessions = new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const knowledge = new FileKnowledgeStore(root);
  const initial = new FakeProvider([call('w', 'write_file', { path: 'work.txt', content: 'work' }), answer()]);
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const provider = { id: 'fixture', async *stream(request, signal) {
    if (++requests <= 2) { yield* initial.stream(request, signal); return; }
    started(); await gate; throw new MarsError('ProviderUnavailableError', 'fixture');
  } };
  const mars = await createMars({ workspace: root, provider, model: 'fixture', sessionStore: sessions, knowledgeStore: knowledge,
    shellPolicy: 'allow', verificationCommands: ['fixture'], shellExecutor: async () => ({ exitCode: 0, output: 'passed', truncated: false }) });
  t.after(() => mars.close());
  await mars.run('First task.'); await mars.verify();
  const controller = new AbortController();
  const running = mars.run('Second task.', controller.signal);
  const rejection = assert.rejects(running, { code: 'CancelledError' });
  await waiting;
  const snapshot = await sessions.get(mars.id);
  assert.equal(snapshot.status, 'active');
  assert.equal(snapshot.lastRun, undefined);
  controller.abort(); release(); await rejection;
  assert.equal((await sessions.get(mars.id)).lastRun.status, 'cancelled');
  await assert.rejects(mars.learnFrom(mars.id), /passed real checks/);
  assert.equal((await knowledge.load()).entries.length, 0);
});

test('reviewed project skills respect project file precedence over approved notes and user skills', async t => {
  const root = await fixture(t);
  const home = await fixture(t);
  await mkdir(path.join(root, '.mars', 'skills', 'reporting'), { recursive: true });
  await mkdir(path.join(home, '.mars', 'skills', 'reporting'), { recursive: true });
  await mkdir(path.join(home, '.mars', 'skills', 'writing'), { recursive: true });
  await writeFile(path.join(root, '.mars', 'skills', 'reporting', 'SKILL.md'), 'PROJECT REPORTING');
  await writeFile(path.join(home, '.mars', 'skills', 'reporting', 'SKILL.md'), 'USER REPORTING');
  await writeFile(path.join(home, '.mars', 'skills', 'writing', 'SKILL.md'), 'USER WRITING');
  const skills = await new SkillRegistry(root, home, [
    { name: 'reporting', path: 'reviewed-reporting', scope: 'project', content: 'REVIEWED REPORTING' },
    { name: 'writing', path: 'reviewed-writing', scope: 'project', content: 'REVIEWED WRITING' },
  ]).list();
  assert.deepEqual(skills.map(skill => skill.content), ['PROJECT REPORTING', 'REVIEWED WRITING']);
});

test('CLI and configuration cover memory review and offline learning with no model selection', async t => {
  const root = await fixture(t);
  const env = envFor(root);
  const cli = path.resolve('dist/apps/cli/src/index.js');
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args, '--workspace', root], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 20000 });
  const added = run(['memory', 'add', 'report-format', 'Use concise reports.', '--json'], { MARS_CREDENTIAL_STORE: 'unused-invalid-backend' });
  assert.equal(added.status, 0, added.stderr);
  const entry = JSON.parse(added.stdout);
  assert.equal(entry.status, 'pending');
  assert.equal(JSON.parse(run(['memory', 'show', entry.id]).stdout).content, 'Use concise reports.');
  assert.equal(run(['memory', 'approve', entry.id]).status, 0);
  assert.equal(JSON.parse(run(['memory', '--json']).stdout)[0].status, 'approved');
  assert.equal(run(['memory', 'forget', entry.id]).status, 0);
  const script = path.join(root, 'script.json');
  await writeFile(script, JSON.stringify([call('w', 'write_file', { path: 'report.txt', content: 'report' }), answer()]));
  await saveConfig(path.join(root, '.mars', 'config.json'), { verification: { commands: ['node --version'] } });
  const result = run(['run', 'Prepare a report.', '--model', 'fake:scripted', '--script', script, '--verify', '--allow-shell', '--no-animation']);
  assert.equal(result.status, 0, result.stderr);
  const sessionId = result.stderr.match(/\[session\] ([a-zA-Z0-9-]+)/)[1];
  const learned = run(['learn', sessionId, '--json'], { MARS_CREDENTIAL_STORE: 'unused-invalid-backend' });
  assert.equal(learned.status, 0, learned.stderr);
  const procedure = JSON.parse(learned.stdout);
  assert.equal(procedure.status, 'pending');
  assert.equal(JSON.parse(run(['skills', 'pending', '--json']).stdout)[0].id, procedure.id);
  assert.equal(run(['skills', 'approve', procedure.id]).status, 0);
  assert.ok(JSON.parse(run(['skills', '--json']).stdout).some(skill => skill.name === procedure.name));
  assert.equal(run(['learn', sessionId, '--no-save']).status, 1);
  assert.equal(run(['config', 'set', 'knowledge.enabled', 'false']).status, 0);
  assert.equal((await loadConfig(root, env)).config.knowledge.enabled, false);
  await writeFile(script, JSON.stringify([call('proposal-disabled', 'propose_memory', { name: 'disabled-note', content: 'Must not be stored.' }), answer()]));
  const disabled = run(['run', 'Report with integration disabled.', '--model', 'fake:scripted', '--script', script, '--no-animation']);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stderr, /InvalidToolCallError/);
  assert.ok(!(await new FileKnowledgeStore(root).load()).entries.some(entry => entry.name === 'disabled-note'));
  const disabledSession = await new FileSessionStore(path.join(root, '.mars', 'sessions')).get(disabled.stderr.match(/\[session\] ([a-zA-Z0-9-]+)/)[1]);
  assert.ok(!disabledSession.messages.some(message => message.role === 'system' && message.content.startsWith('Relevant skills for current task:')));
});
