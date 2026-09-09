import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  FileEventLog, FileEvidenceStore, FileSessionStore, ProviderHealthTracker, Workspace, Permissions, ToolRegistry, workspaceTools, runProjectChecks,
  McpStdioClient,
  readEventLog, readEventLogEntries,
  loadConfig, saveConfig, routeTask, classifyTask, SkillRegistry, selectWorkflow, ModelRegistry,
  OpenRouterProvider, OllamaProvider,
} from '../dist/packages/sdk/src/index.js';
import { FakeProvider } from '../dist/packages/providers/src/fake.js';
import { createForge } from '../dist/packages/sdk/src/index.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/apps/cli/src/index.js', import.meta.url));

async function tempRoot(t, prefix = 'mars-v02-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('config precedence is project over user over defaults and writes atomically', async t => {
  const root = await tempRoot(t);
  const appData = await tempRoot(t, 'mars-appdata-');
  await saveConfig(path.join(appData, 'mars', 'config.json'), { model: { default: 'openai:from-user' }, limits: { maxTurns: 4, maxRetries: 1, retryDelayMs: 10 } });
  await saveConfig(path.join(root, '.mars', 'config.json'), { model: { default: 'fake:scripted' }, permissions: { shell: 'deny' }, mcp: { servers: [{ name: 'fixture', command: 'node', args: ['server.mjs'] }] } });
  const loaded = await loadConfig(root, { APPDATA: appData, USERPROFILE: appData });
  assert.equal(loaded.config.model.default, 'fake:scripted');
  assert.equal(loaded.config.limits.maxTurns, 4);
  assert.equal(loaded.config.limits.maxRetries, 1);
  assert.equal(loaded.config.limits.retryDelayMs, 10);
  assert.equal(loaded.config.permissions.shell, 'deny');
  assert.deepEqual(loaded.config.mcp.servers[0], { name: 'fixture', command: 'node', args: ['server.mjs'] });
  assert.ok(loaded.sources.some(file => file.endsWith(path.join('.mars', 'config.json'))));
});

test('sessions survive process boundaries and resume from tool observations', async t => {
  const root = await tempRoot(t);
  await writeFile(path.join(root, 'package.json'), '{"name":"session-fixture"}');
  const sessions = new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const first = await createForge({ workspace: root, provider: new FakeProvider([{ role: 'assistant', content: 'first', toolCalls: [] }]), model: 'scripted', sessionStore: sessions });
  await first.run('first task');
  const listed = await sessions.list(root);
  assert.equal(listed.length, 1);
  const saved = await sessions.get(first.id);
  assert.equal(saved?.messages.filter(message => message.role === 'user').length, 1);
  const resumed = await createForge({ workspace: root, provider: new FakeProvider([{ role: 'assistant', content: 'second', toolCalls: [] }]), model: 'scripted', sessionStore: sessions, sessionId: first.id });
  await resumed.run('second task');
  assert.equal(resumed.session.messages.filter(message => message.role === 'user').length, 2);
  assert.equal((await sessions.list(root))[0].messageCount, resumed.session.messages.length);
});

test('search_files finds source lines and git exposes read-only repository state', async t => {
  const root = await tempRoot(t);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'answer.ts'), 'export const answer = 42;\n');
  await writeFile(path.join(root, '.env'), 'answer=secret\n');
  const workspace = await Workspace.open(root);
  const registry = new ToolRegistry(workspaceTools(workspace, new Permissions('deny')));
  const search = await registry.execute({ id: 's', name: 'search_files', arguments: { query: 'answer', path: null, caseSensitive: false, maxResults: null } }, new AbortController().signal);
  assert.equal(search.error, undefined);
  assert.match(search.content, /src\/answer\.ts:1/);
  assert.doesNotMatch(search.content, /secret/);
  try {
    await exec('git', ['init', '-q'], { cwd: root });
    const git = await registry.execute({ id: 'g', name: 'git', arguments: { action: 'status', path: null } }, new AbortController().signal);
    assert.equal(git.error, undefined);
    assert.match(git.content, /answer\.ts|src/);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    t.skip('git is not installed');
  }
});

