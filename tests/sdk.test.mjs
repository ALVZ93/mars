import test from 'node:test';
import assert from 'node:assert/strict';
import { createForge, FakeProvider } from '../dist/packages/sdk/src/index.js';

test('SDK keeps session history in memory and prevents overlapping turns', async () => {
  const forge = await createForge({ workspace: process.cwd(), provider: new FakeProvider(), model: 'scripted' });
  const first = forge.run('one');
  await assert.rejects(forge.run('overlap'), { code: 'ConfigurationError' });
  await first;
  await forge.run('two');
  assert.equal(forge.session.messages.filter(message => message.role === 'user').length, 2);
  const snapshot = forge.session;
  snapshot.messages.length = 0;
  assert.ok(forge.session.messages.length > 0);
});

test('failed runs preserve observations so the next turn knows about completed effects', async () => {
  const provider = new FakeProvider([
    { role: 'assistant', content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'package.json' } }] },
    () => { throw new Error('provider disconnected'); },
    request => {
      assert.ok(request.messages.some(message => message.role === 'tool' && message.callId === 'r1'));
      return { role: 'assistant', content: 'Recovered', toolCalls: [] };
    },
  ]);
  const forge = await createForge({ workspace: process.cwd(), provider, model: 'scripted' });
  await assert.rejects(forge.run('read then fail'));
  assert.equal((await forge.run('continue')).content, 'Recovered');
});

test('long sessions compact complete old turns and keep the current task', async () => {
  let compacted = 0;
  let secondRequest;
  const provider = new FakeProvider([
    { role: 'assistant', content: 'x'.repeat(800), toolCalls: [] },
    request => { secondRequest = request; return { role: 'assistant', content: 'continued', toolCalls: [] }; },
  ]);
  const forge = await createForge({
    workspace: process.cwd(), provider, model: 'scripted', includeProjectContext: false, maxContextChars: 1_100,
    emit: event => { if (event.type === 'context:compacted') compacted++; },
  });
  await forge.run('first task');
  await forge.run('current task');
  assert.equal(compacted, 1);
  assert.ok(secondRequest.messages.some(message => message.role === 'system' && /context compaction/.test(message.content)));
  assert.ok(secondRequest.messages.some(message => message.role === 'user' && message.content === 'current task'));
  assert.ok(!secondRequest.messages.some(message => message.role === 'user' && message.content === 'first task'));
});
