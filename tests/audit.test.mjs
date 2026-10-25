import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Workspace, Permissions, WorkflowRegistry, FileSessionStore, loadConfig, saveConfig, routeTask } from '../dist/packages/runtime/src/index.js';
import { ToolRegistry, workspaceTools, runProjectChecks, McpStdioClient, createSandboxShell } from '../dist/packages/tools/src/index.js';
import { createMars, runAgent, FakeProvider, GeminiProvider, GoogleGeminiAuthProvider, AnthropicProvider, OpenAICodexProvider, OpenAIProvider, resolveAuthCredential, MemoryCredentialStore, MarsError } from '../dist/packages/sdk/src/internal.js';
import { providerForTarget } from '../dist/apps/cli/src/session.js';

const signal = () => new AbortController().signal;
const answer = (content = 'done') => ({ role: 'assistant', content, toolCalls: [] });
const call = (id, name, argumentsValue) => ({ role: 'assistant', content: '', toolCalls: [{ id, name, arguments: argumentsValue }] });
const cli = path.resolve('dist/apps/cli/src/index.js');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mars-audit-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}
function sse(events) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } }));
}
const request = { model: 'fixture', messages: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'inspect' }], tools: [] };

test('search applies workspace secret policy recursively and Git excludes secret diffs', async t => {
  const root = await fixture(t);
  for (const directory of ['.aws', '.ssh', '.azure', '.config', '.MARS', 'nested/.aws']) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'config'), 'AUDIT_SECRET');
  }
  await writeFile(path.join(root, '.env'), 'AUDIT_SECRET');
  await writeFile(path.join(root, 'safe.txt'), 'AUDIT_VISIBLE');
  const registry = new ToolRegistry(workspaceTools(await Workspace.open(root), new Permissions('deny')));
  const execute = (name, args) => registry.execute({ id: 'audit', name, arguments: args }, signal());
  const result = await execute('search_files', { query: 'AUDIT_', path: null, caseSensitive: null, maxResults: null });
  assert.match(result.content, /AUDIT_VISIBLE/);
  assert.doesNotMatch(result.content, /AUDIT_SECRET/);
  const git = args => { const value = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(value.status, 0, value.stderr); };
  git(['init']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=', 'commit', '-m', 'fixture']);
  await writeFile(path.join(root, '.env'), 'AUDIT_SECRET_CHANGED');
  await writeFile(path.join(root, '.aws', 'config'), 'AUDIT_SECRET_CHANGED');
  await writeFile(path.join(root, 'safe.txt'), 'AUDIT_VISIBLE_CHANGED');
  const diff = await execute('git', { action: 'diff', path: null });
  assert.equal(diff.error, undefined, diff.content);
  assert.match(diff.content, /AUDIT_VISIBLE_CHANGED/);
  assert.doesNotMatch(diff.content, /AUDIT_SECRET/);
});

test('shell applies Git mutation policies even when shell and network are allowed', async () => {
  const permissions = new Permissions('allow', undefined, { gitCommit: 'deny', gitPush: 'deny', network: 'allow' });
  for (const command of ['git commit -m fixture', 'git -C repo push origin main', 'git.exe push']) {
    await assert.rejects(permissions.checkShell(command, process.cwd(), signal()), { code: 'PermissionDeniedError' });
  }
});

test('verification propagates cancellation instead of reporting an ordinary failed check', async t => {
  const workspace = await Workspace.open(await fixture(t));
  const controller = new AbortController();
  await assert.rejects(runProjectChecks(workspace, controller.signal, { commands: ['fixture'], shellExecutor: async () => {
    controller.abort(); throw new Error('interrupted');
  } }), { code: 'CancelledError' });
});

test('CLI JSON checks fail the process while retaining valid JSON', async t => {
  const root = await fixture(t);
  const result = spawnSync(process.execPath, [cli, 'check', '--json', '--workspace', root], { encoding: 'utf8', env: { ...process.env, MARS_CREDENTIAL_STORE: 'file', APPDATA: root, XDG_CONFIG_HOME: root, USERPROFILE: root, HOME: root } });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).verified, false);
});

test('CLI rejects resume without a terminal instead of spinning indefinitely', async t => {
  const root = await fixture(t);
  const result = spawnSync(process.execPath, [cli, 'resume', 'audit-session', '--workspace', root], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /requires a terminal/);
});

