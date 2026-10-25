import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMars } from '../dist/packages/sdk/src/index.js';
import { FakeProvider, WorkflowRegistry, FileSessionStore, MarsError, saveConfig, loadConfig } from '../dist/packages/sdk/src/internal.js';
import { executeShell } from '../dist/packages/tools/src/index.js';

const answer = (content = 'done') => ({ role: 'assistant', content, toolCalls: [] });
const write = (file, content) => ({ role: 'assistant', content: '', toolCalls: [{ id: `write-${file}`, name: 'write_file', arguments: { path: file, content } }] });
const execution = exitCode => ({ exitCode, output: exitCode ? 'expected fixed, received broken' : 'passed', truncated: false });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mars-value-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

test('workflow repairs a real failed check, reuses role provider and preserves both check reports', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'value.txt'), 'broken');
  await writeFile(path.join(root, 'check.mjs'), 'import { readFileSync } from "node:fs"; process.exit(readFileSync("value.txt", "utf8") === "fixed" ? 0 : 1);');
  const verifier = new FakeProvider([answer('plan'), answer('review'), answer('review repaired change')]);
  const implementer = new FakeProvider([answer('implemented'), write('value.txt', 'fixed'), answer('repaired')]);
  const commands = [];
  const mars = await createMars({ workspace: root, provider: verifier, model: 'plan', includeProjectContext: false,
    roleProviders: { implementer: { provider: implementer, model: 'implement' } },
    maxRepairAttempts: 1, shellPolicy: 'allow', verificationCommands: ['node check.mjs', 'node --version'],
    shellExecutor: async (...args) => { commands.push(args[0]); return executeShell(...args); },
  });
  t.after(() => mars.close());
  await mars.runWorkflow(undefined, 'add the requested behavior');
  assert.equal(await readFile(path.join(root, 'value.txt'), 'utf8'), 'fixed');
  assert.deepEqual(commands, ['node check.mjs', 'node check.mjs', 'node --version']);
  assert.equal(mars.session.status, 'completed');
  const report = mars.lastRun;
  assert.equal(report.workflow, 'feature');
  assert.equal(report.status, 'completed');
  assert.equal(report.verificationStatus, 'passed');
  assert.equal(report.repairAttempts, 1);
  assert.equal(report.modelRequests, 6);
  assert.equal(report.toolCalls, 1);
  assert.deepEqual(report.verifications.map(check => check.report.verified), [false, true]);
  assert.equal(report.verifications[0].report.checks[0].exitCode, 1);
  assert.equal(report.verifications[1].attempt, 1);
  assert.equal(implementer.requests.length, 3);
  assert.match(implementer.requests[1].messages.at(-1).content, /Original task: add the requested behavior/);
  assert.match(implementer.requests[1].messages.at(-1).content, /Failed checks \(JSON data\)/);
  assert.deepEqual(verifier.requests[2].tools.map(tool => tool.name).sort(), ['git', 'read_file', 'search_files']);
  report.verifications.length = 0;
  report.models.push('tampered');
  assert.equal(mars.lastRun.verifications.length, 2);
  assert.ok(!mars.lastRun.models.includes('tampered'));
});

test('repair budget exhaustion persists failure and is shared across verification phases', async t => {
  const root = await fixture(t);
  const sessions = new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const provider = new FakeProvider(Array.from({ length: 8 }, () => answer()));
  const exits = [1, 0, 1];
  const mars = await createMars({ workspace: root, provider, model: 'scripted', includeProjectContext: false, sessionStore: sessions,
    maxRepairAttempts: 1, shellPolicy: 'allow', verificationCommands: ['check'], shellExecutor: async () => execution(exits.shift()),
    workflows: new WorkflowRegistry([{ id: 'twice', description: '', repairPhase: 'implement', matches: () => true, phases: [
      { id: 'implement', role: 'implementer', instruction: 'implement' },
      { id: 'first', role: 'verifier', instruction: 'review', verification: true },
      { id: 'second', role: 'verifier', instruction: 'review', verification: true },
    ] }]),
  });
  t.after(() => mars.close());
  await assert.rejects(mars.runWorkflow('twice', 'task'), { code: 'ToolExecutionError' });
  assert.equal(provider.requests.length, 5);
  assert.equal(mars.lastRun.repairAttempts, 1);
  assert.equal(mars.lastRun.status, 'failed');
  assert.equal(mars.lastRun.verificationStatus, 'failed');
  assert.deepEqual(mars.lastRun.verifications.map(value => value.attempt), [0, 1, 0]);
  assert.equal((await sessions.get(mars.id)).status, 'failed');
});

