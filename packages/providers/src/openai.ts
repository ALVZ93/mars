import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { AgentMessage, ModelEvent, ModelProvider, ModelRequest, ToolCall } from '../../core/src/index.js';
import { checkAbort, ForgeError } from '../../core/src/index.js';
import type { ApiKeyCredential } from '../../auth/src/index.js';

export function toOpenAIMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
  return messages.map(message => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.callId, content: message.error ? `${message.error}: ${message.content}` : message.content };
    if (message.role === 'assistant') return {
      role: 'assistant', content: message.content || null,
      ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
    };
    return { role: message.role, content: message.content };
  });
}

export interface OpenAICompatibleProviderOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  providerId?: string;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  #client: OpenAI;
  #secret: string;
  constructor(credential: ApiKeyCredential, options: OpenAICompatibleProviderOptions = {}) {
    this.id = options.providerId ?? credential.provider;
    if (credential.provider !== this.id || credential.kind !== 'api-key' || !credential.secret.trim()) throw new ForgeError('AuthenticationError', 'An OpenAI-compatible API key is required.');
    this.#secret = credential.secret;
    this.#client = new OpenAI({ apiKey: credential.secret, maxRetries: 0, timeout: 120_000, ...(options.baseUrl ? { baseURL: options.baseUrl } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
  }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    let stream;
    try {
      checkAbort(signal);
      stream = await this.#client.chat.completions.create({
        model: request.model,
        messages: toOpenAIMessages(request.messages),
        tools: request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: true } })),
        stream: true,
        stream_options: { include_usage: true },
        store: false,
      }, { signal });
      let content = '';
      let size = 0;
      let finished = false;
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      const pending = new Map<number, { id: string; name: string; json: string }>();
      for await (const chunk of stream) {
        checkAbort(signal);
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta.content) {
          content += choice.delta.content;
          size += choice.delta.content.length;
          yield { type: 'text', text: choice.delta.content };
        }
        if (choice.delta.refusal) throw new ForgeError('ProviderUnavailableError', 'The provider declined the request.');
        for (const part of choice.delta.tool_calls ?? []) {
          const call = pending.get(part.index) ?? { id: '', name: '', json: '' };
          call.id += part.id ?? '';
          call.name += part.function?.name ?? '';
          call.json += part.function?.arguments ?? '';
          size += (part.id?.length ?? 0) + (part.function?.name?.length ?? 0) + (part.function?.arguments?.length ?? 0);
          pending.set(part.index, call);
        }
        if (size > 1_000_000 || pending.size > 100) throw new ForgeError('ContextLimitError', 'Provider output exceeded the limit.');
        if (choice.finish_reason) {
          if (!['stop', 'tool_calls'].includes(choice.finish_reason)) throw new ForgeError('ProviderUnavailableError', 'The provider response was incomplete.');
          finished = true;
        }
      }
      if (!finished) throw new ForgeError('ProviderUnavailableError', 'Provider stream ended prematurely.');
      const toolCalls: ToolCall[] = [...pending.values()].map(call => {
        if (!call.id || !call.name) throw new ForgeError('InvalidToolCallError', 'Incomplete tool call.');
        let args: unknown;
        try { args = JSON.parse(call.json); }
        catch { throw new ForgeError('InvalidToolCallError', 'Provider returned malformed tool arguments.'); }
        return { id: call.id, name: call.name, arguments: args };
      });
      yield { type: 'done', message: { role: 'assistant', content, toolCalls }, usage };
    } catch (error) {
      checkAbort(signal);
      if (error instanceof ForgeError) throw error;
      if (error instanceof OpenAI.APIError) {
        if (error.status === 401 || error.status === 403) throw new ForgeError('AuthenticationError', `${this.id} rejected the credential or model access.`);
        if (error.status === 429) throw new ForgeError('RateLimitError', `${this.id} rate or quota limit reached.`);
        const detail = error.message.replaceAll(this.#secret, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\s+/g, ' ').trim().slice(0, 240);
        throw new ForgeError('ProviderUnavailableError', `${this.id} rejected the request (HTTP ${error.status ?? 'unknown'}${detail ? `: ${detail}` : ''}). Check the model name and provider availability.`);
      }
      throw new ForgeError('ProviderUnavailableError', `${this.id} request failed. Check connectivity and model availability.`);
    } finally { stream?.controller.abort(); }
  }
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(credential: ApiKeyCredential, options: { fetch?: typeof fetch } = {}) {
    super(credential, { ...options, providerId: 'openai' });
  }
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(credential: ApiKeyCredential, options: { fetch?: typeof fetch; baseUrl?: string } = {}) {
    super(credential, { ...options, providerId: 'openrouter', baseUrl: options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1' });
  }
}

/** Ollama exposes an OpenAI-compatible local endpoint and does not require a credential. */
export class OllamaProvider extends OpenAICompatibleProvider {
  constructor(options: { fetch?: typeof fetch; baseUrl?: string } = {}) {
    super({ provider: 'ollama', kind: 'api-key', secret: 'local' }, { ...options, providerId: 'ollama', baseUrl: options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1' });
  }
}
