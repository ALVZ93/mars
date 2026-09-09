#!/usr/bin/env node
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import {
  AnthropicAuthProvider, AnthropicProvider, FakeProvider, FileEventLog, FileEvidenceStore, FileSessionStore, ProviderHealthTracker, createCredentialStore, defaultSessionDirectory, evidencePath, eventLogPath, ForgeError, keychainAvailable,
  GeminiProvider, GoogleGeminiAuthProvider, KimiCodeAuthProvider, KimiCodeProvider, OpenAICodexAuthProvider,
  OpenAICodexProvider, OpenAIProvider, QwenProvider, SkillRegistry, MODEL_CATALOG, Workspace, projectConfigPath,
  OpenRouterProvider, OllamaProvider, Permissions, createSandboxShell, sandboxStatus,
  loadConfig, readEventLogEntries, routeTask, runProjectChecks, refreshCredential, resolveAuthCredential, resolveCredential, migrateFileCredentials,
  openBrowser, saveConfig, createForge,
} from '../../../packages/sdk/src/index.js';
import type { AuthContext, AuthProvider, CredentialStore, ModelProvider, RouteDecision, VerificationReport } from '../../../packages/sdk/src/index.js';
import { providerAuthCatalog } from '../../../packages/auth/src/index.js';
import { showMarsBoot } from './visual.js';
import { choose, validTarget } from './terminal.js';
import { ConversationScreen } from './conversation.js';

const WORKFLOW_ROLES = ['planner', 'implementer', 'reviewer', 'verifier'] as const;

const help = `MARS 0.1 — provider-independent agent harness (daily-driver runtime)

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
mars evidence                         Show local skill/workflow evidence
mars health                           Show last-known provider health
mars logout PROVIDER                   Disconnect a provider

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
  MARS_ENABLE_EXPERIMENTAL_SUBSCRIPTION_AUTH=1 (development only)

Options:
  --model       Explicit provider:model, or MARS_MODEL/FORGE_MODEL
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
  --verify      Run standard project checks after the agent finishes
  --json        Print machine-readable output where supported
  --no-save     Do not persist the session
  --no-animation Skip the MARS startup animation
  --help        Show help
  --version     Show version

Interactive commands: /help, /login, /new, /model [provider:model], /models, /permissions, /route, /sessions, /resume ID, /config, /check, /skills, /evidence, /health, /workflows, /exit
Shell defaults to host access; use --sandbox docker for containerized execution.
`;

function safe(text: string): string { return stripVTControlCharacters(text).replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, ''); }
async function prompt(label: string, signal: AbortSignal, hidden = false): Promise<string> {
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

function authProvider(id: string): AuthProvider | undefined {
  if (id === 'openai-codex') return new OpenAICodexAuthProvider();
  if (id === 'anthropic') return new AnthropicAuthProvider();
  if (id === 'kimi-code') return new KimiCodeAuthProvider();
  if (id === 'gemini') return new GoogleGeminiAuthProvider();
  return undefined;
}
function authContext(signal: AbortSignal): AuthContext {
  return {
    signal,
    openUrl: async url => {
      process.stderr.write(`\nAbriendo el navegador para autenticar MARS…\n${safe(url)}\n`);
      try { await openBrowser(url); } catch { process.stderr.write('No se pudo abrir el navegador automáticamente; abre la URL anterior manualmente.\n'); }
    },
    notify: event => {
      if (event.type === 'auth-url') return;
      if (event.type === 'device-code') { process.stderr.write(`\nCódigo de dispositivo: ${safe(event.userCode)}\n${safe(event.verificationUriComplete ?? event.verificationUri)}\n`); return; }
      process.stderr.write(`${safe(event.message)}\n`);
    },
  };
}

async function loginCommand(providerId: string | undefined, values: Record<string, unknown>, credentials: CredentialStore): Promise<void> {
  if (!providerId) {
    process.stdout.write('Connect provider\n\n');
    providerAuthCatalog.forEach((provider, index) => process.stdout.write(`${index + 1}. ${provider.name} (${provider.id})\n`));
    const choice = await prompt('Provider number or id: ', new AbortController().signal);
    const index = Number(choice.trim()) - 1;
    providerId = Number.isInteger(index) && providerAuthCatalog[index] ? providerAuthCatalog[index].id : choice.trim();
  }
  if (!providerId) throw new ForgeError('ConfigurationError', 'Select a provider.');
  if (values['api-key'] === true) {
    if (!['openai', 'anthropic', 'kimi-code', 'gemini', 'qwen', 'openrouter'].includes(providerId)) throw new ForgeError('ConfigurationError', 'OpenAI Codex usa login de navegador; selecciona un proveedor API para guardar una API key.');
    const labels: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', 'kimi-code': 'Kimi Code', gemini: 'Gemini', qwen: 'Qwen', openrouter: 'OpenRouter' };
    const secret = await prompt(`${labels[providerId]} API key (hidden): `, new AbortController().signal, true);
    await credentials.set({ provider: providerId, kind: 'api-key', secret });
    process.stdout.write(`${labels[providerId]} API key guardada en el almacén de credenciales de MARS.\n`);
    return;
  }
  if (providerId === 'anthropic') throw new ForgeError('ConfigurationError', 'Anthropic no permite ofrecer login de claude.ai en productos de terceros sin aprobación previa; usa `mars login anthropic --api-key`.');
  if ((providerId === 'openai-codex' || providerId === 'kimi-code') && process.env.MARS_ENABLE_EXPERIMENTAL_SUBSCRIPTION_AUTH !== '1') {
    throw new ForgeError('ConfigurationError', `El login de suscripción de ${providerId} es experimental y está desactivado. Usa un proveedor con API key o establece MARS_ENABLE_EXPERIMENTAL_SUBSCRIPTION_AUTH=1 para desarrollo.`);
  }
  if (providerId === 'openai' || providerId === 'qwen' || providerId === 'openrouter' || providerId === 'ollama') throw new ForgeError('ConfigurationError', `${providerId} no ofrece login de navegador en MARS; usa su configuración local o --api-key.`);
  const provider = authProvider(providerId);
  if (!provider) throw new ForgeError('ConfigurationError', `Unsupported authentication provider: ${providerId}.`);
  const method = providerId === 'kimi-code' ? 'oauth-device' : 'oauth-pkce';
  if (values.browser === false && providerId !== 'kimi-code') throw new ForgeError('ConfigurationError', `${providerId} solo admite login OAuth de navegador.`);
  if (values.device === true && providerId !== 'kimi-code' && providerId !== 'openai-codex') throw new ForgeError('ConfigurationError', `${providerId} no admite device code.`);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const credential = await provider.login(values.device === true ? 'oauth-device' : method, authContext(controller.signal));
    await credentials.set(credential);
    process.stdout.write(`${provider.displayName} conectado. La credencial queda disponible para futuras ejecuciones.\n`);
  } finally { process.off('SIGINT', cancel); }
}

