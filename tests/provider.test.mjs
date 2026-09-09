import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider, toOpenAIMessages } from '../dist/packages/providers/src/openai.js';

const credential = { provider: 'openai', kind: 'api-key', secret: 'TEST-SECRET' };
const request = { model: 'test-model', messages: [{ role: 'user', content: 'Read a file' }], tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }] };
const chunk = (delta, finish_reason = null) => ({ id: 'test', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] });
function sse(items) {
  const bytes = new TextEncoder().encode(items.map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n');
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const collect = provider => Array.fromAsync(provider.stream(request, new AbortController().signal));

test('real adapter parses fragmented streaming tool calls and keeps credentials out of model input', async () => {
  let received;
  const provider = new OpenAIProvider(credential, { fetch: async (_url, options) => {
    received = JSON.parse(options.body);
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer TEST-SECRET');
    return sse([
      chunk({ content: 'Inspecting ' }), chunk({ content: 'file' }),
      chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"package.json"}' } }] }),
      chunk({}, 'tool_calls'),
    ]);
  } });
  const events = await collect(provider);
  assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'Inspecting file');
  assert.deepEqual(events.at(-1).message.toolCalls, [{ id: 'c1', name: 'read_file', arguments: { path: 'package.json' } }]);
  assert.equal(received.store, false);
  assert.equal(received.tools[0].function.strict, true);
  assert.ok(!JSON.stringify(received).includes('TEST-SECRET'));
});
test('message conversion correlates tool results without leaking provider types into core', () => {
  const messages = toOpenAIMessages([
    { role: 'system', content: 'instructions' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'x' } }] },
    { role: 'tool', callId: 'c1', content: 'Denied', error: 'PermissionDeniedError' },
  ]);
  assert.equal(messages[1].tool_calls[0].function.arguments, '{"path":"x"}');
  assert.equal(messages[2].tool_call_id, 'c1');
  assert.equal(messages[2].content, 'PermissionDeniedError: Denied');
});
test('adapter rejects malformed arguments, interrupted output and incomplete responses', async () => {
  for (const [items, code] of [
    [[chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{' } }] }, 'tool_calls')], 'InvalidToolCallError'],
    [[chunk({ content: 'partial' })], 'ProviderUnavailableError'],
    [[chunk({}, 'length')], 'ProviderUnavailableError'],
  ]) {
    await assert.rejects(collect(new OpenAIProvider(credential, { fetch: async () => sse(items) })), { code });
  }
});
test('API authentication and provider errors are normalized and sanitized with no retries', async () => {
  for (const [status, code] of [[400, 'ProviderUnavailableError'], [401, 'AuthenticationError'], [429, 'RateLimitError'], [500, 'ProviderUnavailableError']]) {
    let calls = 0;
    const provider = new OpenAIProvider(credential, { fetch: async () => {
      calls++; return new Response(JSON.stringify({ error: { message: 'TEST-SECRET provider detail' } }), { status, headers: { 'Content-Type': 'application/json' } });
    } });
    let error;
    await assert.rejects(collect(provider), value => {
      error = value;
      return value.code === code && !value.message.includes('TEST-SECRET');
    });
    if (status === 400) assert.match(error.message, /HTTP 400/);
    assert.equal(calls, 1);
  }
});
test('adapter propagates cancellation without exposing HTTP internals', async () => {
  const provider = new OpenAIProvider(credential, { fetch: async () => { throw new Error('should not run'); } });
  await assert.rejects(Array.fromAsync(provider.stream(request, AbortSignal.abort())), { code: 'CancelledError' });
});