test('routing and workflow selection are deterministic and do not call a model', () => {
  assert.equal(classifyTask('review this diff'), 'reviewer');
  assert.equal(classifyTask('run tests and verify'), 'verifier');
  assert.equal(selectWorkflow('the tests are failing').id, 'bugfix');
  const decision = routeTask('review this diff', { authenticatedProviders: ['openai-codex'] });
  assert.equal(decision.role, 'reviewer');
  assert.equal(decision.target, 'openai-codex:gpt-5.6-sol');
  assert.ok(decision.candidates.length >= 1);
  assert.throws(() => routeTask('implement this', { authenticatedProviders: [] }));
  const registry = new ModelRegistry();
  assert.ok(registry.byProvider('openai-codex').length >= 1);
  assert.throws(() => registry.register(registry.get('fake:scripted')));
});

test('SDK exposes lifecycle hooks and opt-in workflows with real verification', async t => {
  const root = await tempRoot(t, 'mars-workflow-');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.19.0', scripts: { test: 'node -e "process.exit(0)"' } }));
  const provider = new FakeProvider([
    { role: 'assistant', content: 'inspected', toolCalls: [] },
    { role: 'assistant', content: 'implemented', toolCalls: [] },
    { role: 'assistant', content: 'verified', toolCalls: [] },
  ]);
  const forge = await createForge({ workspace: root, provider, model: 'scripted', includeProjectContext: false, shellPolicy: 'allow' });
  const events = [];
  forge.on('model:request', event => events.push(event));
  await forge.runWorkflow(undefined, 'fix this bug');
  assert.equal(events.length, 3);
  assert.equal(forge.session.messages.filter(message => message.role === 'user').length, 3);
});

test('workflow failures persist a failed session and roles can use separate providers', async t => {
  const root = await tempRoot(t, 'mars-workflow-failure-');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.19.0', scripts: { test: 'node -e "process.exit(1)"' } }));
  const makeProvider = (id, content) => {
    const provider = new FakeProvider([{ role: 'assistant', content, toolCalls: [] }]);
    Object.defineProperty(provider, 'id', { value: id });
    return provider;
  };
  const planner = makeProvider('planner-fake', 'planned');
  const implementer = makeProvider('implementer-fake', 'implemented');
  const verifier = makeProvider('verifier-fake', 'verified');
  const sessions = new FileSessionStore(path.join(root, '.mars', 'sessions'));
  const forge = await createForge({
    workspace: root,
    provider: planner,
    model: 'default',
    sessionStore: sessions,
    includeProjectContext: false,
    roleProviders: {
      planner: { provider: planner, model: 'plan' },
      implementer: { provider: implementer, model: 'implement' },
      verifier: { provider: verifier, model: 'verify' },
    },
  });
  await assert.rejects(forge.runWorkflow('feature', 'add a feature'), { code: 'ToolExecutionError' });
  assert.equal(planner.requests[0]?.model, 'plan');
  assert.equal(implementer.requests[0]?.model, 'implement');
  assert.equal(verifier.requests[0]?.model, 'verify');
  assert.equal(forge.providers.length, 3);
  assert.equal((await sessions.get(forge.id))?.status, 'failed');
});

test('evidence records outcomes without storing task or model content', async t => {
  const root = await tempRoot(t, 'mars-evidence-');
  await mkdir(path.join(root, '.mars', 'skills', 'testing'), { recursive: true });
  await writeFile(path.join(root, '.mars', 'skills', 'testing', 'SKILL.md'), 'Run tests after changes.');
  const evidence = new FileEvidenceStore(path.join(root, '.mars', 'evidence.json'));
  const provider = new FakeProvider([
    { role: 'assistant', content: 'done', toolCalls: [] },
    { role: 'assistant', content: 'done again', toolCalls: [] },
  ]);
  const forge = await createForge({ workspace: root, provider, model: 'scripted', evidenceStore: evidence });
  await forge.run('run testing checks with a sensitive-token-placeholder');
  await forge.run('run testing checks again');
  const snapshot = await evidence.load();
  const skill = Object.values(snapshot.skills)[0];
  assert.equal(skill?.executions, 2);
  assert.equal(skill?.successes, 2);
  assert.equal(Object.values(snapshot.workflows).length, 0);
  const raw = await readFile(evidence.path, 'utf8');
  assert.doesNotMatch(raw, /sensitive-token-placeholder/);
  const suggestions = await evidence.suggestions({ minExecutions: 2, minConfidence: 1 });
  assert.equal(suggestions[0]?.name, 'testing');
});

