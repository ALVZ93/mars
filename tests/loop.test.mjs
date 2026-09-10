import test from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory, runAgent, MarsError } from '../dist/packages/core/src/index.js';
import { FakeProvider } from '../dist/packages/providers/src/fake.js';

const final = { role: 'assistant', content: 'Done', toolCalls: [] };
const call = (id = 'c1') => ({ role: 'assistant', content: '', toolCalls: [{ id, name: 'read_file', arguments: { path: 'package.json' } }] });
const executor = { schemas: () => [], execute: async () => ({ content: 'contents' }) };
const run = (steps, extra = {}) => runAgent({ provider: new FakeProvider(steps), model: 'scripted', messages: [{ role: 'user', content: 'Task' }], tools: executor, ...extra });

test('compaction drops old tool cycles within the current task without orphaning results', () => {
  const messages = [
    { role: 'system', content: 'instructions' },
    { role: 'user', content: 'current task' },
    call('old'),
    { role: 'tool', callId: 'old', content: 'x'.repeat(900) },
    call('recent'),
    { role: 'tool', callId: 'recent', content: 'y'.repeat(900) },
  ];
  const compacted = compactHistory(messages, 1_500);
  assert.ok(compacted.some(message => message.role === 'system' && /context compaction/.test(message.content)));
  assert.ok(compacted.some(message => message.role === 'user' && message.content === 'current task'));
  assert.ok(!compacted.some(message => message.role === 'tool' && message.callId === 'old'));
  assert.ok(compacted.some(message => message.role === 'assistant' && message.toolCalls.some(toolCall => toolCall.id === 'recent')));
  assert.ok(compacted.some(message => message.role === 'tool' && message.callId === 'recent'));
});

test('final response and streaming events', async () => {
  const events = [];
  const result = await run([final], { emit: event => events.push(event) });
  assert.deepEqual(result.at(-1), final);
  assert.ok(events.some(event => event.type === 'model:text' && event.text === 'Done'));
  assert.equal(events.at(-1).type, 'session:end');
});
test('tool observations are correlated and returned to the provider sequentially', async () => {
  const provider = new FakeProvider([call(), call('c2'), request => {
    assert.equal(request.messages.filter(message => message.role === 'tool').length, 2);
    assert.equal(request.messages.at(-1).callId, 'c2');
    return final;
  }]);
  await run([], { provider });
  assert.equal(provider.requests.length, 3);
});
test('max turns and tool calls stop execution', async () => {
  await assert.rejects(run([call()], { maxTurns: 1 }), { code: 'LimitError' });
  let executions = 0;
  await assert.rejects(run([{ ...call(), toolCalls: [...call().toolCalls, ...call('c2').toolCalls] }], {
    maxToolCalls: 1, tools: { ...executor, execute: async () => { executions++; return { content: '' }; } },
  }), { code: 'LimitError' });
  assert.equal(executions, 0);
});
test('default agent budget supports a normal multi-tool task beyond the old twelve-turn cap', async () => {
  const steps = Array.from({ length: 13 }, (_, index) => call(`long-${index}`));
  steps.push(final);
  const result = await run(steps);
  assert.deepEqual(result.at(-1), final);
});
test('repeated correlation IDs are rejected', async () => {
  await assert.rejects(run([call(), call()]), { code: 'InvalidToolCallError' });
});
test('cancellation, timeout and interrupted streams never report success', async () => {
  await assert.rejects(run([final], { signal: AbortSignal.abort() }), { code: 'CancelledError' });
  const provider = { id: 'stalled', async *stream() { await new Promise(resolve => setTimeout(resolve, 100)); yield { type: 'done', message: final }; } };
  await assert.rejects(run([], { provider, timeoutMs: 10 }), { code: 'TimeoutError' });
  await assert.rejects(run([], { provider: { id: 'broken', async *stream() {} } }), { code: 'ProviderUnavailableError' });
});
test('provider error propagates and input history is not mutated', async () => {
  const messages = [{ role: 'user', content: 'Task' }];
  await assert.rejects(run([], { messages, provider: { id: 'broken', async *stream() { throw new MarsError('AuthenticationError', 'Missing credential'); } } }), { code: 'AuthenticationError' });
  assert.equal(messages.length, 1);
});
test('transient provider retries are opt-in and bounded before any tool executes', async () => {
  let attempts = 0;
  const events = [];
  const provider = {
    id: 'flaky',
    async *stream() {
      attempts++;
      if (attempts === 1) throw new MarsError('ProviderUnavailableError', 'temporary outage');
      yield { type: 'done', message: final };
    },
  };
  await assert.rejects(run([], { provider }), { code: 'ProviderUnavailableError' });
  assert.equal(attempts, 1);
  attempts = 0;
  const result = await run([], { provider, maxRetries: 1, retryDelayMs: 1, emit: event => events.push(event) });
  assert.deepEqual(result.at(-1), final);
  assert.equal(attempts, 2);
  assert.deepEqual(events.filter(event => event.type === 'model:retry').map(event => event.attempt), [1]);
  attempts = 0;
  const malformed = {
    id: 'malformed',
    async *stream() {
      attempts++;
      if (attempts === 1) throw new MarsError('InvalidToolCallError', 'malformed arguments');
      yield { type: 'done', message: final };
    },
  };
  assert.deepEqual((await run([], { provider: malformed, maxRetries: 1, retryDelayMs: 1 })).at(-1), final);
  attempts = 0;
  const emptyThenFinal = {
    id: 'empty-then-final',
    async *stream() {
      attempts++;
      yield { type: 'done', message: attempts === 1 ? { role: 'assistant', content: '', toolCalls: [] } : final };
    },
  };
  assert.deepEqual((await run([], { provider: emptyThenFinal, maxRetries: 1, retryDelayMs: 1 })).at(-1), final);
  assert.equal(attempts, 2);
  attempts = 0;
  const invalidRequest = { id: 'invalid', async *stream() { attempts++; throw new MarsError('ProviderUnavailableError', 'HTTP 400: model not found'); } };
  await assert.rejects(run([], { provider: invalidRequest, maxRetries: 3, retryDelayMs: 1 }), { code: 'ProviderUnavailableError' });
  assert.equal(attempts, 1);
});