async function authCommand(positionals: string[], credentials: CredentialStore): Promise<void> {
  const action = positionals[1] ?? 'providers';
  if (action === 'providers' && positionals.length === 2) {
    process.stdout.write('MARS authentication providers\n\n');
    for (const provider of providerAuthCatalog) process.stdout.write(`${provider.name}\n  id: ${provider.id}\n  browser: ${provider.browser}\n  subscription: ${provider.subscription ? 'yes' : 'no'}\n  api key: ${provider.apiKey ? 'yes' : 'no'}\n\n`);
    return;
  }
  if (action === 'status' && positionals.length === 2) {
    const signal = new AbortController().signal;
    for (const entry of providerAuthCatalog) {
      const credential = await resolveAuthCredential(entry.id, { store: credentials, env: process.env });
      const provider = authProvider(entry.id);
      const status = entry.id === 'ollama' ? { authenticated: true, method: 'local' as const, message: 'No login required.' } : provider ? await provider.status(credential, authContext(signal)) : credential ? { authenticated: true, method: credential.kind === 'api-key' ? 'api-key' as const : 'local' as const } : { authenticated: false };
      process.stdout.write(`${entry.id}: ${status.authenticated ? 'connected' : 'not connected'}${status.method ? ` (${status.method})` : ''}${status.message ? ` — ${safe(status.message)}` : ''}\n`);
    }
    return;
  }
  if (action === 'logout' && positionals.length === 3) {
    const providerId = positionals[2]!;
    const credential = await credentials.get(providerId);
    const provider = authProvider(providerId);
    if (credential && provider) await provider.logout(credential, authContext(new AbortController().signal));
    await credentials.delete(providerId);
    process.stdout.write(`${providerId}: disconnected.\n`);
    return;
  }
  if (action === 'migrate' && positionals.length === 2) {
    const providers = await migrateFileCredentials();
    process.stdout.write(providers.length ? `Migrated to the native keychain: ${providers.join(', ')}.\n` : 'No file credentials found.\n');
    return;
  }
  throw new ForgeError('ConfigurationError', 'Use auth providers, auth status, auth logout PROVIDER or auth migrate.');
}

function positive(value: string | undefined, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) throw new ForgeError('ConfigurationError', 'Limits must be positive integers <= 2147483647.');
  return number;
}
function nonNegative(value: string | undefined, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 100) throw new ForgeError('ConfigurationError', 'max-retries must be an integer from 0 to 100.');
  return number;
}
function targetParts(target: string): { providerId: string; model: string } {
  if (!validTarget(target)) throw new ForgeError('ConfigurationError', 'Select a real provider:model with /model; MODEL is only a placeholder.');
  const separator = target.indexOf(':');
  return { providerId: target.slice(0, separator), model: target.slice(separator + 1) };
}
async function authenticatedProviders(credentials: CredentialStore): Promise<string[]> {
  const ids = ['openai', 'openai-codex', 'anthropic', 'kimi-code', 'gemini', 'qwen', 'openrouter'];
  const connected: string[] = [];
  for (const id of ids) if (await resolveAuthCredential(id, { store: credentials, env: process.env })) connected.push(id);
  return connected;
}
async function resolveTarget(values: Record<string, unknown>, workspace: string, task: string | undefined, credentials: CredentialStore): Promise<{ target: string; route?: RouteDecision }> {
  const target = (typeof values.model === 'string' ? values.model : undefined) ?? process.env.MARS_MODEL ?? process.env.FORGE_MODEL;
  if (target) { targetParts(target); return { target }; }
  const loaded = await loadConfig(workspace);
  try {
    const route = routeTask(task ?? '', { config: { ...loaded.config, routing: { ...loaded.config.routing, enabled: values.route === true || loaded.config.routing.enabled } }, authenticatedProviders: await authenticatedProviders(credentials), allowOffline: typeof values.script === 'string' });
    return { target: route.target, route };
  } catch { throw new ForgeError('ConfigurationError', 'No model selected. Set MARS_MODEL, configure model.default with `mars config set model.default provider:model`, or choose --model (see `mars models`).'); }
}

