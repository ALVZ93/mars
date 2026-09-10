import type { AgentMessage } from './messages.js';

export function historyChars(messages: readonly AgentMessage[]): number {
  return JSON.stringify(messages).length;
}

export function compactHistory(messages: readonly AgentMessage[], limit: number): AgentMessage[] {
  const systems = messages.filter(message => message.role === 'system');
  const conversational = messages.filter(message => message.role !== 'system');
  const latestUser = conversational.findLastIndex(message => message.role === 'user');
  if (latestUser < 0) return [...messages];
  const marker: AgentMessage = { role: 'system', content: 'Earlier conversation turns were removed by local context compaction. Re-inspect the workspace when prior details are needed.' };
  const target = Math.floor(limit * 0.75);
  const anchor = conversational[latestUser]!;
  const turns: AgentMessage[][] = [];
  for (const message of conversational.slice(latestUser + 1)) {
    if (message.role === 'assistant' || turns.length === 0) turns.push([]);
    turns.at(-1)!.push(message);
  }
  const kept: AgentMessage[][] = [];
  for (let index = turns.length - 1; index >= 0; index--) {
    const candidate = [systems[0], marker, ...systems.slice(1), anchor, ...turns[index]!, ...kept.flat()].filter(Boolean) as AgentMessage[];
    if (kept.length && historyChars(candidate) > target) break;
    kept.unshift(turns[index]!);
  }
  const compacted = [systems[0], marker, ...systems.slice(1), anchor, ...kept.flat()].filter(Boolean) as AgentMessage[];
  return compacted.length < messages.length ? compacted : [...messages];
}
