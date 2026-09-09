export type ErrorCode =
  | 'AuthenticationError' | 'ProviderUnavailableError' | 'RateLimitError'
  | 'ContextLimitError' | 'InvalidToolCallError' | 'ToolExecutionError'
  | 'PermissionDeniedError' | 'WorkspaceViolationError' | 'TimeoutError'
  | 'CancelledError' | 'ConfigurationError' | 'LimitError';

export class ForgeError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = code;
  }
}

export interface ToolCall { id: string; name: string; arguments: unknown }
export interface ToolResult { content: string; error?: ErrorCode }
export interface AssistantMessage { role: 'assistant'; content: string; toolCalls: ToolCall[] }
export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | ({ role: 'tool'; callId: string } & ToolResult);
export interface ToolSchema { name: string; description: string; parameters: Record<string, unknown> }
export interface ModelRequest { model: string; messages: AgentMessage[]; tools: ToolSchema[] }
export interface TokenUsage { inputTokens: number; outputTokens: number }
export type ModelEvent = { type: 'text'; text: string } | { type: 'done'; message: AssistantMessage; usage?: TokenUsage };
export interface ModelProvider {
  readonly id: string;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  /** Optional catalog hook. Providers may return a static or remote catalog. */
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
export interface ToolContext { signal: AbortSignal }
export interface Tool extends ToolSchema {
  validate(input: unknown): unknown;
  execute(input: unknown, context: ToolContext): Promise<string>;
}
export interface ToolExecutor {
  schemas(): ToolSchema[];
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
}
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

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new ForgeError(
    signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'CancelledError',
    signal.reason?.name === 'TimeoutError' ? 'Operation timed out.' : 'Operation cancelled.',
  );
}

