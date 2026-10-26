import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMars, receiptVerdict, renderReceipt } from '../dist/packages/sdk/src/index.js';
import { FakeProvider, Workspace, WorkflowRegistry, loadConfig, projectConfigPath, runProjectChecks } from '../dist/packages/sdk/src/internal.js';
import { executeShell } from '../dist/packages/tools/src/index.js';

let ids = 0;
const answer = (content = 'done') => ({ role: 'assistant', content, toolCalls: [] });
const call = (name, args) => ({ role: 'assistant', content: '', toolCalls: [{ id: `${name}-${++ids}`, name, arguments: args }] });
const write = (file, content) => call('write_file', { path: file, content });
const SCOPE = { reported: 'add(2, 3) is 5, not -1', covers: 'add() returns the arithmetic sum', cases: ['add(2, 3) is 5'] };
const declare = (command, files, scope = SCOPE) => call('declare_reproduction', { command, files, ...scope });

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
  assert.deepEqual(report.proof.scope, SCOPE);
  assert.deepEqual(report.contract, { files: ['tests/calc.test.mjs'], modified: [] });
  assert.deepEqual(report.verifications.at(-1).report.plannedCommands, ['node tests/calc.test.mjs', 'node --version']);
  const receipt = renderReceipt([report]);
  assert.match(receipt, /✅ MARS — Fixed and proven/);
  assert.match(receipt, /Before the fix: failed with exit 1/);
  assert.match(receipt, /After the fix: passed \(exit 0\)/);
  assert.match(receipt, /1 protected file\(s\) unchanged/);
  assert.match(receipt, /Reported case declared by the agent: `add\(2, 3\) is 5, not -1`/);
  assert.match(receipt, /Scope declared by the agent: add\(\) returns the arithmetic sum/);
  assert.match(receipt, /- `add\(2, 3\) is 5`/);
  assert.match(receipt, /only these cases are proven/i);
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

test('declare_reproduction requires the covered contract and its cases', async t => {
  const root = await project(t);
  const instance = await mars(t, root, [answer('inspected'), write('tests/calc.test.mjs', TEST), declare('node tests/calc.test.mjs', ['tests/calc.test.mjs'], {}), answer('reproduced')]);
  await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /without declare_reproduction/);
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

// Regressions from the Codex review of phase B (3990a9d).
test('reproductions that fail before reaching assertions are rejected', async t => {
  const root = await project(t);
  const broken = 'import { add } from "../missing.mjs";\nadd(1, 2);\n';
  const instance = await mars(t, root, [answer(), write('tests/calc.test.mjs', broken), declare('node tests/calc.test.mjs', ['tests/calc.test.mjs']), answer()]);
  await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /before reaching its assertions/);
});

test('the reproduction command must name the declared tests; named runner files are protected', async t => {
  const root = await project(t);
  await writeFile(path.join(root, 'runner.mjs'), 'await import("./" + process.argv[2]);\n');
  const elsewhere = await mars(t, root, [...reproduceSteps.slice(0, 2), declare('node runner.mjs', ['tests/calc.test.mjs']), answer()]);
  await assert.rejects(elsewhere.runWorkflow('bugfix', 'bug'), /must run the declared test files directly/);

  const root2 = await project(t);
  const RUNNER = 'await import("./" + process.argv[2]);\n';
  await writeFile(path.join(root2, 'runner.mjs'), RUNNER);
  const viaRunner = await mars(t, root2, [answer(), write('tests/calc.test.mjs', TEST), declare('node runner.mjs tests/calc.test.mjs', ['tests/calc.test.mjs']), answer(),
    write('runner.mjs', 'process.exit(0);\n'), write('calc.mjs', FIXED), answer(), answer()]);
  await viaRunner.runWorkflow('bugfix', 'bug');
  assert.deepEqual(viaRunner.lastRun.contract.files, ['runner.mjs', 'tests/calc.test.mjs']);
  assert.equal(await readFile(path.join(root2, 'runner.mjs'), 'utf8'), RUNNER);
  assert.equal(viaRunner.lastRun.toolErrors, 1);
});

