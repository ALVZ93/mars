import type { AgentMessage, AssistantMessage } from './messages.js';
import type { ToolSchema } from './tools.js';

export interface ModelRequest { model: string; messages: AgentMessage[]; tools: ToolSchema[] }
export interface TokenUsage { inputTokens: number; outputTokens: number }
export type ModelEvent = { type: 'text'; text: string } | { type: 'done'; message: AssistantMessage; usage?: TokenUsage };
export interface ModelProvider {
  readonly id: string;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  listModels?(signal?: AbortSignal): Promise<ModelDescriptor[]>;
}
export interface ModelDescriptor {
  id: string;
  provider: string;
  model: string;
  capabilities: {
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
    structuredOutput: boolean;
    streaming: boolean;
  };
  contextWindow?: number;
  pricing?: { inputPerMillion?: number; outputPerMillion?: number };
  metadata?: Record<string, unknown>;
}
