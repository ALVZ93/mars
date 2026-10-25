// Validates the eval corpus without any model: for `fix` tasks the hidden tests must fail on repo/ and pass
// with reference/ applied; for `trap` tasks they must pass on repo/ unchanged. Project checks must pass on
// the accepted solution. Usage: node evals/validate.mjs [task-id ...]
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tasksDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tasks');
const shell = command => process.platform === 'win32'
  ? ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]]
  : ['/bin/sh', ['-c', command]];
const run = (command, cwd) => {
  const [executable, args] = shell(command);
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n') };
};

async function validate(id) {
  const task = JSON.parse(await readFile(path.join(tasksDir, id, 'task.json'), 'utf8'));
  const problems = [];
  for (const field of ['id', 'title', 'kind', 'report', 'hidden', 'checks', 'scope', 'tags']) if (task[field] === undefined) problems.push(`missing ${field}`);
  if (task.id !== id) problems.push('id does not match directory');
  if (!['fix', 'trap'].includes(task.kind)) problems.push('kind must be fix or trap');
  const hasReference = existsSync(path.join(tasksDir, id, 'reference'));
  if (task.kind === 'fix' && !hasReference) problems.push('fix tasks need reference/');
  if (task.kind === 'trap' && hasReference) problems.push('trap tasks must not have reference/');

  const work = await mkdtemp(path.join(tmpdir(), `mars-eval-${id}-`));
  try {
    await cp(path.join(tasksDir, id, 'repo'), work, { recursive: true });
    for (const command of task.checks) {
      const result = run(command, work);
      if (!result.ok) problems.push(`check fails on the initial repo (${command}):\n${result.output}`);
    }
    await cp(path.join(tasksDir, id, 'hidden'), path.join(work, '.eval-hidden'), { recursive: true });
    const before = run(task.hidden, work);
    if (task.kind === 'fix' && before.ok) problems.push('hidden tests already pass on repo/: the bug is not observable');
    if (task.kind === 'trap' && !before.ok) problems.push(`hidden tests fail on repo/ for a trap:\n${before.output}`);
    if (task.kind === 'fix') {
      await cp(path.join(tasksDir, id, 'reference'), work, { recursive: true });
      const after = run(task.hidden, work);
      if (!after.ok) problems.push(`hidden tests fail with reference/:\n${after.output}`);
      await rm(path.join(work, '.eval-hidden'), { recursive: true, force: true });
      for (const command of task.checks) {
        const result = run(command, work);
        if (!result.ok) problems.push(`check fails with reference/ (${command}):\n${result.output}`);
      }
    }
  } finally { await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  return { id, kind: task.kind, problems };
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : (await readdir(tasksDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
let failed = 0;
for (const id of ids) {
  const { kind, problems } = await validate(id);
  if (problems.length) failed++;
  process.stdout.write(`${problems.length ? '✕' : '✓'} ${id} (${kind})\n${problems.map(problem => `  - ${problem.replaceAll('\n', '\n    ')}`).join('\n')}${problems.length ? '\n' : ''}`);
}
process.stdout.write(`\n${ids.length - failed}/${ids.length} tasks valid\n`);
process.exitCode = failed ? 1 : 0;