async function providerForTarget(target: string, credentials: CredentialStore, values: Record<string, unknown>): Promise<ModelProvider> {
  const { providerId, model: selectedModel } = targetParts(target);
  if (providerId === 'fake' && selectedModel === 'scripted') {
    const assistant = z.strictObject({ role: z.literal('assistant'), content: z.string(), toolCalls: z.array(z.strictObject({ id: z.string().min(1), name: z.string().min(1), arguments: z.unknown() })) });
    if (typeof values.script === 'string') {
      try { return new FakeProvider(z.array(assistant).parse(JSON.parse(await readFile(values.script, 'utf8')))); }
      catch { throw new ForgeError('ConfigurationError', 'Cannot load fake provider script: expected an array of assistant messages.'); }
    }
    return new FakeProvider([
      { role: 'assistant', content: '', toolCalls: [{ id: 'demo-read', name: 'read_file', arguments: { path: 'package.json' } }] },
      request => ({ role: 'assistant', content: `Offline demo — read_file result:\n${request.messages.at(-1)?.content ?? ''}`, toolCalls: [] }),
    ]);
  }
  if (typeof values.script === 'string') throw new ForgeError('ConfigurationError', '--script is only available with fake:scripted.');
  if (providerId === 'openai') {
    const credential = await resolveCredential('openai', { store: credentials });
    if (!credential) throw new ForgeError('AuthenticationError', 'Set OPENAI_API_KEY or use login openai --api-key.');
    return new OpenAIProvider(credential);
  }
  if (providerId === 'openrouter') {
    const credential = await resolveCredential(providerId, { store: credentials });
    if (!credential) throw new ForgeError('AuthenticationError', 'Set OPENROUTER_API_KEY or use login openrouter --api-key.');
    return new OpenRouterProvider(credential);
  }
  if (providerId === 'ollama') return new OllamaProvider();
  if (!['openai-codex', 'anthropic', 'kimi-code', 'gemini', 'qwen'].includes(providerId)) throw new ForgeError('ConfigurationError', 'Supported providers: openai, openai-codex, anthropic, kimi-code, gemini, qwen, openrouter, ollama and fake.');
  const auth = authProvider(providerId);
  if (providerId === 'qwen') {
    const credential = await resolveAuthCredential(providerId, { store: credentials });
    if (credential?.kind !== 'api-key') throw new ForgeError('AuthenticationError', 'Qwen requires a Model Studio API key or Token Plan key.');
    return new QwenProvider(credential);
  }
  if (providerId === 'gemini') {
    const credential = await resolveAuthCredential(providerId, { store: credentials });
    if (!credential) throw new ForgeError('AuthenticationError', 'Set GOOGLE_API_KEY or connect Gemini with mars login gemini.');
    const refreshed = auth ? await refreshCredential(auth, credential, { store: credentials, context: authContext(new AbortController().signal) }) : credential;
    return new GeminiProvider(refreshed);
  }
  if (!auth) throw new ForgeError('ConfigurationError', `No authentication adapter for ${providerId}.`);
  const credential = await resolveAuthCredential(providerId, { store: credentials });
  if (!credential) throw new ForgeError('AuthenticationError', `Connect ${providerId} with mars login ${providerId}.`);
  const refreshed = await refreshCredential(auth, credential, { store: credentials, context: authContext(new AbortController().signal) });
  if (providerId === 'openai-codex') {
    if (refreshed.kind !== 'oauth') throw new ForgeError('AuthenticationError', 'OpenAI Codex requires browser authentication.');
    return new OpenAICodexProvider(refreshed);
  }
  if (refreshed.kind !== 'oauth' && refreshed.kind !== 'api-key') throw new ForgeError('AuthenticationError', 'Provider credential is invalid.');
  return providerId === 'anthropic' ? new AnthropicProvider(refreshed) : new KimiCodeProvider(refreshed);
}

async function workspaceRoot(input: string | undefined): Promise<string> { return (await Workspace.open(input ?? process.cwd())).root; }
function approval(screen?: ConversationScreen) {
  return async (command: string, cwd: string, signal: AbortSignal): Promise<boolean> => {
    if (!process.stdin.isTTY) return false;
    if (screen) return screen.confirm(command, cwd, signal);
    return /^y(es)?$/i.test((await prompt(`\nShell (host access) in ${safe(cwd)}:\n${safe(command)}\nAllow this command? [y/N] `, signal)).trim());
  };
}

