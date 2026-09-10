import { open, lstat, mkdir, rename, unlink, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { MarsError, checkAbort } from '../../core/src/index.js';
import type { Tool, ToolCall, ToolContext, ToolExecutor, ToolResult } from '../../core/src/index.js';
import { Permissions, Workspace } from '../../runtime/src/index.js';
import type { ShellExecution, ShellExecutor } from './sandbox.js';

export const OUTPUT_LIMIT = 32_000;
export function truncate(text: string): string {
  return text.length > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) + '\n[output truncated]' : text;
}

export function formatShellExecution(result: ShellExecution): string {
  return `Exit code: ${result.exitCode ?? 'unknown'}\n${result.output}${result.truncated ? '\n[output truncated]' : ''}`;
}

export class ToolRegistry implements ToolExecutor {
  #tools = new Map<string, Tool>();
  constructor(tools: Tool[]) { for (const tool of tools) this.register(tool); }
  register(tool: Tool): void {
    if (!tool.name || this.#tools.has(tool.name)) throw new MarsError('ConfigurationError', `Duplicate tool name: ${tool.name || '(empty)'}.`);
    this.#tools.set(tool.name, tool);
  }
  get(name: string): Tool | undefined { return this.#tools.get(name); }
  schemas() { return [...this.#tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })); }
  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    try {
      checkAbort(signal);
      const tool = this.#tools.get(call.name);
      if (!tool) throw new MarsError('InvalidToolCallError', 'Unknown tool.');
      let input: unknown;
      try { input = tool.validate(call.arguments); }
      catch { throw new MarsError('InvalidToolCallError', 'Arguments do not match the tool schema.'); }
      const content = await tool.execute(input, { signal });
      checkAbort(signal);
      return { content: truncate(content) };
    } catch (error) {
      checkAbort(signal);
      if (error instanceof MarsError) return { content: error.message, error: error.code };
      // Raw OS/provider errors can contain paths, arguments or credentials.
      return { content: 'Tool execution failed.', error: 'ToolExecutionError' };
    }
  }
}

export interface WorkspaceToolOptions { shellExecutor?: ShellExecutor }

function defineTool<S extends z.ZodType>(name: string, description: string, schema: S, execute: (input: z.output<S>, context: ToolContext) => Promise<string>): Tool {
  return { name, description, parameters: z.toJSONSchema(schema), validate: input => schema.parse(input), execute: (input, context) => execute(input as z.output<S>, context) };
}

export function workspaceTools(workspace: Workspace, permissions: Permissions, options: WorkspaceToolOptions = {}): Tool[] {
  const filePath = z.string().min(1).max(4096);
  const shellExecutor = options.shellExecutor ?? executeShell;
  return [
    defineTool('read_file', 'Read a UTF-8 file within the workspace; sensitive files and links are blocked.', z.strictObject({ path: filePath }), async ({ path: input }, { signal }) => {
      const target = await workspace.resolve(input);
      await permissions.check('filesystem.read', target, signal);
      checkAbort(signal);
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink > 1) throw new MarsError('WorkspaceViolationError', 'Only regular, unlinked files are readable.');
        const buffer = Buffer.alloc(OUTPUT_LIMIT + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        checkAbort(signal);
        return truncate(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally { await handle.close(); }
    }),
    defineTool('write_file', 'Create or replace a UTF-8 file in the workspace. Parents are created as needed.', z.strictObject({ path: filePath, content: z.string().max(1_000_000) }), async ({ path: input, content }, { signal }) => {
      const target = await workspace.resolve(input);
      await permissions.check('filesystem.write', target, signal);
      checkAbort(signal);
      await mkdir(path.dirname(target), { recursive: true });
      await workspace.resolve(input);
      const temporary = path.join(path.dirname(target), `.mars-write-${randomUUID()}`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(content, { encoding: 'utf8', signal });
        await handle.close();
        await workspace.resolve(input);
        checkAbort(signal);
        await rename(temporary, target);
        return 'File written.';
      } finally {
        await handle.close();
        await unlink(temporary).catch(() => {});
      }
    }),
    defineTool('shell', 'Run a shell command with the workspace as cwd. Requires approval; host mode is NOT an OS sandbox.', z.strictObject({ command: z.string().min(1).max(16_000), cwd: filePath.nullable(), timeout: z.number().int().min(1).max(120_000).nullable() }), async ({ command, cwd, timeout }, { signal }) => {
      const directory = await workspace.resolve(cwd ?? '.');
      if (!(await lstat(directory)).isDirectory()) throw new MarsError('WorkspaceViolationError', 'Shell cwd must be a directory.');
      await permissions.checkShell(command, directory, signal);
      checkAbort(signal);
      return formatShellExecution(await shellExecutor(command, directory, timeout ?? 30_000, signal));
    }),
    defineTool('search_files', 'Search text in project files without traversing dependencies, build output, VCS metadata or sensitive files.', z.strictObject({ query: z.string().min(1).max(2_000), path: filePath.nullable(), caseSensitive: z.boolean().nullable(), maxResults: z.number().int().min(1).max(200).nullable() }), async ({ query, path: input, caseSensitive, maxResults }, { signal }) => {
      const root = await workspace.resolve(input ?? '.');
      await permissions.check('filesystem.read', root, signal);
      if (!(await lstat(root)).isDirectory()) throw new MarsError('WorkspaceViolationError', 'Search path must be a directory.');
      return searchFiles(root, query, caseSensitive ?? false, maxResults ?? 100, signal, workspace.root);
    }),
    defineTool('git', 'Inspect repository state with read-only Git operations: status, diff, log or branch.', z.strictObject({ action: z.enum(['status', 'diff', 'log', 'branch']), path: filePath.nullable() }), async ({ action, path: input }, { signal }) => {
      const relative = input ?? undefined;
      await permissions.check('filesystem.read', workspace.root, signal);
      if (relative) await workspace.resolve(relative);
      return executeGit(action, relative, workspace.root, signal);
    }),
  ];
}

const SKIP_DIRECTORIES = new Set(['.git', '.hg', '.svn', '.mars', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo']);
const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519))$/i;
const MAX_SEARCH_FILES = 10_000;

async function searchFiles(root: string, query: string, caseSensitive: boolean, maxResults: number, signal: AbortSignal, workspaceRoot: string): Promise<string> {
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const results: string[] = [];
  let visited = 0;
  const walk = async (directory: string): Promise<void> => {
    checkAbort(signal);
    if (results.length >= maxResults || visited >= MAX_SEARCH_FILES) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      checkAbort(signal);
      if (results.length >= maxResults || visited >= MAX_SEARCH_FILES) return;
      if (entry.name === '.' || entry.name === '..' || SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile() || SENSITIVE_NAME.test(entry.name)) continue;
      visited++;
      let content: string;
      try {
        const fileStat = await lstat(full);
        if (!fileStat.isFile() || fileStat.nlink > 1 || fileStat.size > 2_000_000) continue;
        const bytes = await readFile(full);
        if (bytes.includes(0)) continue;
        content = bytes.toString('utf8');
      } catch { continue; }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < maxResults; index++) {
        const line = lines[index]!;
        const haystack = caseSensitive ? line : line.toLocaleLowerCase();
        if (!haystack.includes(needle)) continue;
        const relative = path.relative(workspaceRoot, full).split(path.sep).join('/');
        results.push(`${relative}:${index + 1}: ${line.slice(0, 500)}`);
      }
    }
  };
  await walk(root);
  if (!results.length) return 'No matches.';
  return `${results.join('\n')}${visited >= MAX_SEARCH_FILES ? '\n[search file limit reached]' : ''}${results.length >= maxResults ? '\n[search result limit reached]' : ''}`;
}

async function executeGit(action: 'status' | 'diff' | 'log' | 'branch', relativePath: string | undefined, cwd: string, signal: AbortSignal): Promise<string> {
  const args: string[] = ['--no-pager'];
  if (action === 'status') args.push('status', '--short', '--branch');
  if (action === 'diff') args.push('diff', '--no-ext-diff', '--no-color');
  if (action === 'log') args.push('log', '-8', '--oneline', '--decorate');
  if (action === 'branch') args.push('branch', '--show-current');
  if (relativePath && action === 'diff') args.push('--', relativePath);
  const output = await executeProcess('git', args, cwd, 30_000, signal, true);
  return output;
}

interface VerificationResult { name: string; command: string; exitCode: number | null; passed: boolean; output: string }
export interface VerificationReport { workspace: string; checks: VerificationResult[]; passed: boolean; verified: boolean; reason?: string }
export interface VerificationOptions {
  timeoutMs?: number;
  shellExecutor?: ShellExecutor;
  permissions?: Permissions;
  commands?: readonly string[];
}

/** Run configured commands or known package scripts; every command remains behind the shell permission boundary. */
export async function runProjectChecks(workspace: Workspace, signal: AbortSignal, options: VerificationOptions = {}): Promise<VerificationReport> {
  const configured = options.commands?.filter(command => command.trim()).map(command => command.trim()) ?? [];
  let packageJson: { scripts?: Record<string, unknown>; packageManager?: string };
  const planned: Array<{ name: string; command: string }> = [];
  if (configured.length) configured.forEach((command, index) => planned.push({ name: `configured-${index + 1}`, command }));
  else {
    try { packageJson = JSON.parse(await readFile(path.join(workspace.root, 'package.json'), 'utf8')) as typeof packageJson; }
    catch { return { workspace: workspace.root, checks: [], passed: false, verified: false, reason: 'No verification commands configured and no readable package.json found.' }; }
    const scripts = packageJson.scripts ?? {};
    const names = ['typecheck', 'test', 'lint', 'build'].filter(name => typeof scripts[name] === 'string');
    if (!names.length) return { workspace: workspace.root, checks: [], passed: false, verified: false, reason: 'No configured or standard verification commands found.' };
    const declaredManager = packageJson.packageManager?.split('@')[0];
    const packageManager = declaredManager && ['pnpm', 'npm', 'yarn', 'bun'].includes(declaredManager) ? declaredManager : await detectPackageManager(workspace.root);
    names.forEach(name => planned.push({ name, command: `${packageManager} run ${name}` }));
  }
  const checks: VerificationResult[] = [];
  const timeout = options.timeoutMs ?? 120_000;
  const shellExecutor = options.shellExecutor ?? executeShell;
  for (const { name, command } of planned) {
    checkAbort(signal);
    let output = '';
    let exitCode: number | null = null;
    let passed = false;
    try {
      await options.permissions?.checkShell(command, workspace.root, signal);
      const execution = await shellExecutor(command, workspace.root, timeout, signal);
      exitCode = execution.exitCode;
      output = formatShellExecution(execution);
      passed = exitCode === 0;
    } catch (error) {
      output = error instanceof MarsError ? `${error.code}: ${error.message}` : 'Verification command failed.';
      passed = false;
    }
    checks.push({ name, command, exitCode, passed, output: truncate(output) });
    if (!passed) break;
  }
  const passed = checks.length === planned.length && checks.every(check => check.passed);
  return { workspace: workspace.root, checks, passed, verified: passed && checks.length > 0 };
}

async function detectPackageManager(root: string): Promise<'pnpm' | 'npm' | 'yarn' | 'bun'> {
  for (const [file, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']] as const) {
    try { await stat(path.join(root, file)); return manager; } catch { /* next */ }
  }
  return 'npm';
}

function executeProcess(command: string, args: string[], cwd: string, timeout: number, parent: AbortSignal, includeStderr = false): Promise<string> {
  checkAbort(parent);
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeout)]);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: shellEnvironment(process.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: string) => { const remaining = OUTPUT_LIMIT - output.length; output += chunk.slice(0, remaining); };
    child.stdout.setEncoding('utf8').on('data', collect);
    if (includeStderr) child.stderr.setEncoding('utf8').on('data', collect);
    const stop = () => { if (child.pid) child.kill(); };
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', () => { signal.removeEventListener('abort', stop); reject(new MarsError('ToolExecutionError', `Unable to start ${command}.`)); });
    child.on('close', code => {
      signal.removeEventListener('abort', stop);
      try { checkAbort(signal); } catch (error) { reject(error); return; }
      if (code !== 0) reject(new MarsError('ToolExecutionError', `git exited with code ${code ?? 'unknown'}.\n${output}`));
      else resolve(truncate(output || '(no output)'));
    });
  });
}