test('Gemini sends systemInstruction, parses CRLF SSE and assigns unique tool IDs across turns', async () => {
  const bodies = [];
  const provider = new GeminiProvider({ provider: 'gemini', kind: 'api-key', secret: 'fixture' }, { fetch: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return sse([{ candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a' } } }] }, finishReason: 'STOP' }] }]);
  } });
  const first = (await Array.fromAsync(provider.stream(request, signal()))).at(-1).message;
  const second = (await Array.fromAsync(provider.stream(request, signal()))).at(-1).message;
  assert.equal(bodies[0].systemInstruction.parts[0].text, 'instructions');
  assert.equal(bodies[0].system, undefined);
  assert.notEqual(first.toolCalls[0].id, second.toolCalls[0].id);
});

test('Gemini rejects truncated streams and token-limited completion', async () => {
  for (const finishReason of [undefined, 'MAX_TOKENS', 'SAFETY']) {
    const provider = new GeminiProvider({ provider: 'gemini', kind: 'api-key', secret: 'fixture' }, { fetch: async () => sse([{ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason }] }]) });
    await assert.rejects(Array.fromAsync(provider.stream(request, signal())), { code: 'ProviderUnavailableError' });
  }
});

test('Anthropic parses CRLF and rejects max_tokens instead of accepting truncated success', async () => {
  for (const stop of ['end_turn', 'max_tokens']) {
    const provider = new AnthropicProvider({ provider: 'anthropic', kind: 'api-key', secret: 'fixture' }, { fetch: async () => sse([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
      { type: 'message_delta', delta: { stop_reason: stop } }, { type: 'message_stop' },
    ]) });
    if (stop === 'end_turn') assert.equal((await Array.fromAsync(provider.stream(request, signal()))).at(-1).message.content, 'answer');
    else await assert.rejects(Array.fromAsync(provider.stream(request, signal())), { code: 'ProviderUnavailableError' });
  }
});

test('Codex resets cached context on changed model, tools or transcript prefix', async () => {
  let starts = 0;
  const provider = new OpenAICodexProvider({ provider: 'openai-codex', kind: 'external', source: 'codex-cli' }, { codex: { startThread() {
    starts++;
    return { run: async () => ({ finalResponse: JSON.stringify({ content: 'done', toolCalls: [] }), usage: null }) };
  } } });
  await Array.fromAsync(provider.stream(request, signal()));
  await Array.fromAsync(provider.stream({ ...request, model: 'other' }, signal()));
  await Array.fromAsync(provider.stream({ ...request, model: 'other', tools: [{ name: 'fixture', parameters: {} }] }, signal()));
  await Array.fromAsync(provider.stream({ ...request, model: 'other', messages: [{ role: 'user', content: 'different' }, ...request.messages] }, signal()));
  assert.equal(starts, 4);
});

test('workflow read-only phases enforce tools and custom unverified workflows do not claim verification', async t => {
  const root = await fixture(t);
  const records = [];
  const observations = [];
  const mars = await createMars({ workspace: root, model: 'scripted', includeProjectContext: false,
    provider: new FakeProvider([
      call('forbidden', 'write_file', { path: 'must-not-exist', content: 'bad' }),
      req => { observations.push(req.messages.at(-1)); return answer(); }, answer(),
    ]), shellPolicy: 'allow', verificationCommands: ['fixture'],
    shellExecutor: async () => ({ exitCode: 0, output: 'ok', truncated: false }),
    evidenceStore: { record: async value => records.push(value) },
  });
  await mars.runWorkflow('review', 'review fixture');
  await assert.rejects(readFile(path.join(root, 'must-not-exist')), { code: 'ENOENT' });
  assert.equal(observations[0].error, 'PermissionDeniedError');
  const custom = await createMars({ workspace: root, model: 'scripted', includeProjectContext: false, provider: new FakeProvider([answer()]),
    workflows: new WorkflowRegistry([{ id: 'unchecked', description: '', matches: () => true, phases: [{ id: 'work', role: 'implementer', instruction: 'work' }] }]),
    evidenceStore: { record: async value => records.push(value) },
  });
  await custom.runWorkflow('unchecked', 'task');
  assert.notEqual(records.at(-1).verificationPassed, true);
});

