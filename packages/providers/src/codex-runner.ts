import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

/**
 * Minimal runner for the bundled `codex exec --experimental-json` protocol (same events as @openai/codex-sdk).
 * It exists to pass `--ignore-user-config`: the user's config.toml (plugins, MCP servers, notify hooks,
 * profiles) is not loaded, while authentication still lives in CODEX_HOME and stays managed by Codex.
 * With a typical desktop configuration this turns ~4 minute turns into seconds.
 */
export interface CodexThreadOptions {
  model?: string;
  modelReasoningEffort?: string;
  sandboxMode?: string;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  approvalPolicy?: string;
  networkAccessEnabled?: boolean;
  webSearchMode?: string;
  threadSource?: string;
  /** Windows sandbox mode (`windows.sandbox`), needed when shell commands run inside Codex's own sandbox. */
  windowsSandbox?: string;
}
export interface CodexTurnResult { finalResponse: string; usage: { input_tokens: number; output_tokens: number } | null }

const PACKAGES: Record<string, [string, string]> = {
  'linux-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
  'linux-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  'darwin-x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
  'darwin-arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
  'win32-x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
  'win32-arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
};

export function findCodexBinary(): { executable: string; pathDirs: string[] } {
  const target = PACKAGES[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`Unsupported platform for Codex: ${process.platform}-${process.arch}`);
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const codexRequire = createRequire(createRequire(import.meta.url).resolve('@openai/codex/package.json'));
  const root = path.join(path.dirname(codexRequire.resolve(`${target[0]}/package.json`)), 'vendor', target[1]);
  for (const executable of [path.join(root, 'bin', binary), path.join(root, 'codex', binary)]) {
    if (existsSync(executable)) return { executable, pathDirs: [path.join(root, 'codex-path')].filter(existsSync) };
  }
  throw new Error('Unable to locate the bundled Codex CLI binary.');
}

const wait = (promise: Promise<unknown>, ms: number) => Promise.race([promise.then(() => true), new Promise<boolean>(resolve => setTimeout(resolve, ms, false).unref())]);

/** Ends the Codex process and every child it started (sandbox helpers, shells), and waits until it is gone. */
export async function terminate(child: ChildProcess, closed: Promise<unknown>): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    await new Promise<void>(resolve => spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => resolve()).on('close', () => resolve()));
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* not a group leader */ }
  }
  if (await wait(closed, 5_000)) return;
  child.kill('SIGKILL');
  await wait(closed, 2_000);
}

/**
 * `--ignore-user-config` also skips the credential backend chosen in config.toml. Keep that single setting so
 * `exec` reads credentials from the same store as `codex login` (file, keyring or auto).
 */
function credentialStoreOverride(): string[] {
  try {
    const config = readFileSync(path.join(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'config.toml'), 'utf8');
    const store = config.match(/^\s*cli_auth_credentials_store\s*=\s*"(file|keyring|auto|ephemeral)"\s*$/m)?.[1];
    return store ? ['--config', `cli_auth_credentials_store="${store}"`] : [];
  } catch { return []; }
}

