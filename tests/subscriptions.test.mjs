import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AnthropicAuthProvider,
  AnthropicProvider,
  FileCredentialStore,
  GeminiProvider,
  KimiCodeAuthProvider,
  KimiCodeProvider,
  OpenAICodexAuthProvider,
  OpenAICodexProvider,
  QwenProvider,
} from '../dist/packages/sdk/src/internal.js';

const signal = () => new AbortController().signal;
const sse = events => {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
};
const collect = provider => Array.fromAsync(provider.stream({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }] }, signal()));

test('file credential store persists OAuth metadata and replaces records atomically', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mars-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileCredentialStore(path.join(root, 'nested', 'auth.json'));
  await store.set({ provider: 'openai-codex', kind: 'oauth', accessToken: 'access', refreshToken: 'refresh', accountId: 'acct' });
  const copy = await store.get('openai-codex');
  assert.deepEqual(copy, { provider: 'openai-codex', kind: 'oauth', accessToken: 'access', refreshToken: 'refresh', accountId: 'acct' });
  copy.accessToken = 'mutated';
  assert.equal((await store.get('openai-codex')).accessToken, 'access');
  await store.delete('openai-codex');
  assert.equal(await store.get('openai-codex'), undefined);
});

test('OpenAI Codex login delegates credentials to the official runtime', async () => {
  const calls = [];
  const provider = new OpenAICodexAuthProvider({ run: async (args, _signal, inherit) => {
    calls.push({ args, inherit });
    return { code: 0, output: 'Logged in using ChatGPT' };
  } });
  const credential = await provider.login('oauth-device', { signal: signal(), openUrl: async () => {} });
  assert.deepEqual(credential, { provider: 'openai-codex', kind: 'external', source: 'codex-cli' });
  assert.deepEqual(calls, [{ args: ['login', 'status'], inherit: false }]);
});

test('Anthropic browser login is blocked at the adapter boundary', async () => {
  let requests = 0;
  const provider = new AnthropicAuthProvider({ clientId: 'fixture', fetch: async () => { requests++; } });
  const context = { signal: signal(), openUrl: async () => { requests++; } };
  await assert.rejects(provider.login('oauth-pkce', context), { code: 'ConfigurationError' });
  await assert.rejects(provider.refresh({ provider: 'anthropic', kind: 'oauth', accessToken: 'fixture', refreshToken: 'fixture' }, context), { code: 'AuthenticationError' });
  assert.equal(requests, 0);
  assert.deepEqual(provider.methods(), []);
});

test('Kimi Code device login opens the verification URL and polls RFC 8628', async () => {
  let polls = 0;
  const notifications = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('/device_authorization')) return Response.json({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://auth.example.test/device', verification_uri_complete: 'https://auth.example.test/device?user_code=ABCD', interval: 0.01, expires_in: 30 });
    polls++;
    if (polls === 1) return Response.json({ error: 'authorization_pending' }, { status: 400 });
    return Response.json({ access_token: 'kimi-access', refresh_token: 'kimi-refresh', expires_in: 3600 });
  };
  const opened = [];
  const provider = new KimiCodeAuthProvider({ oauthHost: 'https://auth.example.test', fetch: fetchImpl, waitBeforeFirstPoll: false });
  const credential = await provider.login('oauth-device', { signal: signal(), openUrl: async url => opened.push(url), notify: event => notifications.push(event) });
  assert.equal(credential.accessToken, 'kimi-access');
  assert.equal(polls, 2);
  assert.deepEqual(opened, ['https://auth.example.test/device?user_code=ABCD']);
  assert.equal(notifications[0].userCode, 'ABCD');
});

