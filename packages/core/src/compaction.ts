import type { AgentMessage } from './messages.js';

export function historyChars(messages: readonly AgentMessage[]): number {
  return JSON.stringify(messages).length;
}

export function compactHistory(messages: readonly AgentMessage[], limit: number): AgentMessage[] {
  const systems = messages.filter(message => message.role === 'system');
  const conversational = messages.filter(message => message.role !== 'system');
  const groups: AgentMessage[][] = [];
  for (const message of conversational) {
    if (message.role === 'user' || groups.length === 0) groups.push([]);
    groups.at(-1)!.push(message);
  }
  if (groups.length < 2) return [...messages];
  const marker: AgentMessage = { role: 'system', content: 'Earlier conversation turns were removed by local context compaction. Re-inspect the workspace when prior details are needed.' };
  const target = Math.floor(limit * 0.75);
  const kept: AgentMessage[][] = [];
  for (let index = groups.length - 1; index >= 0; index--) {
    const candidate = [systems[0], marker, ...systems.slice(1), ...groups[index]!, ...kept.flat()].filter(Boolean) as AgentMessage[];
    if (kept.length && historyChars(candidate) > target) break;
    kept.unshift(groups[index]!);
  }
  if (kept.length === groups.length) return [...messages];
  return [systems[0], marker, ...systems.slice(1), ...kept.flat()].filter(Boolean) as AgentMessage[];
}
