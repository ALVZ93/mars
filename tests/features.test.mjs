import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { featureOutcome, featureTask, nextFeature, parseFeatures } from '../dist/packages/sdk/src/internal.js';
import { runNextFeatures } from '../dist/apps/cli/src/commands/features.js';

const cli = path.join(process.cwd(), 'dist', 'apps', 'cli', 'src', 'index.js');
const list = features => ({ version: 1, features });

async function project(t, data) {
  const root = await mkdtemp(path.join(tmpdir(), 'mars-features-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(path.join(root, '.mars'), { recursive: true });
  if (data) await writeFile(path.join(root, '.mars', 'features.json'), JSON.stringify(data));
  return root;
}
const stored = async root => JSON.parse(await readFile(path.join(root, '.mars', 'features.json'), 'utf8'));
/** A run report as receiptVerdict reads it. */
const report = (verdict = 'approve', overrides = {}) => ({ schemaVersion: 1, id: `run-${Math.random().toString(16).slice(2, 8)}`, sessionId: 's1', kind: 'workflow', workflow: 'cross-review',
  startedAt: new Date().toISOString(), durationMs: 1, status: 'completed', models: [], modelRequests: 2, modelRetries: 0, toolCalls: 0, toolErrors: 0, permissionDenials: 0,
  repairAttempts: 0, usage: [], verificationStatus: 'passed', verifications: [], reviews: [{ round: 1, agent: 'claude', verdict, findings: verdict === 'changes' ? [{ file: 'a', problem: 'p', fix: 'f' }] : [] }], ...overrides });

test('features.json is validated: ids, statuses, dependencies and cycles', () => {
  assert.equal(parseFeatures(list([{ id: 'a', title: 'A' }])).features[0].status, 'not_started');
  assert.throws(() => parseFeatures({ features: [] }), /version/);
  assert.throws(() => parseFeatures(list([{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }])), /duplicate id a/);
  assert.throws(() => parseFeatures(list([{ id: 'A b', title: 'A' }])), /id must be/);
  assert.throws(() => parseFeatures(list([{ id: 'a' }])), /title is required/);
  assert.throws(() => parseFeatures(list([{ id: 'a', title: 'A', status: 'done' }])), /status must be/);
  assert.throws(() => parseFeatures(list([{ id: 'a', title: 'A', dependsOn: ['z'] }])), /unknown feature z/);
  assert.throws(() => parseFeatures(list([{ id: 'a', title: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B', dependsOn: ['a'] }])), /dependency cycle: a → b → a/);
  assert.throws(() => parseFeatures(list([{ id: 'a', title: 'A', acceptance: 'one' }])), /acceptance must be a list/);
});

test('the next feature is the first open one whose dependencies are accepted', () => {
  const parsed = parseFeatures(list([
    { id: 'login', title: 'Login', status: 'accepted' },
    { id: 'export', title: 'Export', dependsOn: ['booking'] },
    { id: 'booking', title: 'Booking', dependsOn: ['login'] },
    { id: 'stuck', title: 'Stuck', status: 'blocked' },
  ]));
  assert.equal(nextFeature(parsed).id, 'booking');
  parsed.features[2].status = 'accepted';
  assert.equal(nextFeature(parsed).id, 'export');
  parsed.features[1].status = 'accepted';
  assert.equal(nextFeature(parsed), undefined, 'blocked features are never picked');
});

test('outcome comes from the receipt verdict, and attempts run out into blocked', () => {
  assert.equal(featureOutcome({ ok: true, label: 'Verified' }, 1, 2), 'accepted');
  assert.equal(featureOutcome({ ok: true, label: 'Verified' }, 2, 2), 'accepted');
  assert.equal(featureOutcome({ ok: false, label: 'Review findings open' }, 1, 2), 'passing');
  assert.equal(featureOutcome({ ok: false, label: 'Failed (ToolExecutionError)' }, 1, 2), 'in_progress');
  assert.equal(featureOutcome({ ok: false, label: 'Review findings open' }, 2, 2), 'blocked');
});

test('the task carries acceptance scenarios, the spec and the Definition of Done', () => {
  const task = featureTask({ id: 'booking', title: 'Book a slot', description: 'Members book courts.', acceptance: ['A free slot can be booked'], spec: 'docs/booking.md', status: 'not_started' }, '# Spec body');
  assert.match(task, /^Feature booking: Book a slot\n\nMembers book courts\./);
  assert.match(task, /each one must be covered by an automated test\):\n- A free slot can be booked/);
  assert.match(task, /Spec \(docs\/booking\.md, repository data\):\n# Spec body/);
  assert.match(task, /Definition of done:/);
});

test('mars next loop: accepted continues, open findings stop as passing, evidence and receipt are recorded', async t => {
  const root = await project(t, list([{ id: 'one', title: 'One', verify: ['node one.js'] }, { id: 'two', title: 'Two', dependsOn: ['one'], spec: 'spec.md' }, { id: 'three', title: 'Three' }]));
  await writeFile(path.join(root, 'spec.md'), 'Two must do X.');
  const calls = [];
  const verdicts = ['approve', 'changes'];
  await runNextFeatures(root, { maxFeatures: 5, maxAttempts: 2, gate: ['pnpm test'], async runFeature(task, commands) {
    calls.push({ task, commands });
    // An agent rewriting features.json must not change what MARS records.
    await writeFile(path.join(root, '.mars', 'features.json'), JSON.stringify(list([{ id: 'one', title: 'One', status: 'accepted' }])));
    return { report: report(verdicts.shift()) };
  } });
  assert.equal(calls.length, 2, 'stops after a feature that is not accepted');
  assert.deepEqual(calls[0].commands, ['node one.js', 'pnpm test']);
  assert.match(calls[1].task, /Two must do X\./);
  const data = await stored(root);
  assert.deepEqual(data.features.map(feature => [feature.id, feature.status, feature.attempts ?? 0]), [['one', 'accepted', 1], ['two', 'passing', 1], ['three', 'not_started', 0]]);
  assert.equal(data.features[1].evidence.verdict, 'Review findings open');
  assert.equal(data.features[1].evidence.reviews, 1);
  assert.match(await readFile(path.join(root, '.mars', 'features', 'two.md'), 'utf8'), /Feature two — Review findings open/);
});

test('mars next loop: failures retry, then block; a missing report still counts as an attempt', async t => {
  const root = await project(t, list([{ id: 'one', title: 'One' }]));
  const run = async () => { await runNextFeatures(root, { maxFeatures: 1, maxAttempts: 2, gate: [], runFeature: async () => ({ failure: new Error('engine crashed') }) }); };
  await run();
  assert.equal((await stored(root)).features[0].status, 'in_progress');
  await run();
  const feature = (await stored(root)).features[0];
  assert.equal(feature.status, 'blocked');
  assert.equal(feature.attempts, 2);
  let called = false;
  await runNextFeatures(root, { maxFeatures: 1, maxAttempts: 2, gate: [], runFeature: async () => { called = true; return {}; } });
  assert.equal(called, false, 'blocked features wait for a person');
});

test('mars features lists status; mars next needs agents and a features file', async t => {
  const root = await project(t, { version: 1, features: [{ id: 'one', title: 'One', status: 'accepted' }, { id: 'two', title: 'Two', dependsOn: ['one'] }] });
  const listed = spawnSync(process.execPath, [cli, 'features'], { cwd: root, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /✔ accepted +one/);
  assert.match(listed.stdout, /· not_started two ← next/);
  assert.match(listed.stdout, /1 accepted · 1 not_started/);
  const noAgents = spawnSync(process.execPath, [cli, 'next'], { cwd: root, encoding: 'utf8' });
  assert.match(noAgents.stderr, /needs an implementer and a reviewer/);
  const empty = await project(t);
  const missing = spawnSync(process.execPath, [cli, 'features'], { cwd: empty, encoding: 'utf8' });
  assert.match(missing.stderr, /No \.mars\/features\.json/);
});

test('mars init saves the detected gate; --ci adds a gate script and a workflow that run the same commands', async t => {
  const root = await project(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"' } }));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), '');
  const init = spawnSync(process.execPath, [cli, 'init', '--ci'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /Gate: pnpm run test · pnpm run build \(detected, saved as verification\.commands\)/);
  const config = JSON.parse(await readFile(path.join(root, '.mars', 'config.json'), 'utf8'));
  assert.deepEqual(config.verification.commands, ['pnpm run test', 'pnpm run build']);
  const workflow = await readFile(path.join(root, '.github', 'workflows', 'mars-gate.yml'), 'utf8');
  assert.match(workflow, /- run: corepack enable\n {6}- run: pnpm install --frozen-lockfile\n {6}- run: node \.mars\/gate\.mjs/);

  // The script runs whatever the config says, in order, and fails on the first failing command.
  await writeFile(path.join(root, '.mars', 'config.json'), JSON.stringify({ version: 1, verification: { commands: ['node -e "console.log(1)"', 'node -e "process.exit(3)"', 'node -e "console.log(2)"'] } }));
  const failing = spawnSync(process.execPath, [path.join(root, '.mars', 'gate.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(failing.status, 3);
  assert.doesNotMatch(failing.stdout, /▶ node -e "console\.log\(2\)"/);
  await writeFile(path.join(root, '.mars', 'config.json'), JSON.stringify({ version: 1, verification: { commands: ['node -e "process.exit(0)"'] } }));
  const passing = spawnSync(process.execPath, [path.join(root, '.mars', 'gate.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /Gate passed: 1 command/);

  const again = spawnSync(process.execPath, [cli, 'init', '--ci'], { cwd: root, encoding: 'utf8' });
  assert.match(again.stdout, /Gate: node -e "process\.exit\(0\)" \(configured\)/);
  assert.match(again.stdout, /gate\.mjs already exists[\s\S]*mars-gate\.yml already exists/);
});
