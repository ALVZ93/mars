import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexCliRunner } from '../dist/packages/providers/src/codex-runner.js';

// The runner spawns `<executable> exec …`; with node as the executable, `exec` is this fake CLI script.
const FAKE = String.raw`
const fs = require('fs');
const { spawn } = require('child_process');
const scenario = process.env.FAKE_CODEX;
fs.appendFileSync('args.log', JSON.stringify(process.argv.slice(2)) + '\n');
const out = event => process.stdout.write(JSON.stringify(event) + '\n');
const respond = () => {
  if (scenario === 'failed') { out({ type: 'turn.failed', error: { message: 'boom' } }); return; }
  out({ type: 'thread.started', thread_id: 'thread-1' });
  out({ type: 'item.completed', item: { type: 'agent_message', text: '{"answer":"ok"}' } });
  if (scenario === 'corrupt') { process.stdout.write('not json\n'); return; }
  if (scenario === 'incomplete') return;
  out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
};
if (scenario === 'epipe') process.exit(0);
if (scenario === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync('pids.json', JSON.stringify([process.pid, grandchild.pid]));
  setInterval(() => {}, 1000);
} else {
  process.stdin.on('data', () => {}).on('end', respond);
}
`;

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const schema = { type: 'object' };

async function fakeCli(t, scenario) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mars-fake-codex-'));
  await writeFile(path.join(dir, 'exec'), FAKE);
  const cwd = process.cwd();
  process.chdir(dir);
  process.env.FAKE_CODEX = scenario;
  t.after(async () => { process.chdir(cwd); delete process.env.FAKE_CODEX; await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const thread = new CodexCliRunner({ binary: () => ({ executable: process.execPath, pathDirs: [] }) }).startThread({ model: 'm', sandboxMode: 'read-only', threadSource: 'mars' });
  return { dir, thread };
}

test('runs without the user config, parses the turn and resumes the same thread', async t => {
  const { dir, thread } = await fakeCli(t, 'ok');
  assert.deepEqual(await thread.run('first', { outputSchema: schema, signal: new AbortController().signal }), { finalResponse: '{"answer":"ok"}', usage: { input_tokens: 10, output_tokens: 2 } });
  await thread.run('second', { outputSchema: schema, signal: new AbortController().signal });
  const [first, second] = (await readFile(path.join(dir, 'args.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  // argv[1] is the `exec` subcommand itself (the fake script); the flags follow it.
  assert.deepEqual(first.slice(0, 2), ['--experimental-json', '--ignore-user-config']);
  assert.ok(first.includes('--thread-source') && !first.includes('resume'));
  assert.deepEqual(second.slice(-2), ['resume', 'thread-1']);
  assert.ok(!second.includes('--thread-source'));
});

for (const [scenario, message] of [['failed', /boom/], ['corrupt', /invalid JSONL/], ['incomplete', /without completing the turn/]]) {
  test(`rejects a ${scenario} turn`, async t => {
    const { thread } = await fakeCli(t, scenario);
    await assert.rejects(thread.run('x', { outputSchema: schema, signal: new AbortController().signal }), message);
  });
}

test('an early stdin close is a rejected turn, never an unhandled EPIPE', async t => {
  const { thread } = await fakeCli(t, 'epipe');
  await assert.rejects(thread.run('x'.repeat(8 * 1024 * 1024), { outputSchema: schema, signal: new AbortController().signal }), /closed its input early|without completing/);
});

test('cancellation settles only after the whole process tree is gone', async t => {
  const { dir, thread } = await fakeCli(t, 'hang');
  const controller = new AbortController();
  const turn = thread.run('x', { outputSchema: schema, signal: controller.signal });
  let pids;
  for (let i = 0; i < 100 && !pids; i++) { await new Promise(resolve => setTimeout(resolve, 50)); pids = await readFile(path.join(dir, 'pids.json'), 'utf8').then(JSON.parse, () => undefined); }
  assert.ok(pids, 'fake codex started');
  controller.abort();
  await assert.rejects(turn, /cancelled/);
  assert.equal(alive(pids[0]), false, 'codex process terminated before the turn settled');
  for (let i = 0; i < 40 && alive(pids[1]); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(alive(pids[1]), false, 'grandchild terminated');
});
