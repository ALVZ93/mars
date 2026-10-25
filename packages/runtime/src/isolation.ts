import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MarsError } from '../../core/src/index.js';

export interface IsolatedWorkspace {
  id: string;
  /** Canonical root of the user's workspace; never written by an isolated run. */
  source: string;
  /** Detached worktree directory where tools, shell and checks run. */
  root: string;
  /** Snapshot of the source tree (including uncommitted, non-ignored files) the run started from. */
  base: string;
}

export interface IsolatedRun {
  id: string;
  base: string;
  result?: string;
  root: string;
  exists: boolean;
  createdAt?: string;
}

export interface IsolationOptions {
  /** Link the source `node_modules` into the worktree so checks can run. Default true. */
  linkDependencies?: boolean;
}

export interface IsolatedResult { base: string; result: string; files: string[] }

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEPENDENCY_DIRS = ['node_modules'];
// Never captured from the working tree; tracked entries are restored from the parent commit.
const EXCLUDE = ['.mars', 'node_modules', ':(glob)**/.mars/**', ':(glob)**/node_modules/**'];

interface GitResult { code: number; stdout: string; stderr: string }

function gitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'MARS', GIT_AUTHOR_EMAIL: 'mars@localhost', GIT_COMMITTER_NAME: 'MARS', GIT_COMMITTER_EMAIL: 'mars@localhost', ...extra };
}

/** Runs git without a shell. Hooks, fsmonitor and external diff helpers never run on MARS-owned operations. */
function git(cwd: string, args: string[], options: { env?: Record<string, string>; input?: string; allowFailure?: boolean } = {}): Promise<GitResult> {
  const safeArgs = ['-c', `core.hooksPath=${path.join(cwd, '.mars-no-hooks')}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', ...args];
  return new Promise((resolve, reject) => {
    const child = spawn('git', safeArgs, { cwd, env: gitEnvironment(options.env), windowsHide: true, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', () => reject(new MarsError('ConfigurationError', 'Git is required for isolated runs.')));
    child.on('close', code => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !options.allowFailure) reject(new MarsError('ToolExecutionError', `git ${args[0]} failed: ${stderr.trim().split('\n').at(-1) ?? 'unknown error'}`));
      else resolve(result);
    });
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

function validId(id: string): string {
  if (!RUN_ID.test(id)) throw new MarsError('ConfigurationError', 'Invalid isolated run ID.');
  return id;
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch { return false; }
}

async function repository(source: string): Promise<{ top: string; common: string }> {
  const inside = await git(source, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') throw new MarsError('ConfigurationError', 'Isolated runs require a Git repository.');
  const head = await git(source, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true });
  if (head.code !== 0) throw new MarsError('ConfigurationError', 'Isolated runs require at least one commit.');
  const top = (await git(source, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const common = path.resolve(source, (await git(source, ['rev-parse', '--git-common-dir'])).stdout.trim());
  return { top: path.resolve(top), common };
}

function marsDir(common: string): string { return path.join(common, 'mars'); }
function worktreePath(common: string, id: string): string { return path.join(marsDir(common), 'worktrees', id); }
function ref(id: string, kind: 'base' | 'result'): string { return `refs/mars/runs/${id}/${kind}`; }

async function resolveRef(cwd: string, name: string): Promise<string | undefined> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Commits the current tree of `cwd` on top of `parent` without touching the user's index, stash or branches. */
async function snapshot(cwd: string, common: string, parent: string, message: string): Promise<string> {
  await mkdir(marsDir(common), { recursive: true });
  const index = path.join(marsDir(common), `index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(cwd, ['read-tree', parent], { env });
    await git(cwd, ['add', '-A', '--', '.'], { env });
    await git(cwd, ['reset', '-q', parent, '--', ...EXCLUDE], { env });
    const tree = (await git(cwd, ['write-tree'], { env })).stdout.trim();
    const parentTree = (await git(cwd, ['rev-parse', `${parent}^{tree}`])).stdout.trim();
    if (tree === parentTree) return parent;
    return (await git(cwd, ['commit-tree', tree, '-p', parent, '-m', message])).stdout.trim();
  } finally { await rm(index, { force: true }); }
}

