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
          return { output: step.output, usage: { inputTokens: 10, outputTokens: 2 }, commands: step.commands ?? [] };
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
const mars = (t, root, implementer, reviewer, extra = {}, options = {}) => createMars({ workspace: root, provider: new FakeProvider([]), model: 'unused', includeProjectContext: false,
  shellPolicy: 'allow', verificationCommands: ['node --version'], ...options,
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
  assert.deepEqual(reviewer.sessions, [{ readOnly: true, protect: [], denyCommands: [] }]);
  assert.deepEqual(implementer.sessions, [{ protect: [], denyCommands: [] }]);
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

test('engines receive the project map (AGENTS.md, or CLAUDE.md without it) in the first prompt of each session', async t => {
  const root = await project(t);
  await writeFile(path.join(root, 'AGENTS.md'), '# Calc\nVerify with node --version.\n');
  spawnSync('git', ['add', '-A'], { cwd: root }); spawnSync('git', ['commit', '-qm', 'map'], { cwd: root });
  const implementer = fakeEngine('i', [{ write: { 'calc.mjs': FIXED }, output: { summary: 's' } }, { output: { summary: 's2' } }]);
  const reviewer = fakeEngine('r', [{ output: CHANGES }, { output: APPROVE }]);
  const instance = await mars(t, root, implementer, reviewer, {}, { includeProjectContext: true });
  await instance.runWorkflow('cross-review', 'bug');
  assert.match(implementer.prompts[0].prompt, /\[project instructions: AGENTS\.md\]\n# Calc/);
  assert.match(reviewer.prompts[0].prompt, /# Calc/);
  assert.doesNotMatch(implementer.prompts[1].prompt, /# Calc/, 'resumed sessions already have it');
  assert.doesNotMatch(reviewer.prompts[1].prompt, /# Calc/);

  const other = await project(t);
  await writeFile(path.join(other, 'CLAUDE.md'), '# Claude-only map\n');
  const solo = fakeEngine('i', [{ output: { summary: 's' } }]);
  const second = await mars(t, other, solo, fakeEngine('r', [{ output: APPROVE }]), {}, { includeProjectContext: true });
  await second.runWorkflow('cross-review', 'bug');
  assert.match(solo.prompts[0].prompt, /\[project instructions: CLAUDE\.md\]/);

  const bare = await project(t);
  const none = fakeEngine('i', [{ output: { summary: 's' } }]);
  const third = await mars(t, bare, none, fakeEngine('r', [{ output: APPROVE }]), {}, { includeProjectContext: true });
  await third.runWorkflow('cross-review', 'bug');
  assert.doesNotMatch(none.prompts[0].prompt, /Project instructions/);
});

test('the Codex engine does not load AGENTS.md itself and reviews in a read-only sandbox', async () => {
  const { codexEngine } = await import('../dist/packages/sdk/src/internal.js');
  const threads = [];
  const runner = { startThread(options) { threads.push(options); return { async run() { return { finalResponse: '{"summary":"ok"}' }; } }; } };
  const engine = codexEngine({ runner });
  await engine.session('.').turn('p', {}, new AbortController().signal);
  await engine.session('.', { readOnly: true }).turn('p', {}, new AbortController().signal);
  assert.equal(threads[0].projectDocMaxBytes, 0);
  assert.equal(threads[0].sandboxMode, 'workspace-write');
  assert.equal(threads[1].sandboxMode, 'read-only');
});

test('mars init writes an AGENTS.md skeleton with the detected checks and never overwrites a map', async t => {
  const cli = path.join(process.cwd(), 'dist', 'apps', 'cli', 'src', 'index.js');
  const root = await mkdtemp(path.join(tmpdir(), 'mars-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), '');
  const first = spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const { readFile } = await import('node:fs/promises');
  const map = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(map, /## Verify\nRun before finishing any change:\n- `pnpm run test`\n- `pnpm run lint`/);
  assert.match(map, /TODO: one or two sentences/);
  await writeFile(path.join(root, 'AGENTS.md'), '# mine\n');
  const second = spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8' });
  assert.match(second.stdout, /AGENTS\.md already exists/);
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), '# mine\n');
});

test('policy: commands are unwrapped from the engine shell and matched by prefix across chains', async () => {
  const { deniedCommand, unwrapShell } = await import('../dist/packages/sdk/src/contract.js');
  assert.equal(unwrapShell(String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'npm test'`), 'npm test');
  assert.equal(unwrapShell(String.raw`/bin/bash -lc 'echo '\''hi'\'''`), "echo 'hi'");
  assert.equal(unwrapShell('npm test'), 'npm test');
  assert.equal(deniedCommand("/bin/bash -lc 'npm test && git push origin main'", ['git push']), 'git push');
  assert.equal(deniedCommand('FOO=1 rm -rf build', ['rm -rf']), 'rm -rf');
  assert.equal(deniedCommand('git pushx', ['git push']), undefined);
  assert.equal(deniedCommand('npm test | grep ok', ['git push']), undefined);
});

test('policy: a denied command fails the run for any engine; commands are recorded; protected files hold', async t => {
  const root = await project(t);
  const implementer = fakeEngine('i', [{ write: { 'calc.mjs': FIXED }, commands: ["/bin/bash -lc 'node --test'", "/bin/bash -lc 'git push origin main'"], output: { summary: 's' } }]);
  const reviewer = fakeEngine('r', []);
  const instance = await mars(t, root, implementer, reviewer, {}, { denyCommands: ['git push'], protect: ['secret.txt'] });
  await assert.rejects(instance.runWorkflow('cross-review', 'bug'), /Policy violated: impl ran `git push origin main` \(contract\.denyCommands: git push\)/);
  assert.deepEqual(instance.lastRun.commands, [{ agent: 'impl', command: 'node --test' }, { agent: 'impl', command: 'git push origin main' }]);
  assert.deepEqual(implementer.sessions, [{ protect: ['secret.txt'], denyCommands: ['git push'] }]);
  assert.equal(reviewer.prompts.length, 0, 'no review after a policy violation');

  const other = await project(t);
  await writeFile(path.join(other, 'secret.txt'), 'v1');
  const editor = fakeEngine('i', [{ write: { 'secret.txt': 'v2' }, output: { summary: 's' } }]);
  const second = await mars(t, other, editor, fakeEngine('r', [{ output: APPROVE }]), {}, { protect: ['secret.txt'] });
  await assert.rejects(second.runWorkflow('cross-review', 'bug'), /Task contract violated: protected files changed \(secret\.txt\)/);
});

test('config: contract.denyCommands is validated and merges with protect', async () => {
  const { mergeConfig } = await import('../dist/packages/sdk/src/internal.js');
  const merged = mergeConfig({ contract: { protect: ['a/**'] } }, { contract: { denyCommands: ['git push'] } });
  assert.deepEqual(merged.contract, { protect: ['a/**'], denyCommands: ['git push'] });
  assert.deepEqual(mergeConfig().contract, { protect: [], denyCommands: [] });
  const { saveConfig } = await import('../dist/packages/sdk/src/internal.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'mars-policy-'));
  await assert.rejects(saveConfig(path.join(dir, 'c.json'), { contract: { denyCommands: ['Bash(x)'] } }), /denyCommands must be up to 64 command prefixes/);
  await rm(dir, { recursive: true, force: true });
});