test('subscription transports keep provider credentials out of model input and parse tool streams', async () => {
  let anthropicBody;
  const anthropic = new AnthropicProvider({ provider: 'anthropic', kind: 'oauth', accessToken: 'sk-ant-oat-test' }, { fetch: async (_url, options) => {
    anthropicBody = JSON.parse(options.body);
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer sk-ant-oat-test');
    return sse([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]);
  } });
  const anthropicEvents = await collect(anthropic);
  assert.equal(anthropicEvents.at(-1).message.content, 'ok');
  assert.equal(anthropicBody.messages[0].content, 'hello');
  assert.ok(!JSON.stringify(anthropicBody).includes('sk-ant-oat-test'));

  let threadOptions;
  let prompt;
  const codex = new OpenAICodexProvider({ provider: 'openai-codex', kind: 'external', source: 'codex-cli' }, { codex: {
    startThread(options) {
      threadOptions = options;
      return { async run(input, options) {
        prompt = input;
        assert.equal(options.outputSchema.type, 'object');
        assert.equal(options.outputSchema.properties.toolCalls.items.properties.arguments.type, 'string');
        return { finalResponse: JSON.stringify({ content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"package.json"}' }] }), usage: { input_tokens: 123, output_tokens: 7 } };
      } };
    },
  } });
  const codexEvents = await collect(codex);
  assert.equal(threadOptions.sandboxMode, 'read-only');
  assert.equal(threadOptions.modelReasoningEffort, 'low');
  assert.equal(threadOptions.networkAccessEnabled, false);
  assert.match(prompt, /read_file/);
  assert.ok(!prompt.includes('accessToken'));
  assert.deepEqual(codexEvents.at(-1).usage, { inputTokens: 123, outputTokens: 7 });
  assert.deepEqual(codexEvents.at(-1).message.toolCalls, [{ id: 'c1', name: 'read_file', arguments: { path: 'package.json' } }]);
});

test('Codex transport rejects malformed JSON tool arguments', async () => {
  const codex = new OpenAICodexProvider({ provider: 'openai-codex', kind: 'external', source: 'codex-cli' }, { codex: {
    startThread() {
      return { async run() {
        return { finalResponse: JSON.stringify({ content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{' }] }), usage: null };
      } };
    },
  } });
  await assert.rejects(() => collect(codex), error => error?.code === 'InvalidToolCallError');
});

test('Codex transport reuses its thread and sends only new non-assistant transcript entries', async () => {
  const prompts = [];
  let starts = 0;
  let runs = 0;
  const codex = new OpenAICodexProvider({ provider: 'openai-codex', kind: 'external', source: 'codex-cli' }, { codex: {
    startThread() {
      starts++;
      return { async run(prompt) {
        prompts.push(prompt);
        runs++;
        return runs === 1
          ? { finalResponse: JSON.stringify({ content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"package.json"}' }] }), usage: null }
          : { finalResponse: JSON.stringify({ content: 'done', toolCalls: [] }), usage: null };
      } };
    },
  } });
  const tools = [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {}, additionalProperties: false } }];
  const firstMessages = [{ role: 'user', content: 'inspect' }];
  await Array.fromAsync(codex.stream({ model: 'test-model', messages: firstMessages, tools }, signal()));
  const secondMessages = [
    ...firstMessages,
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'package.json' } }] },
    { role: 'tool', callId: 'c1', content: '{"name":"mars"}' },
  ];
  await Array.fromAsync(codex.stream({ model: 'test-model', messages: secondMessages, tools }, signal()));
  assert.equal(starts, 1);
  assert.match(prompts[0], /MARS tools/);
  assert.match(prompts[1], /New MARS transcript entries/);
  assert.match(prompts[1], /\"role\":\"tool\"/);
  assert.doesNotMatch(prompts[1], /\"role\":\"assistant\"/);
  assert.doesNotMatch(prompts[1], /MARS tools:\n/);
});

test('Kimi Code transport uses its Anthropic-compatible endpoint', async () => {
  let calledUrl;
  const provider = new KimiCodeProvider({ provider: 'kimi-code', kind: 'api-key', secret: 'kimi-secret' }, { fetch: async (url, options) => {
    calledUrl = url;
    assert.equal(new Headers(options.headers).get('x-api-key'), 'kimi-secret');
    return sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]);
  } });
  await collect(provider);
  assert.equal(calledUrl, 'https://api.kimi.com/coding/v1/messages');
});

test('Gemini transport maps tools to function declarations and parses function calls', async () => {
  let body;
  const provider = new GeminiProvider({ provider: 'gemini', kind: 'api-key', secret: 'gemini-secret' }, { baseUrl: 'https://generativelanguage.googleapis.com', fetch: async (url, options) => {
    assert.match(url, /models\/test-model:streamGenerateContent/);
    assert.equal(new Headers(options.headers).get('x-goog-api-key'), 'gemini-secret');
    body = JSON.parse(options.body);
    return sse([{ candidates: [{ content: { parts: [{ text: 'ok' }, { functionCall: { name: 'read_file', args: { path: 'package.json' } } }] }, finishReason: 'STOP' }] }]);
  } });
  const events = await collect(provider);
  assert.equal(events.at(-1).message.content, 'ok');
  assert.equal(typeof events.at(-1).message.toolCalls[0].id, 'string');
  assert.equal(events.at(-1).message.toolCalls[0].name, 'read_file');
  assert.deepEqual(events.at(-1).message.toolCalls[0].arguments, { path: 'package.json' });
  assert.equal(body.tools[0].functionDeclarations[0].name, 'read_file');
});

test('Qwen provider uses OpenAI-compatible Token Plan endpoint', async () => {
  let calledUrl;
  const provider = new QwenProvider({ provider: 'qwen', kind: 'api-key', secret: 'qwen-secret' }, { baseUrl: 'https://qwen.example/v1', fetch: async (url, options) => {
    calledUrl = url;
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer qwen-secret');
    return sse([{ id: '1', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
  } });
  const events = await collect(provider);
  assert.equal(calledUrl, 'https://qwen.example/v1/chat/completions');
  assert.equal(events.at(-1).message.content, 'ok');
});
