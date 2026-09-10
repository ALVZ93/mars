import type { ErrorCode } from './errors.js';

export interface ToolCall { id: string; name: string; arguments: unknown }
export interface ToolResult { content: string; error?: ErrorCode }
export interface AssistantMessage { role: 'assistant'; content: string; toolCalls: ToolCall[] }
export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | ({ role: 'tool'; callId: string } & ToolResult);