async function createSessionForge(target: string, root: string, values: Record<string, unknown>, credentials: CredentialStore, sessionId?: string, screen?: ConversationScreen) {
  const { model } = targetParts(target);
  const provider = await providerForTarget(target, credentials, values);
  const loaded = await loadConfig(root);
  const shellPolicy = ['allow', 'ask', 'deny'].includes(String(values.shellPolicy)) ? values.shellPolicy as 'allow' | 'ask' | 'deny' : values['allow-shell'] === true ? 'allow' as const : loaded.config.permissions.shell;
  const sessionStore = values['no-save'] === true ? undefined : new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const evidenceStore = values['no-save'] === true ? undefined : new FileEvidenceStore(evidencePath(root));
  const eventLog = values['no-save'] === true ? undefined : new FileEventLog(eventLogPath(root));
  const roleSelection = await workflowRoleProviders(root, values, credentials, target, provider, loaded.config);
  const options = {
    workspace: root, provider, model, sessionId, sessionStore,
    maxTurns: positive(typeof values['max-turns'] === 'string' ? values['max-turns'] : undefined, loaded.config.limits.maxTurns),
    maxToolCalls: positive(typeof values['max-tool-calls'] === 'string' ? values['max-tool-calls'] : undefined, loaded.config.limits.maxToolCalls),
    timeoutMs: positive(typeof values.timeout === 'string' ? values.timeout : undefined, loaded.config.limits.timeoutMs),
    maxRetries: nonNegative(typeof values['max-retries'] === 'string' ? values['max-retries'] : undefined, loaded.config.limits.maxRetries),
    retryDelayMs: positive(typeof values['retry-delay'] === 'string' ? values['retry-delay'] : undefined, loaded.config.limits.retryDelayMs),
    maxContextChars: loaded.config.limits.maxContextChars,
    verificationCommands: loaded.config.verification.commands,
    shellPolicy, permissionPolicies: { ...loaded.config.permissions, shell: shellPolicy }, approveShell: approval(screen), includeProjectContext: true,
    evidenceStore,
    eventLog: eventLog?.sink,
    mcpServers: loaded.config.mcp.servers.map(server => ({ ...server, cwd: path.resolve(root, server.cwd ?? '.') })),
    ...(typeof values.sandbox === 'string' ? { sandbox: { mode: values.sandbox as 'host' | 'docker', image: process.env.MARS_SANDBOX_IMAGE } } : process.env.MARS_SANDBOX === 'docker' ? { sandbox: { mode: 'docker' as const, image: process.env.MARS_SANDBOX_IMAGE } } : {}),
    ...(roleSelection?.providers ? { roleProviders: roleSelection.providers } : {}),
    emit: (event: import('../../../packages/core/src/index.js').AgentEvent) => {
      if (screen) { screen.handleEvent(event); return; }
      if (event.type === 'model:text') process.stdout.write(safe(event.text));
      if (event.type === 'tool:start') process.stderr.write(`\n[tool] ${safe(event.tool)}\n`);
      if (event.type === 'tool:end' && event.error) process.stderr.write(`[${event.error}] ${safe(event.tool)}\n`);
      if (event.type === 'permission:denied') process.stderr.write(`[PermissionDeniedError] ${safe(event.permission)}\n`);
    },
  };
  return { forge: await createForge(options), sessionStore, eventLog, roleTargets: roleSelection?.targets ?? [] };
}

async function workflowRoleProviders(root: string, values: Record<string, unknown>, credentials: CredentialStore, primaryTarget: string, primaryProvider: ModelProvider, config: Awaited<ReturnType<typeof loadConfig>>['config']): Promise<{ providers: Partial<Record<(typeof WORKFLOW_ROLES)[number], { provider: ModelProvider; model: string }>>; targets: string[] } | undefined> {
  if (typeof values.workflow !== 'string' || typeof values.script === 'string') return undefined;
  const hasRolePolicy = WORKFLOW_ROLES.some(role => Boolean(config.routing[role]));
  if (values.route !== true && !config.routing.enabled && !hasRolePolicy) return undefined;
  const authenticated = await authenticatedProviders(credentials);
  const providers: Partial<Record<(typeof WORKFLOW_ROLES)[number], { provider: ModelProvider; model: string }>> = {};
  const targets: string[] = [];
  for (const role of WORKFLOW_ROLES) {
    let decision: RouteDecision;
    try {
      decision = routeTask('', {
        role,
        config: { ...config, routing: { ...config.routing, enabled: true } },
        authenticatedProviders: authenticated,
      });
    } catch { continue; }
    const parts = targetParts(decision.target);
    const selectedProvider = decision.target === primaryTarget ? primaryProvider : await providerForTarget(decision.target, credentials, values);
    providers[role] = { provider: selectedProvider, model: parts.model };
    targets.push(`${role}=${decision.target}`);
  }
  return Object.keys(providers).length ? { providers, targets } : undefined;
}

async function runTask(target: string, root: string, values: Record<string, unknown>, credentials: CredentialStore, task: string, sessionId?: string, route?: RouteDecision): Promise<void> {
  const { forge, eventLog, roleTargets } = await createSessionForge(target, root, values, credentials, sessionId);
  if (route) process.stderr.write(`[route] ${route.role} → ${route.target} (${route.reason})\n`);
  if (roleTargets.length) process.stderr.write(`[workflow routing] ${roleTargets.join(' · ')}\n`);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    if (process.stdout.isTTY && values['no-animation'] !== true) process.stdout.write('\n');
    await showMarsBoot(controller.signal, values['no-animation'] !== true);
    if (typeof values.workflow === 'string') await forge.runWorkflow(values.workflow, task, controller.signal);
    else await forge.run(task, controller.signal);
    if (values.verify === true) renderCheckReport(await forge.verify(controller.signal));
    process.stderr.write(`\n[session] ${forge.id}\n`);
  } finally { process.off('SIGINT', cancel); await forge.close(); await eventLog?.flush(); process.stdout.write('\n'); }
}