test('local event log redacts model text and health is derived without probing providers', async t => {
  const root = await tempRoot(t, 'mars-observability-');
  const log = new FileEventLog(path.join(root, '.mars', 'events.jsonl'));
  log.sink({ type: 'model:text', text: 'secret-code-from-model' });
  log.sink({ type: 'model:request', turn: 1, provider: 'fake', model: 'scripted', messageCount: 1, toolCount: 0 });
  log.sink({ type: 'model:response', turn: 1, provider: 'fake', toolCount: 0, contentChars: 4 });
  await log.flush();
  const raw = await readFile(log.path, 'utf8');
  assert.doesNotMatch(raw, /secret-code-from-model/);
  const entries = await readEventLogEntries(log.path);
  assert.equal(entries.filter(entry => entry.event.type === 'model:request').length, 1);
  const tracker = new ProviderHealthTracker();
  tracker.markAuthenticated('fake');
  for (const event of await readEventLog(log.path)) tracker.observe(event, event.type === 'model:request' ? 100 : 142);
  assert.deepEqual(tracker.get('fake'), { provider: 'fake', authenticated: true, reachable: true, rateLimited: false, lastLatencyMs: 42, lastUsedAt: new Date(142).toISOString() });
});

test('MCP stdio bridge discovers and executes a tool in a separate process', async t => {
  const root = await tempRoot(t, 'mars-mcp-');
  const server = path.join(root, 'mcp-fixture.mjs');
  const source = String.raw`import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') respond(request.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } });
  else if (request.method === 'tools/list') respond(request.id, { tools: [{ name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] });
  else if (request.method === 'tools/call') respond(request.id, request.params?.arguments?.value === 'error' ? { isError: true, content: [{ type: 'text', text: 'fixture failed' }] } : { content: [{ type: 'text', text: String(request.params?.arguments?.value ?? '') }] });
});
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
`;
  await writeFile(server, source);
  const client = new McpStdioClient({ name: 'fixture', command: process.execPath, args: [server], timeoutMs: 2_000 });
  const definitions = await client.start(AbortSignal.timeout(5_000));
  assert.equal(definitions[0]?.name, 'echo');
  const registry = new ToolRegistry(client.asTools(definitions));
  const result = await registry.execute({ id: 'mcp-1', name: 'mcp_fixture_echo', arguments: { value: 'ok' } }, AbortSignal.timeout(5_000));
  assert.deepEqual(result, { content: 'ok' });
  const invalid = await registry.execute({ id: 'mcp-2', name: 'mcp_fixture_echo', arguments: { value: 42 } }, AbortSignal.timeout(5_000));
  assert.equal(invalid.error, 'InvalidToolCallError');
  const failed = await registry.execute({ id: 'mcp-3', name: 'mcp_fixture_echo', arguments: { value: 'error' } }, AbortSignal.timeout(5_000));
  assert.equal(failed.error, 'ToolExecutionError');
  assert.equal(client.connected, true);
  await client.close();
  assert.equal(client.connected, false);
});

