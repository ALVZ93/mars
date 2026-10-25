import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { MarsError, Workspace } from '../../../../packages/sdk/src/internal.js';
import { validTarget } from '../terminal.js';
export const help = `MARS 0.1 — provider-independent agent harness (daily-driver runtime)

mars                                  Start an interactive session in the current folder
mars "task"                           Run a task in the current folder
mars run "task"                      Run a task
mars resume SESSION_ID                Resume a persisted session
mars new                              Start a new interactive session
mars sessions                         List persisted sessions
mars check                            Run project verification scripts
mars models                           List known models and auth state
mars route "task"                    Explain deterministic model routing
mars workflows                        List built-in workflows
mars doctor                           Diagnose local configuration
  mars init                             Create .mars/config.json
  mars config [show|path|set KEY VALUE] Read or update configuration
mars skills                           List project and user skills
mars memory                           List reviewed notes and pending proposals
mars memory add NAME CONTENT          Propose a project note for review
mars memory show|approve|reject|forget ID  Review or remove a memory entry
mars skills pending|show|approve|reject|forget [ID]  Review procedure drafts
mars learn SESSION_ID                 Capture a local procedure draft from verified work (no model calls)
mars evidence                         Show local skill/workflow evidence
mars health                           Show last-known provider health
mars logout PROVIDER                   Disconnect a provider
mars runs [list|diff|apply|discard ID] Review and apply isolated runs (--stat)

Authentication:
  mars login openai --api-key
  mars login anthropic --api-key
  mars login kimi-code --api-key
  mars login gemini --browser
  mars login openrouter --api-key
  mars auth providers
  mars auth status
  mars auth logout PROVIDER
  mars auth migrate                    Move file credentials to the native keychain
  MARS_CREDENTIAL_STORE=auto|keychain|file

Options:
  --model       Explicit provider:model, or MARS_MODEL
  --workspace   Workspace root (default: current directory)
  --allow-shell Allow host shell for this process
  --script      JSON assistant-message script for fake:scripted
  --max-turns   Agent turn limit (default: 24)
  --max-tool-calls Tool call limit (default: 64)
  --timeout     Total run timeout in milliseconds
  --max-retries Retry transient provider failures (default: 0; opt in to avoid duplicate billing)
  --retry-delay Initial retry delay in milliseconds (default: 500)
  --sandbox     Shell mode: host (default) or docker
  --route       Enable deterministic role-based model routing
  --workflow    Run a workflow (bugfix, feature or review)
  --repair-attempts Repair failing workflow checks (0 to 3; default: 0)
  --report      Export run/check reports as JSON to a new workspace file
  --receipt     Export a Markdown receipt (proof, contract, checks, changes) to a new workspace file
  --verify      Run standard project checks after the agent finishes
  --isolate     Work in a disposable Git worktree; apply the diff later with mars runs apply
  --budget-time Total milliseconds for the whole task, shared by all phases and repairs
  --budget-requests Total model requests for the whole task
  --budget-tokens Total reported tokens for the whole task
  --json        Print machine-readable output where supported
  --no-save     Do not persist the session or enable project knowledge integration
  --no-animation Skip the MARS startup animation
  --help        Show help
  --version     Show version

Interactive commands: /help, /login, /new, /model [provider:model], /models, /permissions, /route, /sessions, /resume ID, /config, /check, /memory, /remember NAME CONTENT, /learn [SESSION_ID], /skills, /evidence, /health, /workflows, /exit
Shell defaults to host access; use --sandbox docker for containerized execution.
`;

export function safe(text: string): string { return stripVTControlCharacters(text).replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, ''); }
export async function prompt(label: string, signal: AbortSignal, hidden = false): Promise<string> {
  const output = hidden ? new Writable({ write(_chunk, _encoding, callback) { callback(); } }) : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  rl.on('SIGINT', cancel);
  rl.on('close', cancel);
  if (hidden) process.stdout.write(label);
  try { return await rl.question(hidden ? '' : label, { signal: AbortSignal.any([signal, controller.signal]) }); }
  finally { rl.close(); if (hidden) process.stdout.write('\n'); }
}

export function positive(value: string | undefined, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) throw new MarsError('ConfigurationError', 'Limits must be positive integers <= 2147483647.');
  return number;
}
export function nonNegative(value: string | undefined, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 100) throw new MarsError('ConfigurationError', 'max-retries must be an integer from 0 to 100.');
  return number;
}
export function targetParts(target: string): { providerId: string; model: string } {
  if (!validTarget(target)) throw new MarsError('ConfigurationError', 'Select a real provider:model with /model; MODEL is only a placeholder.');
  const separator = target.indexOf(':');
  return { providerId: target.slice(0, separator), model: target.slice(separator + 1) };
}
export async function workspaceRoot(input: string | undefined): Promise<string> { return (await Workspace.open(input ?? process.cwd())).root; }
