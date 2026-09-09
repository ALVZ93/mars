import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { ForgeError, checkAbort } from '../../core/src/index.js';
import { executeShell } from './index.js';

export type SandboxMode = 'host' | 'docker';
export interface SandboxOptions {
  mode?: SandboxMode;
  image?: string;
  network?: 'none' | 'host';
  memoryMb?: number;
  cpus?: number;
}
export interface SandboxStatus {
  mode: SandboxMode;
  available: boolean;
  isolated: boolean;
  message: string;
}
export interface ShellExecution {
  exitCode: number | null;
  output: string;
  truncated: boolean;
}
export type ShellExecutor = (command: string, cwd: string, timeout: number, signal: AbortSignal) => Promise<ShellExecution>;

const DEFAULT_IMAGE = 'node:24-bookworm';

export function sandboxStatus(options: SandboxOptions = {}): SandboxStatus {
  const mode = options.mode ?? 'host';
  if (mode === 'host') return { mode, available: true, isolated: false, message: 'Host process; no OS isolation.' };
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', windowsHide: true, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (docker.status === 0 && docker.stdout.trim()) return { mode, available: true, isolated: true, message: `Docker ${docker.stdout.trim()}; network ${options.network ?? 'none'}.` };
  if (docker.error && (docker.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return { mode, available: false, isolated: false, message: 'Docker CLI is not installed or is not on PATH.' };
  }
  return { mode, available: false, isolated: false, message: 'Docker CLI is installed, but the Docker Engine is unavailable. Start Docker Desktop before using --sandbox docker.' };
}

export function createSandboxShell(workspaceRoot: string, options: SandboxOptions = {}): ShellExecutor {
  const mode = options.mode ?? 'host';
  if (mode === 'host') return executeShell;
  if (mode !== 'docker') throw new ForgeError('ConfigurationError', 'Sandbox mode must be host or docker.');
  const image = options.image?.trim() || DEFAULT_IMAGE;
  const network = options.network ?? 'none';
  if (network !== 'none' && network !== 'host') throw new ForgeError('ConfigurationError', 'Sandbox network must be none or host.');
  const memoryMb = options.memoryMb ?? 2048;
  if (!Number.isSafeInteger(memoryMb) || memoryMb < 128 || memoryMb > 65_536) throw new ForgeError('ConfigurationError', 'Sandbox memory must be an integer from 128 to 65536 MB.');
  const cpus = options.cpus ?? 2;
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 64) throw new ForgeError('ConfigurationError', 'Sandbox CPUs must be greater than 0 and at most 64.');
  return (command, cwd, timeout, signal) => executeDockerShell(workspaceRoot, command, cwd, timeout, signal, { image, network, memoryMb, cpus });
}

async function executeDockerShell(workspaceRoot: string, command: string, cwd: string, timeout: number, parent: AbortSignal, options: { image: string; network: 'none' | 'host'; memoryMb: number; cpus: number }): Promise<ShellExecution> {
  checkAbort(parent);
  const relative = path.relative(workspaceRoot, cwd);
  if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) throw new ForgeError('WorkspaceViolationError', 'Sandbox cwd must be inside the workspace.');
  const containerCwd = `/workspace${relative ? `/${relative.split(path.sep).join('/')}` : ''}`;
  const args = [
    'run', '--rm', '--init', '--network', options.network,
    '--memory', `${options.memoryMb}m`, '--cpus', String(options.cpus),
    '--mount', `type=bind,src=${workspaceRoot},dst=/workspace`,
    '--workdir', containerCwd, options.image, '/bin/sh', '-lc', command,
  ];
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeout)]);
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let truncated = false;
    const collect = (chunk: string) => {
      const remaining = 32_000 - output.length;
      output += chunk.slice(0, Math.max(0, remaining));
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    const stop = () => { if (child.pid) child.kill(); };
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', error => {
      signal.removeEventListener('abort', stop);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(new ForgeError('ConfigurationError', 'Docker is not installed or is not on PATH.'));
      else reject(new ForgeError('ToolExecutionError', 'Unable to start Docker sandbox.'));
    });
    child.on('close', code => {
      signal.removeEventListener('abort', stop);
      try { checkAbort(signal); } catch (error) { reject(error); return; }
      resolve({ exitCode: code, output, truncated });
    });
  });
}
