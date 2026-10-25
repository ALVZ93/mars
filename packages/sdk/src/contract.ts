import { createHash } from 'node:crypto';
import { glob, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { MarsError } from '../../core/src/index.js';
import type { Tool } from '../../core/src/index.js';
import type { Workspace } from '../../runtime/src/index.js';

// Windows and macOS default to case-insensitive filesystems: `TEST.MJS` must not bypass `test.mjs`.
const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
function normalize(file: string): string { return file.split(path.sep).join('/').replace(/^\.\//, ''); }
function key(file: string): string { const value = normalize(file); return caseInsensitive ? value.toLowerCase() : value; }

/**
 * Files the implementation must not change: configured `contract.protect` globs plus the tests and runner
 * files of a reproduction. Writes through MARS tools are denied; changes by any other means (shell, MCP,
 * checks) are detected by hash before and after each verification. Transient changes that are restored
 * before the next comparison are not detectable.
 */
export class TaskContract {
  readonly #workspace: Workspace;
  readonly #patterns: readonly string[];
  readonly #baseline = new Map<string, { file: string; hash: string }>();

  constructor(workspace: Workspace, patterns: readonly string[] = []) {
    this.#workspace = workspace;
    this.#patterns = patterns;
  }

  get files(): string[] { return [...this.#baseline.values()].map(entry => entry.file).sort(); }

  /** Hashes every existing file matching the configured globs. Call once, before any phase can write. */
  async seal(): Promise<void> {
    const files: string[] = [];
    for (const pattern of this.#patterns) {
      for await (const entry of glob(pattern, { cwd: this.#workspace.root, exclude: name => ['node_modules', '.git', '.mars'].includes(path.basename(name)) })) files.push(entry);
    }
    await this.add(files);
  }

  /** Adds files to the contract, keeping the original hash of anything already protected. */
  async add(files: readonly string[]): Promise<void> {
    for (const file of files) {
      if (this.#baseline.has(key(file))) continue;
      const hash = await this.#hash(file);
      if (hash !== 'missing') this.#baseline.set(key(file), { file: normalize(file), hash });
    }
  }

  /** True for workspace paths that the implementation must not write. */
  protects(absolute: string): boolean {
    return this.#baseline.has(key(path.relative(this.#workspace.root, absolute)));
  }

  /** Protected files whose content changed or that disappeared since they were added. */
  async modified(): Promise<string[]> {
    const changed: string[] = [];
    for (const { file, hash } of this.#baseline.values()) if ((await this.#hash(file)) !== hash) changed.push(file);
    return changed;
  }

  async #hash(file: string): Promise<string> {
    try {
      const target = await this.#workspace.resolve(file);
      return createHash('sha256').update(await readFile(target)).digest('hex');
    } catch (error) {
      if (error instanceof MarsError) throw error;
      return 'missing';
    }
  }
}

/** Command arguments that name existing workspace files (the test, its runner or config). */
export async function commandFiles(workspace: Workspace, command: string): Promise<string[]> {
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  const files: string[] = [];
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, '').replace(/^--?[\w-]+=/, '');
    if (!token || token.startsWith('-') || token.length > 4_096) continue;
    try {
      const target = await workspace.resolve(token);
      if ((await lstat(target)).isFile()) files.push(normalize(path.relative(workspace.root, target)));
    } catch { /* not a workspace file */ }
  }
  return files;
}

/** True when two workspace-relative paths name the same file on this platform. */
export function samePath(a: string, b: string): boolean { return key(a) === key(b); }

// Signatures of a test that never reached its assertions: load, syntax, missing module or missing command.
const UNRELATED_FAILURE = /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|ModuleNotFoundError|ImportError|is not recognized as (?:an internal|the name)|command not found|No such file or directory|error TS\d{4}/i;
/** Heuristic only: rejects reproductions that fail for reasons unrelated to behavior. */
export function unrelatedFailure(exitCode: number | null, output: string): boolean {
  return exitCode === 127 || exitCode === 9009 || UNRELATED_FAILURE.test(output);
}

export interface ReproductionDeclaration { command: string; files: string[] }

/** Tool offered only during a reproduction phase; the agent declares how to run its failing test. */
export function reproductionTool(onDeclare: (value: ReproductionDeclaration) => void): Tool {
  const schema = z.strictObject({
    command: z.string().min(1).max(4_096).describe('Exact shell command that runs only the new failing test, from the workspace root. It must name the test file(s).'),
    files: z.array(z.string().min(1).max(4_096)).min(1).max(16).describe('Workspace-relative test files written for the reproduction.'),
  });
  return {
    name: 'declare_reproduction',
    description: 'Declare the failing test that reproduces the bug. MARS runs it, requires it to fail on an assertion now and to pass after the fix, and protects the listed files and any file named in the command.',
    parameters: z.toJSONSchema(schema),
    validate: input => schema.parse(input),
    async execute(input) {
      const value = input as ReproductionDeclaration;
      onDeclare({ command: value.command.trim(), files: value.files.map(normalize) });
      return 'Reproduction declared. Stop now; MARS will run it and expects it to fail before the fix.';
    },
  };
}
