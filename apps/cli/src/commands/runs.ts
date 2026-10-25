import { MarsError, applyIsolatedRun, discardIsolatedRun, isolatedDiff, listIsolatedRuns } from '../../../../packages/sdk/src/internal.js';
import { safe } from '../utils/common.js';

export async function runsCommand(root: string, positionals: string[], values: Record<string, unknown>, json = false): Promise<void> {
  const [action = 'list', id] = positionals;
  if (action === 'list') {
    const runs = await listIsolatedRuns(root);
    if (json) { process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`); return; }
    if (!runs.length) { process.stdout.write('No isolated runs. Start one with mars run "TASK" --isolate.\n'); return; }
    for (const run of runs) process.stdout.write(`${run.id}  ${run.createdAt ?? ''}  ${run.result && run.result !== run.base ? 'changes' : 'no changes'}  ${run.exists ? 'worktree' : 'refs only'}\n`);
    return;
  }
  if (!id) throw new MarsError('ConfigurationError', `Provide a run ID: mars runs ${action} ID`);
  if (action === 'diff') {
    const diff = await isolatedDiff(root, id, { stat: values.stat === true });
    process.stdout.write(diff ? safe(diff) : 'No changes.\n');
    return;
  }
  if (action === 'apply') {
    const files = await applyIsolatedRun(root, id);
    if (json) { process.stdout.write(`${JSON.stringify({ id, applied: files }, null, 2)}\n`); return; }
    process.stdout.write(files.length ? `Applied ${files.length} file(s) from ${id}:\n${files.map(file => `  ${safe(file)}`).join('\n')}\nReview with git diff. Remove the run with: mars runs discard ${id}\n` : 'No changes to apply.\n');
    return;
  }
  if (action === 'discard') {
    await discardIsolatedRun(root, id);
    process.stdout.write(`Discarded isolated run ${id}. Your working tree was not modified.\n`);
    return;
  }
  throw new MarsError('ConfigurationError', 'Use mars runs [list|diff ID|apply ID|discard ID].');
}

export function isolationSummary(report: { isolation?: { id: string; files: string[] } } | undefined): string {
  const isolation = report?.isolation;
  if (!isolation) return '';
  if (!isolation.files.length) return `[isolated] ${isolation.id} · no changes\n`;
  return `[isolated] ${isolation.id} · ${isolation.files.length} file(s) changed\n  review:  mars runs diff ${isolation.id}\n  apply:   mars runs apply ${isolation.id}\n  discard: mars runs discard ${isolation.id}\n`;
}
