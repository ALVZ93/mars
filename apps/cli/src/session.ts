import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AnthropicProvider, FakeProvider, FileEventLog, FileEvidenceStore, FileSessionStore, GeminiProvider, KimiCodeProvider, MarsError, OpenAICodexProvider, OpenAIProvider, OpenRouterProvider, OllamaProvider, QwenProvider, Workspace, createMars, evidencePath, eventLogPath, loadConfig, refreshCredential, resolveAuthCredential, resolveCredential, routeTask } from '../../../packages/sdk/src/internal.js';
import type { CredentialStore, ModelProvider, RouteDecision } from '../../../packages/sdk/src/internal.js';
import { ConversationScreen } from './conversation.js';
import { authContext, authProvider, authenticatedProviders } from './commands/auth.js';
import { nonNegative, positive, prompt, safe, targetParts } from './utils/common.js';

const WORKFLOW_ROLES = ['planner', 'implementer', 'reviewer', 'verifier'] as const;
export async function resolveTarget(values: Record<string, unknown>, workspace: string, task: string | undefined, credentials: CredentialStore): Promise<{ target: string; route?: RouteDecision }> {
  const target = (typeof values.model === 'string' ? values.model : undefined) ?? process.env.MARS_MODEL;
  if (target) { targetParts(target); return { target }; }
  const loaded = await loadConfig(workspace);
  try {
    const route = routeTask(task ?? '', { config: { ...loaded.config, routing: { ...loaded.config.routing, enabled: values.route === true || loaded.config.routing.enabled } }, authenticatedProviders: await authenticatedProviders(credentials), allowOffline: typeof values.script === 'string' });
    return { target: route.target, route };
  } catch { throw new MarsError('ConfigurationError', 'No model selected. Set MARS_MODEL, configure model.default with `mars config set model.default provider:model`, or choose --model (see `mars models`).'); }
}

export async function providerForTarget(target: string, credentials: CredentialStore, values: Record<string, unknown>): Promise<ModelProvider> {
  const { providerId, model: selectedModel } = targetParts(target);
  if (providerId === 'fake' && selectedModel === 'scripted') {
    const assistant = z.strictObject({ role: z.literal('assistant'), content: z.string(), toolCalls: z.array(z.strictObject({ id: z.string().min(1), name: z.string().min(1), arguments: z.unknown() })) });
    if (typeof values.script === 'string') {
      try { return new FakeProvider(z.array(assistant).parse(JSON.parse(await readFile(values.script, 'utf8')))); }
      catch { throw new MarsError('ConfigurationError', 'Cannot load fake provider script: expected an array of assistant messages.'); }
    }
    return new FakeProvider([
      { role: 'assistant', content: '', toolCalls: [{ id: 'demo-read', name: 'read_file', arguments: { path: 'package.json' } }] },
      request => ({ role: 'assistant', content: `Offline demo — read_file result:\n${request.messages.at(-1)?.content ?? ''}`, toolCalls: [] }),
    ]);
  }
  if (typeof values.script === 'string') throw new MarsError('ConfigurationError', '--script is only available with fake:scripted.');
  if (providerId === 'openai') {
    const credential = await resolveCredential('openai', { store: credentials });
    if (!credential) throw new MarsError('AuthenticationError', 'Set OPENAI_API_KEY or use login openai --api-key.');
    return new OpenAIProvider(credential);
  }
  if (providerId === 'openrouter') {
    const credential = await resolveCredential(providerId, { store: credentials });
    if (!credential) throw new MarsError('AuthenticationError', 'Set OPENROUTER_API_KEY or use login openrouter --api-key.');
    return new OpenRouterProvider(credential);
  }
  if (providerId === 'ollama') return new OllamaProvider();
  if (!['openai-codex', 'anthropic', 'kimi-code', 'gemini', 'qwen'].includes(providerId)) throw new MarsError('ConfigurationError', 'Supported providers: openai, openai-codex, anthropic, kimi-code, gemini, qwen, openrouter, ollama and fake.');
  const auth = authProvider(providerId);
  if (providerId === 'qwen') {
    const credential = await resolveAuthCredential(providerId, { store: credentials });
    if (credential?.kind !== 'api-key') throw new MarsError('AuthenticationError', 'Qwen requires a Model Studio API key or Token Plan key.');
    return new QwenProvider(credential);
  }
  if (providerId === 'gemini') {
    const credential = await resolveAuthCredential(providerId, { store: credentials });
    if (!credential) throw new MarsError('AuthenticationError', 'Set GOOGLE_API_KEY or connect Gemini with mars login gemini.');
    const refreshed = auth ? await refreshCredential(auth, credential, { store: credentials, context: authContext(new AbortController().signal) }) : credential;
    return new GeminiProvider(refreshed);
  }
  if (!auth) throw new MarsError('ConfigurationError', `No authentication adapter for ${providerId}.`);
  const credential = await resolveAuthCredential(providerId, { store: credentials });
  if (!credential) throw new MarsError('AuthenticationError', `Connect ${providerId} with mars login ${providerId}.`);
  const refreshed = await refreshCredential(auth, credential, { store: credentials, context: authContext(new AbortController().signal) });
  if (providerId === 'openai-codex') {
    if (refreshed.kind !== 'external' || refreshed.source !== 'codex-cli') throw new MarsError('AuthenticationError', 'OpenAI Codex requires ChatGPT authentication managed by Codex.');
    return new OpenAICodexProvider(refreshed);
  }
  if (refreshed.kind !== 'oauth' && refreshed.kind !== 'api-key') throw new MarsError('AuthenticationError', 'Provider credential is invalid.');
  return providerId === 'anthropic' ? new AnthropicProvider(refreshed) : new KimiCodeProvider(refreshed);
}

export async function workspaceRoot(input: string | undefined): Promise<string> { return (await Workspace.open(input ?? process.cwd())).root; }
export function approval(screen?: ConversationScreen) {
  return async (command: string, cwd: string, signal: AbortSignal): Promise<boolean> => {
    if (!process.stdin.isTTY) return false;
    if (screen) return screen.confirm(command, cwd, signal);
    return /^y(es)?$/i.test((await prompt(`\nShell (host access) in ${safe(cwd)}:\n${safe(command)}\nAllow this command? [y/N] `, signal)).trim());
  };
}

export async function createSessionMars(target: string, root: string, values: Record<string, unknown>, credentials: CredentialStore, sessionId?: string, screen?: ConversationScreen) {
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
  return { mars: await createMars(options), sessionStore, eventLog, roleTargets: roleSelection?.targets ?? [] };
}

export async function workflowRoleProviders(root: string, values: Record<string, unknown>, credentials: CredentialStore, primaryTarget: string, primaryProvider: ModelProvider, config: Awaited<ReturnType<typeof loadConfig>>['config']): Promise<{ providers: Partial<Record<(typeof WORKFLOW_ROLES)[number], { provider: ModelProvider; model: string }>>; targets: string[] } | undefined> {
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