test('contract.protect is sealed before the reproduction phase can write', async t => {
  const root = await project(t);
  await mkdir(path.join(root, 'fixtures'));
  await writeFile(path.join(root, 'fixtures', 'golden.txt'), 'golden');
  const instance = await mars(t, root, [answer(), write('fixtures/golden.txt', 'weakened'), ...reproduceSteps.slice(1), write('calc.mjs', FIXED), answer(), answer()], { protect: ['fixtures/**'] });
  await instance.runWorkflow('bugfix', 'bug');
  assert.equal(await readFile(path.join(root, 'fixtures', 'golden.txt'), 'utf8'), 'golden');
  assert.deepEqual(instance.lastRun.contract.files, ['fixtures/golden.txt', 'tests/calc.test.mjs']);
});

test('protected files changed while checks run are detected', async t => {
  const root = await project(t);
  const tamperingCheck = async (command, cwd, timeout, signal) => {
    const result = await executeShell(command, cwd, timeout, signal);
    if (command === 'node --version') await writeFile(path.join(cwd, 'tests', 'calc.test.mjs'), 'process.exit(0);\n');
    return result;
  };
  const instance = await mars(t, root, [...reproduceSteps, write('calc.mjs', FIXED), answer(), answer()], { shellExecutor: tamperingCheck });
  await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /Task contract violated/);
  assert.match(renderReceipt([instance.lastRun]), /❌/);
});

test('a phase after verification invalidates the proof; two reproduction phases are rejected', async t => {
  const root = await project(t);
  const workflows = new WorkflowRegistry([
    { id: 'late', description: '', matches: () => true, phases: [
      { id: 'reproduce', role: 'implementer', instruction: 'r', reproduction: true },
      { id: 'implement', role: 'implementer', instruction: 'i' },
      { id: 'verify', role: 'verifier', instruction: 'v', verification: true },
      { id: 'polish', role: 'implementer', instruction: 'p' },
    ] },
    { id: 'twice', description: '', matches: () => false, phases: [
      { id: 'a', role: 'implementer', instruction: 'a', reproduction: true },
      { id: 'b', role: 'implementer', instruction: 'b', reproduction: true },
    ] },
  ]);
  const instance = await mars(t, root, [...reproduceSteps.slice(1), write('calc.mjs', FIXED), answer(), answer(), write('calc.mjs', BUGGY), answer()], { workflows });
  await assert.rejects(instance.runWorkflow('late', 'bug'), /no longer passes on the final tree/);
  assert.equal(instance.lastRun.proof.green, undefined);
  assert.match(renderReceipt([instance.lastRun]), /❌ MARS — Failed/);
  await assert.rejects(instance.runWorkflow('twice', 'bug'), /at most one reproduction phase/);
});

test('protection is case-insensitive where the filesystem is', { skip: !['win32', 'darwin'].includes(process.platform) }, async t => {
  const root = await project(t);
  const instance = await mars(t, root, [...reproduceSteps, write('TESTS/CALC.TEST.MJS', 'process.exit(0);\n'), write('calc.mjs', FIXED), answer(), answer()]);
  await instance.runWorkflow('bugfix', 'bug');
  assert.equal(await readFile(path.join(root, 'tests', 'calc.test.mjs'), 'utf8'), TEST);
  assert.equal(instance.lastRun.toolErrors, 1);
});

