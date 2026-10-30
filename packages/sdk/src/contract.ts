import { createHash } from 'node:crypto';
import { glob, lstat, readFile, readdir } from 'node:fs/promises';
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

const INTERPRETERS = /^(node|nodejs|deno|bun|python[\d.]*|py|ruby|perl|php|sh|bash|zsh|dash|pwsh|powershell)(\.exe)?$/i;
const INLINE_FLAGS = /^(-e|--eval|-p|--print|-c|--command|-command|-encodedcommand)(=.*)?$/i;
/** True when the command runs inline code (`node -e`, `python -c`, `sh -c`…) instead of a test file. */
export function runsInlineCode(command: string): boolean {
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  const interpreter = path.basename(tokens[0]?.replace(/^["']|["']$/g, '') ?? '');
  return INTERPRETERS.test(interpreter) && tokens.slice(1).some(token => INLINE_FLAGS.test(token));
}

/** Conventional test locations and names across ecosystems (tests/, __tests__/, *.test.*, *_test.go, test_*.py…). */
export function isTestPath(file: string): boolean {
  const value = normalize(file);
  return /(^|\/)(tests?|__tests__|specs?)\//i.test(value) || /[._-](test|spec)s?\.[^/.]+$/i.test(value) || /(^|\/)test_[^/]+\.py$/i.test(value);
}

/** Output with timings and counters removed, to compare two runs of the same command. */
export function outputShape(output: string): string {
  return output.replace(/\d+(?:[.,]\d+)?\s*(?:ms|s|sec|seconds)\b/gi, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * `reported`, `covers` and `cases` state what the reproduction asserts: the proof is only as wide as these cases.
 * `reported` ties the test to the report's own example, so a reviewer sees when a test proves a different bug.
 */
export interface ReproductionDeclaration { command: string; files: string[]; reported: string; covers: string; cases: string[] }

export interface OutdatedTestDeclaration { command: string; files: string[]; reason: string }

const OUTDATED_SCHEMA = z.strictObject({
  command: z.string().min(1).max(4_096).describe('Exact shell command that runs only the edited test file(s), from the workspace root.'),
  files: z.array(z.string().min(1).max(4_096)).min(1).max(16).describe('Existing test files edited in this phase to the correct expectation.'),
  reason: z.string().min(1).max(120).describe('Why the original expectation is outdated, in one sentence, citing the source of truth (report, docs, spec).'),
});
const REPRODUCTION_SCHEMA = z.strictObject({
  command: z.string().min(1).max(4_096).describe('Exact shell command that runs only the new failing test, from the workspace root. It must name the test file(s).'),
  files: z.array(z.string().min(1).max(4_096)).min(1).max(16).describe('Workspace-relative test files written for the reproduction.'),
  reported: z.string().min(1).max(200).describe("The report's own example as the test asserts it, in one line: the input from the report and the expected result instead of the wrong one it describes. If no test case can reproduce it, the diagnosis is wrong: keep inspecting."),
  covers: z.string().min(1).max(120).describe('The required behavior the test asserts, in one sentence: the rule or spec from the report, not only the reported example.'),
  cases: z.array(z.string().min(1).max(200)).min(1).max(24).describe('Each case the test asserts, one short line each (input and expected result).'),
});
const line = (value: string) => value.replace(/\s+/g, ' ').trim();
const reproductionDeclaration = (value: ReproductionDeclaration): ReproductionDeclaration => ({ command: value.command.trim(), files: value.files.map(normalize), reported: line(value.reported), covers: line(value.covers), cases: value.cases.map(line) });
const outdatedDeclaration = (value: OutdatedTestDeclaration): OutdatedTestDeclaration => ({ command: value.command.trim(), files: value.files.map(normalize), reason: line(value.reason) });

/**
 * Structured answer of an external engine's reproduction turn. One flat shape (unused fields empty) so that every
 * vendor's structured-output mode accepts it.
 */
export const ENGINE_DECLARATION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['kind', 'command', 'files', 'reported', 'covers', 'cases', 'reason'],
  properties: {
    kind: { type: 'string', enum: ['reproduction', 'outdated'] },
    command: { type: 'string', description: 'Exact shell command that runs only the test file(s), from the workspace root.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative test files written or edited.' },
    reported: { type: 'string', description: "reproduction: The report's own example as the test asserts it, in one line: the input from the report and the expected result instead of the wrong one it describes. If no test case can reproduce it, the diagnosis is wrong: keep inspecting. At most 200 characters. Otherwise empty." },
    covers: { type: 'string', description: 'reproduction: the required behavior the test asserts, in one sentence of at most 120 characters. Otherwise empty.' },
    cases: { type: 'array', items: { type: 'string' }, description: 'reproduction: each case the test asserts (at most 24), one line of at most 200 characters each. Otherwise empty.' },
    reason: { type: 'string', description: 'outdated: why the original expectation is outdated, in one sentence of at most 120 characters. Otherwise empty.' },
  },
};

/** Validates an engine declaration with the same limits as the declare_* tools. */
export function engineDeclaration(output: unknown): { reproduction: ReproductionDeclaration } | { outdated: OutdatedTestDeclaration } {
  const value = z.object({ kind: z.enum(['reproduction', 'outdated']) }).passthrough().safeParse(output);
  if (!value.success) throw new MarsError('ToolExecutionError', 'The engine did not declare a reproduction or an outdated test.');
  const { kind, ...rest } = value.data as { kind: string } & Record<string, unknown>;
  // Descriptive text is trimmed rather than rejected: a long sentence does not make the declaration wrong.
  const clip = (value: unknown, max: number) => typeof value === 'string' && value.length > max ? `${value.slice(0, max - 1)}…` : value;
  rest.covers = clip(rest.covers, 120); rest.reason = clip(rest.reason, 120); rest.reported = clip(rest.reported, 200);
  if (Array.isArray(rest.cases)) rest.cases = rest.cases.slice(0, 24).map(item => clip(item, 200));
  const pick = (keys: string[]) => Object.fromEntries(keys.map(name => [name, rest[name]]));
  const parsed = kind === 'reproduction' ? REPRODUCTION_SCHEMA.safeParse(pick(['command', 'files', 'reported', 'covers', 'cases'])) : OUTDATED_SCHEMA.safeParse(pick(['command', 'files', 'reason']));
  if (!parsed.success) throw new MarsError('ToolExecutionError', `The engine's ${kind} declaration is invalid: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}.`);
  return kind === 'reproduction' ? { reproduction: reproductionDeclaration(parsed.data as ReproductionDeclaration) } : { outdated: outdatedDeclaration(parsed.data as OutdatedTestDeclaration) };
}

const SKIPPED_DIRS = new Set(['.git', '.mars', 'node_modules']);
/** Hash of every workspace file outside dependencies and MARS data, plus the contents of test files. */
export async function snapshotTree(root: string): Promise<Map<string, { hash: string; data?: Buffer }>> {
  const files = new Map<string, { hash: string; data?: Buffer }>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIPPED_DIRS.has(entry.name)) await walk(absolute); continue; }
      if (!entry.isFile()) continue;
      const data = await readFile(absolute);
      const relative = normalize(path.relative(root, absolute));
      files.set(relative, { hash: createHash('sha256').update(data).digest('hex'), ...(isTestPath(relative) ? { data } : {}) });
    }
  };
  await walk(root);
  return files;
}

