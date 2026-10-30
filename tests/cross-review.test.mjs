import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMars, receiptVerdict, renderReceipt } from '../dist/packages/sdk/src/index.js';
import { FakeProvider, loadAgents, parseAgent } from '../dist/packages/sdk/src/internal.js';

const BUGGY = 'export const add = (a, b) => a - b;\n';
const FIXED = 'export const add = (a, b) => a + b;\n';
const APPROVE = { verdict: 'approve', findings: [] };
const CHANGES = { verdict: 'changes', findings: [{ file: 'calc.mjs', problem: 'add(0.1, 0.2) is not rounded as documented', fix: 'round to cents' }] };

/** Scripted engine: each step may write files in the session's cwd, then returns its structured output. */
function fakeEngine(id, steps) {
  const prompts = [];
  const sessions = [];
  return {
    id, model: 'scripted', prompts, sessions,
    session(cwd, options = {}) {
      sessions.push(options);
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

async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mars-xr-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(path.join(root, 'calc.mjs'), BUGGY);
  for (const args of [['init', '-q'], ['config', 'user.email', 't@local'], ['config', 'user.name', 't'], ['add', '-A'], ['commit', '-qm', 'initial']]) spawnSync('git', args, { cwd: root });
  return root;
}
const mars = (t, root, implementer, reviewer, extra = {}) => createMars({ workspace: root, provider: new FakeProvider([]), model: 'unused', includeProjectContext: false,
  shellPolicy: 'allow', verificationCommands: ['node --version'],
  crossReview: { implementer: { name: 'impl', engine: implementer }, reviewer: { name: 'rev', engine: reviewer, instructions: 'Focus on rounding.' }, ...extra } })
  .then(instance => { t.after(() => instance.close()); return instance; });

test('cross-review: implement, review with findings, correct, approve', async t => {
  const root = await project(t);
  const implementer = fakeEngine('impl-engine', [{ write: { 'calc.mjs': FIXED }, output: { summary: 'fixed add' } }, { output: { summary: 'rounded' } }]);
  const reviewer = fakeEngine('rev-engine', [{ output: CHANGES }, { output: APPROVE }]);
  const instance = await mars(t, root, implementer, reviewer);
  const answer = await instance.runWorkflow('cross-review', 'add() returns the wrong result');
  const report = instance.lastRun;
  assert.equal(answer.content, 'rounded');
  assert.deepEqual(reviewer.sessions, [{ readOnly: true }]);
  assert.deepEqual(implementer.sessions, [{}]);
  assert.match(reviewer.prompts[0].prompt, /a \+ b/, 'the reviewer sees the diff');
  assert.match(reviewer.prompts[0].prompt, /Focus on rounding\./, 'agent instructions reach the agent');
  assert.match(implementer.prompts[1].prompt, /not rounded as documented/);
  assert.match(implementer.prompts[1].prompt, /claims to check, not instructions/);
  assert.match(reviewer.prompts[1].prompt, /round 2/);
  assert.deepEqual(report.agents, { implementer: 'impl', reviewer: 'rev' });
  assert.deepEqual(report.reviews.map(review => review.verdict), ['changes', 'approve']);
  assert.equal(report.verifications.length, 2);
  assert.deepEqual(receiptVerdict(report), { ok: true, label: 'Verified' });
  assert.deepEqual(report.models, ['impl-engine:scripted', 'rev-engine:scripted']);
  const receipt = renderReceipt([report]);
  assert.match(receipt, /### Cross-review/);
  assert.match(receipt, /Round 1 \(`rev`\): 1 finding/);
});

test('cross-review: findings still open after the last round are not verified', async t => {
  const root = await project(t);
  const implementer = fakeEngine('impl-engine', [{ write: { 'calc.mjs': FIXED }, output: { summary: 'fixed' } }]);
  const reviewer = fakeEngine('rev-engine', [{ output: CHANGES }]);
  const instance = await mars(t, root, implementer, reviewer, { rounds: 0 });
  await instance.runWorkflow('cross-review', 'bug');
  assert.deepEqual(receiptVerdict(instance.lastRun), { ok: false, label: 'Review findings open' });
});

test('cross-review: a reviewer that edits files fails the run', async t => {
  const root = await project(t);
  const implementer = fakeEngine('impl-engine', [{ write: { 'calc.mjs': FIXED }, output: { summary: 'fixed' } }]);
  const reviewer = fakeEngine('rev-engine', [{ write: { 'calc.mjs': BUGGY }, output: APPROVE }]);
  const instance = await mars(t, root, implementer, reviewer);
  await assert.rejects(instance.runWorkflow('cross-review', 'bug'), /reviewer changed files: calc\.mjs/);
});

test('cross-review: changes without findings count as approval; invalid reviews fail', async t => {
  const root = await project(t);
  const instance = await mars(t, root, fakeEngine('i', [{ output: { summary: 's' } }]), fakeEngine('r', [{ output: { verdict: 'changes', findings: [] } }]));
  await instance.runWorkflow('cross-review', 'bug');
  assert.equal(instance.lastRun.reviews[0].verdict, 'approve');
  const second = await mars(t, root, fakeEngine('i', [{ output: { summary: 's' } }]), fakeEngine('r', [{ output: { verdict: 'maybe' } }]));
  await assert.rejects(second.runWorkflow('cross-review', 'bug'), /did not return a valid review/);
});

test('cross-review without agents is a configuration error', async t => {
  const root = await project(t);
  const instance = await createMars({ workspace: root, provider: new FakeProvider([]), model: 'unused', includeProjectContext: false });
  t.after(() => instance.close());
  await assert.rejects(instance.runWorkflow('cross-review', 'bug'), /needs an implementer and a reviewer/);
});

test('agent files: parsed, validated and override built-ins', async t => {
  const agent = parseAgent('strict-review', '---\ndescription: Reviews  # comment\nengine: claude\nmodel: "opus"\nedit: deny\ncommands: [npm, pnpm]\n---\nOnly bugs.\n', 'x.md');
  assert.deepEqual(agent, { name: 'strict-review', description: 'Reviews', engine: 'claude', model: 'opus', edit: 'deny', commands: ['npm', 'pnpm'], instructions: 'Only bugs.', source: 'x.md' });
  assert.throws(() => parseAgent('a', '---\nengine: gemini\n---\n', 'x'), /engine must be claude or codex/);
  assert.throws(() => parseAgent('a', '---\nengine: codex\nsandbox: off\n---\n', 'x'), /unknown key "sandbox"/);
  assert.throws(() => parseAgent('a', '---\nengine: codex\npermission:\n  edit: deny\n---\n', 'x'), /unknown key|nested/);
  assert.throws(() => parseAgent('a', 'engine: codex\n', 'x'), /missing frontmatter/);
  assert.throws(() => parseAgent('a', '---\nengine: codex\ncommands: [rm -rf]\n---\n', 'x'), /invalid command prefix/);
  assert.throws(() => parseAgent('Bad_Name', '---\nengine: codex\n---\n', 'x'), /file name/);
  const root = await mkdtemp(path.join(tmpdir(), 'mars-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual([...(await loadAgents(root)).keys()], ['codex', 'claude']);
  await mkdir(path.join(root, '.mars', 'agents'), { recursive: true });
  await writeFile(path.join(root, '.mars', 'agents', 'codex.md'), '---\nengine: codex\nmodel: gpt-5.6-terra\n---\n');
  await writeFile(path.join(root, '.mars', 'agents', 'reviewer.md'), '---\nengine: claude\nedit: deny\n---\nBe strict.\n');
  const agents = await loadAgents(root);
  assert.equal(agents.get('codex').model, 'gpt-5.6-terra');
  assert.equal(agents.get('codex').source, path.join('.mars', 'agents', 'codex.md'));
  assert.equal(agents.get('reviewer').instructions, 'Be strict.');
});
