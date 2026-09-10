import type { ErrorCode } from './errors.js';

export type AgentEvent =
  | { type: 'model:usage'; provider: string; inputTokens: number; outputTokens: number }
  | { type: 'session:start' | 'session:end' }
  | { type: 'turn:start' | 'turn:end'; turn: number }
  | { type: 'model:request'; turn: number; provider?: string; model: string; messageCount: number; toolCount: number }
  | { type: 'model:response'; turn: number; provider?: string; toolCount: number; contentChars: number }
  | { type: 'model:error'; turn: number; provider?: string; error: ErrorCode }
  | { type: 'model:retry'; turn: number; provider?: string; attempt: number; delayMs: number; error: ErrorCode }
  | { type: 'model:text'; text: string }
  | { type: 'tool:before' | 'tool:start' | 'tool:end' | 'tool:error'; callId: string; tool: string; error?: ErrorCode }
  | { type: 'permission:requested' | 'permission:granted' | 'permission:denied'; permission: string; target?: string }
  | { type: 'context:built' | 'context:compacted'; chars?: number }
  | { type: 'workflow:start' | 'workflow:end'; workflow: string }
  | { type: 'evidence:recorded'; workflow?: string; skills: string[]; passed: boolean };
export type EventSink = (event: AgentEvent) => void;
