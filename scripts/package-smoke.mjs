import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const root = await mkdtemp(path.join(tmpdir(), 'mars-package-smoke-'));

async function run(command, args, cwd) {
  const windowsCommand = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd');
  const executable = windowsCommand ? process.env.ComSpec ?? 'cmd.exe' : command;
  const commandArgs = windowsCommand ? ['/d', '/s', '/c', command, ...args] : args;
  return exec(executable, commandArgs, { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
}

try {
  const packed = await run(npm, ['pack', '--json', '--pack-destination', root], projectRoot);
  const manifest = JSON.parse(packed.stdout);
  assert.equal(manifest.length, 1);
  const tarball = path.join(root, manifest[0].filename);

  const consumer = path.join(root, 'consumer');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), '{"name":"mars-package-smoke","private":true,"type":"module"}\n');
  await run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer);

  const localBin = path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'mars.cmd' : 'mars');
  assert.equal((await run(localBin, ['--version'], consumer)).stdout.trim(), '0.1.0');
  assert.equal((await run(npx, ['--no-install', 'mars', '--version'], consumer)).stdout.trim(), '0.1.0');

  const sdkSmoke = path.join(consumer, 'sdk-smoke.mjs');
  await writeFile(sdkSmoke, "import { createForge, FakeProvider, keychainAvailable } from '@alvz/mars';\nif (typeof createForge !== 'function' || typeof FakeProvider !== 'function' || !keychainAvailable()) process.exit(1);\n");
  await run(process.execPath, [sdkSmoke], consumer);

  const globalRoot = path.join(root, 'global');
  await run(npm, ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', globalRoot, tarball], consumer);
  const globalBin = process.platform === 'win32' ? path.join(globalRoot, 'mars.cmd') : path.join(globalRoot, 'bin', 'mars');
  assert.equal((await run(globalBin, ['--version'], consumer)).stdout.trim(), '0.1.0');
  assert.match((await run(pnpm, ['dlx', tarball, '--version'], consumer)).stdout, /0\.1\.0/);

  console.log(`Package smoke passed on ${process.platform}/${process.arch}.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