export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { try { checkAbort(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export interface RunOptions {
  provider: ModelProvider;
  model: string;
  messages: AgentMessage[];
  tools: ToolExecutor;
  signal?: AbortSignal;
  emit?: EventSink;
  maxTurns?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  maxContextChars?: number;
  /** Disabled by default because retrying a provider request can duplicate billing. */
  maxRetries?: number;
  retryDelayMs?: number;
  onCheckpoint?: (messages: AgentMessage[]) => void;
}

function retryable(error: unknown): error is ForgeError {
  if (!(error instanceof ForgeError)) return false;
  if (error.code === 'RateLimitError') return true;
  return error.code === 'ProviderUnavailableError' && !/\bHTTP\s+(?:400|401|403|404|422)\b/i.test(error.message);
}

async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  await abortable(new Promise<void>(resolve => setTimeout(resolve, milliseconds)), signal);
}

function historyChars(messages: readonly AgentMessage[]): number {
  return JSON.stringify(messages).length;
}

function compactHistory(messages: readonly AgentMessage[], limit: number): AgentMessage[] {
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

export async function runAgent(options: RunOptions): Promise<AgentMessage[]> {
  const { provider, model, tools, emit = () => {} } = options;
  const maxTurns = options.maxTurns ?? 24;
  const maxCalls = options.maxToolCalls ?? 64;
  const timeout = options.timeoutMs ?? 120_000;
  const contextLimit = options.maxContextChars ?? 200_000;
  const maxRetries = options.maxRetries ?? 0;
  const retryDelayMs = options.retryDelayMs ?? 500;
  for (const value of [maxTurns, maxCalls, timeout, contextLimit, retryDelayMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ForgeError('ConfigurationError', 'Limits must be positive integers.');
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new ForgeError('ConfigurationError', 'maxRetries must be a non-negative integer.');
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(timeout)]);
  let messages = structuredClone(options.messages);
  const ids = new Set(messages.flatMap(message => message.role === 'assistant' ? message.toolCalls.map(call => call.id) : []));
  let calls = 0;
  emit({ type: 'session:start' });
  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      checkAbort(signal);
      if (historyChars(messages) > contextLimit) {
        const before = historyChars(messages);
        messages = compactHistory(messages, contextLimit);
        if (historyChars(messages) < before) {
          emit({ type: 'context:compacted', chars: before - historyChars(messages) });
          options.onCheckpoint?.(structuredClone(messages));
        }
        if (historyChars(messages) > contextLimit) throw new ForgeError('ContextLimitError', 'Current task and required instructions exceed the session context limit.');
      }
      emit({ type: 'turn:start', turn });
      let response: AssistantMessage | undefined;
      let attempt = 0;
      while (!response) {
        emit({ type: 'model:request', turn, provider: provider.id, model, messageCount: messages.length, toolCount: tools.schemas().length });
        const iterator = provider.stream({ model, messages: structuredClone(messages), tools: tools.schemas() }, signal)[Symbol.asyncIterator]();
        let streamedChars = 0;
        try {
          while (true) {
            const item = await abortable(iterator.next(), signal);
            if (item.done) break;
            if (item.value.type === 'text') {
              streamedChars += item.value.text.length;
              if (streamedChars > contextLimit) throw new ForgeError('ContextLimitError', 'Model output limit reached.');
              emit({ type: 'model:text', text: item.value.text });
            } else {
              response = item.value.message;
              if (item.value.usage) emit({ type: 'model:usage', provider: provider.id, ...item.value.usage });
              break;
            }
          }
          checkAbort(signal);
          if (!response) throw new ForgeError('ProviderUnavailableError', 'Model stream ended without a final message.');
        } catch (error) {
          const canRetry = retryable(error) && attempt < maxRetries && streamedChars === 0 && !signal.aborted;
          if (canRetry) {
            attempt++;
            const delayMs = Math.min(retryDelayMs * (2 ** (attempt - 1)), 30_000);
            emit({ type: 'model:retry', turn, provider: provider.id, attempt, delayMs, error: error.code });
            try { await waitForRetry(delayMs, signal); }
            catch (waitError) {
              emit({ type: 'model:error', turn, provider: provider.id, error: waitError instanceof ForgeError ? waitError.code : 'ProviderUnavailableError' });
              throw waitError;
            }
            continue;
          }
          emit({ type: 'model:error', turn, provider: provider.id, error: error instanceof ForgeError ? error.code : 'ProviderUnavailableError' });
          throw error;
        } finally {
          // Do not wait on a provider that ignores cancellation.
          void Promise.resolve(iterator.return?.()).catch(() => {});
        }
      }
      checkAbort(signal);
      if (JSON.stringify(response).length > contextLimit) throw new ForgeError('ContextLimitError', 'Model output limit reached.');
      emit({ type: 'model:response', turn, provider: provider.id, toolCount: response.toolCalls.length, contentChars: response.content.length });
      for (const call of response.toolCalls) {
        if (!call.id || ids.has(call.id)) throw new ForgeError('InvalidToolCallError', 'Missing or duplicate tool call ID.');
        ids.add(call.id);
      }
      if (calls + response.toolCalls.length > maxCalls) throw new ForgeError('LimitError', 'Tool call limit reached.');
      messages.push(response);
      for (const call of response.toolCalls) {
        checkAbort(signal);
        calls++;
        emit({ type: 'tool:before', callId: call.id, tool: call.name });
        emit({ type: 'tool:start', callId: call.id, tool: call.name });
        const result = await abortable(tools.execute(call, signal), signal);
        messages.push({ role: 'tool', callId: call.id, ...result });
        emit({ type: 'tool:end', callId: call.id, tool: call.name, error: result.error });
        if (result.error) emit({ type: 'tool:error', callId: call.id, tool: call.name, error: result.error });
      }
      emit({ type: 'turn:end', turn });
      if (!response.toolCalls.length) return messages;
    }
    throw new ForgeError('LimitError', `Turn limit reached (${maxTurns}). Continue with a new message or raise limits.maxTurns.`);
  } catch (error) {
    const completed = new Set(messages.filter(message => message.role === 'tool').map(message => message.callId));
    for (const message of [...messages]) {
      if (message.role !== 'assistant') continue;
      for (const call of message.toolCalls) {
        if (!completed.has(call.id)) messages.push({ role: 'tool', callId: call.id, error: 'CancelledError', content: 'Run interrupted. Execution may have partially completed; inspect state before retrying.' });
      }
    }
    throw error;
  } finally {
    options.onCheckpoint?.(structuredClone(messages));
    emit({ type: 'session:end' });
  }
}