/**
 * Tool offered with declare_reproduction: the agent claims that an existing test encodes an outdated expectation
 * and that the code is right. MARS checks it (original fails, edited passes) and reports it for human review.
 */
export function outdatedTestTool(onDeclare: (value: OutdatedTestDeclaration) => void): Tool {
  const schema = OUTDATED_SCHEMA;
  return {
    name: 'declare_outdated_test',
    description: 'Use instead of declare_reproduction only when the code is right and an existing test is wrong: edit that test to the correct expectation first. MARS requires the original test to fail and the edited one to pass on the unchanged code, skips the fix, and reports a test change that needs human review.',
    parameters: z.toJSONSchema(schema),
    validate: input => schema.parse(input),
    async execute(input) {
      onDeclare(outdatedDeclaration(input as OutdatedTestDeclaration));
      return 'Outdated test declared. Do not call more tools: reply with one short sentence. MARS runs the original and the edited test next.';
    },
  };
}

/** Tool offered only during a reproduction phase; the agent declares how to run its failing test. */
export function reproductionTool(onDeclare: (value: ReproductionDeclaration) => void): Tool {
  const schema = REPRODUCTION_SCHEMA;
  return {
    name: 'declare_reproduction',
    description: 'Declare the failing test that reproduces the bug and the cases it asserts; the receipt states that only these cases are proven. MARS runs it, requires it to fail on an assertion now and to pass after the fix, and protects the listed files and any file named in the command.',
    parameters: z.toJSONSchema(schema),
    validate: input => schema.parse(input),
    async execute(input) {
      onDeclare(reproductionDeclaration(input as ReproductionDeclaration));
      return 'Reproduction declared. Do not call more tools: reply with one short sentence describing the failing test. MARS runs it next and expects it to fail before the fix.';
    },
  };
}

/** Structured answer of a cross-review turn (ADR 010). Every field is required so strict output schemas accept it. */
export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes'], description: 'approve when you found no concrete problem.' },
    findings: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['file', 'problem', 'fix'], properties: {
      file: { type: 'string', description: 'Workspace-relative path, or empty for a general finding.' },
      problem: { type: 'string', description: 'The concrete bug or broken documented rule, with an input that shows it.' },
      fix: { type: 'string', description: 'What the code should do instead.' },
    } } },
  },
} as const;

/** Validates and clips a review answer. `changes` without findings leaves nothing to act on, so it counts as approval. */
export function reviewOutput(output: unknown): { verdict: 'approve' | 'changes'; findings: Array<{ file: string; problem: string; fix: string }> } {
  const value = output as { verdict?: unknown; findings?: unknown } | null;
  if (!value || (value.verdict !== 'approve' && value.verdict !== 'changes') || !Array.isArray(value.findings)) throw new MarsError('ToolExecutionError', 'The reviewer did not return a valid review (verdict and findings).');
  const clip = (item: unknown, max: number) => typeof item === 'string' ? item.slice(0, max) : '';
  const findings = value.findings.slice(0, 20).map(item => {
    const finding = (item ?? {}) as Record<string, unknown>;
    return { file: clip(finding.file, 300), problem: clip(finding.problem, 1_000), fix: clip(finding.fix, 1_000) };
  }).filter(finding => finding.problem.trim());
  return { verdict: value.verdict === 'changes' && findings.length ? 'changes' : 'approve', findings };
}