test('review, disabled repair, missing checks, denied permission, executor errors and cancellation never trigger repair', async t => {
  for (const scenario of ['review', 'disabled', 'missing', 'denied', 'executor-error', 'timeout', 'cancelled']) {
    await t.test(scenario, async t => {
      const root = await fixture(t);
      const provider = new FakeProvider(Array.from({ length: 8 }, () => answer()));
      const controller = new AbortController();
      let calls = 0;
      const mars = await createMars({ workspace: root, provider, model: 'scripted', includeProjectContext: false,
        maxRepairAttempts: scenario === 'disabled' ? 0 : 2, shellPolicy: scenario === 'denied' ? 'deny' : 'allow',
        verificationCommands: scenario === 'missing' ? [] : ['check'], shellExecutor: async () => {
          calls++;
          if (scenario === 'cancelled') controller.abort();
          if (scenario === 'executor-error') throw new Error('executor failed');
          if (scenario === 'timeout') throw new MarsError('TimeoutError', 'timeout');
          return execution(1);
        },
      });
      t.after(() => mars.close());
      await assert.rejects(mars.runWorkflow(scenario === 'review' ? 'review' : 'bugfix', 'fix task', controller.signal));
      assert.equal(mars.lastRun.repairAttempts, 0);
      assert.equal(provider.requests.length, scenario === 'review' ? 2 : 3);
      assert.equal(calls, ['missing', 'denied'].includes(scenario) ? 0 : 1);
      assert.equal(mars.lastRun.status, scenario === 'cancelled' ? 'cancelled' : 'failed');
      if (scenario === 'denied') assert.equal(mars.lastRun.verifications[0].report.checks[0].error, 'PermissionDeniedError');
    });
  }
});

test('repair preserves implementation tool restrictions instead of granting write access', async t => {
  const root = await fixture(t);
  const provider = new FakeProvider([answer(), answer(), write('forbidden.txt', 'no'), answer(), answer()]);
  const mars = await createMars({ workspace: root, provider, model: 'scripted', includeProjectContext: false,
    maxRepairAttempts: 1, shellPolicy: 'allow', verificationCommands: ['check'], shellExecutor: async () => execution(1),
    workflows: new WorkflowRegistry([{ id: 'limited', description: '', repairPhase: 'implement', matches: () => true, phases: [
      { id: 'implement', role: 'implementer', instruction: 'inspect', allowedTools: ['read_file'] },
      { id: 'verify', role: 'verifier', instruction: 'review', verification: true },
    ] }]),
  });
  t.after(() => mars.close());
  await assert.rejects(mars.runWorkflow('limited', 'task'), { code: 'ToolExecutionError' });
  await assert.rejects(readFile(path.join(root, 'forbidden.txt')), { code: 'ENOENT' });
  assert.deepEqual(provider.requests[2].tools.map(tool => tool.name), ['read_file']);
  assert.equal(mars.lastRun.toolErrors, 1);
  assert.equal(mars.lastRun.repairAttempts, 1);
});

test('repair repeats the initial command plan even if package scripts disappear', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'test', build: 'build' } }));
  const provider = new FakeProvider([answer(), answer(), answer(), write('package.json', '{}'), answer(), answer()]);
  const commands = [];
  const mars = await createMars({ workspace: root, provider, model: 'scripted', includeProjectContext: false,
    maxRepairAttempts: 1, shellPolicy: 'allow', shellExecutor: async command => { commands.push(command); return execution(commands.length === 1 ? 1 : 0); },
  });
  t.after(() => mars.close());
  await mars.runWorkflow('feature', 'task');
  assert.deepEqual(commands, ['npm run test', 'npm run test', 'npm run build']);
});

test('run reports distinguish absent usage, reported tokens and verification invalidated by later phases', async t => {
  const root = await fixture(t);
  const provider = { id: 'usage-fixture', async *stream() { yield { type: 'done', message: answer('private response'), usage: { inputTokens: 10, outputTokens: 4 } }; } };
  const mars = await createMars({ workspace: root, provider, model: 'fixture', includeProjectContext: false,
    shellPolicy: 'allow', verificationCommands: ['check'], shellExecutor: async () => execution(0),
    workflows: new WorkflowRegistry([{ id: 'after', description: '', matches: () => true, phases: [
      { id: 'verify', role: 'verifier', instruction: 'review', verification: true },
      { id: 'later', role: 'implementer', instruction: 'work' },
    ] }]),
  });
  t.after(() => mars.close());
  await mars.runWorkflow('after', 'private task');
  assert.equal(mars.lastRun.verificationStatus, 'not-run');
  assert.equal(mars.lastRun.verifications[0].report.verified, true);
  assert.deepEqual(mars.lastRun.usage, [{ provider: 'usage-fixture', inputTokens: 20, outputTokens: 8, samples: 2 }]);
  assert.ok(mars.lastRun.durationMs >= 0);
  assert.ok(mars.lastRun.finishedAt);
  assert.doesNotMatch(JSON.stringify(mars.lastRun), /private (task|response)/);
  const unknown = await createMars({ workspace: root, provider: new FakeProvider([answer()]), model: 'scripted', includeProjectContext: false });
  t.after(() => unknown.close());
  await unknown.run('task');
  assert.deepEqual(unknown.lastRun.usage, []);
  assert.equal(unknown.lastRun.verificationStatus, 'not-run');
});

