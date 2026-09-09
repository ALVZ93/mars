import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace, Permissions } from '../dist/packages/runtime/src/index.js';
import { ToolRegistry, workspaceTools, shellEnvironment, OUTPUT_LIMIT, sandboxStatus, createSandboxShell } from '../dist/packages/tools/src/index.js';

async function setup(t, permissions = new Permissions('deny')) {
  const temp = await mkdtemp(path.join(tmpdir(), 'forge-test-'));
  assert.equal(path.dirname(temp), tmpdir());
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'workspace');
  await mkdir(root);
  const workspace = await Workspace.open(root);
  const registry = new ToolRegistry(workspaceTools(workspace, permissions));
  const execute = (name, args, signal = new AbortController().signal) => registry.execute({ id: 'call', name, arguments: args }, signal);
  return { temp, root, workspace, registry, execute };
}
test('sandbox status is explicit and host mode remains backward compatible', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mars-sandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const status = sandboxStatus({ mode: 'host' });
  assert.deepEqual(status, { mode: 'host', available: true, isolated: false, message: 'Host process; no OS isolation.' });
  const shell = createSandboxShell(root, { mode: 'host' });
  assert.equal(typeof shell, 'function');
});
test('read and atomic write, including new parent directories and replacement', async t => {
  const { execute, root } = await setup(t);
  assert.deepEqual(await execute('write_file', { path: 'nested/hello.txt', content: 'hello forge' }), { content: 'File written.' });
  assert.deepEqual(await execute('read_file', { path: 'nested/hello.txt' }), { content: 'hello forge' });
  await execute('write_file', { path: 'nested/hello.txt', content: 'replaced' });
  assert.equal(await readFile(path.join(root, 'nested/hello.txt'), 'utf8'), 'replaced');
});
test('traversal, absolute, Windows drive, UNC, ADS and sensitive files are blocked', async t => {
  const { execute, temp } = await setup(t);
  for (const input of ['../escape.txt', path.join(temp, 'outside.txt'), 'Z:\\outside.txt', '\\\\server\\share\\file', 'a.txt:secret', '.env', '.env.local', '.ssh/id_rsa', '.git/config', 'NUL', 'odd.']) {
    const result = await execute('write_file', { path: input, content: 'secret' });
    assert.ok(['WorkspaceViolationError', 'PermissionDeniedError'].includes(result.error), input);
  }
});
test('symlink/junction and hardlink escapes are blocked for reads and writes', async t => {
  const { execute, temp, root } = await setup(t);
  const outside = path.join(temp, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'private');
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await link(path.join(outside, 'secret.txt'), path.join(root, 'hard.txt'));
  for (const target of ['linked/secret.txt', 'linked/new.txt', 'hard.txt']) {
    assert.equal((await execute('read_file', { path: target })).error, 'WorkspaceViolationError');
    assert.equal((await execute('write_file', { path: target, content: 'changed' })).error, 'WorkspaceViolationError');
  }
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'private');
});
test('unknown tools, malformed inputs, extra keys and IO failure return safe observations', async t => {
  const { execute } = await setup(t);
  for (const [name, args] of [['missing', {}], ['read_file', {}], ['write_file', { path: 'a', content: 1 }], ['read_file', { path: 'a', extra: true }]]) {
    assert.equal((await execute(name, args)).error, 'InvalidToolCallError');
  }
  const result = await execute('read_file', { path: 'missing' });
  assert.deepEqual(result, { error: 'ToolExecutionError', content: 'Tool execution failed.' });
});
test('tool output is bounded and cancellation prevents writes', async t => {
  const { execute, root } = await setup(t);
  await writeFile(path.join(root, 'big.txt'), 'x'.repeat(OUTPUT_LIMIT * 4));
  const result = await execute('read_file', { path: 'big.txt' });
  assert.ok(result.content.length < OUTPUT_LIMIT + 100);
  assert.match(result.content, /truncated/);
  await assert.rejects(execute('write_file', { path: 'cancelled.txt', content: 'no' }, AbortSignal.abort()), { code: 'CancelledError' });
  await assert.rejects(readFile(path.join(root, 'cancelled.txt')), { code: 'ENOENT' });
});
test('shell is denied without approval and validates cwd before prompting', async t => {
  let prompts = 0;
  const { execute } = await setup(t, new Permissions('ask', async () => { prompts++; return false; }));
  assert.equal((await execute('shell', { command: 'node --version', cwd: '../', timeout: null })).error, 'WorkspaceViolationError');
  assert.equal(prompts, 0);
  assert.equal((await execute('shell', { command: 'node --version', cwd: null, timeout: null })).error, 'PermissionDeniedError');
  assert.equal(prompts, 1);
});
test('approved platform shell returns output, nonzero exit and bounded output', async t => {
  const { execute, root } = await setup(t, new Permissions('allow'));
  assert.match((await execute('shell', { command: 'node --version', cwd: null, timeout: 10000 })).content, /Exit code: 0\nv24\./);
  await writeFile(path.join(root, 'fail.cjs'), 'process.stdout.write("x".repeat(100000)); process.exitCode = 7;');
  const result = await execute('shell', { command: 'node fail.cjs', cwd: null, timeout: 10000 });
  assert.match(result.content.slice(0, 30), /Exit code: [1-9]/);
  assert.match(result.content, /truncated/);
});
test('shell timeout and cancellation terminate running commands', async t => {
  const { execute, root } = await setup(t, new Permissions('allow'));
  await writeFile(path.join(root, 'wait.cjs'), 'setTimeout(() => {}, 30000);');
  const startedAt = Date.now();
  assert.equal((await execute('shell', { command: 'node wait.cjs', cwd: null, timeout: 100 })).error, 'TimeoutError');
  const controller = new AbortController();
  const run = execute('shell', { command: 'node wait.cjs', cwd: null, timeout: 10000 }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(run, { code: 'CancelledError' });
  assert.ok(Date.now() - startedAt < 10_000, 'shell termination must not wait for the child command timeout');
});
test('shell environment uses an allowlist rather than inheriting credentials or runtime injection', () => {
  assert.deepEqual(shellEnvironment({ PATH: '/bin', HOME: '/home/user', OPENAI_API_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'secret', NODE_OPTIONS: '--require injected', BASH_ENV: '/evil', CUSTOM_PASSWORD: 'secret' }), { PATH: '/bin', HOME: '/home/user' });
});