async function modelsCommand(json = false): Promise<void> {
  const credentials = createCredentialStore();
  const connected = new Set(await authenticatedProviders(credentials));
  const values = MODEL_CATALOG.map(model => ({ id: model.id, provider: model.provider, model: model.model, authenticated: model.provider === 'fake' || model.provider === 'ollama' || connected.has(model.provider), capabilities: model.capabilities, metadata: model.metadata }));
  if (json) { process.stdout.write(`${JSON.stringify(values, null, 2)}\n`); return; }
  process.stdout.write('MARS models\n\n');
  for (const model of values) process.stdout.write(`${model.authenticated ? '✓' : '·'} ${model.id}${model.metadata?.subscription ? ' [subscription]' : ''}${model.metadata?.offline ? ' [offline]' : ''}\n`);
  process.stdout.write('\nUse --model provider:model or configure model.default.\n');
}
async function doctorCommand(root: string, requestedSandbox?: unknown): Promise<void> {
  const credentials = createCredentialStore();
  const loaded = await loadConfig(root);
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  const mode = requestedSandbox === 'docker' || (requestedSandbox === undefined && process.env.MARS_SANDBOX === 'docker') ? 'docker' : 'host';
  const sandbox = sandboxStatus({ mode });
  process.stdout.write(`MARS doctor\nworkspace: ${root}\nnode: ${process.version}\ngit: ${git.status === 0 ? safe((git.stdout ?? '').trim()) : 'not available'}\nconfig: ${loaded.sources.length ? loaded.sources.join(', ') : 'defaults'}\nproject config: ${projectConfigPath(root)}\nauthenticated providers: ${(await authenticatedProviders(credentials)).join(', ') || 'none'}\ncredential store: ${keychainAvailable() ? 'native keychain (keytar)' : 'file fallback (install keytar for native storage)'}\nsandbox: ${sandbox.message}\nnetwork checks: skipped (use a real run to validate provider availability)\n`);
}
async function configCommand(positionals: string[], root: string): Promise<void> {
  const loaded = await loadConfig(root);
  const action = positionals[1] ?? 'show';
  if (action === 'show') { process.stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`); return; }
  if (action === 'path') { process.stdout.write(`${loaded.paths.project}\n`); return; }
  if (action === 'set' && positionals.length >= 4) {
    const key = positionals[2]!;
    const allowed = new Set(['model.default', 'routing.enabled', 'routing.planner', 'routing.implementer', 'routing.reviewer', 'routing.verifier', 'permissions.shell', 'permissions.destructiveShell', 'permissions.network', 'permissions.gitCommit', 'permissions.gitPush', 'limits.maxTurns', 'limits.maxToolCalls', 'limits.timeoutMs', 'limits.maxContextChars', 'limits.maxRetries', 'limits.retryDelayMs', 'mcp.servers']);
    if (!allowed.has(key)) throw new ForgeError('ConfigurationError', `Unknown config key: ${key}`);
    const raw = positionals.slice(3).join(' ');
    let value: unknown = raw;
    if (key === 'mcp.servers') {
      try { value = JSON.parse(raw); } catch { throw new ForgeError('ConfigurationError', 'mcp.servers must be valid JSON.'); }
    }
    if (raw === 'true' || raw === 'false') value = raw === 'true'; else if (/^-?\d+$/.test(raw)) value = Number(raw);
    const patch: Record<string, unknown> = {};
    let cursor = patch;
    const parts = key.split('.');
    for (const part of parts.slice(0, -1)) { cursor[part] = {}; cursor = cursor[part] as Record<string, unknown>; }
    cursor[parts.at(-1)!] = value;
    await saveConfig(projectConfigPath(root), patch as never);
    process.stdout.write(`Saved ${key} in ${projectConfigPath(root)}\n`);
    return;
  }
  throw new ForgeError('ConfigurationError', 'Use config, config path o config set KEY VALUE.');
}
async function sessionsCommand(root: string, json = false): Promise<void> {
  const sessions = await new FileSessionStore(path.join(root, '.mars', 'sessions')).list(root);
  if (json) { process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`); return; }
  if (!sessions.length) { process.stdout.write('No MARS sessions.\n'); return; }
  for (const session of sessions) process.stdout.write(`${session.id}  ${session.status ?? 'active'}  ${session.model}  ${session.updatedAt}  ${safe(session.lastMessage ?? '')}\n`);
}
function renderCheckReport(report: VerificationReport, json = false): void {
  if (json) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return; }
  if (report.reason) process.stdout.write(`${report.reason}\n`);
  for (const check of report.checks) process.stdout.write(`${check.passed ? '✓' : '✕'} ${check.command}\n${safe(check.output)}\n`);
  process.stdout.write(report.verified ? 'Verification passed.\n' : 'Verification failed.\n');
  if (!report.verified) throw new ForgeError('ToolExecutionError', report.reason ?? 'Project verification failed.');
}
async function checkCommand(root: string, values: Record<string, unknown>, json = false): Promise<void> {
  const loaded = await loadConfig(root);
  const shellPolicy = values['allow-shell'] === true ? 'allow' as const : loaded.config.permissions.shell;
  const permissions = new Permissions(shellPolicy, approval(), { ...loaded.config.permissions, shell: shellPolicy });
  const sandbox = typeof values.sandbox === 'string'
    ? { mode: values.sandbox as 'host' | 'docker', image: process.env.MARS_SANDBOX_IMAGE }
    : process.env.MARS_SANDBOX === 'docker' ? { mode: 'docker' as const, image: process.env.MARS_SANDBOX_IMAGE } : undefined;
  const workspace = await Workspace.open(root);
  const shellExecutor = createSandboxShell(workspace.root, sandbox);
  const report = await runProjectChecks(workspace, new AbortController().signal, { timeoutMs: loaded.config.limits.timeoutMs, shellExecutor, permissions, commands: loaded.config.verification.commands });
  renderCheckReport(report, json);
}
async function skillsCommand(root: string): Promise<void> {
  const skills = await new SkillRegistry(root).list();
  if (!skills.length) { process.stdout.write('No MARS skills found.\n'); return; }
  for (const skill of skills) process.stdout.write(`${skill.scope}\t${skill.name}\t${skill.path}\n`);
}
async function evidenceCommand(root: string, action = 'show', json = false): Promise<void> {
  const evidence = new FileEvidenceStore(evidencePath(root));
  if (action === 'clear') { await evidence.clear(); process.stdout.write('Cleared MARS evidence.\n'); return; }
  if (action !== 'show') throw new ForgeError('ConfigurationError', 'Use evidence or evidence clear.');
  const snapshot = await evidence.load();
  const suggestions = await evidence.suggestions();
  if (json) { process.stdout.write(`${JSON.stringify({ ...snapshot, suggestions }, null, 2)}\n`); return; }
  process.stdout.write(`MARS evidence\nupdated: ${snapshot.updatedAt}\n`);
  const skills = Object.values(snapshot.skills);
  const workflows = Object.values(snapshot.workflows);
  if (skills.length) {
    process.stdout.write('\nSkills\n');
    for (const skill of skills) process.stdout.write(`  ${skill.name}  ${skill.successes}/${skill.executions}  confidence ${(skill.confidence * 100).toFixed(0)}%\n`);
  }
  if (workflows.length) {
    process.stdout.write('\nWorkflows\n');
    for (const workflow of workflows) process.stdout.write(`  ${workflow.id}  ${workflow.successes}/${workflow.executions}  confidence ${(workflow.confidence * 100).toFixed(0)}%\n`);
  }
  if (suggestions.length) {
    process.stdout.write('\nCandidates for manual skill promotion\n');
    for (const suggestion of suggestions) process.stdout.write(`  ${suggestion.name}  ${suggestion.reason}\n`);
  }
  if (!skills.length && !workflows.length) process.stdout.write('\nNo evidence recorded.\n');
}
async function healthCommand(root: string, credentials: CredentialStore, json = false): Promise<void> {
  const tracker = new ProviderHealthTracker();
  for (const provider of await authenticatedProviders(credentials)) tracker.markAuthenticated(provider);
  for (const entry of await readEventLogEntries(eventLogPath(root))) tracker.observe(entry.event, Date.parse(entry.at) || Date.now());
  const values = tracker.list();
  if (json) { process.stdout.write(`${JSON.stringify(values, null, 2)}\n`); return; }
  process.stdout.write('MARS provider health (last known; no network probe)\n\n');
  if (!values.length) { process.stdout.write('No provider activity recorded.\n'); return; }
  for (const value of values) {
    const state = value.reachable ? 'reachable' : value.authenticated ? 'not checked' : 'not connected';
    const latency = value.lastLatencyMs === undefined ? '' : ` ${value.lastLatencyMs}ms`;
    const error = value.lastError ? ` — ${value.lastError}` : '';
    process.stdout.write(`${value.provider}: ${state}${value.rateLimited ? ' (rate limited)' : ''}${latency}${error}\n`);
  }
}
async function resumeSession(id: string, root: string, workspaceWasExplicit: boolean): Promise<{ session: import('../../../packages/sdk/src/index.js').Session; root: string }> {
  const local = new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const found = await local.get(id);
  if (found) return { session: found, root };
  if (!workspaceWasExplicit) {
    try {
      const global = await new FileSessionStore(defaultSessionDirectory()).get(id);
      if (global) {
        const projectRoot = await workspaceRoot(global.workspace);
        await new FileSessionStore(path.join(projectRoot, '.mars', 'sessions')).save(global);
        return { session: global, root: projectRoot };
      }
    } catch { /* Global session storage is optional; continue with the local error. */ }
  }
  throw new ForgeError('ConfigurationError', `Session not found: ${id}`);
}
async function workflowsCommand(): Promise<void> {
  const forge = await createForge({ workspace: process.cwd(), provider: new FakeProvider(), model: 'scripted', includeProjectContext: false });
  for (const workflow of forge.workflows) process.stdout.write(`${workflow.id}\t${workflow.description}\n`);
}

