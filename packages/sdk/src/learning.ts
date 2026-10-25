import { z } from 'zod';
import { MarsError, checkAbort } from '../../core/src/index.js';
import type { Tool, ToolCall } from '../../core/src/index.js';
import { redactKnowledgeSecrets } from '../../runtime/src/index.js';
import type { KnowledgeEntry, KnowledgeStore, KnowledgeSource, SessionStore } from '../../runtime/src/index.js';

const note = z.strictObject({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/), content: z.string().trim().min(1).max(1_200) });
export function memoryProposalTool(store: KnowledgeStore, source: () => KnowledgeSource, proposed?: (entry: KnowledgeEntry) => void): Tool {
  return {
    name: 'propose_memory', description: 'Propose a durable project fact or user preference for human review. Pending notes are not used as memory until explicitly approved. Never store secrets.',
    parameters: z.toJSONSchema(note), validate: input => note.parse(input),
    async execute(input, { signal }) {
      checkAbort(signal);
      const entry = await store.propose({ kind: 'memory', ...note.parse(input), source: source() }, signal);
      proposed?.(entry);
      return JSON.stringify({ id: entry.id, status: entry.status, name: entry.name, message: 'Proposal recorded; pending entries require explicit human approval before use.' });
    },
  };
}

export async function captureVerifiedProcedure(options: { workspace: string; sessionId: string; sessions: SessionStore; knowledge: KnowledgeStore; signal: AbortSignal }): Promise<KnowledgeEntry> {
  checkAbort(options.signal);
  const session = await options.sessions.get(options.sessionId);
  const receipt = session?.lastRun;
  if (!session || session.workspace !== options.workspace) throw new MarsError('ConfigurationError', 'Learning source session is missing or belongs to another workspace.');
  if (session.status !== 'completed' || !receipt || receipt.sessionId !== session.id || receipt.status !== 'completed' || receipt.verificationStatus !== 'passed'
    || !receipt.verificationCommands.length || receipt.messageCount !== session.messages.length) throw new MarsError('ConfigurationError', 'Learning requires a saved session whose latest operation passed real checks. Run verification first.');
  // Select the last task/workflow, even when the receipt comes from a subsequent explicit verify().
  const lastTask = session.messages.findLastIndex(message => message.role === 'user');
  const original = session.messages[lastTask]?.content.split('Original task:').at(-1)?.split('\n')[0]?.trim() ?? 'Repeat the verified project workflow.';
  const start = receipt.taskStartMessageCount;
  const calls = new Map<string, ToolCall>();
  const steps: string[] = [];
  for (const message of session.messages.slice(Math.max(0, start))) {
    if (message.role === 'assistant') for (const call of message.toolCalls) calls.set(call.id, call);
    if (message.role !== 'tool' || message.error) continue;
    const call = calls.get(message.callId);
    if (!call || !call.arguments || typeof call.arguments !== 'object') continue;
    const args = call.arguments as Record<string, unknown>;
    if (['read_file', 'write_file', 'search_files'].includes(call.name) && typeof args.path === 'string') steps.push(`${call.name}: ${args.path.slice(0, 500)}`);
    if (call.name === 'shell' && typeof args.command === 'string' && message.content.startsWith('Exit code: 0\n')) steps.push(`shell: ${args.command.slice(0, 800)}${args.command.length > 800 ? ' [truncated; inspect source]' : ''}`);
    if (call.name === 'git' && typeof args.action === 'string') steps.push(`git: ${args.action}`);
  }
  const uniqueSteps = [...new Set(steps)].slice(0, 12);
  if (!uniqueSteps.length) throw new MarsError('ConfigurationError', 'No reusable successful file/shell/Git steps found in the verified task. Add a procedure manually instead.');
  const content = redactKnowledgeSecrets([
    '# Procedure draft captured from a verified task',
    `\n## When to use\n${original.slice(0, 500)}`,
    '\n## Observed steps (excerpt; review order, paths and parameters before reuse)',
    ...uniqueSteps.map((step, index) => `${index + 1}. ${step}`),
    '\n## Verification commands',
    ...receipt.verificationCommands.map(command => `- ${command.slice(0, 500)}${command.length > 500 ? ' [truncated; inspect source]' : ''}`),
    '\n## Before reuse\nGeneralize task-specific paths and values. Keep current permissions and user instructions. Passing these checks only proves the behavior they cover; inspect the diff and do not weaken tests.',
  ].join('\n'));
  if (content.length > 10_000) throw new MarsError('LimitError', 'The captured procedure is too large. Create a focused procedure manually.');
  checkAbort(options.signal);
  return options.knowledge.propose({ kind: 'skill', name: `procedure-${receipt.id.slice(0, 8)}`, content,
    source: { origin: 'learning', sessionId: session.id, runId: receipt.id, verified: true } }, options.signal);
}
