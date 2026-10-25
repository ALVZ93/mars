import { createHash } from 'node:crypto';
import { glob, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { MarsError } from '../../core/src/index.js';
import type { Tool } from '../../core/src/index.js';
import type { Workspace } from '../../runtime/src/index.js';

/**
 * Files the implementation must not change: configured `contract.protect` globs plus the tests declared
 * by a reproduction phase. Writes through MARS tools are denied; changes by any other means (shell, MCP)
 * are detected by hash before each verification.
 */
export class TaskContract {
  readonly #workspace: Workspace;
  readonly #patterns: readonly string[];
  #baseline = new Map<string, string>();

  constructor(workspace: Workspace, patterns: readonly string[] = []) {
    this.#workspace = workspace;
    this.#patterns = patterns;
  }

  get files(): string[] { return [...this.#baseline.keys()].sort(); }

  /** Hashes every existing protected file plus `extra` (workspace-relative paths). */
  async seal(extra: readonly string[] = []): Promise<void> {
    const files = new Set(extra.map(normalize));
    for (const pattern of this.#patterns) {
      for await (const entry of glob(pattern, { cwd: this.#workspace.root, exclude: name => ['node_modules', '.git', '.mars'].includes(path.basename(name)) })) files.add(normalize(entry));
    }
    const baseline = new Map<string, string>();
    for (const file of files) {
      const hash = await this.#hash(file);
      if (hash !== 'missing') baseline.set(file, hash);
    }
    this.#baseline = baseline;
  }

  /** True for workspace paths that the implementation must not write. */
  protects(absolute: string): boolean {
    return this.#baseline.has(normalize(path.relative(this.#workspace.root, absolute)));
  }

  /** Protected files whose content changed or that disappeared since `seal`. */
  async modified(): Promise<string[]> {
    const changed: string[] = [];
    for (const [file, hash] of this.#baseline) if ((await this.#hash(file)) !== hash) changed.push(file);
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

function normalize(file: string): string { return file.split(path.sep).join('/').replace(/^\.\//, ''); }

export interface ReproductionDeclaration { command: string; files: string[] }

/** Tool offered only during a reproduction phase; the agent declares how to run its failing test. */
export function reproductionTool(onDeclare: (value: ReproductionDeclaration) => void): Tool {
  const schema = z.strictObject({
    command: z.string().min(1).max(4_096).describe('Exact shell command that runs only the new failing test, from the workspace root.'),
    files: z.array(z.string().min(1).max(4_096)).min(1).max(16).describe('Workspace-relative test files written for the reproduction.'),
  });
  return {
    name: 'declare_reproduction',
    description: 'Declare the failing test that reproduces the bug. MARS runs it, requires it to fail now and to pass after the fix, and protects the listed files.',
    parameters: z.toJSONSchema(schema),
    validate: input => schema.parse(input),
    async execute(input) {
      const value = input as ReproductionDeclaration;
      onDeclare({ command: value.command.trim(), files: value.files.map(normalize) });
      return 'Reproduction declared. Stop now; MARS will run it and expects it to fail before the fix.';
    },
  };
}
