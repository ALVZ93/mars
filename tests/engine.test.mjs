import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMars, receiptVerdict, renderReceipt } from '../dist/packages/sdk/src/index.js';
import { FakeProvider } from '../dist/packages/sdk/src/internal.js';

const BUGGY = 'export const add = (a, b) => a - b;\n';
const FIXED = 'export const add = (a, b) => a + b;\n';
const TEST = 'import { add } from "../calc.mjs";\nif (add(2, 3) !== 5) { console.error("expected 5, got " + add(2, 3)); process.exit(1); }\n';
const OUTDATED = 'import { add } from "../calc.mjs";\nif (add(2, 3) !== 6) { console.error("expected 6, got " + add(2, 3)); process.exit(1); }\n';
const reproduction = { kind: 'reproduction', command: 'node tests/calc.test.mjs', files: ['tests/calc.test.mjs'], reported: 'add(2, 3) is 5, not -1', covers: 'add() returns the sum', cases: ['add(2, 3) is 5'], reason: '' };

/** Scripted engine: each step may write files in the session's cwd, then returns its structured output. */
function fakeEngine(steps) {
  const prompts = [];
  return {
    id: 'fake-engine', model: 'scripted', prompts,
    session(cwd) {
      return {
        async turn(prompt, schema) {
          prompts.push({ prompt, schema });
          const step = steps.shift();
          if (!step) throw new Error('No scripted turn left.');
          for (const [file, content] of Object.entries(step.write ?? {})) {
            await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
            await writeFile(path.join(cwd, file), content);
          }
          return { output: step.output, usage: { inputTokens: 10, outputTokens: 2 } };
        },
      };
    },
  };
}

async function project(t, source = BUGGY) {
  const root = await mkdtemp(path.join(tmpdir(), 'mars-engine-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(path.join(root, 'calc.mjs'), source);
  return root;
}
const mars = (t, root, engine, extra = {}) => createMars({ workspace: root, provider: new FakeProvider([]), model: 'unused', includeProjectContext: false,
  shellPolicy: 'allow', verificationCommands: ['node --version'], engine, ...extra }).then(instance => { t.after(() => instance.close()); return instance; });

test('an engine runs bugfix in two turns and MARS proves the fix in between', async t => {
  const root = await project(t);
  const engine = fakeEngine([{ write: { 'tests/calc.test.mjs': TEST }, output: reproduction }, { write: { 'calc.mjs': FIXED }, output: { summary: 'fixed add' } }]);
  const instance = await mars(t, root, engine);
  const answer = await instance.runWorkflow('bugfix', 'add() returns the wrong result');
  const report = instance.lastRun;
  assert.equal(report.status, 'completed');
  assert.equal(answer.content, 'fixed add');
  assert.equal(engine.prompts.length, 2);
  assert.match(engine.prompts[0].prompt, /add\(\) returns the wrong result/);
  assert.match(engine.prompts[0].prompt, /do not fix the bug/i);
  assert.match(engine.prompts[1].prompt, /tests\/calc\.test\.mjs/);
  assert.match(engine.prompts[1].prompt, /fails as expected/);
  assert.notEqual(report.proof.red.exitCode, 0);
  assert.deepEqual(report.proof.green, { exitCode: 0 });
  assert.deepEqual(report.proof.scope, { reported: 'add(2, 3) is 5, not -1', covers: 'add() returns the sum', cases: ['add(2, 3) is 5'] });
  assert.deepEqual(report.models, ['fake-engine:scripted']);
  assert.equal(report.modelRequests, 2);
  assert.deepEqual(report.usage, [{ provider: 'fake-engine', inputTokens: 20, outputTokens: 4, samples: 2 }]);
  assert.deepEqual(receiptVerdict(report), { ok: true, label: 'Fixed and proven' });
  assert.match(renderReceipt([report]), /Models: `fake-engine:scripted`/);
});

test('the reproduction turn may only touch tests', async t => {
  const root = await project(t);
  const engine = fakeEngine([{ write: { 'tests/calc.test.mjs': TEST, 'calc.mjs': FIXED }, output: reproduction }]);
  const instance = await mars(t, root, engine);
  await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /changed non-test files while reproducing: calc\.mjs/);
  assert.equal(engine.prompts.length, 1);
});

test('changing the protected test in the fix turn violates the contract', async t => {
  const root = await project(t);
  const engine = fakeEngine([{ write: { 'tests/calc.test.mjs': TEST }, output: reproduction },
    { write: { 'tests/calc.test.mjs': 'process.exit(0);\n' }, output: { summary: 'made it pass' } }]);
  const instance = await mars(t, root, engine);
  await assert.rejects(instance.runWorkflow('bugfix', 'bug'), /Task contract violated: protected files changed \(tests\/calc\.test\.mjs\)/);
  assert.match(renderReceipt([instance.lastRun]), /Protected files changed/);
});

test('failing checks go back to the same engine session as a repair turn', async t => {
  const root = await project(t);
  const engine = fakeEngine([{ write: { 'tests/calc.test.mjs': TEST }, output: reproduction },
    { write: { 'calc.mjs': 'export const add = (a, b) => a * b;\n' }, output: { summary: 'wrong fix' } },
    { write: { 'calc.mjs': FIXED }, output: { summary: 'repaired' } }]);
  const instance = await mars(t, root, engine, { maxRepairAttempts: 1 });
  await instance.runWorkflow('bugfix', 'bug');
  assert.equal(instance.lastRun.status, 'completed');
  assert.equal(instance.lastRun.repairAttempts, 1);
  assert.match(engine.prompts[2].prompt, /expected 5, got 6/);
  assert.match(engine.prompts[2].prompt, /untrusted data/);
});

test('an engine can report an outdated test; MARS checks it and proposes the change', async t => {
  const root = await project(t, FIXED);
  await mkdir(path.join(root, 'tests'));
  await writeFile(path.join(root, 'tests', 'calc.test.mjs'), OUTDATED);
  const engine = fakeEngine([{ write: { 'tests/calc.test.mjs': TEST },
    output: { kind: 'outdated', command: 'node tests/calc.test.mjs', files: ['tests/calc.test.mjs'], reported: '', covers: '', cases: [], reason: 'expects 6 for add(2, 3)' } }]);
  const instance = await mars(t, root, engine);
  await instance.runWorkflow('bugfix', 'npm test fails');
  assert.equal(engine.prompts.length, 1);
  assert.deepEqual(receiptVerdict(instance.lastRun), { ok: false, label: 'Test change proposed' });
  assert.equal(await readFile(path.join(root, 'calc.mjs'), 'utf8'), FIXED);
});

test('engines are only for workflows with a reproduction phase', async t => {
  const root = await project(t);
  const instance = await mars(t, root, fakeEngine([]));
  await assert.rejects(instance.runWorkflow('feature', 'add a feature'), /--engine requires a workflow with a reproduction phase/);
});