test('detected checks do not repeat a prepended reproduction command', async t => {
  const root = await project(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0', lint: 'node -e 0' } }));
  const report = await runProjectChecks(await Workspace.open(root), new AbortController().signal, { prepend: ['npm run test'], shellExecutor: async () => ({ exitCode: 0, output: '', truncated: false }) });
  assert.deepEqual(report.plannedCommands, ['npm run test', 'npm run lint']);
});

test('receipts escape dynamic values and redact credentials', () => {
  const secretCommand = 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz node t.mjs';
  const report = { schemaVersion: 1, id: 'run-1', sessionId: 's', kind: 'workflow', workflow: 'bugfix', startedAt: new Date().toISOString(), durationMs: 1000, status: 'completed',
    models: ['fake:m'], modelRequests: 1, modelRetries: 0, toolCalls: 0, toolErrors: 0, permissionDenials: 0, repairAttempts: 0, usage: [], verificationStatus: 'passed',
    verifications: [{ phase: 'verify', attempt: 0, report: { workspace: '.', plannedCommands: [secretCommand], checks: [{ name: 'c', command: secretCommand, exitCode: 0, passed: true, output: '' }], passed: true, verified: true } }],
    proof: { phase: 'reproduce', command: 'node t.mjs', files: ['evil`\n# Injected <img src=x>.mjs'], red: { exitCode: 1, output: 'boom\n~~~\n# fake heading' }, green: { exitCode: 0 } } };
  const receipt = renderReceipt([report]);
  assert.doesNotMatch(receipt, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(receipt, /^# Injected/m);
  assert.doesNotMatch(receipt, /^~~~\n# fake heading/m);
  assert.equal((receipt.match(/^~~~/gm) ?? []).length % 2, 0, 'fences stay balanced');
  assert.match(receipt, /✅ MARS — Fixed and proven/);
});

// Regressions from the Codex review of 1e6b720.
test('a command that names the test but does not depend on it is rejected', async t => {
  await t.test('inline code', async t => {
    const root = await project(t);
    const instance = await mars(t, root, [...reproduceSteps.slice(0, 2), declare('node -e "process.exit(1)" tests/calc.test.mjs', ['tests/calc.test.mjs']), answer()]);
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /cannot run inline code/);
  });
  await t.test('failure independent of the test content', async t => {
    const root = await project(t);
    await writeFile(path.join(root, 'always-fail.mjs'), 'process.exit(1);\n');
    const instance = await mars(t, root, [...reproduceSteps.slice(0, 2), declare('node always-fail.mjs tests/calc.test.mjs', ['tests/calc.test.mjs']), answer()]);
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /fails the same way with its tests emptied/);
    assert.equal(await readFile(path.join(root, 'tests', 'calc.test.mjs'), 'utf8'), TEST, 'the control run restores the test');
  });
  await t.test('genuine failure records the control run', async t => {
    const root = await project(t);
    const instance = await mars(t, root, [...reproduceSteps, write('calc.mjs', FIXED), answer(), answer()]);
    await instance.runWorkflow('bugfix', 'bug');
    assert.equal(instance.lastRun.proof.control.exitCode, 0);
    assert.match(renderReceipt([instance.lastRun]), /With the test emptied: exit 0/);
  });
});

test('the reproduction phase can only write tests: no production edits, shell or MCP', async t => {
  const root = await project(t);
  const sabotage = 'export const add = (a, b) => a + b + 1;\n';
  const instance = await mars(t, root, [answer(), write('calc.mjs', sabotage), call('shell', { command: 'node --version', cwd: null, timeout: null }), ...reproduceSteps.slice(1), write('calc.mjs', FIXED), answer(), answer()]);
  await instance.runWorkflow('bugfix', 'bug');
  assert.equal(instance.lastRun.toolErrors, 2);
  assert.match(instance.lastRun.proof.red.output, /expected 5, got -1/, 'red comes from the original bug, not from sabotage');
});

test('a check that reintroduces the bug or swaps a protected file between commands is caught', async t => {
  await t.test('bug reintroduced by a later check', async t => {
    const root = await project(t);
    const regress = async (command, cwd, timeout, signal) => {
      const result = await executeShell(command, cwd, timeout, signal);
      if (command === 'node --version') await writeFile(path.join(cwd, 'calc.mjs'), BUGGY);
      return result;
    };
    const instance = await mars(t, root, [...reproduceSteps, write('calc.mjs', FIXED), answer(), answer()], { shellExecutor: regress });
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /no longer passes on the final tree/);
  });
  await t.test('protected file swapped and restored across commands', async t => {
    const root = await project(t);
    const swap = async (command, cwd, timeout, signal) => {
      if (command === 'node tests/calc.test.mjs' && (await readFile(path.join(cwd, 'calc.mjs'), 'utf8')) === FIXED) await writeFile(path.join(cwd, 'tests', 'calc.test.mjs'), 'process.exit(0);\n');
      const result = await executeShell(command, cwd, timeout, signal);
      if (command === 'node --version') await writeFile(path.join(cwd, 'tests', 'calc.test.mjs'), TEST);
      return result;
    };
    const instance = await mars(t, root, [...reproduceSteps, write('calc.mjs', FIXED), answer(), answer()], { shellExecutor: swap });
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /Task contract violated/);
  });
});