async function selectModel(root: string, credentials: CredentialStore, preferred?: string): Promise<string> {
  const ask = (label: string) => prompt(label, new AbortController().signal);
  const write = (text: string) => { process.stdout.write(text); };
  const providers = [...new Set(MODEL_CATALOG.map(model => model.provider))];
  const connected = new Set(await authenticatedProviders(credentials));
  const providerIndex = await choose('MARS · Proveedor', providers.map(id => `${id} · ${connected.has(id) ? 'conectado' : ['fake', 'ollama'].includes(id) ? 'local' : 'requiere autenticación'}`), ask, write, Math.max(0, providers.indexOf(preferred?.split(':')[0] ?? '')));
  const provider = providers[providerIndex]!;
  if (!connected.has(provider) && !['fake', 'ollama'].includes(provider)) {
    const info = providerAuthCatalog.find(entry => entry.id === provider);
    const methods = info?.apiKey && authProvider(provider) ? ['Navegador / suscripción', 'API key'] : [authProvider(provider) ? 'Navegador / suscripción' : 'API key'];
    const method = await choose('Autenticación', methods, ask, write);
    await loginCommand(provider, { 'api-key': methods[method] === 'API key' }, credentials);
  }
  const models = MODEL_CATALOG.filter(model => model.provider === provider);
  const index = await choose('Modelo · catálogo local, disponibilidad según tu cuenta', [...models.map(model => model.model), 'Otro modelo (ID manual)'], ask, write, Math.max(0, models.findIndex(model => model.id === preferred)));
  const target = index === models.length ? `${provider}:${(await ask('ID del modelo: ')).trim()}` : models[index]!.id;
  targetParts(target);
  await saveConfig(projectConfigPath(root), { model: { default: target } });
  return target;
}

