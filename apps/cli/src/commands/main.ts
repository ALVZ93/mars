import { parseArgs } from 'node:util';
import { MarsError, MODEL_CATALOG, createCredentialStore, loadConfig, projectConfigPath, routeTask, saveConfig } from '../../../../packages/sdk/src/internal.js';
import { validTarget } from '../terminal.js';
import { authCommand, authenticatedProviders, loginCommand } from './auth.js';
import { checkCommand, configCommand, doctorCommand, evidenceCommand, healthCommand, modelsCommand, resumeSession, runTask, selectModel, sessionsCommand, skillsCommand, workflowsCommand } from './index.js';
import { interactive } from '../interactive/repl.js';
import { help, safe, workspaceRoot } from '../utils/common.js';
import { resolveTarget } from '../session.js';
export async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: {
      model: { type: 'string' }, workspace: { type: 'string' }, script: { type: 'string' },
      'allow-shell': { type: 'boolean' }, 'api-key': { type: 'boolean' }, browser: { type: 'boolean' }, device: { type: 'boolean' },
      'max-turns': { type: 'string' }, 'max-tool-calls': { type: 'string' }, timeout: { type: 'string' }, 'max-retries': { type: 'string' }, 'retry-delay': { type: 'string' }, sandbox: { type: 'string' }, route: { type: 'boolean' }, workflow: { type: 'string' }, verify: { type: 'boolean' }, json: { type: 'boolean' }, 'no-save': { type: 'boolean' }, 'no-animation': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    } });
  } catch { throw new MarsError('ConfigurationError', 'Invalid command arguments. Use --help.'); }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(help); return; }
  if (values.version) { process.stdout.write('0.1.0\n'); return; }
  const command = positionals[0];
  const known = new Set(['run', 'login', 'logout', 'auth', 'resume', 'new', 'sessions', 'check', 'models', 'route', 'workflows', 'doctor', 'init', 'config', 'skills', 'evidence', 'health']);
  const shorthand = Boolean(command && !known.has(command) && !command.startsWith('/'));
  if (command === 'run' && !positionals.slice(1).join(' ').trim()) throw new MarsError('ConfigurationError', 'Provide a task to run.');
  if (command === 'doctor') { await doctorCommand(await workspaceRoot(typeof values.workspace === 'string' ? values.workspace : undefined), values.sandbox); return; }
  const credentials = createCredentialStore();
  if (command === 'auth') { await authCommand(positionals, credentials); return; }
  if (command === 'logout') { if (!positionals[1]) throw new MarsError('ConfigurationError', 'Provide a provider to logout.'); await authCommand(['auth', 'logout', positionals[1]], credentials); return; }
  if (command === 'login') { if (!process.stdin.isTTY) throw new MarsError('ConfigurationError', 'Login requires an interactive terminal.'); await loginCommand(positionals[1], values as Record<string, unknown>, credentials); return; }
  if (command === 'models') { await modelsCommand(values.json === true); return; }
  if (command === 'workflows') { await workflowsCommand(); return; }
  let root = await workspaceRoot(typeof values.workspace === 'string' ? values.workspace : undefined);
  if (command === 'init') { await saveConfig(projectConfigPath(root), {}); process.stdout.write(`Created ${projectConfigPath(root)}\n`); return; }
  if (command === 'config') { await configCommand(positionals, root); return; }
  if (command === 'sessions') { await sessionsCommand(root, values.json === true); return; }
  if (command === 'check') { await checkCommand(root, values as Record<string, unknown>, values.json === true); return; }
  if (command === 'skills') { await skillsCommand(root); return; }
  if (command === 'evidence') { await evidenceCommand(root, positionals[1] ?? 'show', values.json === true); return; }
  if (command === 'health') { await healthCommand(root, credentials, values.json === true); return; }
  const task = command === 'run' || command === 'route' ? positionals.slice(1).join(' ').trim() : shorthand ? positionals.join(' ').trim() : undefined;
  if (command === 'route' && !task) throw new MarsError('ConfigurationError', 'Provide a task to route.');
  if (!process.stdin.isTTY && !task && command !== 'resume') { process.stdout.write(help); return; }
  let target: string;
  let resumeId: string | undefined;
  if (command === 'resume') {
    resumeId = positionals[1];
    if (!resumeId) throw new MarsError('ConfigurationError', 'Provide a session ID.');
    const resumed = await resumeSession(resumeId, root, typeof values.workspace === 'string');
    root = resumed.root;
    const session = resumed.session;
    target = (typeof values.model === 'string' ? values.model : undefined) ?? session.model;
  } else if (!task && process.stdin.isTTY && !values.model) {
    const configured = (await loadConfig(root)).config.model.default;
    const preferred = configured ?? process.env.MARS_MODEL;
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

export function report(error: unknown): number {
  const known = error instanceof MarsError;
  const cancelled = (known && error.code === 'CancelledError') || (error instanceof Error && error.name === 'AbortError');
  process.stderr.write(cancelled ? 'Cancelled.\n' : known ? `${error.code}: ${safe(error.message)}\n` : `MARS failed: ${safe(error instanceof Error ? error.message : 'Check the workspace and configuration.')}\n`);
  return cancelled ? 130 : 1;
}
