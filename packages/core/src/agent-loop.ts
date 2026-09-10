import { abortable, checkAbort } from './abort.js';
import { compactHistory, historyChars } from './compaction.js';
import { MarsError } from './errors.js';
import type { EventSink } from './events.js';
import type { AgentMessage, AssistantMessage } from './messages.js';
import type { ModelProvider } from './providers.js';
import type { ToolExecutor } from './tools.js';

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
  maxRetries?: number;
  retryDelayMs?: number;
  onCheckpoint?: (messages: AgentMessage[]) => void;
}

function retryable(error: unknown): error is MarsError {
  if (!(error instanceof MarsError)) return false;
  if (error.code === 'RateLimitError') return true;
  return error.code === 'ProviderUnavailableError' && !/\bHTTP\s+(?:400|401|403|404|422)\b/i.test(error.message);
}

async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  await abortable(new Promise<void>(resolve => setTimeout(resolve, milliseconds)), signal);
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
    if (!Number.isSafeInteger(value) || value < 1) throw new MarsError('ConfigurationError', 'Limits must be positive integers.');
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new MarsError('ConfigurationError', 'maxRetries must be a non-negative integer.');
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
        if (historyChars(messages) > contextLimit) throw new MarsError('ContextLimitError', 'Current task and required instructions exceed the session context limit.');
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
              if (streamedChars > contextLimit) throw new MarsError('ContextLimitError', 'Model output limit reached.');
              emit({ type: 'model:text', text: item.value.text });
            } else {
              response = item.value.message;
              if (item.value.usage) emit({ type: 'model:usage', provider: provider.id, ...item.value.usage });
              break;
            }
          }
          checkAbort(signal);
          if (!response) throw new MarsError('ProviderUnavailableError', 'Model stream ended without a final message.');
        } catch (error) {
          const canRetry = retryable(error) && attempt < maxRetries && streamedChars === 0 && !signal.aborted;
          if (canRetry) {
            attempt++;
            const delayMs = Math.min(retryDelayMs * (2 ** (attempt - 1)), 30_000);
            emit({ type: 'model:retry', turn, provider: provider.id, attempt, delayMs, error: error.code });
            try { await waitForRetry(delayMs, signal); }
            catch (waitError) {
              emit({ type: 'model:error', turn, provider: provider.id, error: waitError instanceof MarsError ? waitError.code : 'ProviderUnavailableError' });
              throw waitError;
            }
            continue;
          }
          emit({ type: 'model:error', turn, provider: provider.id, error: error instanceof MarsError ? error.code : 'ProviderUnavailableError' });
          throw error;
        } finally {
          void Promise.resolve(iterator.return?.()).catch(() => {});
        }
      }
      checkAbort(signal);
      if (JSON.stringify(response).length > contextLimit) throw new MarsError('ContextLimitError', 'Model output limit reached.');
      emit({ type: 'model:response', turn, provider: provider.id, toolCount: response.toolCalls.length, contentChars: response.content.length });
      for (const call of response.toolCalls) {
        if (!call.id || ids.has(call.id)) throw new MarsError('InvalidToolCallError', 'Missing or duplicate tool call ID.');
        ids.add(call.id);
      }
      if (calls + response.toolCalls.length > maxCalls) throw new MarsError('LimitError', 'Tool call limit reached.');
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
    throw new MarsError('LimitError', `Turn limit reached (${maxTurns}). Continue with a new message or raise limits.maxTurns.`);
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