test('CLI loads project MCP configuration and closes the server after the run', async t => {
  const root = await tempRoot(t, 'mars-cli-mcp-');
  const server = path.join(root, 'mcp-fixture.mjs');
  const marker = path.join(root, 'mcp-called.txt');
  await writeFile(path.join(root, 'package.json'), '{"name":"mcp-fixture"}');
  await mkdir(path.join(root, '.mars'), { recursive: true });
  await writeFile(server, String.raw`import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const marker = ${JSON.stringify(marker)};
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') respond(request.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } });
  else if (request.method === 'tools/list') respond(request.id, { tools: [{ name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] });
  else if (request.method === 'tools/call') { writeFileSync(marker, String(request.params?.arguments?.value ?? '')); respond(request.id, { content: [{ type: 'text', text: 'ok' }] }); }
});
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
`);
  await writeFile(path.join(root, '.mars', 'config.json'), JSON.stringify({ mcp: { servers: [{ name: 'fixture', command: process.execPath, args: [server] }] } }));
  const script = path.join(root, 'fake.json');
  await writeFile(script, JSON.stringify([
    { role: 'assistant', content: '', toolCalls: [{ id: 'mcp-call', name: 'mcp_fixture_echo', arguments: { value: 'from-cli' } }] },
    { role: 'assistant', content: 'MCP done', toolCalls: [] },
  ]));
  const result = spawnSync(process.execPath, [cli, 'run', 'use the MCP fixture', '--model', 'fake:scripted', '--workspace', root, '--script', script, '--no-animation'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, MARS_MODEL: '', FORGE_MODEL: '', OPENAI_API_KEY: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(marker, 'utf8'), 'from-cli');
});

test('SDK extension points register tools, providers and workflows without changing the loop', async t => {
  const root = await tempRoot(t, 'mars-extensions-');
  const forge = await createForge({ workspace: root, provider: new FakeProvider([{ role: 'assistant', content: 'done', toolCalls: [] }]), model: 'scripted', includeProjectContext: false });
  forge.registerTool({ name: 'noop', description: 'No-op test tool', parameters: { type: 'object', properties: {}, additionalProperties: false }, validate: input => input, execute: async () => 'ok' });
  const customProvider = new FakeProvider();
  Object.defineProperty(customProvider, 'id', { value: 'custom-fake' });
  forge.registerProvider(customProvider);
  forge.registerWorkflow({ id: 'custom', description: 'custom', phases: [], matches: () => false });
  assert.ok(forge.tools.schemas().some(tool => tool.name === 'noop'));
  assert.equal(forge.providers.length, 2);
  assert.ok(forge.workflows.some(workflow => workflow.id === 'custom'));
});

test('project skills are selected by task and verification runs real package scripts', async t => {
  const root = await tempRoot(t);
  await mkdir(path.join(root, '.mars', 'skills', 'testing'), { recursive: true });
  await writeFile(path.join(root, '.mars', 'skills', 'testing', 'SKILL.md'), '# Testing\nAlways run the test command.');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.19.0', scripts: { test: 'node -e "process.stdout.write(\\"ok\\")"' } }));
  const skills = await new SkillRegistry(root, root).select('fix this and run tests');
  assert.equal(skills[0]?.name, 'testing');
  const report = await runProjectChecks(await Workspace.open(root), new AbortController().signal);
  assert.equal(report.passed, true);
  assert.equal(report.checks[0]?.name, 'test');
  assert.match(report.checks[0]?.output ?? '', /Exit code: 0/);
});

test('project skills override same-named user skills and selection refreshes for every task', async t => {
  const root = await tempRoot(t, 'mars-skills-project-');
  const home = await tempRoot(t, 'mars-skills-home-');
  await mkdir(path.join(root, '.mars', 'skills', 'testing'), { recursive: true });
  await mkdir(path.join(home, '.mars', 'skills', 'testing'), { recursive: true });
  await mkdir(path.join(root, '.mars', 'skills', 'docs'), { recursive: true });
  await writeFile(path.join(root, '.mars', 'skills', 'testing', 'SKILL.md'), 'PROJECT TESTING');
  await writeFile(path.join(home, '.mars', 'skills', 'testing', 'SKILL.md'), 'USER TESTING');
  await writeFile(path.join(root, '.mars', 'skills', 'docs', 'SKILL.md'), 'DOCUMENTATION TASK');
  const registry = new SkillRegistry(root, home);
  const skills = await registry.list();
  assert.equal(skills.filter(skill => skill.name === 'testing').length, 1);
  assert.equal(skills.find(skill => skill.name === 'testing')?.content, 'PROJECT TESTING');

  const requests = [];
  const provider = new FakeProvider([
    request => { requests.push(request); return { role: 'assistant', content: 'tested', toolCalls: [] }; },
    request => { requests.push(request); return { role: 'assistant', content: 'documented', toolCalls: [] }; },
  ]);
  const forge = await createForge({ workspace: root, provider, model: 'scripted' });
  await forge.run('run testing checks');
  await forge.run('write documentation task');
  const firstSkills = requests[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  const secondSkills = requests[1].messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.match(firstSkills, /PROJECT TESTING/);
  assert.doesNotMatch(firstSkills, /USER TESTING/);
  assert.match(secondSkills, /DOCUMENTATION TASK/);
  assert.doesNotMatch(secondSkills, /PROJECT TESTING/);
});

test('verification requires a real check, permission and a successful structured exit code', async t => {
  const root = await tempRoot(t, 'mars-verification-');
  const workspace = await Workspace.open(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }));
  const empty = await runProjectChecks(workspace, new AbortController().signal);
  assert.equal(empty.verified, false);
  assert.equal(empty.passed, false);

  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'ignored' } }));
  let executions = 0;
  const denied = await runProjectChecks(workspace, new AbortController().signal, {
    permissions: new Permissions('deny'),
    shellExecutor: async () => { executions++; return { exitCode: 0, output: 'ok', truncated: false }; },
  });
  assert.equal(denied.verified, false);
  assert.equal(executions, 0);

  const spoofed = await runProjectChecks(workspace, new AbortController().signal, {
    permissions: new Permissions('allow'),
    shellExecutor: async () => ({ exitCode: 1, output: 'Exit code: 0', truncated: false }),
  });
  assert.equal(spoofed.verified, false);
  assert.equal(spoofed.checks[0]?.exitCode, 1);
});