async function interactive(root: string, values: Record<string, unknown>, credentials: CredentialStore, target: string): Promise<void> {
  let currentTarget = target;
  const loaded = await loadConfig(root);
  const screen = new ConversationScreen(currentTarget, root, loaded.config.limits.maxContextChars);
  screen.start();
  let activeForge = await createSessionForge(currentTarget, root, values, credentials, undefined, screen);
  const sessionStore = activeForge.sessionStore ?? new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const outside = async <T>(work: () => Promise<T>): Promise<T> => {
    screen.suspend();
    try { return await work(); } finally { screen.resume(currentTarget); }
  };
  const refresh = () => screen.setContext(JSON.stringify(activeForge.forge.session.messages).length);
  const attach = () => {
    activeForge.forge.on('model:response', refresh);
    activeForge.forge.on('tool:end', refresh);
  };
  attach();
  const execute = async (task: string) => {
    const controller = new AbortController();
    screen.setInterrupt(() => controller.abort());
    screen.setRunning(true);
    screen.addUser(task);
    try {
      if (typeof values.workflow === 'string') await activeForge.forge.runWorkflow(values.workflow, task, controller.signal);
      else await activeForge.forge.run(task, controller.signal);
      screen.addNotice(`[session] ${activeForge.forge.id}`);
    } catch (error) {
      screen.addNotice(error instanceof ForgeError ? `${error.code}: ${safe(error.message)}` : 'MARS failed.');
    } finally {
      screen.setInterrupt(undefined);
      screen.setRunning(false);
      refresh();
    }
  };
  try {
    while (true) {
      const task = (await screen.readInput()).trim();
      if (!task) continue;
      if (task === '/exit') break;
      if (task === '/permissions' || task.startsWith('/permissions ')) {
        try {
          const result = await outside(async () => {
            const parts = task.split(/\s+/).slice(1);
            let policy = parts[0];
            let scope = parts[1] ?? 'session';
            if (!policy) {
              const selected = await choose(`Shell: ${activeForge.forge.shellPolicy}`, ['Preguntar cada vez', 'Permitir durante esta sesión', 'Permitir y guardar en este proyecto', 'Denegar durante esta sesión'], label => prompt(label, new AbortController().signal), text => process.stdout.write(text));
              policy = ['ask', 'allow', 'allow', 'deny'][selected];
              scope = selected === 2 ? 'project' : 'session';
            }
            if (!['allow', 'ask', 'deny'].includes(policy!) || !['session', 'project'].includes(scope) || parts.length > 2) throw new ForgeError('ConfigurationError', 'Use /permissions [allow|ask|deny] [session|project].');
            return { policy: policy as 'allow' | 'ask' | 'deny', scope };
          });
          if (result.scope === 'project') await saveConfig(projectConfigPath(root), { permissions: { shell: result.policy } });
          activeForge.forge.setShellPolicy(result.policy);
          values.shellPolicy = result.policy;
          screen.addNotice(`Shell: ${result.policy} (${result.scope}). Red y comandos destructivos mantienen sus políticas.`);
        } catch (error) { screen.addNotice(error instanceof ForgeError ? `${error.code}: ${safe(error.message)}` : 'Permission command failed.'); }
        continue;
      }
      if (task === '/help') { screen.addNotice(help); continue; }
      if (task === '/login') { try { await outside(() => loginCommand(undefined, values, credentials)); } catch (error) { screen.addNotice(safe(error instanceof Error ? error.message : 'Login failed.')); } continue; }
      if (task === '/models' || task === '/model' || task === '/providers') {
        try {
          const nextTarget = await outside(() => selectModel(root, credentials, currentTarget));
          const replacement = await createSessionForge(nextTarget, root, values, credentials, values['no-save'] === true ? undefined : activeForge.forge.id, screen);
          await activeForge.forge.close();
          await activeForge.eventLog?.flush();
          activeForge = replacement;
          currentTarget = nextTarget;
          attach();
          screen.setModel(currentTarget);
          screen.addNotice(values['no-save'] === true ? 'Modelo seleccionado. Nueva conversación sin persistencia.' : 'Modelo seleccionado. Conversación conservada.');
        } catch (error) { screen.addNotice(safe(error instanceof Error ? error.message : 'Model selection failed.')); }
        continue;
      }
      if (task === '/sessions') { await outside(() => sessionsCommand(root)); continue; }
      if (task === '/config') { await outside(() => configCommand(['config'], root)); continue; }
      if (task === '/skills') { await outside(() => skillsCommand(root)); continue; }
      if (task === '/evidence') { await outside(() => evidenceCommand(root)); continue; }
      if (task === '/health') { await outside(() => healthCommand(root, credentials)); continue; }
      if (task === '/workflows') { await outside(workflowsCommand); continue; }
      if (task === '/check') { try { await outside(async () => renderCheckReport(await activeForge.forge.verify())); } catch (error) { screen.addNotice(safe(error instanceof Error ? error.message : 'Check failed.')); } continue; }
      if (task === '/route') { screen.addNotice(JSON.stringify(routeTask('implement task', { explicit: currentTarget }), null, 2)); continue; }
      if (task === '/new') { await activeForge.forge.close(); await activeForge.eventLog?.flush(); activeForge = await createSessionForge(currentTarget, root, values, credentials, undefined, screen); attach(); screen.addNotice('New persisted session.'); continue; }
      if (task.startsWith('/model ')) {
        const nextTarget = task.slice('/model '.length).trim();
        try {
          targetParts(nextTarget);
          const previousId = values['no-save'] === true ? undefined : activeForge.forge.id;
          await activeForge.forge.close();
          await activeForge.eventLog?.flush();
          activeForge = await createSessionForge(nextTarget, root, values, credentials, previousId, screen);
          attach();
          currentTarget = nextTarget;
          screen.setModel(currentTarget);
          screen.addNotice(`Switched to ${currentTarget}.`);
        } catch (error) { screen.addNotice(safe(error instanceof Error ? error.message : 'Model switch failed.')); }
        continue;
      }
      if (task.startsWith('/resume ')) {
        const id = task.slice('/resume '.length).trim();
        const session = await sessionStore.get(id);
        if (!session) { screen.addNotice('Session not found.'); continue; }
        if (session.workspace !== root) { screen.addNotice('Session belongs to another workspace.'); continue; }
        currentTarget = session.model;
        await activeForge.forge.close();
        await activeForge.eventLog?.flush();
        activeForge = await createSessionForge(currentTarget, root, values, credentials, id, screen);
        attach();
        screen.setModel(currentTarget);
        screen.addNotice(`Resumed ${id}.`);
        continue;
      }
      if (task.startsWith('/')) { screen.addNotice('Unknown command. Use /help.'); continue; }
      await execute(task);
    }
  } finally {
    await activeForge.forge.close();
    await activeForge.eventLog?.flush();
    screen.stop();
  }
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: {
      model: { type: 'string' }, workspace: { type: 'string' }, script: { type: 'string' },
      'allow-shell': { type: 'boolean' }, 'api-key': { type: 'boolean' }, browser: { type: 'boolean' }, device: { type: 'boolean' },
      'max-turns': { type: 'string' }, 'max-tool-calls': { type: 'string' }, timeout: { type: 'string' }, 'max-retries': { type: 'string' }, 'retry-delay': { type: 'string' }, sandbox: { type: 'string' }, route: { type: 'boolean' }, workflow: { type: 'string' }, verify: { type: 'boolean' }, json: { type: 'boolean' }, 'no-save': { type: 'boolean' }, 'no-animation': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    } });
  } catch { throw new ForgeError('ConfigurationError', 'Invalid command arguments. Use --help.'); }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(help); return; }
  if (values.version) { process.stdout.write('0.1.0\n'); return; }
  const command = positionals[0];
  const known = new Set(['run', 'login', 'logout', 'auth', 'resume', 'new', 'sessions', 'check', 'models', 'route', 'workflows', 'doctor', 'init', 'config', 'skills', 'evidence', 'health']);
  const shorthand = Boolean(command && !known.has(command) && !command.startsWith('/'));
  if (command === 'run' && !positionals.slice(1).join(' ').trim()) throw new ForgeError('ConfigurationError', 'Provide a task to run.');
  const credentials = createCredentialStore();
  if (command === 'auth') { await authCommand(positionals, credentials); return; }
  if (command === 'logout') { if (!positionals[1]) throw new ForgeError('ConfigurationError', 'Provide a provider to logout.'); await authCommand(['auth', 'logout', positionals[1]], credentials); return; }
  if (command === 'login') { if (!process.stdin.isTTY) throw new ForgeError('ConfigurationError', 'Login requires an interactive terminal.'); await loginCommand(positionals[1], values as Record<string, unknown>, credentials); return; }
  if (command === 'models') { await modelsCommand(values.json === true); return; }
  if (command === 'workflows') { await workflowsCommand(); return; }
  let root = await workspaceRoot(typeof values.workspace === 'string' ? values.workspace : undefined);
  if (command === 'doctor') { await doctorCommand(root, values.sandbox); return; }
  if (command === 'init') { await saveConfig(projectConfigPath(root), {}); process.stdout.write(`Created ${projectConfigPath(root)}\n`); return; }
  if (command === 'config') { await configCommand(positionals, root); return; }
  if (command === 'sessions') { await sessionsCommand(root, values.json === true); return; }
  if (command === 'check') { await checkCommand(root, values as Record<string, unknown>, values.json === true); return; }
  if (command === 'skills') { await skillsCommand(root); return; }
  if (command === 'evidence') { await evidenceCommand(root, positionals[1] ?? 'show', values.json === true); return; }
  if (command === 'health') { await healthCommand(root, credentials, values.json === true); return; }
  const task = command === 'run' || command === 'route' ? positionals.slice(1).join(' ').trim() : shorthand ? positionals.join(' ').trim() : undefined;
  if (command === 'route' && !task) throw new ForgeError('ConfigurationError', 'Provide a task to route.');
  if (!process.stdin.isTTY && !task && command !== 'resume') { process.stdout.write(help); return; }
  let target: string;
  let resumeId: string | undefined;
  if (command === 'resume') {
    resumeId = positionals[1];
    if (!resumeId) throw new ForgeError('ConfigurationError', 'Provide a session ID.');
    const resumed = await resumeSession(resumeId, root, typeof values.workspace === 'string');
    root = resumed.root;
    const session = resumed.session;
    target = (typeof values.model === 'string' ? values.model : undefined) ?? session.model;
  } else if (!task && process.stdin.isTTY && !values.model) {
    const configured = (await loadConfig(root)).config.model.default;
    const preferred = configured ?? process.env.MARS_MODEL ?? process.env.FORGE_MODEL;
    const connected = await authenticatedProviders(credentials);
    target = preferred && validTarget(preferred) && [...connected, 'fake', 'ollama'].includes(preferred.split(':')[0]!)
      ? preferred : connected.length ? MODEL_CATALOG.find(model => model.provider === connected[0])!.id : await selectModel(root, credentials, preferred);
  } else {
    const resolved = await resolveTarget(values as Record<string, unknown>, root, task, credentials);
    target = resolved.target;
    if (resolved.route && task) process.stderr.write(`[route] ${resolved.route.role} → ${resolved.route.target} (${resolved.route.reason})\n`);
    if (command === 'route') { process.stdout.write(`${JSON.stringify(resolved.route ?? routeTask(task ?? '', { explicit: target }), null, 2)}\n`); return; }
  }
  if (command === 'resume' || !task) { await interactive(root, values as Record<string, unknown>, credentials, target); return; }
  await runTask(target, root, values as Record<string, unknown>, credentials, task, resumeId);
}

function report(error: unknown): number {
  const known = error instanceof ForgeError;
  const cancelled = (known && error.code === 'CancelledError') || (error instanceof Error && error.name === 'AbortError');
  process.stderr.write(cancelled ? 'Cancelled.\n' : known ? `${error.code}: ${safe(error.message)}\n` : `MARS failed: ${safe(error instanceof Error ? error.message : 'Check the workspace and configuration.')}\n`);
  return cancelled ? 130 : 1;
}
main().catch(error => { process.exitCode = report(error); });
