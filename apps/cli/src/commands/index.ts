import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { FakeProvider, FileEvidenceStore, FileSessionStore, MarsError, MODEL_CATALOG, Permissions, ProviderHealthTracker, SkillRegistry, Workspace, createCredentialStore, createMars, createSandboxShell, defaultSessionDirectory, evidencePath, eventLogPath, keychainAvailable, loadConfig, projectConfigPath, readEventLogEntries, runProjectChecks, sandboxStatus, saveConfig } from '../../../../packages/sdk/src/internal.js';
import type { CredentialStore, RouteDecision, VerificationReport } from '../../../../packages/sdk/src/internal.js';
import { providerAuthCatalog } from '../../../../packages/auth/src/index.js';
import { showMarsBoot } from '../visual.js';
import { choose } from '../terminal.js';
import { approval, createSessionMars } from '../session.js';
import { authProvider, authenticatedProviders, loginCommand } from './auth.js';
import { prompt, safe, targetParts, workspaceRoot } from '../utils/common.js';
export async function runTask(target: string, root: string, values: Record<string, unknown>, credentials: CredentialStore, task: string, sessionId?: string, route?: RouteDecision): Promise<void> {
  const { mars, eventLog, roleTargets } = await createSessionMars(target, root, values, credentials, sessionId);
  if (route) process.stderr.write(`[route] ${route.role} → ${route.target} (${route.reason})\n`);
  if (roleTargets.length) process.stderr.write(`[workflow routing] ${roleTargets.join(' · ')}\n`);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    if (process.stdout.isTTY && values['no-animation'] !== true) process.stdout.write('\n');
    await showMarsBoot(controller.signal, values['no-animation'] !== true);
    if (typeof values.workflow === 'string') await mars.runWorkflow(values.workflow, task, controller.signal);
    else await mars.run(task, controller.signal);
    if (values.verify === true) renderCheckReport(await mars.verify(controller.signal));
    process.stderr.write(`\n[session] ${mars.id}\n`);
  } finally { process.off('SIGINT', cancel); await mars.close(); await eventLog?.flush(); process.stdout.write('\n'); }
}