export function shellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'appdata', 'localappdata', 'lang', 'lc_all', 'term']);
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toLowerCase())));
}

export async function executeShell(command: string, cwd: string, timeout: number, parent: AbortSignal): Promise<ShellExecution> {
  checkAbort(parent);
  const windows = process.platform === 'win32';
  const executable = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/bash';
  const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command] : ['--noprofile', '--norc', '-c', command];
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeout)]);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: shellEnvironment(process.env), windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let truncated = false;
    let settled = false;
    const collect = (chunk: string) => {
      const remaining = OUTPUT_LIMIT - output.length;
      output += chunk.slice(0, remaining);
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    const stop = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', stop);
      const finish = () => {
        child.stdout.destroy();
        child.stderr.destroy();
        try { checkAbort(signal); }
        catch (error) { reject(error); }
      };
      if (child.pid && windows) {
        const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        const killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        let finished = false;
        const finishOnce = () => { if (!finished) { finished = true; setTimeout(finish, 250); } };
        killer.on('error', () => { child.kill(); finishOnce(); });
        killer.on('close', code => { if (code) child.kill(); finishOnce(); });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        finish();
      } else {
        finish();
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.on('error', () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', stop);
      reject(new MarsError('ToolExecutionError', 'Unable to start the configured platform shell.'));
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', stop);
      try { checkAbort(signal); }
      catch (error) { reject(error); return; }
      resolve({ exitCode: code, output, truncated });
    });
  });
}

export { McpStdioClient, connectMcpTools, type McpConnectResult, type McpStdioServerOptions, type McpToolDefinition } from './mcp.js';
export { createSandboxShell, sandboxStatus, type SandboxMode, type SandboxOptions, type SandboxStatus, type ShellExecution, type ShellExecutor } from './sandbox.js';
