import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMars, renderReceipt } from '../dist/packages/sdk/src/index.js';
import { FakeProvider, WorkflowRegistry, loadConfig, projectConfigPath } from '../dist/packages/sdk/src/internal.js';
import { executeShell } from '../dist/packages/tools/src/index.js';

let ids = 0;
const answer = (content = 'done') => ({ role: 'assistant', content, toolCalls: [] });
const call = (name, args) => ({ role: 'assistant', content: '', toolCalls: [{ id: `${name}-${++ids}`, name, arguments: args }] });
const write = (file, content) => call('write_file', { path: file, content });
const declare = (command, files) => call('declare_reproduction', { command, files });

const BUGGY = 'export const add = (a, b) => a - b;\n';
const FIXED = 'export const add = (a, b) => a + b;\n';
const TEST = 'import { add } from "../calc.mjs";\nif (add(2, 3) !== 5) { console.error("expected 5, got " + add(2, 3)); process.exit(1); }\n';

async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mars-proof-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(path.join(root, 'calc.mjs'), BUGGY);
  return root;
}
const mars = (t, root, steps, extra = {}) => createMars({ workspace: root, provider: new FakeProvider(steps), model: 'fake', includeProjectContext: false,
  shellPolicy: 'allow', verificationCommands: ['node --version'], ...extra }).then(instance => { t.after(() => instance.close()); return instance; });
const reproduceSteps = [answer('inspected'), write('tests/calc.test.mjs', TEST), declare('node tests/calc.test.mjs', ['tests/calc.test.mjs']), answer('reproduced')];

test('bugfix proves the fix: reproduction fails before, passes after, test untouched', async t => {
  const root = await project(t);
  const instance = await mars(t, root, [...reproduceSteps, write('calc.mjs', FIXED), answer('fixed'), answer('reviewed')]);
  await instance.runWorkflow('bugfix', 'add() returns the wrong result');
  const report = instance.lastRun;
  assert.equal(report.status, 'completed');
  assert.equal(report.verificationStatus, 'passed');
  assert.equal(report.proof.command, 'node tests/calc.test.mjs');
  assert.notEqual(report.proof.red.exitCode, 0);
  assert.match(report.proof.red.output, /expected 5, got -1/);
  assert.deepEqual(report.proof.green, { exitCode: 0 });
  assert.deepEqual(report.contract, { files: ['tests/calc.test.mjs'], modified: [] });
  assert.deepEqual(report.verifications.at(-1).report.plannedCommands, ['node tests/calc.test.mjs', 'node --version']);
  const receipt = renderReceipt([report]);
  assert.match(receipt, /✅ MARS — Fixed and proven/);
  assert.match(receipt, /Before the fix: failed with exit 1/);
  assert.match(receipt, /After the fix: passed \(exit 0\)/);
  assert.match(receipt, /1 protected file\(s\) unchanged/);
  assert.doesNotMatch(receipt, /reproduced|inspected/, 'receipts never include model output');
});

test('bugfix rejects a reproduction that already passes, one that cannot run, and a missing declaration', async t => {
  await t.test('passes before the fix', async t => {
    const root = await project(t);
    await writeFile(path.join(root, 'calc.mjs'), FIXED);
    const instance = await mars(t, root, [...reproduceSteps]);
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /does not reproduce the bug/);
    assert.equal(instance.lastRun.proof.red.exitCode, 0);
  });
  await t.test('runner error', async t => {
    const root = await project(t);
    const instance = await mars(t, root, [...reproduceSteps], { shellExecutor: async () => { throw new Error('runner missing'); } });
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /could not run/);
  });
  await t.test('denied shell', async t => {
    const root = await project(t);
    const instance = await mars(t, root, [...reproduceSteps], { shellPolicy: 'deny' });
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /could not run \(PermissionDeniedError\)/);
  });
  await t.test('no declaration', async t => {
    const root = await project(t);
    const instance = await mars(t, root, [answer('inspected'), write('tests/calc.test.mjs', TEST), answer('forgot to declare')]);
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /without declare_reproduction/);
  });
  await t.test('declared file missing', async t => {
    const root = await project(t);
    const instance = await mars(t, root, [answer(), declare('node tests/none.mjs', ['tests/none.mjs']), answer()]);
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /test file not found/);
  });
});

