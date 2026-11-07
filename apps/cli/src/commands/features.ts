import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MarsError, Workspace, detectProjectChecks, featureOutcome, featureTask, loadConfig, loadFeatures, nextFeature, receiptVerdict, renderReceipt, saveFeatures } from '../../../../packages/sdk/src/internal.js';
import type { CredentialStore, Feature, RunReport } from '../../../../packages/sdk/src/internal.js';
import { createSessionMars } from '../session.js';
import { safe } from '../utils/common.js';

const MARK: Record<Feature['status'], string> = { not_started: '·', in_progress: '…', passing: '◐', accepted: '✔', blocked: '✖' };

export async function featuresCommand(root: string, json: boolean): Promise<void> {
  const list = await loadFeatures(root);
  if (json) { process.stdout.write(`${JSON.stringify(list, null, 2)}\n`); return; }
  const next = nextFeature(list);
  for (const feature of list.features) {
    const details = [feature.dependsOn?.length ? `after ${feature.dependsOn.join(', ')}` : '', feature.attempts ? `${feature.attempts} attempt(s)` : '', feature.evidence ? feature.evidence.verdict : ''].filter(Boolean).join(' · ');
    process.stdout.write(`${MARK[feature.status]} ${feature.status.padEnd(11)} ${feature.id}${feature === next ? ' ← next' : ''}\t${safe(feature.title)}${details ? `\t(${safe(details)})` : ''}\n`);
  }
  const counts = list.features.reduce((sum, feature) => ({ ...sum, [feature.status]: (sum[feature.status] ?? 0) + 1 }), {} as Record<string, number>);
  process.stdout.write(`\n${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(' · ')}\n`);
}

/**
 * ADR 011: picks the next open feature, runs it through cross-review and records the outcome. Status comes from the
 * receipt verdict MARS computed, never from the agents; whatever an agent wrote to features.json is discarded.
 */
export async function nextCommand(root: string, values: Record<string, unknown>, credentials: CredentialStore): Promise<void> {
  const list = await loadFeatures(root);
  const count = (flag: string, fallback: number, max: number) => {
    if (typeof values[flag] !== 'string') return fallback;
    const value = Number(values[flag]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new MarsError('ConfigurationError', `--${flag} must be an integer from 1 to ${max}.`);
    return value;
  };
  const maxFeatures = count('max-features', 1, 50);
  const maxAttempts = count('max-attempts', 2, 5);
  const implementer = typeof values.implementer === 'string' ? values.implementer : list.agents?.implementer;
  const reviewer = typeof values.reviewer === 'string' ? values.reviewer : list.agents?.reviewer;
  if (!implementer || !reviewer) throw new MarsError('ConfigurationError', 'mars next needs an implementer and a reviewer: --implementer A --reviewer B, or "agents" in .mars/features.json.');
  const config = (await loadConfig(root)).config;
  // Without a terminal nobody can approve the gate's shell commands, and every attempt would fail on them.
  if (values['allow-shell'] !== true && config.permissions.shell !== 'allow' && !process.stdin.isTTY) throw new MarsError('ConfigurationError', 'mars next runs the project checks through the shell: pass --allow-shell or set permissions.shell to allow.');
  const gate = config.verification.commands.length ? config.verification.commands : await detectProjectChecks(root).then(result => 'checks' in result ? result.checks.map(check => check.command) : []);
  process.stderr.write(`[next] ${implementer} implements, ${reviewer} reviews\n`);
  await runNextFeatures(root, { maxFeatures, maxAttempts, gate, async runFeature(task, verificationCommands) {
    const runValues = { ...values, workflow: 'cross-review', implementer, reviewer, verificationCommands };
    const target = typeof values.model === 'string' ? values.model : 'fake:scripted';
    const { mars, eventLog } = await createSessionMars(target, root, runValues, credentials);
    let failure: unknown;
    try { await mars.runWorkflow('cross-review', task); }
    catch (error) { failure = error; }
    const report = mars.lastRun;
    await mars.close().catch(() => {});
    await eventLog?.flush().catch(() => {});
    return { report, failure };
  } });
}

export interface NextOptions {
  maxFeatures: number;
  maxAttempts: number;
  /** Project checks; each feature's `verify` commands run before them. */
  gate: readonly string[];
  runFeature(task: string, verificationCommands: string[]): Promise<{ report?: RunReport; failure?: unknown }>;
}

/** The loop of ADR 011, separate from how a feature is run so it can be tested without vendor CLIs. */
export async function runNextFeatures(root: string, options: NextOptions): Promise<void> {
  const { maxFeatures, maxAttempts, gate } = options;
  const list = await loadFeatures(root);
  const workspace = await Workspace.open(root);
  for (let done = 0; done < maxFeatures; done++) {
    const feature = nextFeature(list);
    if (!feature) {
      const blocked = list.features.filter(item => item.status === 'blocked').map(item => item.id);
      process.stdout.write(list.features.every(item => item.status === 'accepted') ? 'All features are accepted.\n'
        : `No feature can start: ${blocked.length ? `blocked: ${blocked.join(', ')}; ` : ''}the rest wait on dependencies that are not accepted.\n`);
      return;
    }
    const spec = feature.spec ? await readFile(await workspace.resolve(feature.spec), 'utf8').then(text => text.slice(0, 16_000)).catch(() => { throw new MarsError('ConfigurationError', `${feature.id}: cannot read spec ${feature.spec}.`); }) : undefined;
    feature.status = 'in_progress';
    feature.attempts = (feature.attempts ?? 0) + 1;
    await saveFeatures(root, list);
    process.stderr.write(`\n▶ ${feature.id} · attempt ${feature.attempts}/${maxAttempts}\n`);
    const { report, failure } = await options.runFeature(featureTask(feature, spec), [...(feature.verify ?? []), ...gate]);
    const verdict = report ? receiptVerdict(report) : { ok: false, label: 'No report' };
    feature.status = featureOutcome(verdict, feature.attempts, maxAttempts);
    if (report) {
      feature.evidence = { at: new Date().toISOString(), run: report.id, session: report.sessionId, verdict: verdict.label, reviews: report.reviews?.length ?? 0, ...(report.isolation ? { isolation: report.isolation.id } : {}) };
      const receipt = path.join(root, '.mars', 'features', `${feature.id}.md`);
      await mkdir(path.dirname(receipt), { recursive: true });
      await writeFile(receipt, renderReceipt([report], { title: `Feature ${feature.id}` }), 'utf8');
    }
    await saveFeatures(root, list);
    const reason = failure instanceof Error ? ` · ${safe(failure.message).slice(0, 200)}` : '';
    process.stdout.write(`${MARK[feature.status]} ${feature.id}: ${feature.status} (${verdict.label})${reason}\n`);
    if (report) process.stdout.write(`  receipt: .mars/features/${feature.id}.md\n`);
    if (feature.status !== 'accepted') return;
    if (report?.isolation) { process.stdout.write(`  isolated run ${report.isolation.id}: apply it (mars runs apply ${report.isolation.id}) before the next feature.\n`); return; }
  }
}
