// Runs the eval corpus in several conditions and records one JSONL row per run.
//   mars-claude, mars-codex: MARS bugfix with --engine claude|codex doing the work
//   claude:   Claude Code `claude -p --bare` with ANTHROPIC_API_KEY only, edits accepted, shell limited to npm/node
//   agy:      Antigravity `agy -p` in its sandbox with edits accepted
//   mars:     mars run REPORT --workflow bugfix --isolate (diff applied afterwards)
//   baseline: the same bundled Codex binary, `codex exec` in workspace-write mode, same model and time limit
// Then the hidden acceptance tests run on the resulting tree. Consumes real model quota.
// A false proof is split by the hidden tests it fails: `reported` (the reported example itself, so the proof was wrong)
// or `scope` (other cases of the contract, outside what the reproduction covered); `checks` when the project checks fail.
// --prompt contract gives the vendor CLIs the same documented-contract instruction as MARS's bugfix prompts.
// Usage: node evals/run.mjs [--model openai-codex:gpt-5.6-sol] [--conditions mars,baseline,claude,agy] [--prompt plain|contract] [--claude-model sonnet] [--agy-model gemini-4-argon-low] [task-id ...]
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'apps', 'cli', 'src', 'index.js');
const { findCodexBinary } = await import(new URL('../dist/packages/providers/src/codex-runner.js', import.meta.url).href);
const { receiptVerdict } = await import(new URL('../dist/packages/sdk/src/receipt.js', import.meta.url).href);
const { values, positionals } = parseArgs({ allowPositionals: true, options: { model: { type: 'string', default: 'openai-codex:gpt-5.6-sol' }, conditions: { type: 'string', default: 'mars,baseline' }, timeout: { type: 'string', default: '900000' }, 'claude-model': { type: 'string', default: 'sonnet' }, 'agy-model': { type: 'string', default: 'gemini-4-argon-low' }, prompt: { type: 'string', default: 'plain' } } });
if (!['plain', 'contract'].includes(values.prompt)) throw new Error('--prompt must be plain or contract');
const timeoutMs = Number(values.timeout);
const [, codexModel] = values.model.split(':');

const shell = command => process.platform === 'win32'
  ? ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]]
  : ['/bin/sh', ['-c', command]];
const sh = (command, cwd) => { const [file, args] = shell(command); const r = spawnSync(file, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 }); return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }; };
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).stdout.trim();
const matches = (file, globs) => globs.some(glob => path.matchesGlob(file, glob));
// Failing test names from node:test output, without the per-file summary lines.
const failedTests = output => [...new Set([...output.matchAll(/^\s*✖ (.+?) \(\d[\d.]*m?s\)\s*$/gm)].map(match => match[1]).filter(name => !/\.eval-hidden|\.m?js$/.test(name)))];

async function prepare(task) {
  const work = await mkdtemp(path.join(tmpdir(), `mars-bench-${task.id}-`));
  await cp(path.join(here, 'tasks', task.id, 'repo'), work, { recursive: true });
  await writeFile(path.join(work, '.gitignore'), 'node_modules/\n.mars/\n.eval-hidden/\nreceipt.md\nreport.json\n');
  await mkdir(path.join(work, '.mars'));
  await writeFile(path.join(work, '.mars', 'config.json'), JSON.stringify({ verification: { commands: task.checks } }));
  git(work, 'init', '-q'); git(work, 'config', 'user.email', 'bench@local'); git(work, 'config', 'user.name', 'bench'); git(work, 'config', 'core.autocrlf', 'false');
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'initial');
  return work;
}

function runMars(task, work, extra = []) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [cli, 'run', task.report, '--workflow', 'bugfix', '--isolate', '--model', values.model, '--allow-shell',
    '--timeout', '300000', '--max-retries', '2', '--budget-requests', '60', '--budget-time', String(timeoutMs), '--receipt', 'receipt.md', '--report', 'report.json', '--no-animation', ...extra],
    { cwd: work, encoding: 'utf8', windowsHide: true, timeout: timeoutMs + 120_000, input: '' });
  return { seconds: (Date.now() - started) / 1000, exit: r.status, log: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function finishMars(work, run) {
  let report;
  try { report = JSON.parse(await readFile(path.join(work, 'report.json'), 'utf8')).runs.at(-1); } catch { /* no report */ }
  if (report?.isolation?.files.length) spawnSync(process.execPath, [cli, 'runs', 'apply', report.isolation.id], { cwd: work, encoding: 'utf8', windowsHide: true });
  const verdict = report ? receiptVerdict(report) : { ok: false, label: 'No report' };
  const tokens = report?.usage.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0) ?? null;
  return { status: report?.status ?? 'missing', error: report?.error, verdict: verdict.label, claimed: verdict.label === 'Fixed and proven', needsReview: verdict.label === 'Test change proposed', proofScope: report?.proof?.scope, requests: report?.modelRequests ?? null, tokens, tokensKnown: report?.budget?.tokensKnown ?? false, repairs: report?.repairAttempts ?? 0, seconds: run.seconds };
}