async function linkDependencies(source: string, root: string): Promise<void> {
  for (const name of DEPENDENCY_DIRS) {
    const from = path.join(source, name);
    const to = path.join(root, name);
    try { if (!(await lstat(from)).isDirectory()) continue; } catch { continue; }
    if (await exists(to)) continue;
    await symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

async function unlinkDependencies(root: string): Promise<void> {
  for (const name of DEPENDENCY_DIRS) {
    const target = path.join(root, name);
    try {
      if (!(await lstat(target)).isSymbolicLink()) continue;
      // Remove only the link; never recurse into the user's real dependency directory.
      try { await unlink(target); } catch { await rmdir(target); }
    } catch { /* absent */ }
  }
}

/** Creates (or reopens) the isolated worktree for run `id`. */
export async function openIsolatedWorkspace(source: string, id: string, options: IsolationOptions = {}): Promise<IsolatedWorkspace> {
  validId(id);
  const { top, common } = await repository(source);
  const relative = path.relative(top, path.resolve(source));
  const worktree = worktreePath(common, id);
  let base = await resolveRef(top, ref(id, 'base'));
  if (!base) {
    const head = (await git(top, ['rev-parse', 'HEAD'])).stdout.trim();
    base = await snapshot(top, common, head, `mars: base ${id}`);
    await git(top, ['update-ref', ref(id, 'base'), base]);
  }
  if (!(await exists(worktree))) {
    await mkdir(path.dirname(worktree), { recursive: true });
    await git(top, ['worktree', 'prune']);
    await git(top, ['worktree', 'add', '--detach', worktree, (await resolveRef(top, ref(id, 'result'))) ?? base]);
  }
  const root = path.join(worktree, relative);
  if (options.linkDependencies !== false) await linkDependencies(path.resolve(source), root);
  return { id, source: path.resolve(source), root, base };
}

/** Records the worktree state as `refs/mars/runs/<id>/result`; the diff base..result is only the agent's work. */
export async function captureIsolatedResult(isolated: IsolatedWorkspace): Promise<IsolatedResult> {
  const { common } = await repository(isolated.source);
  const worktree = worktreePath(common, isolated.id);
  const parent = (await resolveRef(worktree, ref(isolated.id, 'result'))) ?? isolated.base;
  const result = await snapshot(worktree, common, parent, `mars: result ${isolated.id}`);
  await git(worktree, ['update-ref', ref(isolated.id, 'result'), result]);
  return { base: isolated.base, result, files: await changedFiles(worktree, isolated.base, result) };
}

async function changedFiles(cwd: string, base: string, result: string): Promise<string[]> {
  if (base === result) return [];
  return (await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', base, result])).stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

export async function isolatedRunExists(source: string, id: string): Promise<boolean> {
  if (!RUN_ID.test(id)) return false;
  try { const { top } = await repository(source); return Boolean(await resolveRef(top, ref(id, 'base'))); }
  catch { return false; }
}

export async function listIsolatedRuns(source: string): Promise<IsolatedRun[]> {
  const { top, common } = await repository(source);
  const output = (await git(top, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)', 'refs/mars/runs/'])).stdout;
  const runs = new Map<string, IsolatedRun>();
  for (const line of output.split('\n').filter(Boolean)) {
    const [name, sha, date] = line.split('\t');
    const match = /^refs\/mars\/runs\/(.+)\/(base|result)$/.exec(name ?? '');
    if (!match || !sha) continue;
    const id = match[1]!;
    const run = runs.get(id) ?? { id, base: '', root: worktreePath(common, id), exists: false };
    if (match[2] === 'base') { run.base = sha; run.createdAt = date; } else run.result = sha;
    runs.set(id, run);
  }
  for (const run of runs.values()) run.exists = await exists(run.root);
  return [...runs.values()].filter(run => run.base).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

async function requireRun(source: string, id: string): Promise<{ top: string; common: string; base: string; result: string }> {
  validId(id);
  const repo = await repository(source);
  const base = await resolveRef(repo.top, ref(id, 'base'));
  if (!base) throw new MarsError('ConfigurationError', `Isolated run not found: ${id}`);
  return { ...repo, base, result: (await resolveRef(repo.top, ref(id, 'result'))) ?? base };
}

export async function isolatedDiff(source: string, id: string, options: { stat?: boolean } = {}): Promise<string> {
  const run = await requireRun(source, id);
  return (await git(run.top, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...(options.stat ? ['--stat'] : ['--binary']), run.base, run.result])).stdout;
}

/** Applies the agent's diff to the user's working tree. Never resets or overwrites on conflict. */
export async function applyIsolatedRun(source: string, id: string, options: { threeWay?: boolean } = {}): Promise<string[]> {
  const run = await requireRun(source, id);
  const files = await changedFiles(run.top, run.base, run.result);
  if (!files.length) return [];
  const patch = (await git(run.top, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--no-color', run.base, run.result])).stdout;
  const mode = options.threeWay ? ['--3way'] : [];
  const check = await git(run.top, ['apply', '--check', ...mode, '-'], { input: patch, allowFailure: true });
  if (check.code !== 0) throw new MarsError('ToolExecutionError', `The run no longer applies cleanly; nothing was changed.${options.threeWay ? '' : ' Retry with --3way to merge with conflict markers.'}\n${check.stderr.trim()}`);
  await git(run.top, ['apply', ...mode, '-'], { input: patch });
  return files;
}

export async function discardIsolatedRun(source: string, id: string): Promise<void> {
  const run = await requireRun(source, id);
  const worktree = worktreePath(run.common, id);
  if (await exists(worktree)) {
    await unlinkDependencies(path.join(worktree, path.relative(run.top, path.resolve(source))));
    await unlinkDependencies(worktree);
    await git(run.top, ['worktree', 'remove', '--force', worktree]);
  }
  await git(run.top, ['update-ref', '-d', ref(id, 'result')], { allowFailure: true });
  await git(run.top, ['update-ref', '-d', ref(id, 'base')]);
}
