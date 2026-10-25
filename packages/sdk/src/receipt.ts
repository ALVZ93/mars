import { redactKnowledgeSecrets } from '../../runtime/src/index.js';
import type { RunReport } from './reports.js';

// Every dynamic value is redacted and confined to an inline code span or a fenced block, so file names,
// commands and check output can neither inject Markdown/HTML into a PR nor publish recognisable credentials.
const code = (value: string) => `\`${redactKnowledgeSecrets(value).replaceAll('`', 'ˋ').replace(/[\s\u0000-\u001f]+/g, ' ').slice(0, 300)}\``;
const block = (value: string) => ['~~~text', redactKnowledgeSecrets(value).replaceAll('~~~', '~ ~ ~').slice(0, 2_000).trimEnd(), '~~~'];
const seconds = (ms: number) => ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

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
    const verdict = receiptVerdict(report);
    lines.push(`## ${verdict.ok ? '✅' : '❌'} ${options.title ?? 'MARS'} — ${verdict.label}`, '');
    lines.push(`${report.kind}${report.workflow ? ` \`${report.workflow}\`` : ''} · ${report.startedAt.slice(0, 19).replace('T', ' ')} UTC · ${seconds(report.durationMs)} · run \`${report.id.slice(0, 8)}\``, '');

    if (report.proof) {
      const { proof } = report;
      lines.push('### Proof', '');
      lines.push(`Reproduction: ${code(proof.command)} (${proof.files.map(code).join(', ')})`, '');
      lines.push(`- Before the fix: ${proof.red.exitCode === null ? 'did not run' : `failed with exit ${proof.red.exitCode}`} — expected`);
      lines.push(`- After the fix: ${proof.green ? `passed (exit ${proof.green.exitCode})` : 'not passing'}`);
      lines.push('', '<details><summary>Failure before the fix</summary>', '', ...block(proof.red.output || '(no output)'), '', '</details>', '');
    }
    if (report.contract) {
      const { files, modified } = report.contract;
      lines.push('### Contract', '');
      lines.push(modified.length
        ? `⚠️ Protected files changed: ${modified.map(code).join(', ')}`
        : `${files.length} protected file(s) unchanged${files.length ? `: ${files.slice(0, 8).map(code).join(', ')}${files.length > 8 ? ', …' : ''}` : ''}.`);
      lines.push('');
    }
    const last = report.verifications.at(-1);
    if (last) {
      lines.push('### Checks', '', '| Command | Result |', '| --- | --- |');
      for (const check of last.report.checks) lines.push(`| ${code(check.command)} | ${check.passed ? '✅ passed' : `❌ ${check.error ?? `exit ${check.exitCode ?? '?'}`}`} |`);
      const skipped = last.report.plannedCommands.slice(last.report.checks.length);
      for (const command of skipped) lines.push(`| ${code(command)} | not run |`);
      if (last.report.reason) lines.push('', ...block(last.report.reason));
      lines.push('');
    }
    if (report.isolation) {
      const { id, files } = report.isolation;
      lines.push('### Changes', '');
      lines.push(files.length ? `${files.length} file(s) in isolated run ${code(id)}:` : `No changes in isolated run ${code(id)}.`);
      for (const file of files.slice(0, 20)) lines.push(`- ${code(file)}`);
      if (files.length > 20) lines.push(`- … ${files.length - 20} more`);
      if (files.length) lines.push('', `Review with ${code(`mars runs diff ${id}`)}; apply with ${code(`mars runs apply ${id}`)}.`);
      lines.push('');
    }
    const tokens = report.usage.length ? report.usage.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0) : undefined;
    const tokensText = tokens === undefined || report.budget?.tokensKnown === false ? `${tokens ?? 0}+ (incomplete usage reports)` : String(tokens);
    lines.push('### Execution', '');
    lines.push(`Models: ${report.models.map(code).join(', ') || 'none'} · requests ${report.modelRequests} (retries ${report.modelRetries}) · tool calls ${report.toolCalls} · repairs ${report.repairAttempts} · tokens ${tokensText}`);
    if (report.permissionDenials) lines.push(`Permission denials: ${report.permissionDenials}`);
    if (report.budget?.exceeded) lines.push(`Budget exhausted: ${report.budget.exceeded}`);
    lines.push('');
  }
  lines.push('<sub>Generated by MARS. Checks were executed by the runtime, not reported by the model.</sub>', '');
  return lines.join('\n');
}
