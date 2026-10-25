import path from 'node:path';
import { FileKnowledgeStore, FileSessionStore, FakeProvider, MarsError, createMars } from '../../../../packages/sdk/src/internal.js';
import type { KnowledgeKind } from '../../../../packages/sdk/src/internal.js';
import { safe } from '../utils/common.js';

export async function knowledgeCommand(root: string, kind: KnowledgeKind, args: string[] = [], json = false): Promise<void> {
  const store = new FileKnowledgeStore(root);
  const action = args[0] ?? 'list';
  if (['list', 'pending', 'show'].includes(action)) {
    let entries = (await store.load()).entries.filter(entry => entry.kind === kind);
    if (action === 'pending') entries = entries.filter(entry => entry.status === 'pending');
    if (action === 'show') {
      const entry = entries.find(item => item.id === args[1]);
      if (!entry) throw new MarsError('ConfigurationError', 'Knowledge entry not found.');
      process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
      return;
    }
    if (json) { process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`); return; }
    if (!entries.length) process.stdout.write(`No ${kind === 'memory' ? 'memory notes' : 'skill proposals'}.\n`);
    for (const entry of entries) process.stdout.write(`${entry.id}  ${entry.status}  ${entry.name}\n`);
    if (entries.some(entry => entry.status === 'pending')) process.stdout.write(`Review with mars ${kind === 'memory' ? 'memory' : 'skills'} show ID; approve ID activates a proposal.\n`);
    return;
  }
  if (action === 'add' && args[1] && args.slice(2).join(' ').trim()) {
    const entry = await store.propose({ kind, name: args[1], content: args.slice(2).join(' '), source: { origin: 'user' } });
    process.stdout.write(json ? `${JSON.stringify(entry, null, 2)}\n` : `${entry.id}  ${entry.status}  ${entry.name}\n`);
    return;
  }
  if (['approve', 'reject', 'forget'].includes(action) && args[1] && args.length === 2) {
    await store.review(args[1], action as 'approve' | 'reject' | 'forget', kind);
    process.stdout.write(json ? `${JSON.stringify({ id: args[1], action })}\n` : `${action}: ${args[1]}\n`);
    return;
  }
  throw new MarsError('ConfigurationError', `Use ${kind === 'memory' ? 'memory' : 'skills'} [list|pending|show ID|add NAME CONTENT|approve ID|reject ID|forget ID].`);
}

export async function learnCommand(root: string, sessionId: string | undefined, json = false): Promise<void> {
  if (!sessionId) throw new MarsError('ConfigurationError', 'Use learn SESSION_ID. The source must have passed verification.');
  const mars = await createMars({ workspace: root, provider: new FakeProvider(), model: 'scripted', includeProjectContext: false,
    sessionStore: new FileSessionStore(path.join(root, '.mars', 'sessions')), knowledgeStore: new FileKnowledgeStore(root), shellPolicy: 'deny' });
  try {
    const entry = await mars.learnFrom(sessionId);
    process.stdout.write(json ? `${JSON.stringify(entry, null, 2)}\n` : `Captured local procedure draft: ${entry.id}\nReview: mars skills show ${entry.id}\nActivate after review: mars skills approve ${entry.id}\nNo model calls were made.\n`);
  } finally { await mars.close(); }
}