test('an empty reply after a valid declaration does not fail the reproduction phase', async t => {
  const root = await project(t);
  const instance = await mars(t, root, [answer('inspected'), write('tests/calc.test.mjs', TEST), declare('node tests/calc.test.mjs', ['tests/calc.test.mjs']), answer(''), write('calc.mjs', FIXED), answer('fixed'), answer('reviewed')]);
  await instance.runWorkflow('bugfix', 'bug');
  assert.match(renderReceipt([instance.lastRun]), /Fixed and proven/);

  const root2 = await project(t);
  const undeclared = await mars(t, root2, [answer('inspected'), write('tests/calc.test.mjs', TEST), answer('')]);
  await assert.rejects(undeclared.runWorkflow('bugfix', 'bug'), { code: 'ProviderUnavailableError' });
});

test('receipts escape the title, workflow ids and table separators', () => {
  const report = { schemaVersion: 1, id: 'run-3', sessionId: 's', kind: 'workflow', workflow: 'x`\n# Injected', startedAt: new Date().toISOString(), durationMs: 1, status: 'completed',
    models: [], modelRequests: 0, modelRetries: 0, toolCalls: 0, toolErrors: 0, permissionDenials: 0, repairAttempts: 0, usage: [], verificationStatus: 'passed',
    verifications: [{ phase: 'v', attempt: 0, report: { workspace: '.', plannedCommands: ['a | b'], checks: [{ name: 'c', command: 'a | b', exitCode: 0, passed: true, output: '' }], passed: true, verified: true } }] };
  const receipt = renderReceipt([report], { title: 'Team\n# Evil <script>' });
  assert.doesNotMatch(receipt, /^# (Injected|Evil)/m);
  assert.doesNotMatch(receipt, /<script>/);
  const row = receipt.split('\n').find(line => line.includes('a ') && line.startsWith('|'));
  assert.equal(row.split(/(?<!\\)\|/).length, 4, `table row keeps two cells: ${row}`);
});

test('receipts print paths relative to the execution root and the home directory as ~', async () => {
  const { homedir } = await import('node:os');
  const root = path.join(homedir(), 'repo', '.git', 'mars', 'worktrees', 'run-9');
  const url = `file:///${root.replaceAll('\\', '/').replace(/^\//, '')}/test/a.test.js:5:56`;
  const output = `at TestContext (${url})\nlog written to ${path.join(root, 'out.txt')}\ncache in ${path.join(homedir(), '.cache', 'x')}`;
  const report = { schemaVersion: 1, id: 'run-2', sessionId: 's', kind: 'workflow', workflow: 'bugfix', workspace: root, startedAt: new Date().toISOString(), durationMs: 1, status: 'failed',
    models: [], modelRequests: 0, modelRetries: 0, toolCalls: 0, toolErrors: 0, permissionDenials: 0, repairAttempts: 0, usage: [], verificationStatus: 'not-run', verifications: [],
    proof: { phase: 'reproduce', command: `node ${path.join(root, 'test', 'a.test.js')}`, files: ['test/a.test.js'], red: { exitCode: 1, output } } };
  const receipt = renderReceipt([report]);
  assert.ok(!receipt.toLowerCase().includes(homedir().toLowerCase()), receipt);
  assert.ok(!receipt.includes(homedir().replaceAll('\\', '/')), receipt);
  assert.match(receipt, /\(\.\/test\/a\.test\.js:5:56\)/);
  assert.match(receipt, /~[\\/]\.cache[\\/]x/);
});

// An existing test that encodes an outdated expectation: the code is right, the test is not.
const OUTDATED = 'import { add } from "../calc.mjs";\nif (add(2, 3) !== 6) { console.error("expected 6, got " + add(2, 3)); process.exit(1); }\n';
const outdated = (command, files, reason = 'expects 6 for add(2, 3); the documented sum is 5') => call('declare_outdated_test', { command, files, reason });
async function outdatedProject(t) {
  const root = await project(t);
  await writeFile(path.join(root, 'calc.mjs'), FIXED);
  await mkdir(path.join(root, 'tests'));
  await writeFile(path.join(root, 'tests', 'calc.test.mjs'), OUTDATED);
  return root;
}

test('an outdated test is proposed for review: original fails, updated passes, source untouched', async t => {
  const root = await outdatedProject(t);
  const instance = await mars(t, root, [answer('inspected'), write('tests/calc.test.mjs', TEST), outdated('node tests/calc.test.mjs', ['tests/calc.test.mjs']), answer('declared'), answer('reviewed')]);
  await instance.runWorkflow('bugfix', 'npm test fails on add');
  const report = instance.lastRun;
  assert.equal(report.status, 'completed');
  assert.equal(report.proof, undefined);
  assert.equal(report.testUpdate.command, 'node tests/calc.test.mjs');
  assert.deepEqual(report.testUpdate.files, ['tests/calc.test.mjs']);
  assert.notEqual(report.testUpdate.original.exitCode, 0);
  assert.match(report.testUpdate.original.output, /expected 6, got 5/);
  assert.deepEqual(report.testUpdate.updated, { exitCode: 0 });
  assert.equal(await readFile(path.join(root, 'calc.mjs'), 'utf8'), FIXED);
  assert.equal(await readFile(path.join(root, 'tests', 'calc.test.mjs'), 'utf8'), TEST);
  assert.deepEqual(report.contract, { files: ['tests/calc.test.mjs'], modified: [] });
  assert.equal(report.verificationStatus, 'passed');
  assert.deepEqual(receiptVerdict(report), { ok: false, label: 'Test change proposed' });
  const receipt = renderReceipt([report]);
  assert.match(receipt, /⚠️ MARS — Test change proposed/);
  assert.match(receipt, /Reason declared by the agent: expects 6 for add\(2, 3\); the documented sum is 5/);
  assert.match(receipt, /Original test: failed with exit 1/);
  assert.match(receipt, /Updated test: passed \(exit 0\)/);
  assert.match(receipt, /needs human review/i);
});

test('declare_outdated_test is rejected unless an edited existing test failed and now passes', async t => {
  await t.test('original already passes', async t => {
    const root = await outdatedProject(t);
    await writeFile(path.join(root, 'tests', 'calc.test.mjs'), TEST);
    const instance = await mars(t, root, [answer(), write('tests/calc.test.mjs', `${TEST}// note\n`), outdated('node tests/calc.test.mjs', ['tests/calc.test.mjs']), answer()]);
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /original test passes/);
  });
  await t.test('updated still fails', async t => {
    const root = await outdatedProject(t);
    const instance = await mars(t, root, [answer(), write('tests/calc.test.mjs', `${OUTDATED}// still wrong\n`), outdated('node tests/calc.test.mjs', ['tests/calc.test.mjs']), answer()]);
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /updated test does not pass/);
  });
  await t.test('new file instead of an edited test', async t => {
    const root = await outdatedProject(t);
    const instance = await mars(t, root, [answer(), write('tests/other.test.mjs', TEST), outdated('node tests/other.test.mjs', ['tests/other.test.mjs']), answer()]);
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /only existing tests edited in this phase/);
  });
  await t.test('both declarations', async t => {
    const root = await outdatedProject(t);
    const instance = await mars(t, root, [answer(), write('tests/calc.test.mjs', TEST), outdated('node tests/calc.test.mjs', ['tests/calc.test.mjs']), declare('node tests/calc.test.mjs', ['tests/calc.test.mjs']), answer()]);
    await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /either a reproduction or an outdated test/);
  });
});