export async function modelsCommand(json = false): Promise<void> {
  const credentials = createCredentialStore();
  const connected = new Set(await authenticatedProviders(credentials));
  const values = MODEL_CATALOG.map(model => ({ id: model.id, provider: model.provider, model: model.model, authenticated: model.provider === 'fake' || model.provider === 'ollama' || connected.has(model.provider), capabilities: model.capabilities, metadata: model.metadata }));
  if (json) { process.stdout.write(`${JSON.stringify(values, null, 2)}\n`); return; }
  process.stdout.write('MARS models\n\n');
  for (const model of values) process.stdout.write(`${model.authenticated ? '✓' : '·'} ${model.id}${model.metadata?.subscription ? ' [subscription]' : ''}${model.metadata?.offline ? ' [offline]' : ''}\n`);
  process.stdout.write('\nUse --model provider:model or configure model.default.\n');
}
export async function doctorCommand(root: string, requestedSandbox?: unknown): Promise<void> {
  const loaded = await loadConfig(root);
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  const mode = requestedSandbox === 'docker' || (requestedSandbox === undefined && process.env.MARS_SANDBOX === 'docker') ? 'docker' : 'host';
  const sandbox = sandboxStatus({ mode });
  const fileMode = process.env.MARS_CREDENTIAL_STORE === 'file';
  let providers = 'none';
  let credentialStore = fileMode ? 'development file (explicit)' : keychainAvailable() ? 'native keychain' : 'native keychain unavailable';
  try { providers = (await authenticatedProviders(createCredentialStore())).join(', ') || 'none'; }
  catch (error) {
    credentialStore = `unavailable (${safe(error instanceof Error ? error.message : 'credential backend failed')})`;
    providers = 'unavailable';
  }
  process.stdout.write(`MARS doctor\nworkspace: ${root}\nnode: ${process.version}\ngit: ${git.status === 0 ? safe((git.stdout ?? '').trim()) : 'not available'}\nconfig: ${loaded.sources.length ? loaded.sources.join(', ') : 'defaults'}\nproject config: ${projectConfigPath(root)}\nauthenticated providers: ${providers}\ncredential store: ${credentialStore}\nsandbox: ${sandbox.message}\nnetwork checks: skipped (use a real run to validate provider availability)\n`);
}
export async function configCommand(positionals: string[], root: string): Promise<void> {
  const loaded = await loadConfig(root);
  const action = positionals[1] ?? 'show';
  if (action === 'show') { process.stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`); return; }
  if (action === 'path') { process.stdout.write(`${loaded.paths.project}\n`); return; }
  if (action === 'set' && positionals.length >= 4) {
    const key = positionals[2]!;
    const allowed = new Set(['model.default', 'routing.enabled', 'routing.planner', 'routing.implementer', 'routing.reviewer', 'routing.verifier', 'permissions.shell', 'permissions.destructiveShell', 'permissions.network', 'permissions.gitCommit', 'permissions.gitPush', 'limits.maxTurns', 'limits.maxToolCalls', 'limits.timeoutMs', 'limits.maxContextChars', 'limits.maxRetries', 'limits.retryDelayMs', 'verification.commands', 'mcp.servers']);
    if (!allowed.has(key)) throw new MarsError('ConfigurationError', `Unknown config key: ${key}`);
    const raw = positionals.slice(3).join(' ');
    let value: unknown = raw;
    if (key === 'mcp.servers' || key === 'verification.commands') {
      try { value = JSON.parse(raw); } catch { throw new MarsError('ConfigurationError', `${key} must be valid JSON.`); }
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
  throw new MarsError('ConfigurationError', 'Use config, config path o config set KEY VALUE.');
}
export async function sessionsCommand(root: string, json = false): Promise<void> {
  const sessions = await new FileSessionStore(path.join(root, '.mars', 'sessions')).list(root);
  if (json) { process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`); return; }
  if (!sessions.length) { process.stdout.write('No MARS sessions.\n'); return; }
  for (const session of sessions) process.stdout.write(`${session.id}  ${session.status ?? 'active'}  ${session.model}  ${session.updatedAt}  ${safe(session.lastMessage ?? '')}\n`);
}
export function renderCheckReport(report: VerificationReport, json = false): void {
  if (json) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return; }
  if (report.reason) process.stdout.write(`${report.reason}\n`);
  for (const check of report.checks) process.stdout.write(`${check.passed ? '✓' : '✕'} ${check.command}\n${safe(check.output)}\n`);
  process.stdout.write(report.verified ? 'Verification passed.\n' : 'Verification failed.\n');
  if (!report.verified) throw new MarsError('ToolExecutionError', report.reason ?? 'Project verification failed.');
}
export async function checkCommand(root: string, values: Record<string, unknown>, json = false): Promise<void> {
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
export async function skillsCommand(root: string): Promise<void> {
  const skills = await new SkillRegistry(root).list();
  if (!skills.length) { process.stdout.write('No MARS skills found.\n'); return; }
  for (const skill of skills) process.stdout.write(`${skill.scope}\t${skill.name}\t${skill.path}\n`);
}
export async function evidenceCommand(root: string, action = 'show', json = false): Promise<void> {
  const evidence = new FileEvidenceStore(evidencePath(root));
  if (action === 'clear') { await evidence.clear(); process.stdout.write('Cleared MARS evidence.\n'); return; }
  if (action !== 'show') throw new MarsError('ConfigurationError', 'Use evidence or evidence clear.');
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
export async function healthCommand(root: string, credentials: CredentialStore, json = false): Promise<void> {
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
export async function resumeSession(id: string, root: string, workspaceWasExplicit: boolean): Promise<{ session: import('../../../../packages/sdk/src/internal.js').Session; root: string }> {
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
  throw new MarsError('ConfigurationError', `Session not found: ${id}`);
}
export async function workflowsCommand(): Promise<void> {
  const mars = await createMars({ workspace: process.cwd(), provider: new FakeProvider(), model: 'scripted', includeProjectContext: false });
  for (const workflow of mars.workflows) process.stdout.write(`${workflow.id}\t${workflow.description}\n`);
}

export async function selectModel(root: string, credentials: CredentialStore, preferred?: string): Promise<string> {
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
