import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { CodexCliRunner, terminate } from './codex-runner.js';

/**
 * A vendor agent CLI (Claude Code, Codex) used as the hands of a MARS workflow: it reads, edits and runs commands
 * in its own sandbox, while MARS checks the result between turns. A session keeps the conversation across turns.
 */
export interface AgentEngine {
  readonly id: string;
  readonly model: string;
  session(cwd: string, options?: EngineSessionOptions): EngineSession;
}
export interface EngineSessionOptions {
  /** No file edits: enforced by the engine's own tools or sandbox. MARS also checks the tree afterwards. */
  readOnly?: boolean;
}
export interface EngineSession {
  /** One turn that ends in JSON matching `schema`; later turns resume the same conversation. */
  turn(prompt: string, schema: Record<string, unknown>, signal: AbortSignal): Promise<{ output: unknown; usage?: { inputTokens: number; outputTokens: number } }>;
}

export interface ClaudeEngineOptions {
  model?: string;
  effort?: string;
  /** Command prefixes the engine may run through its shell, e.g. `npm`, `node`. */
  commands?: readonly string[];
  executable?: string;
  /** Environment checked for ANTHROPIC_API_KEY (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * Developer-only, for local evaluation: run Claude Code with its own login instead of `--bare` + API key.
   * Not a product mode; MARS enables it only with MARS_EVAL_CLAUDE_LOGIN=1.
   */
  localLogin?: boolean;
}

/**
 * Claude Code `claude -p --bare`, authenticated only with ANTHROPIC_API_KEY. `--bare` never reads the claude.ai
 * login: Anthropic does not allow third-party tools to run on Claude subscription credentials. It also skips the
 * user's CLAUDE.md, hooks, plugins and MCP servers. Edits are accepted and the shell is limited to `commands`.
 */
export function claudeEngine(options: ClaudeEngineOptions = {}): AgentEngine {
  const model = options.model ?? 'sonnet';
  // Low effort by default, like the MARS Codex provider: the proof, not long deliberation, carries the result.
  const effort = options.effort ?? 'low';
  const commands = options.commands ?? ['npm', 'node'];
  return {
    id: 'claude-code', model,
    session(cwd, sessionOptions = {}) {
      if (!options.localLogin && !(options.env ?? process.env).ANTHROPIC_API_KEY) throw new Error('--engine claude needs ANTHROPIC_API_KEY: MARS runs Claude Code only with an Anthropic API key, never with a Claude subscription login.');
      const id = randomUUID();
      let started = false;
      return {
        async turn(prompt, schema, signal) {
          const usage = { inputTokens: 0, outputTokens: 0 };
          // The model sometimes ends a turn in plain text without calling StructuredOutput; ask again in the same session.
          for (let attempt = 0; ; attempt++) {
            const args = ['-p', ...(options.localLogin ? [] : ['--bare']), '--output-format', 'stream-json', '--verbose', '--model', model, '--effort', effort,
              '--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands', '--permission-mode', 'acceptEdits',
              '--allowedTools', 'Read', ...(sessionOptions.readOnly ? [] : ['Edit', 'Write']), 'Glob', 'Grep', ...commands.map(command => `Bash(${command}:*)`),
              '--json-schema', JSON.stringify(schema), ...(started ? ['--resume', id] : ['--session-id', id])];
            const input = attempt ? 'You ended without the structured output. Do not repeat the work: answer now with the structured output only.' : prompt;
            const stdout = await run(options.executable ?? 'claude', args, cwd, input, signal, 'Claude Code');
            started = true;
            await trace(id, stdout);
            let result: { is_error?: boolean; subtype?: string; result?: string; structured_output?: unknown; usage?: Record<string, number> } | undefined;
            for (const line of stdout.split('\n')) {
              try { const event = JSON.parse(line); if (event.type === 'result') result = event; } catch { /* not an event */ }
            }
            if (!result) throw new Error(`Claude Code ended without a result: ${stdout.slice(-300)}`);
            if (result.is_error || result.subtype !== 'success') throw new Error(`Claude Code turn failed (${result.subtype ?? 'unknown'}): ${String(result.result ?? '').slice(0, 300)}`);
            if (result.usage) {
              usage.inputTokens += (result.usage.input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0) + (result.usage.cache_read_input_tokens ?? 0);
              usage.outputTokens += result.usage.output_tokens ?? 0;
            }
            if (result.structured_output !== undefined) return { output: result.structured_output, usage };
            if (attempt >= 2) throw new Error('Claude Code ended without structured output.');
          }
        },
      };
    },
  };
}

export interface CodexEngineOptions { model?: string; effort?: string; runner?: CodexCliRunner }

/** `codex exec` in its workspace-write sandbox without network, approvals off, user config ignored. */
export function codexEngine(options: CodexEngineOptions = {}): AgentEngine {
  const model = options.model ?? 'gpt-5.6-sol';
  const effort = options.effort ?? 'low';
  const runner = options.runner ?? new CodexCliRunner();
  return {
    id: 'codex-cli', model,
    session(cwd, sessionOptions = {}) {
      const thread = runner.startThread({ model, workingDirectory: cwd, sandboxMode: sessionOptions.readOnly ? 'read-only' : 'workspace-write', approvalPolicy: 'never', skipGitRepoCheck: true, networkAccessEnabled: false,
        modelReasoningEffort: effort,
        // --ignore-user-config drops the user's Windows sandbox mode; the default one rejects every command.
        ...(process.platform === 'win32' ? { windowsSandbox: 'elevated' } : {}) });
      return {
        async turn(prompt, schema, signal) {
          const result = await thread.run(prompt, { outputSchema: schema, signal });
          await trace('codex', result.finalResponse);
          let output: unknown;
          try { output = JSON.parse(result.finalResponse); } catch { throw new Error(`Codex returned a final message that is not JSON: ${result.finalResponse.slice(0, 300)}`); }
          return { output, ...(result.usage ? { usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } } : {}) };
        },
      };
    },
  };
}

/** With MARS_ENGINE_TRACE set to a file, appends each turn's raw engine output to it (debugging only). */
async function trace(session: string, output: string): Promise<void> {
  const file = process.env.MARS_ENGINE_TRACE;
  if (file) await appendFile(file, `${JSON.stringify({ session, at: new Date().toISOString() })}\n${output}\n`).catch(() => {});
}

function run(executable: string, args: string[], cwd: string, input: string, signal: AbortSignal, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error(`${name} turn cancelled.`)); return; }
    const child = spawn(executable, args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise<number | null>(done => child.once('close', code => done(code)));
    let stdout = '';
    let stderr = '';
    let cancelled = false;
    const abort = () => { cancelled = true; void terminate(child, closed).then(() => reject(new Error(`${name} turn cancelled.`))); };
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', error => { signal.removeEventListener('abort', abort); if (!cancelled) reject(error); });
    child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
    child.stdin!.on('error', () => { /* reported through the exit code */ });
    void closed.then(code => {
      signal.removeEventListener('abort', abort);
      if (cancelled) return;
      // Claude Code reports failed turns as JSON on stdout with a non-zero exit; let the caller read it.
      if (code !== 0 && !stdout.trim()) reject(new Error(`${name} exited with code ${code ?? 'unknown'}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
      else resolve(stdout);
    });
    child.stdin!.end(input);
  });
}