export class CodexCliRunner {
  readonly #binary: () => { executable: string; pathDirs: string[] };
  constructor(options: { binary?: () => { executable: string; pathDirs: string[] } } = {}) { this.#binary = options.binary ?? findCodexBinary; }

  startThread(options: CodexThreadOptions): { run(input: string, turn: { outputSchema: unknown; signal: AbortSignal }): Promise<CodexTurnResult> } {
    let threadId: string | undefined;
    return {
      run: async (input, turn) => {
        const schemaDir = await mkdtemp(path.join(tmpdir(), 'mars-codex-schema-'));
        const schemaPath = path.join(schemaDir, 'schema.json');
        try {
          await writeFile(schemaPath, JSON.stringify(turn.outputSchema), 'utf8');
          const args = ['exec', '--experimental-json', '--ignore-user-config', ...credentialStoreOverride()];
          if (options.model) args.push('--model', options.model);
          if (options.threadSource && !threadId) args.push('--thread-source', options.threadSource);
          if (options.sandboxMode) args.push('--sandbox', options.sandboxMode);
          if (options.workingDirectory) args.push('--cd', options.workingDirectory);
          if (options.skipGitRepoCheck) args.push('--skip-git-repo-check');
          args.push('--output-schema', schemaPath);
          if (options.modelReasoningEffort) args.push('--config', `model_reasoning_effort="${options.modelReasoningEffort}"`);
          if (options.networkAccessEnabled !== undefined) args.push('--config', `sandbox_workspace_write.network_access=${options.networkAccessEnabled}`);
          if (options.webSearchMode) args.push('--config', `web_search="${options.webSearchMode}"`);
          if (options.approvalPolicy) args.push('--config', `approval_policy="${options.approvalPolicy}"`);
          if (options.windowsSandbox) args.push('--config', `windows.sandbox="${options.windowsSandbox}"`);
          if (threadId) args.push('resume', threadId);
          const { executable, pathDirs } = this.#binary();
          const env: NodeJS.ProcessEnv = { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? 'codex_sdk_ts' };
          if (pathDirs.length) env.PATH = [...pathDirs, env.PATH ?? env.Path ?? ''].join(path.delimiter);
          return await this.#runTurn(executable, args, env, input, turn.signal, id => { threadId = id; });
        } finally { await rm(schemaDir, { recursive: true, force: true }); }
      },
    };
  }

  #runTurn(executable: string, args: string[], env: NodeJS.ProcessEnv, input: string, signal: AbortSignal, onThread: (id: string) => void): Promise<CodexTurnResult> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Codex turn cancelled.')); return; }
      const child = spawn(executable, args, { env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      const closed = new Promise<number | null>(done => child.once('close', code => done(code)));
      let finalResponse = '';
      let usage: CodexTurnResult['usage'] = null;
      let completed = false;
      let failure: string | undefined;
      let invalid = false;
      let inputError: Error | undefined;
      let cancelled = false;
      let stderr = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve({ finalResponse, usage });
      };
      // Settles only after the process tree is gone, so callers never clean up under a live Codex.
      const abort = () => { cancelled = true; void terminate(child, closed).then(() => finish(new Error('Codex turn cancelled.'))); };
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', error => { if (!cancelled) finish(error); });
      child.stdin!.on('error', error => { inputError = error; });
      child.stderr!.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
      createInterface({ input: child.stdout!, crlfDelay: Infinity }).on('line', line => {
        if (!line.trim()) return;
        let event: { type?: string; thread_id?: string; item?: { type?: string; text?: string }; usage?: { input_tokens: number; output_tokens: number }; error?: { message?: string } };
        try { event = JSON.parse(line); } catch { invalid = true; return; }
        if (event.type === 'thread.started' && event.thread_id) onThread(event.thread_id);
        else if (event.type === 'item.completed' && event.item?.type === 'agent_message') finalResponse = event.item.text ?? '';
        else if (event.type === 'turn.completed') { completed = true; if (event.usage) usage = { input_tokens: event.usage.input_tokens, output_tokens: event.usage.output_tokens }; }
        else if (event.type === 'turn.failed') failure = event.error?.message ?? 'Codex turn failed.';
      });
      void closed.then(code => {
        if (cancelled) return;
        if (failure) finish(new Error(failure));
        else if (invalid) finish(new Error('Codex produced invalid JSONL output.'));
        else if (code !== 0) finish(new Error(`Codex exited with code ${code ?? 'unknown'}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
        else if (inputError) finish(new Error(`Codex closed its input early: ${inputError.message}`));
        else if (!completed) finish(new Error('Codex ended without completing the turn.'));
        else finish();
      });
      child.stdin!.end(input);
    });
  }
}