test('workflow holds the session lock during checks and failed verify persists failure', async t => {
  const root = await fixture(t);
  let entered;
  let release;
  const checking = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const mars = await createMars({ workspace: root, model: 'scripted', includeProjectContext: false, provider: new FakeProvider([answer(), answer()]),
    workflows: new WorkflowRegistry([{ id: 'checks', description: '', matches: () => true, phases: [{ id: 'verify', role: 'verifier', instruction: 'work', verification: true }] }]),
    sessionStore: new FileSessionStore(path.join(root, '.mars', 'sessions')), shellPolicy: 'allow', verificationCommands: ['fixture'],
    shellExecutor: async () => { entered(); await barrier; return { exitCode: 1, output: 'failed', truncated: false }; },
  });
  const running = mars.runWorkflow('checks', 'task');
  const failure = assert.rejects(running, { code: 'ToolExecutionError' });
  await checking;
  assert.equal(mars.session.status, 'active');
  try { await assert.rejects(mars.run('overlap'), { code: 'ConfigurationError' }); }
  finally { release(); }
  await failure;
  assert.equal(mars.session.status, 'failed');
  const checked = await mars.verify();
  assert.equal(checked.verified, false);
  assert.equal((await mars.sessionStore.get(mars.id)).status, 'failed');
});

test('configuration and sessions carry schema versions and reject unknown future formats', async t => {
  const root = await fixture(t);
  const config = path.join(root, '.mars', 'config.json');
  await saveConfig(config, {});
  assert.equal(JSON.parse(await readFile(config, 'utf8')).version, 1);
  await writeFile(config, '{"version":999}');
  await assert.rejects(loadConfig(root, { APPDATA: root, XDG_CONFIG_HOME: root, HOME: root, USERPROFILE: root }), { code: 'ConfigurationError' });
  const store = new FileSessionStore(path.join(root, 'sessions'));
  const snapshot = { id: 'audit-session', createdAt: '2026-10-11', updatedAt: '2026-10-11', workspace: root, model: 'fake:scripted', messages: [], metadata: {} };
  await store.save(snapshot);
  assert.equal(JSON.parse(await readFile(path.join(store.directory, `${snapshot.id}.json`), 'utf8')).schemaVersion, 1);
  await writeFile(path.join(store.directory, `${snapshot.id}.json`), JSON.stringify({ ...snapshot, schemaVersion: 999 }));
  await assert.rejects(store.get(snapshot.id), { code: 'ConfigurationError' });
});

test('routing hard filters apply to configured and explicit targets and unknown context is not infinite', () => {
  const catalog = [{ id: 'fixture:small', provider: 'fixture', model: 'small', capabilities: { tools: true } }];
  for (const selection of [{ explicit: 'fixture:small' }, { config: { model: { default: 'fixture:small' } } }, {}]) {
    assert.throws(() => routeTask('task', { ...selection, catalog, authenticatedProviders: ['fixture'], required: { contextWindow: 1000 } }));
  }
  assert.throws(() => routeTask('task', { explicit: 'fixture:small', catalog, allowedProviders: ['other'] }));
});

test('MCP drains verbose stderr, discovers all pages and reconnects after close', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'server.mjs');
  await writeFile(file, `import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
input.on('line', line => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') process.stderr.write('x'.repeat(2_000_000), () => send(req.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }));
  if (req.method === 'tools/list') send(req.id, req.params.cursor ? { tools: [{ name: 'second' }] } : { tools: [{ name: 'first' }], nextCursor: 'page-2' });
  if (req.method === 'tools/call') send(req.id, { content: [{ type: 'text', text: req.params.name }] });
});`);
  const client = new McpStdioClient({ name: 'audit', command: process.execPath, args: [file], timeoutMs: 5000 });
  t.after(() => client.close());
  assert.deepEqual((await client.start()).map(tool => tool.name), ['first', 'second']);
  await client.close();
  assert.deepEqual((await client.start()).map(tool => tool.name), ['first', 'second']);
  assert.equal(client.connected, true);
  assert.equal((await client.callTool('second', {})).content[0].text, 'second');
});

test('MCP bounds oversized unterminated messages and validates timeout', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'oversized.mjs');
  await writeFile(file, `process.stdin.resume(); process.stdout.write('x'.repeat(1_000_100));`);
  const client = new McpStdioClient({ name: 'audit', command: process.execPath, args: [file], timeoutMs: 5000 });
  t.after(() => client.close());
  await assert.rejects(client.start(), error => error.code === 'ToolExecutionError' && /size limit/.test(error.message));
  assert.throws(() => new McpStdioClient({ name: 'audit', command: 'node', timeoutMs: -1 }), { code: 'ConfigurationError' });
});

