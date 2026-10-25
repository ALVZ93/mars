import { homedir } from 'node:os';
import { redactKnowledgeSecrets } from '../../runtime/src/index.js';
import type { RunReport } from './reports.js';

// Every dynamic value is redacted and confined to an inline code span or a fenced block, so file names,
// commands and check output can neither inject Markdown/HTML into a PR nor publish recognisable credentials.
const code = (value: string) => `\`${redactKnowledgeSecrets(value).replaceAll('`', 'ˋ').replace(/[\s\u0000-\u001f]+/g, ' ').slice(0, 300)}\``;
/** Plain text for headings and prose: no control characters, Markdown or HTML syntax. */
const text = (value: string) => redactKnowledgeSecrets(value).replace(/[\s\u0000-\u001f]+/g, ' ').replace(/[\\`*_#<>[\]|~!]/g, '').trim().slice(0, 120);
/** Inline code inside a table cell: GFM splits cells on `|` even within code spans. */
const cell = (span: string) => span.replaceAll('|', '\\|');
const block = (value: string) => ['~~~text', redactKnowledgeSecrets(value).replaceAll('~~~', '~ ~ ~').slice(0, 2_000).trimEnd(), '~~~'];
const seconds = (ms: number) => ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Local absolute paths (the execution root, also as file:// URLs, and the home directory) become relative
 * paths or `~`, so a receipt pasted into a PR does not expose the author's machine layout.
 */
export function relativizePaths(text: string, root?: string, home = homedir()): string {
  const flags = process.platform === 'win32' || process.platform === 'darwin' ? 'gi' : 'g';
  let result = text;
  for (const [base, replacement] of [[root, '.'], [home, '~']] as const) {
    if (!base || base.length < 3) continue;
    const forward = base.replaceAll('\\', '/').replace(/\/+$/, '');
    const native = base.replace(/[\\/]+$/, '');
    for (const variant of new Set([`file:///${forward.replace(/^\//, '')}`, `file://${forward}`, forward, native])) {
      result = result.replace(new RegExp(`${escapeRegExp(variant)}(?=[\\\\/]|$|[^\\w.-])`, flags), replacement);
    }
  }
  return result;
}

/** Verdict of one operation: what a reviewer can trust without reading the transcript. */
export function receiptVerdict(report: RunReport): { ok: boolean; label: string } {
  if (report.status !== 'completed') return { ok: false, label: report.status === 'cancelled' ? 'Cancelled' : `Failed${report.error ? ` (${report.error})` : ''}` };
  if (report.contract?.modified.length) return { ok: false, label: 'Contract violated' };
  if (report.proof && (!report.proof.green || report.verificationStatus !== 'passed')) return { ok: false, label: 'Not proven' };
  if (report.proof) return { ok: true, label: 'Fixed and proven' };
  if (report.verificationStatus === 'passed') return { ok: true, label: 'Verified' };
  return { ok: false, label: 'Completed without verification' };
}

/**
 * Markdown receipt for a PR comment or review: proof, contract, checks, changes and cost.
 * It contains commands and truncated check output but never prompts or model responses.
 */
export function renderReceipt(reports: readonly RunReport[], options: { title?: string } = {}): string {
  const lines: string[] = [];
  for (const report of reports) {
    const clean = (value: string) => relativizePaths(value, report.workspace);
    const c = (value: string) => code(clean(value));
    const b = (value: string) => block(clean(value));
    const verdict = receiptVerdict(report);
    lines.push(`## ${verdict.ok ? '✅' : '❌'} ${text(options.title ?? 'MARS') || 'MARS'} — ${verdict.label}`, '');
    lines.push(`${report.kind}${report.workflow ? ` ${c(report.workflow)}` : ''} · ${report.startedAt.slice(0, 19).replace('T', ' ')} UTC · ${seconds(report.durationMs)} · run ${c(report.id.slice(0, 8))}`, '');

    if (report.proof) {
      const { proof } = report;
      lines.push('### Proof', '');
      lines.push(`Reproduction: ${c(proof.command)} (${proof.files.map(c).join(', ')})`, '');
      lines.push(`- Before the fix: ${proof.red.exitCode === null ? 'did not run' : `failed with exit ${proof.red.exitCode}`} — expected`);
      if (proof.control) lines.push(`- With the test emptied: exit ${proof.control.exitCode ?? '?'} — the failure comes from the test`);
      lines.push(`- After the fix: ${proof.green ? `passed (exit ${proof.green.exitCode})` : 'not passing'}`);
      lines.push('', '<details><summary>Failure before the fix</summary>', '', ...b(proof.red.output || '(no output)'), '', '</details>', '');
    }
    if (report.contract) {
      const { files, modified } = report.contract;
      lines.push('### Contract', '');
      lines.push(modified.length
        ? `⚠️ Protected files changed: ${modified.map(c).join(', ')}`
        : `${files.length} protected file(s) unchanged${files.length ? `: ${files.slice(0, 8).map(c).join(', ')}${files.length > 8 ? ', …' : ''}` : ''}.`);
      lines.push('');
    }
    const last = report.verifications.at(-1);
    if (last) {
      lines.push('### Checks', '', '| Command | Result |', '| --- | --- |');
      for (const check of last.report.checks) lines.push(`| ${cell(c(check.command))} | ${check.passed ? '✅ passed' : `❌ ${check.error ?? `exit ${check.exitCode ?? '?'}`}`} |`);
      const skipped = last.report.plannedCommands.slice(last.report.checks.length);
      for (const command of skipped) lines.push(`| ${cell(c(command))} | not run |`);
      if (last.report.reason) lines.push('', ...b(last.report.reason));
      lines.push('');
    }
    if (report.isolation) {
      const { id, files } = report.isolation;
      lines.push('### Changes', '');
      lines.push(files.length ? `${files.length} file(s) in isolated run ${c(id)}:` : `No changes in isolated run ${c(id)}.`);
      for (const file of files.slice(0, 20)) lines.push(`- ${c(file)}`);
      if (files.length > 20) lines.push(`- … ${files.length - 20} more`);
      if (files.length) lines.push('', `Review with ${c(`mars runs diff ${id}`)}; apply with ${c(`mars runs apply ${id}`)}.`);
      lines.push('');
    }
    const tokens = report.usage.length ? report.usage.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0) : undefined;
    const tokensText = tokens === undefined || report.budget?.tokensKnown === false ? `${tokens ?? 0}+ (incomplete usage reports)` : String(tokens);
    lines.push('### Execution', '');
    lines.push(`Models: ${report.models.map(c).join(', ') || 'none'} · requests ${report.modelRequests} (retries ${report.modelRetries}) · tool calls ${report.toolCalls} · repairs ${report.repairAttempts} · tokens ${tokensText}`);
    if (report.permissionDenials) lines.push(`Permission denials: ${report.permissionDenials}`);
    if (report.budget?.exceeded) lines.push(`Budget exhausted: ${report.budget.exceeded}`);
    lines.push('');
  }
  lines.push('<sub>Generated by MARS. Checks were executed by the runtime, not reported by the model.</sub>', '');
  return lines.join('\n');
}
