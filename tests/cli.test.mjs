import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/apps/cli/src/index.js', import.meta.url));
function run(args) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000, env: { ...process.env, OPENAI_API_KEY: '', FORGE_MODEL: '' } }); }
test('CLI help, version and configuration failures', () => {
  assert.match(run(['--help']).stdout, /MARS 0.1/);
  assert.match(run(['auth', 'providers']).stdout, /Google Gemini API/);
  assert.equal(run(['--version']).stdout.trim(), '0.1.0');
  assert.equal(run(['run', 'task']).status, 1);
  assert.match(run(['run', 'task', '--model', 'openai:test']).stderr, /AuthenticationError/);
  assert.equal(run(['run', 'task', '--model', 'fake:scripted', '--timeout', '-1']).status, 1);
});
test('CLI offline fixture executes read → write → shell → final', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-cli-'));
  assert.equal(path.dirname(root), tmpdir());
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}');
  const script = fileURLToPath(new URL('../examples/fake-script.json', import.meta.url));
  const result = run(['run', 'offline fixture', '--model', 'fake:scripted', '--workspace', root, '--script', script, '--allow-shell']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(root, 'hello.txt'), 'utf8'), 'hello forge');
  assert.match(result.stderr, /\[tool\] read_file[\s\S]*\[tool\] write_file[\s\S]*\[tool\] shell/);
  assert.ok(!result.stderr.includes('Error'), result.stderr);
  assert.match(result.stdout, /Fake script complete/);
});
test('CLI blocks shell in non-interactive mode unless explicitly enabled', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-cli-'));
  assert.equal(path.dirname(root), tmpdir());
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'script.json');
  await writeFile(script, JSON.stringify([
    { role: 'assistant', content: '', toolCalls: [{ id: 's', name: 'shell', arguments: { command: 'node --version', cwd: null, timeout: null } }] },
    { role: 'assistant', content: 'Denied', toolCalls: [] },
  ]));
  const result = run(['run', 'task', '--model', 'fake:scripted', '--workspace', root, '--script', script]);
  assert.match(result.stderr, /PermissionDeniedError/);
});