test('Docker rejects an outside cwd or flag-like image before starting a process', async t => {
  const root = await fixture(t);
  const shell = createSandboxShell(root, { mode: 'docker' });
  await assert.rejects(shell('echo fixture', path.dirname(root), 1000, signal()), { code: 'WorkspaceViolationError' });
  assert.throws(() => createSandboxShell(root, { mode: 'docker', image: '--privileged' }), { code: 'ConfigurationError' });
});

test('Anthropic redacts echoed API keys in errors', async () => {
  const secret = 'AUDIT_API_SECRET';
  const provider = new AnthropicProvider({ provider: 'anthropic', kind: 'api-key', secret }, { fetch: async () => Response.json({ error: { message: `invalid key: ${secret}` } }, { status: 400 }) });
  await assert.rejects(Array.fromAsync(provider.stream(request, signal())), error => error.code === 'ProviderUnavailableError' && !error.message.includes(secret));
});

test('explicit credentials do not consult a broken lower-precedence store', async () => {
  const explicit = { provider: 'openai', kind: 'api-key', secret: 'fixture' };
  assert.deepEqual(await resolveAuthCredential('openai', { explicit, store: { get: async () => { throw new Error('broken store'); } } }), explicit);
});

test('agent checkpoints completed tool cycles before requesting another turn', async () => {
  const snapshots = [];
  const provider = new FakeProvider([call('checkpoint', 'fixture', {}), () => {
    assert.ok(snapshots.some(history => history.at(-1)?.role === 'tool' && history.at(-1).callId === 'checkpoint'));
    return answer();
  }]);
  await runAgent({ provider, model: 'scripted', messages: [{ role: 'user', content: 'task' }], tools: { schemas: () => [], execute: async () => ({ content: 'effect observed' }) }, onCheckpoint: history => snapshots.push(history) });
});

test('storage failure during a slow model turn is reported without an unhandled rejection', async t => {
  const root = await fixture(t);
  const mars = await createMars({ workspace: root, model: 'scripted', includeProjectContext: false,
    provider: { id: 'fixture', async *stream() { await new Promise(resolve => setTimeout(resolve, 30)); yield { type: 'done', message: answer() }; } },
    sessionStore: { save: async () => { throw new MarsError('ConfigurationError', 'Could not write MARS session (ENOSPC).'); } },
  });
  await assert.rejects(mars.run('task'), error => error.code === 'ConfigurationError' && /ENOSPC/.test(error.message));
  assert.equal(mars.session.status, 'failed');
  await assert.rejects(mars.close(), { code: 'ConfigurationError' });
});

test('OpenAI optional MCP schemas do not request incompatible strict validation', async () => {
  const provider = new OpenAIProvider({ provider: 'openai', kind: 'api-key', secret: 'fixture' }, { fetch: async (_url, options) => {
    assert.equal(JSON.parse(options.body).tools[0].function.strict, false);
    return sse([{ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
  } });
  const events = await Array.fromAsync(provider.stream({ ...request, tools: [{ name: 'optional', parameters: { type: 'object', properties: { value: { type: 'string' } } } }] }, signal()));
  assert.equal(events.at(-1).message.content, 'ok');
});

test('saved subscription credentials cannot bypass CLI auth policy and Gemini API logout needs no OAuth client', async () => {
  const store = new MemoryCredentialStore();
  await store.set({ provider: 'anthropic', kind: 'oauth', accessToken: 'fixture' });
  await store.set({ provider: 'kimi-code', kind: 'oauth', accessToken: 'fixture' });
  await assert.rejects(providerForTarget('anthropic:fixture', store, {}), { code: 'AuthenticationError' });
  const previous = process.env.MARS_ENABLE_EXPERIMENTAL_SUBSCRIPTION_AUTH;
  delete process.env.MARS_ENABLE_EXPERIMENTAL_SUBSCRIPTION_AUTH;
  try { await assert.rejects(providerForTarget('kimi-code:fixture', store, {}), { code: 'ConfigurationError' }); }
  finally { if (previous !== undefined) process.env.MARS_ENABLE_EXPERIMENTAL_SUBSCRIPTION_AUTH = previous; }
  await new GoogleGeminiAuthProvider().logout({ provider: 'gemini', kind: 'api-key', secret: 'fixture' }, { signal: signal(), openUrl: async () => {} });
});