test('repair settings validate and merge without erasing verification commands', async t => {
  const root = await fixture(t);
  const config = path.join(root, '.mars', 'config.json');
  const env = { APPDATA: root, XDG_CONFIG_HOME: root, HOME: root, USERPROFILE: root };
  await saveConfig(config, { verification: { commands: ['node --version'] } });
  await saveConfig(config, { verification: { maxRepairAttempts: 2 } });
  assert.deepEqual((await loadConfig(root, env)).config.verification, { commands: ['node --version'], maxRepairAttempts: 2 });
  for (const value of [-1, 4, 1.5, '1']) {
    await assert.rejects(saveConfig(config, { verification: { maxRepairAttempts: value } }), { code: 'ConfigurationError' });
    await assert.rejects(createMars({ workspace: root, provider: new FakeProvider(), model: 'scripted', maxRepairAttempts: value }), { code: 'ConfigurationError' });
  }
  const mars = await createMars({ workspace: root, provider: new FakeProvider(), model: 'scripted',
    workflows: new WorkflowRegistry([{ id: 'invalid', description: '', repairPhase: 'absent', matches: () => true, phases: [{ id: 'verify', role: 'verifier', instruction: 'review' }] }]),
  });
  t.after(() => mars.close());
  await assert.rejects(mars.runWorkflow('invalid', 'task'), { code: 'ConfigurationError' });
  assert.equal(mars.lastRun.status, 'failed');
});

test('CLI exports success and failure reports, preserving no-save and rejecting unsafe destinations before actions', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.mars'), { recursive: true });
  await writeFile(path.join(root, '.mars', 'config.json'), JSON.stringify({ verification: { commands: ['node --version'] } }));
  const script = path.join(root, 'script.json');
  await writeFile(script, JSON.stringify([write('effect.txt', 'executed'), answer()]));
  const cli = path.resolve('dist/apps/cli/src/index.js');
  const args = ['run', 'task', '--model', 'fake:scripted', '--workspace', root, '--script', script, '--no-save', '--no-animation'];
  const env = { ...process.env, APPDATA: root, XDG_CONFIG_HOME: root, HOME: root, USERPROFILE: root, MARS_MODEL: '', MARS_CREDENTIAL_STORE: 'file' };
  const run = extra => spawnSync(process.execPath, [cli, ...args, ...extra], { encoding: 'utf8', timeout: 20000, env });
  await writeFile(path.join(root, 'existing.json'), 'original');
  for (const destination of ['../outside.json', '.mars/private.json', 'existing.json']) {
    const rejected = run(['--report', destination]);
    assert.equal(rejected.status, 1, rejected.stderr);
    await assert.rejects(readFile(path.join(root, 'effect.txt')), { code: 'ENOENT' });
  }
  assert.equal(await readFile(path.join(root, 'existing.json'), 'utf8'), 'original');
  const passed = run(['--report', 'reports/passed.json', '--verify', '--allow-shell']);
  assert.equal(passed.status, 0, passed.stderr);
  const passReport = JSON.parse(await readFile(path.join(root, 'reports', 'passed.json'), 'utf8'));
  assert.equal(passReport.schemaVersion, 1);
  assert.deepEqual(passReport.runs.map(run => [run.kind, run.status, run.verificationStatus]), [['run', 'completed', 'not-run'], ['verify', 'completed', 'passed']]);
  await assert.rejects(readFile(path.join(root, '.mars', 'events.jsonl')), { code: 'ENOENT' });
  const failed = run(['--workflow', 'feature', '--repair-attempts', '1', '--report', 'reports/failed.json']);
  assert.equal(failed.status, 1);
  const failureReport = JSON.parse(await readFile(path.join(root, 'reports', 'failed.json'), 'utf8')).runs[0];
  assert.equal(failureReport.status, 'failed');
  assert.equal(failureReport.verificationStatus, 'failed');
  assert.equal(failureReport.repairAttempts, 0);
  assert.equal(failureReport.permissionDenials, 1);

  await writeFile(path.join(root, 'value.txt'), 'broken');
  await writeFile(path.join(root, 'check.mjs'), 'import { readFileSync } from "node:fs"; process.exit(readFileSync("value.txt", "utf8") === "fixed" ? 0 : 1);');
  await writeFile(path.join(root, '.mars', 'config.json'), JSON.stringify({ verification: { commands: ['node check.mjs'] } }));
  await writeFile(script, JSON.stringify([answer(), answer(), answer(), write('value.txt', 'fixed'), answer(), answer()]));
  const repaired = run(['--workflow', 'bugfix', '--repair-attempts', '1', '--allow-shell', '--report', 'reports/repaired.json']);
  assert.equal(repaired.status, 0, repaired.stderr);
  const repairReport = JSON.parse(await readFile(path.join(root, 'reports', 'repaired.json'), 'utf8')).runs[0];
  assert.equal(repairReport.status, 'completed');
  assert.equal(repairReport.repairAttempts, 1);
  assert.deepEqual(repairReport.verifications.map(value => value.report.verified), [false, true]);
  assert.equal(await readFile(path.join(root, 'value.txt'), 'utf8'), 'fixed');
});
