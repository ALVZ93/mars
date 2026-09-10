import path from 'node:path';
import { FileSessionStore, MarsError, loadConfig, routeTask, saveConfig, projectConfigPath } from '../../../../packages/sdk/src/internal.js';
import type { CredentialStore } from '../../../../packages/sdk/src/internal.js';
import { ConversationScreen } from '../conversation.js';
import { choose } from '../terminal.js';
import { loginCommand } from '../commands/auth.js';
import { configCommand, evidenceCommand, healthCommand, renderCheckReport, selectModel, sessionsCommand, skillsCommand, workflowsCommand } from '../commands/index.js';
import { createSessionMars } from '../session.js';
import { help, prompt, safe, targetParts } from '../utils/common.js';
export async function interactive(root: string, values: Record<string, unknown>, credentials: CredentialStore, target: string): Promise<void> {
  let currentTarget = target;
  const loaded = await loadConfig(root);
  const screen = new ConversationScreen(currentTarget, root, loaded.config.limits.maxContextChars);
  screen.start();
  let activeMars = await createSessionMars(currentTarget, root, values, credentials, undefined, screen);
  const sessionStore = activeMars.sessionStore ?? new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const outside = async <T>(work: () => Promise<T>): Promise<T> => {
    screen.suspend();
    try { return await work(); } finally { screen.resume(currentTarget); }
  };
  const refresh = () => screen.setContext(JSON.stringify(activeMars.mars.session.messages).length);
  const attach = () => {
    activeMars.mars.on('model:response', refresh);
    activeMars.mars.on('tool:end', refresh);
  };
  attach();
  const execute = async (task: string) => {
    const controller = new AbortController();
    screen.setInterrupt(() => controller.abort());
    screen.setRunning(true);
    screen.addUser(task);
    try {
      if (typeof values.workflow === 'string') await activeMars.mars.runWorkflow(values.workflow, task, controller.signal);
      else await activeMars.mars.run(task, controller.signal);
      screen.addNotice(`[session] ${activeMars.mars.id}`);
    } catch (error) {
      screen.addNotice(error instanceof MarsError ? `${error.code}: ${safe(error.message)}` : 'MARS failed.');
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
              const selected = await choose(`Shell: ${activeMars.mars.shellPolicy}`, ['Preguntar cada vez', 'Permitir durante esta sesión', 'Permitir y guardar en este proyecto', 'Denegar durante esta sesión'], label => prompt(label, new AbortController().signal), text => process.stdout.write(text));
              policy = ['ask', 'allow', 'allow', 'deny'][selected];
              scope = selected === 2 ? 'project' : 'session';
            }
            if (!['allow', 'ask', 'deny'].includes(policy!) || !['session', 'project'].includes(scope) || parts.length > 2) throw new MarsError('ConfigurationError', 'Use /permissions [allow|ask|deny] [session|project].');
            return { policy: policy as 'allow' | 'ask' | 'deny', scope };
          });
          if (result.scope === 'project') await saveConfig(projectConfigPath(root), { permissions: { shell: result.policy } });
          activeMars.mars.setShellPolicy(result.policy);
          values.shellPolicy = result.policy;
          screen.addNotice(`Shell: ${result.policy} (${result.scope}). Red y comandos destructivos mantienen sus políticas.`);
        } catch (error) { screen.addNotice(error instanceof MarsError ? `${error.code}: ${safe(error.message)}` : 'Permission command failed.'); }
        continue;
      }
      if (task === '/help') { screen.addNotice(help); continue; }
      if (task === '/login') { try { await outside(() => loginCommand(undefined, values, credentials)); } catch (error) { screen.addNotice(safe(error instanceof Error ? error.message : 'Login failed.')); } continue; }
      if (task === '/models' || task === '/model' || task === '/providers') {
        try {
          const nextTarget = await outside(() => selectModel(root, credentials, currentTarget));
          const replacement = await createSessionMars(nextTarget, root, values, credentials, values['no-save'] === true ? undefined : activeMars.mars.id, screen);
          await activeMars.mars.close();
          await activeMars.eventLog?.flush();
          activeMars = replacement;
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
      if (task === '/check') { try { await outside(async () => renderCheckReport(await activeMars.mars.verify())); } catch (error) { screen.addNotice(safe(error instanceof Error ? error.message : 'Check failed.')); } continue; }
      if (task === '/route') { screen.addNotice(JSON.stringify(routeTask('implement task', { explicit: currentTarget }), null, 2)); continue; }
      if (task === '/new') { await activeMars.mars.close(); await activeMars.eventLog?.flush(); activeMars = await createSessionMars(currentTarget, root, values, credentials, undefined, screen); attach(); screen.addNotice('New persisted session.'); continue; }
      if (task.startsWith('/model ')) {
        const nextTarget = task.slice('/model '.length).trim();
        try {
          targetParts(nextTarget);
          const previousId = values['no-save'] === true ? undefined : activeMars.mars.id;
          await activeMars.mars.close();
          await activeMars.eventLog?.flush();
          activeMars = await createSessionMars(nextTarget, root, values, credentials, previousId, screen);
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
        await activeMars.mars.close();
        await activeMars.eventLog?.flush();
        activeMars = await createSessionMars(currentTarget, root, values, credentials, id, screen);
        attach();
        screen.setModel(currentTarget);
        screen.addNotice(`Resumed ${id}.`);
        continue;
      }
      if (task.startsWith('/')) { screen.addNotice('Unknown command. Use /help.'); continue; }
      await execute(task);
    }
  } finally {
    await activeMars.mars.close();
    await activeMars.eventLog?.flush();
    screen.stop();
  }
}