// Same instructions for every vendor CLI.
const contract = 'Lee la documentación y los comentarios del código implicado: cada regla documentada que el código actual incumple forma parte del bug, aunque el informe muestre un solo síntoma. Arregla el código para que cumpla su contrato documentado; el test es el mínimo, no el objetivo. ';
const baselinePrompt = task => `${task.report}\n\n${values.prompt === 'contract' ? contract : ''}Arregla el bug en este repositorio y añade o actualiza un test que lo cubra. Ejecuta los tests del proyecto (${task.checks.join(', ')}) antes de terminar. Si no puedes reproducir el problema, no cambies el código y explica por qué.`;

function runBaseline(task, work) {
  const { executable, pathDirs } = findCodexBinary();
  const prompt = baselinePrompt(task);
  const env = { ...process.env, PATH: [...pathDirs, process.env.PATH ?? ''].join(path.delimiter) };
  const started = Date.now();
  const r = spawnSync(executable, ['exec', '--experimental-json', '--ignore-user-config', '--model', codexModel, '--sandbox', 'workspace-write', '--skip-git-repo-check',
    '--config', 'model_reasoning_effort="low"', '--config', 'approval_policy="never"',
    // --ignore-user-config drops the user's Windows sandbox mode; the default one rejects every command.
    ...(process.platform === 'win32' ? ['--config', 'windows.sandbox="elevated"'] : []), '--cd', work], { cwd: work, env, input: prompt, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  let tokens = 0, turns = 0, completed = false, final = '';
  for (const line of (r.stdout ?? '').split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.completed') { completed = true; turns++; tokens += (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0); }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') final = event.item.text ?? '';
    } catch { /* not JSON */ }
  }
  return { status: completed ? 'completed' : r.error?.code === 'ETIMEDOUT' ? 'timeout' : 'failed', requests: turns, tokens: completed ? tokens : null, tokensKnown: completed, seconds: (Date.now() - started) / 1000, final: final.slice(0, 500), log: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `
${r.error.message}` : ''}` };
}

function runClaude(task, work) {
  const started = Date.now();
  // --bare: Claude Code authenticates only with ANTHROPIC_API_KEY. MARS_EVAL_CLAUDE_LOGIN=1 (developer evaluation
  // only) lets Claude Code use its own login instead.
  const localLogin = process.env.MARS_EVAL_CLAUDE_LOGIN === '1';
  if (!localLogin && !process.env.ANTHROPIC_API_KEY) return { status: 'failed', model: values['claude-model'], requests: 0, tokens: null, tokensKnown: false, seconds: 0, final: '', log: 'ANTHROPIC_API_KEY (or MARS_EVAL_CLAUDE_LOGIN=1 for local evaluation) is required for the claude condition.' };
  // The prompt goes through stdin so it never depends on argument quoting.
  const r = spawnSync('claude', ['-p', ...(localLogin ? [] : ['--bare']), '--output-format', 'json', '--model', values['claude-model'], '--effort', 'low', '--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands',
    '--no-session-persistence', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npm:*)', 'Bash(node:*)'],
    { cwd: work, input: baselinePrompt(task), encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  let result;
  try { result = JSON.parse(r.stdout); } catch { /* not JSON */ }
  const usage = result?.usage;
  const tokens = usage ? usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens : null;
  return { status: result?.subtype === 'success' ? 'completed' : r.error?.code === 'ETIMEDOUT' ? 'timeout' : 'failed', model: Object.keys(result?.modelUsage ?? {}).join(',') || values['claude-model'],
    requests: result?.num_turns ?? null, tokens, tokensKnown: tokens !== null, seconds: (Date.now() - started) / 1000, final: String(result?.result ?? '').slice(0, 500), log: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

function runAgy(task, work) {
  const started = Date.now();
  const r = spawnSync('agy', ['-p', baselinePrompt(task), '--output-format', 'json', '--model', values['agy-model'], '--mode', 'accept-edits', '--sandbox', '--disable-slash-commands'],
    { cwd: work, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  let result;
  try { result = JSON.parse(r.stdout); } catch { /* not JSON */ }
  const tokens = result?.usage?.total_tokens ?? null;
  return { status: result?.status === 'SUCCESS' ? 'completed' : r.error?.code === 'ETIMEDOUT' ? 'timeout' : 'failed', model: values['agy-model'],
    requests: result?.num_turns ?? null, tokens, tokensKnown: tokens !== null, seconds: (Date.now() - started) / 1000, final: String(result?.response ?? '').slice(0, 500), log: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}
const engines = { baseline: runBaseline, claude: runClaude, agy: runAgy };

async function evaluate(task, work) {
  const changed = [...new Set([...git(work, 'diff', '--name-only', 'HEAD').split('\n'), ...git(work, 'ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean))];
  await cp(path.join(here, 'tasks', task.id, 'hidden'), path.join(work, '.eval-hidden'), { recursive: true });
  // Intent-to-add makes new files show up in the diff without staging their content.
  spawnSync('git', ['add', '-N', '.'], { cwd: work, windowsHide: true });
  const diff = spawnSync('git', ['diff', 'HEAD'], { cwd: work, encoding: 'utf8', windowsHide: true }).stdout;
  const hidden = sh(task.hidden, work);
  await rm(path.join(work, '.eval-hidden'), { recursive: true, force: true });
  // A fix is correct only if the hidden tests and the project's own checks both pass on the final tree.
  const checksPass = task.checks.every(command => sh(command, work).ok);
  const sourceChanged = changed.filter(file => !/(^|\/)(tests?|__tests__)\/|\.test\.[^/]+$/.test(file));
  return { diff, hiddenOutput: hidden.output, hiddenPass: hidden.ok, hiddenFailed: hidden.ok ? [] : failedTests(hidden.output), checksPass, correct: hidden.ok && checksPass, changed, outOfScope: task.kind === 'fix' ? changed.filter(file => !matches(file, task.scope)) : [], sourceChanged };
}

const tasksDir = path.join(here, 'tasks');
const ids = positionals.length ? positionals : (await readdir(tasksDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const conditions = values.conditions.split(',');
const out = path.join(here, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
await mkdir(path.dirname(out), { recursive: true });
for (const id of ids) {
  const task = JSON.parse(await readFile(path.join(tasksDir, id, 'task.json'), 'utf8'));
  for (const condition of conditions) {
    const work = await prepare(task);
    process.stderr.write(`▶ ${id} · ${condition}\n`);
    let row;
    try {
      const isMars = condition.startsWith('mars');
      const marsRun = isMars ? runMars(task, work, condition === 'mars' ? [] : ['--engine', condition.slice('mars-'.length)]) : undefined;
      if (!marsRun && !engines[condition]) throw new Error(`Unknown condition: ${condition}`);
      const result = marsRun ? await finishMars(work, marsRun) : engines[condition](task, work);
      // Keep the evidence of every run next to the results for later diagnosis.
      const artifacts = path.join(out.replace(/\.jsonl$/, ''), `${id}-${condition}`);
      await mkdir(artifacts, { recursive: true });
      for (const file of ['report.json', 'receipt.md']) await cp(path.join(work, file), path.join(artifacts, file)).catch(() => {});
      await cp(path.join(work, '.mars', 'events.jsonl'), path.join(artifacts, 'events.jsonl')).catch(() => {});
      const { log, ...summary } = result;
      await writeFile(path.join(artifacts, 'output.log'), marsRun ? marsRun.log : log);
      const { diff, hiddenOutput, ...outcome } = await evaluate(task, work);
      await writeFile(path.join(artifacts, 'changes.diff'), diff);
      await writeFile(path.join(artifacts, 'hidden.log'), hiddenOutput);
      // A "claim" for the baseline is changing source code; for MARS it is the Fixed and proven verdict.
      const claimed = isMars ? result.claimed : outcome.sourceChanged.length > 0;
      row = { task: id, kind: task.kind, condition, model: values.model, ...(isMars ? {} : { prompt: values.prompt }), ...summary, ...outcome, claimed,
        falseProof: isMars ? result.claimed && !outcome.correct : null,
        falseProofKind: isMars && result.claimed && !outcome.correct ? (!outcome.checksPass ? 'checks' : outcome.hiddenFailed.some(name => task.reportedTests?.includes(name)) ? 'reported' : 'scope') : null,
        trapViolated: task.kind === 'trap' ? claimed || !outcome.hiddenPass : null, at: new Date().toISOString() };
    } catch (error) {
      row = { task: id, kind: task.kind, condition, model: values.model, status: 'harness-error', error: String(error?.message ?? error), at: new Date().toISOString() };
    } finally { await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    await appendFile(out, `${JSON.stringify(row)}\n`);
    process.stderr.write(`  ${row.status} · hidden ${row.hiddenPass ? 'pass' : `FAIL${row.falseProofKind ? ` (${row.falseProofKind})` : ''}`} · ${condition.startsWith('mars') ? row.verdict : `claimed ${row.claimed}`} · ${row.seconds?.toFixed?.(0) ?? '?'} s · ${row.tokens ?? '?'} tokens\n`);
  }
}
process.stdout.write(`${out}\n`);