test('AGENTS.md is included as bounded project context before the first model request', async t => {
  const root = await tempRoot(t, 'mars-context-');
  await writeFile(path.join(root, 'AGENTS.md'), 'Use the project test command after edits.');
  let request;
  const forge = await createForge({
    workspace: root,
    provider: new FakeProvider([requestValue => { request = requestValue; return { role: 'assistant', content: 'ok', toolCalls: [] }; }]),
    model: 'scripted',
  });
  await forge.run('inspect');
  assert.match(request.messages[0].content, /Use the project test command/);
});

test('permission engine denies destructive and network shell by default', async () => {
  const denied = new Permissions('allow');
  await assert.rejects(denied.checkShell('rm -rf build', process.cwd(), new AbortController().signal), { code: 'PermissionDeniedError' });
  const asked = new Permissions('allow', async () => false, { network: 'ask' });
  await assert.rejects(asked.checkShell('curl https://example.com', process.cwd(), new AbortController().signal), { code: 'PermissionDeniedError' });
});

test('OpenRouter and Ollama adapters are available without sharing provider internals', () => {
  assert.equal(new OpenRouterProvider({ provider: 'openrouter', kind: 'api-key', secret: 'test' }).id, 'openrouter');
  assert.equal(new OllamaProvider().id, 'ollama');
});

test('compiled CLI completes an offline daily-driver flow with config, verification and sessions', async t => {
  const root = await tempRoot(t, 'mars-cli-v02-');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'cli-fixture', scripts: { test: 'node -e "process.exit(0)"' } }));
  const runCli = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, MARS_MODEL: '', FORGE_MODEL: '', OPENAI_API_KEY: '' } });
  assert.equal(runCli(['init', '--workspace', root]).status, 0);
  assert.equal(runCli(['config', 'set', 'model.default', 'fake:scripted', '--workspace', root]).status, 0);
  const result = runCli(['run', 'inspect this fixture', '--workspace', root, '--verify', '--allow-shell', '--no-animation']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /Offline demo/);
  assert.match(result.stdout, /Verification passed/);
  const sessions = runCli(['sessions', '--workspace', root]);
  assert.equal(sessions.status, 0);
  assert.match(sessions.stdout, /fake:scripted/);
  const route = runCli(['route', 'review this diff', '--model', 'fake:scripted']);
  assert.equal(route.status, 0);
  assert.match(route.stdout, /reviewer/);
  await writeFile(path.join(root, '.mars', 'config.json'), JSON.stringify({ routing: { planner: 'fake:scripted', implementer: 'fake:scripted', verifier: 'fake:scripted' } }));
  const workflow = runCli(['run', 'add this feature', '--workspace', root, '--model', 'fake:scripted', '--workflow', 'feature', '--allow-shell', '--no-animation']);
  assert.equal(workflow.status, 0, workflow.stderr);
  assert.match(workflow.stderr, /workflow routing/);
  const evidence = runCli(['evidence', '--workspace', root]);
  assert.equal(evidence.status, 0);
  assert.match(evidence.stdout, /feature/);
  const health = runCli(['health', '--workspace', root]);
  assert.equal(health.status, 0);
  assert.match(health.stdout, /fake: reachable/);
});
