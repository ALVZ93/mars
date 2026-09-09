import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
} from '../dist/packages/sdk/src/index.js';

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

test('OpenAI Codex browser login uses PKCE, fixed callback contract and account metadata', async t => {
  let tokenRequest;
  const server = createServer(async (request, response) => {
    if (request.url === '/token') {
      let body = '';
      for await (const chunk of request) body += chunk;
      tokenRequest = new URLSearchParams(body);
      const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })).toString('base64url');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: `x.${payload}.y`, refresh_token: 'refresh', expires_in: 3600 }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const provider = new OpenAICodexAuthProvider({ clientId: 'mars-test', authorizationEndpoint: `${base}/authorize`, tokenEndpoint: `${base}/token`, callbackPort: 0 });
  let notification;
  const credential = await provider.login('oauth-pkce', { signal: signal(), openUrl: async url => {
    const auth = new URL(url);
    assert.equal(auth.searchParams.get('client_id'), 'mars-test');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state'));
    callback.searchParams.set('code', 'code-1');
    await fetch(callback);
  }, notify: event => { notification = event; } });
  assert.equal(credential.accountId, 'acct-1');
  assert.equal(tokenRequest.get('code'), 'code-1');
  assert.equal(tokenRequest.get('client_id'), 'mars-test');
  assert.equal(tokenRequest.get('grant_type'), 'authorization_code');
  assert.equal(notification.type, 'auth-url');
});

test('Anthropic browser login includes OAuth state in the JSON token exchange', async t => {
  let tokenBody;
  const server = createServer(async (request, response) => {
    if (request.url === '/token') {
      let body = '';
      for await (const chunk of request) body += chunk;
      tokenBody = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'sk-ant-oat-test', refresh_token: 'refresh', expires_in: 3600 }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const provider = new AnthropicAuthProvider({ clientId: 'anthropic-test', authorizationEndpoint: `${base}/authorize`, tokenEndpoint: `${base}/token`, callbackPort: 0 });
  const credential = await provider.login('oauth-pkce', { signal: signal(), openUrl: async url => {
    const auth = new URL(url);
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state'));
    callback.searchParams.set('code', 'code-2');
    await fetch(callback);
  } });
  assert.equal(credential.accessToken, 'sk-ant-oat-test');
  assert.equal(tokenBody.state, tokenBody.code_verifier);
  assert.equal(tokenBody.code, 'code-2');
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

  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } })).toString('base64url');
  const codex = new OpenAICodexProvider({ provider: 'openai-codex', kind: 'oauth', accessToken: `x.${payload}.y`, accountId: 'acct' }, { fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    const headers = new Headers(options.headers);
    assert.equal(headers.get('chatgpt-account-id'), 'acct');
    assert.equal(headers.get('originator'), 'codex_cli_rs');
    assert.ok(headers.get('session-id'));
    assert.equal(headers.get('x-client-request-id'), headers.get('session-id'));
    assert.equal(headers.get('openai-beta'), 'responses=experimental');
    assert.equal(body.store, false);
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.equal(body.text.verbosity, 'low');
    assert.equal(body.tools[0].strict, false);
    return sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"package.json"}' },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"path":"package.json"}' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 123, output_tokens: 7 } } },
    ]);
  } });
  const codexEvents = await collect(codex);
  assert.deepEqual(codexEvents.at(-1).usage, { inputTokens: 123, outputTokens: 7 });
  assert.deepEqual(codexEvents.at(-1).message.toolCalls, [{ id: 'c1', name: 'read_file', arguments: { path: 'package.json' } }]);
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
    return sse([{ candidates: [{ content: { parts: [{ text: 'ok' }, { functionCall: { name: 'read_file', args: { path: 'package.json' } } }] } }] }]);
  } });
  const events = await collect(provider);
  assert.equal(events.at(-1).message.content, 'ok');
  assert.deepEqual(events.at(-1).message.toolCalls[0], { id: 'read_file-1', name: 'read_file', arguments: { path: 'package.json' } });
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
