import test from 'node:test';
import assert from 'node:assert/strict';
import { choose, validTarget, TerminalUsage } from '../dist/apps/cli/src/terminal.js';
import { runAgent } from '../dist/packages/core/src/index.js';

test('terminal selection retries bad input, accepts defaults and cancels', async () => {
  const answers = ['MODEL', '99', '2'];
  assert.equal(await choose('Models', ['A', 'B'], async () => answers.shift(), () => {}), 1);
  assert.equal(await choose('Models', ['A', 'B'], async () => '', () => {}, 1), 1);
  await assert.rejects(choose('Models', ['A'], async () => 'q', () => {}), /cancelada/);
  assert.equal(validTarget('openai-codex:MODEL'), false);
  assert.equal(validTarget('openai-codex:<model>'), false);
  assert.equal(validTarget('openrouter:vendor/custom-model'), true);
});

test('actual provider usage reaches terminal counters without guessing missing tokens', async () => {
  const usage = new TerminalUsage();
  const provider = { id: 'fixture', async *stream() {
    yield { type: 'done', message: { role: 'assistant', content: 'ok', toolCalls: [] }, usage: { inputTokens: 123, outputTokens: 7 } };
  } };
  await runAgent({ provider, model: 'test', messages: [{ role: 'user', content: 'hi' }], tools: { schemas: () => [] }, emit: event => usage.accept(event) });
  assert.match(usage.render(250, 1000), /123 entrada · 7 salida/);
  assert.match(usage.render(250, 1000), /25%/);
  usage.accept({ type: 'model:response' });
  assert.match(usage.render(250, 1000), /parcial/);
  assert.match(new TerminalUsage().render(0, 1000), /no reportados/);
});
