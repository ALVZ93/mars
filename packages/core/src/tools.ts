import type { ToolCall, ToolResult } from './messages.js';

export interface ToolSchema { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolContext { signal: AbortSignal }
export interface Tool extends ToolSchema {
  validate(input: unknown): unknown;
  execute(input: unknown, context: ToolContext): Promise<string>;
}
export interface ToolExecutor {
  schemas(): ToolSchema[];
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
}