test('the implementation cannot weaken the reproduction test through MARS tools', async t => {
  const root = await project(t);
  const instance = await mars(t, root, [...reproduceSteps, write('tests/calc.test.mjs', 'process.exit(0);\n'), write('calc.mjs', FIXED), answer('fixed'), answer('reviewed')]);
  await instance.runWorkflow('bugfix', 'bug');
  assert.equal(await readFile(path.join(root, 'tests', 'calc.test.mjs'), 'utf8'), TEST);
  assert.equal(instance.lastRun.toolErrors, 1);
  assert.equal(instance.lastRun.proof.green.exitCode, 0);
});

test('changes to protected files by other means are detected before checks and are not repaired', async t => {
  const root = await project(t);
  const tamper = async (command, cwd, timeout, signal) => command === 'tamper'
    ? (await writeFile(path.join(cwd, 'tests', 'calc.test.mjs'), 'process.exit(0);\n'), { exitCode: 0, output: '', truncated: false })
    : executeShell(command, cwd, timeout, signal);
  const instance = await mars(t, root, [...reproduceSteps, call('shell', { command: 'tamper', cwd: null, timeout: null }), answer('done'), answer('reviewed')],
    { shellExecutor: tamper, maxRepairAttempts: 2 });
  await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /Task contract violated: protected files changed \(tests\/calc.test.mjs\)/);
  assert.deepEqual(instance.lastRun.contract.modified, ['tests/calc.test.mjs']);
  assert.equal(instance.lastRun.repairAttempts, 0);
  assert.match(renderReceipt([instance.lastRun]), /❌ MARS — Failed[\s\S]*Protected files changed: `tests\/calc.test.mjs`/);
});

test('contract.protect guards existing files in any workflow; new files stay writable', async t => {
  const root = await project(t);
  await mkdir(path.join(root, 'fixtures'));
  await writeFile(path.join(root, 'fixtures', 'golden.txt'), 'golden');
  const instance = await mars(t, root, [answer('plan'), write('fixtures/golden.txt', 'changed'), write('fixtures/new.txt', 'new'), answer('implemented'), answer('reviewed')],
    { protect: ['fixtures/**'] });
  await instance.runWorkflow('feature', 'change behavior');
  assert.equal(await readFile(path.join(root, 'fixtures', 'golden.txt'), 'utf8'), 'golden');
  assert.equal(await readFile(path.join(root, 'fixtures', 'new.txt'), 'utf8'), 'new');
  assert.deepEqual(instance.lastRun.contract, { files: ['fixtures/golden.txt'], modified: [] });
  assert.equal(instance.lastRun.proof, undefined);
  assert.match(renderReceipt([instance.lastRun]), /✅ MARS — Verified/);
});

test('declare_reproduction exists only during a reproduction phase', async t => {
  const root = await project(t);
  const provider = new FakeProvider([answer('plan'), answer('implemented'), answer('reviewed')]);
  const instance = await createMars({ workspace: root, provider, model: 'fake', includeProjectContext: false, shellPolicy: 'allow', verificationCommands: ['node --version'] });
  t.after(() => instance.close());
  await instance.runWorkflow('feature', 'task');
  assert.ok(provider.requests.every(request => !request.tools.some(tool => tool.name === 'declare_reproduction')));
  assert.equal(instance.lastRun.contract, undefined);
});

test('config validates contract.protect', async t => {
  const root = await project(t);
  await mkdir(path.join(root, '.mars'));
  await writeFile(projectConfigPath(root), JSON.stringify({ contract: { protect: ['tests/**'] } }));
  assert.deepEqual((await loadConfig(root)).config.contract.protect, ['tests/**']);
  for (const bad of [['../outside'], ['/abs/**'], ['C:/x'], [''], 'tests/**']) {
    await writeFile(projectConfigPath(root), JSON.stringify({ contract: { protect: bad } }));
    await assert.rejects(loadConfig(root), { code: 'ConfigurationError' }, JSON.stringify(bad));
  }
});
