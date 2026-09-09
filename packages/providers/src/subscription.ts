import type { AssistantMessage, AgentMessage, ModelEvent, ModelProvider, ModelRequest, ToolCall } from '../../core/src/index.js';
import { randomUUID } from 'node:crypto';
import { checkAbort, ForgeError } from '../../core/src/index.js';
import type { ApiKeyCredential, Credential, OAuthCredential } from '../../auth/src/index.js';
import { OpenAICompatibleProvider } from './openai.js';

type FetchLike = typeof fetch;
type Json = Record<string, unknown>;

function endpoint(value: string, suffix: string): string {
  const normalized = value.replace(/\/+$/, '');
  if (normalized.endsWith(suffix)) return normalized;
  if (suffix === '/v1/messages' && normalized.endsWith('/v1')) return `${normalized}/messages`;
  if (suffix === '/codex/responses' && normalized.endsWith('/codex')) return `${normalized}/responses`;
  return `${normalized}${suffix}`;
}
function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error();
    return url.toString();
  } catch { throw new ForgeError('ConfigurationError', 'Provider endpoint must use HTTPS.'); }
}
function asString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function diagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').trim();
  return text ? text.slice(0, 240) : undefined;
}
async function responseDiagnostic(response: Response): Promise<string | undefined> {
  try {
    const raw = await response.clone().text();
    if (!raw.trim()) return undefined;
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; } catch { return diagnostic(raw); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return diagnostic(raw);
    const record = value as Json;
    const error = record.error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const detail = [asString((error as Json).code) ?? asString((error as Json).type), asString((error as Json).message)].filter(Boolean).join(': ');
      return diagnostic(detail) ?? diagnostic(raw);
    }
    return diagnostic(asString(record.message) ?? asString(error)) ?? diagnostic(raw);
  } catch { return undefined; }
}

async function sendRequest(fetchImpl: FetchLike, url: string, init: RequestInit, signal: AbortSignal, provider: string): Promise<Response> {
  try { return await fetchImpl(url, { ...init, signal }); }
  catch (error) {
    checkAbort(signal);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
    const code = error instanceof Error && error.cause && typeof error.cause === 'object' ? asString((error.cause as Json).code) : undefined;
    const detail = diagnostic([error instanceof Error ? error.message : undefined, cause, code].filter(Boolean).join(': '));
    throw new ForgeError('ProviderUnavailableError', `${provider} request failed${detail ? ` (${detail})` : ''}. Check connectivity and model availability.`);
  }
}
async function ensureOk(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  const detail = await responseDiagnostic(response);
  const suffix = ` (HTTP ${response.status}${detail ? `: ${detail}` : ''})`;
  if (response.status === 401 || response.status === 403) throw new ForgeError('AuthenticationError', `${provider} rejected the credential or model access${suffix}.`);
  if (response.status === 429) throw new ForgeError('RateLimitError', `${provider} rate or usage limit reached${suffix}.`);
  if (response.status === 413) throw new ForgeError('ContextLimitError', `${provider} rejected the request because it is too large${suffix}.`);
  throw new ForgeError('ProviderUnavailableError', `${provider} request failed${suffix}. Check connectivity and model availability.`);
}

async function* sse(response: Response, signal: AbortSignal): AsyncGenerator<Json> {
  if (!response.body) throw new ForgeError('ProviderUnavailableError', 'Provider returned no stream body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (chunk.done && buffer.trim()) buffer += '\n\n';
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n').trim();
        if (data && data !== '[DONE]') {
          try {
            const parsed: unknown = JSON.parse(data);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) yield parsed as Json;
          } catch { throw new ForgeError('ProviderUnavailableError', 'Provider returned malformed streaming data.'); }
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (chunk.done) break;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function anthropicMessages(messages: AgentMessage[]): { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: unknown }> } {
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n').trim();
  const result: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') result.push({ role: 'user', content: message.content });
    else if (message.role === 'assistant') {
      const content: unknown[] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      if (content.length) result.push({ role: 'assistant', content });
    } else if (message.role === 'tool') {
      result.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.callId, content: message.error ? `${message.error}: ${message.content}` : message.content, ...(message.error ? { is_error: true } : {}) }] });
    }
  }
  return { ...(system ? { system } : {}), messages: result };
}
function anthropicTools(request: ModelRequest): unknown[] {
  return request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
}

export interface AnthropicTransportOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  maxTokens?: number;
}
export class AnthropicProvider implements ModelProvider {
  readonly id: string = 'anthropic';
  readonly #credential: Credential;
  readonly #fetch: FetchLike;
  readonly #url: string;
  readonly #maxTokens: number;
  constructor(credential: Credential, options: AnthropicTransportOptions = {}) {
    if (credential.provider !== this.id || (credential.kind !== 'api-key' && credential.kind !== 'oauth')) throw new ForgeError('AuthenticationError', 'An Anthropic API key or browser credential is required.');
    this.#credential = credential;
    this.#fetch = options.fetch ?? fetch;
    this.#url = safeEndpoint(endpoint(options.baseUrl ?? 'https://api.anthropic.com', '/v1/messages'));
    this.#maxTokens = options.maxTokens ?? 4096;
  }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    checkAbort(signal);
    const headers = new Headers({ accept: 'text/event-stream', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' });
    if (this.#credential.kind === 'oauth') {
      headers.set('authorization', `Bearer ${this.#credential.accessToken}`);
      headers.set('anthropic-beta', 'oauth-2025-04-20');
      headers.set('user-agent', 'mars/0.1');
      headers.set('x-app', 'cli');
    } else headers.set('x-api-key', this.#credential.secret);
    const converted = anthropicMessages(request.messages);
    const body = { model: request.model, max_tokens: this.#maxTokens, stream: true, ...converted, ...(request.tools.length ? { tools: anthropicTools(request) } : {}) };
    let response: Response;
    try { response = await sendRequest(this.#fetch, this.#url, { method: 'POST', headers, body: JSON.stringify(body) }, signal, 'Anthropic'); }
    catch (error) { checkAbort(signal); throw error; }
    await ensureOk(response, 'Anthropic');
    let content = '';
    const tools = new Map<number, { id: string; name: string; json: string; input?: unknown }>();
    let sawStop = false;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const event of sse(response, signal)) {
      checkAbort(signal);
      const type = asString(event.type);
      if (type === 'message_start') {
        const message = event.message;
        const counts = message && typeof message === 'object' && !Array.isArray(message) ? (message as Json).usage : undefined;
        if (counts && typeof counts === 'object' && !Array.isArray(counts)) {
          const inputTokens = (counts as Json).input_tokens;
          const outputTokens = (counts as Json).output_tokens;
          if (Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens)) usage = { inputTokens: inputTokens as number, outputTokens: outputTokens as number };
        }
      } else if (type === 'content_block_start') {
        const index = typeof event.index === 'number' ? event.index : tools.size;
        const block = event.content_block;
        if (block && typeof block === 'object' && !Array.isArray(block) && (block as Json).type === 'tool_use') {
          const value = block as Json;
          tools.set(index, { id: asString(value.id) ?? '', name: asString(value.name) ?? '', json: '', input: value.input });
        }
      } else if (type === 'content_block_delta') {
        const delta = event.delta;
        if (!delta || typeof delta !== 'object' || Array.isArray(delta)) continue;
        const value = delta as Json;
        if (value.type === 'text_delta' && typeof value.text === 'string') { content += value.text; yield { type: 'text', text: value.text }; }
        if (value.type === 'input_json_delta' && typeof value.partial_json === 'string') {
          const index = typeof event.index === 'number' ? event.index : -1;
          const call = tools.get(index);
          if (!call) throw new ForgeError('InvalidToolCallError', 'Anthropic returned an unknown tool call.');
          call.json += value.partial_json;
        }
      } else if (type === 'content_block_stop') {
        const index = typeof event.index === 'number' ? event.index : -1;
        const call = tools.get(index);
        if (call && call.json) { try { call.input = JSON.parse(call.json); } catch { throw new ForgeError('InvalidToolCallError', 'Anthropic returned malformed tool arguments.'); } }
      } else if (type === 'message_delta') {
        const delta = event.delta;
        const counts = event.usage;
        if (counts && typeof counts === 'object' && !Array.isArray(counts)) {
          const outputTokens = (counts as Json).output_tokens;
          if (usage && Number.isSafeInteger(outputTokens)) usage.outputTokens = outputTokens as number;
        }
        const stop = delta && typeof delta === 'object' && !Array.isArray(delta) ? asString((delta as Json).stop_reason) : undefined;
        if (stop) sawStop = true;
        if (stop && !['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'].includes(stop)) throw new ForgeError('ProviderUnavailableError', 'Anthropic response was incomplete.');
      } else if (type === 'message_stop') sawStop = true;
      else if (type === 'error') throw new ForgeError('ProviderUnavailableError', 'Anthropic returned a streaming error.');
    }
    if (!sawStop) throw new ForgeError('ProviderUnavailableError', 'Anthropic stream ended prematurely.');
    const toolCalls: ToolCall[] = [];
    for (const call of tools.values()) {
      if (!call.id || !call.name || call.input === undefined) throw new ForgeError('InvalidToolCallError', 'Anthropic returned an incomplete tool call.');
      toolCalls.push({ id: call.id, name: call.name, arguments: call.input });
    }
    yield { type: 'done', message: { role: 'assistant', content, toolCalls }, usage };
  }
}

export interface KimiCodeProviderOptions extends AnthropicTransportOptions {}
export class KimiCodeProvider extends AnthropicProvider {
  readonly id = 'kimi-code';
  constructor(credential: ApiKeyCredential | OAuthCredential, options: KimiCodeProviderOptions = {}) {
    if (credential.provider !== 'kimi-code') throw new ForgeError('AuthenticationError', 'A Kimi Code credential is required.');
    super({ ...credential, provider: 'anthropic' }, { ...options, baseUrl: options.baseUrl ?? 'https://api.kimi.com/coding/v1' });
  }
}

export interface QwenProviderOptions { fetch?: FetchLike; baseUrl?: string }
export class QwenProvider extends OpenAICompatibleProvider {
  constructor(credential: ApiKeyCredential, options: QwenProviderOptions = {}) {
    super(credential, {
      providerId: 'qwen',
      fetch: options.fetch,
      baseUrl: options.baseUrl ?? process.env.QWEN_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    });
  }
}

interface CodexProviderOptions { fetch?: FetchLike; baseUrl?: string }
type ResponsesInput = Array<Record<string, unknown>>;
function codexInput(messages: AgentMessage[]): { instructions?: string; input: ResponsesInput } {
  const instructions = messages.filter(message => message.role === 'system').map(message => message.content).join('\n').trim();
  const input: ResponsesInput = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') input.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] });
    else if (message.role === 'assistant') {
      if (message.content) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      for (const call of message.toolCalls) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
    } else if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.callId, output: message.error ? `${message.error}: ${message.content}` : message.content });
  }
  return { ...(instructions ? { instructions } : {}), input };
}
function codexTools(request: ModelRequest): unknown[] { return request.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })); }
async function* codexEvents(response: Response, signal: AbortSignal): AsyncGenerator<Json> { yield* sse(response, signal); }

export class OpenAICodexProvider implements ModelProvider {
  readonly id = 'openai-codex';
  readonly #credential: OAuthCredential;
  readonly #fetch: FetchLike;
  readonly #url: string;
  readonly #sessionId = randomUUID();
  constructor(credential: OAuthCredential, options: CodexProviderOptions = {}) {
    if (credential.provider !== this.id || credential.kind !== 'oauth' || !credential.accessToken || !credential.accountId) throw new ForgeError('AuthenticationError', 'An OpenAI Codex browser credential is required.');
    this.#credential = credential;
    this.#fetch = options.fetch ?? fetch;
    this.#url = safeEndpoint(endpoint(options.baseUrl ?? 'https://chatgpt.com/backend-api', '/codex/responses'));
  }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    checkAbort(signal);
    const headers = new Headers({
      authorization: `Bearer ${this.#credential.accessToken}`,
      'chatgpt-account-id': this.#credential.accountId!,
      originator: 'codex_cli_rs',
      'user-agent': 'codex_cli_rs/0.1.0',
      'session-id': this.#sessionId,
      'x-client-request-id': this.#sessionId,
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'openai-beta': 'responses=experimental',
    });
    const converted = codexInput(request.messages);
    const body = {
      model: request.model,
      store: false,
      stream: true,
      instructions: converted.instructions ?? 'You are MARS, a coding agent.',
      input: converted.input,
      include: ['reasoning.encrypted_content'],
      text: { verbosity: 'low' },
      ...(request.tools.length ? { tools: codexTools(request) } : {}),
      tool_choice: 'auto',
      parallel_tool_calls: true,
    };
    const response = await sendRequest(this.#fetch, this.#url, { method: 'POST', headers, body: JSON.stringify(body) }, signal, 'OpenAI Codex');
    await ensureOk(response, 'OpenAI Codex');
    let content = '';
    const tools = new Map<number, { id: string; name: string; json: string }>();
    let complete = false;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const event of codexEvents(response, signal)) {
      checkAbort(signal);
      const type = asString(event.type);
      if (type === 'response.output_item.added') {
        const item = event.item;
        if (item && typeof item === 'object' && !Array.isArray(item) && (item as Json).type === 'function_call') {
          const value = item as Json;
          const index = typeof event.output_index === 'number' ? event.output_index : tools.size;
          tools.set(index, { id: asString(value.call_id) ?? '', name: asString(value.name) ?? '', json: asString(value.arguments) ?? '' });
        }
      } else if (type === 'response.output_text.delta') {
        const delta = asString(event.delta) ?? '';
        content += delta;
        if (delta) yield { type: 'text', text: delta };
      } else if (type === 'response.function_call_arguments.delta') {
        const index = typeof event.output_index === 'number' ? event.output_index : -1;
        const call = tools.get(index);
        if (!call) throw new ForgeError('InvalidToolCallError', 'OpenAI Codex returned an unknown tool call.');
        call.json += asString(event.delta) ?? '';
      } else if (type === 'response.function_call_arguments.done') {
        const index = typeof event.output_index === 'number' ? event.output_index : -1;
        const call = tools.get(index);
        if (call) call.json = asString(event.arguments) ?? call.json;
      } else if (type === 'response.failed' || type === 'error') {
        const error = event.error;
        const record = error && typeof error === 'object' && !Array.isArray(error) ? error as Json : undefined;
        const detail = diagnostic(asString(event.message) ?? asString(record?.message) ?? asString(event.code) ?? asString(record?.code));
        throw new ForgeError('ProviderUnavailableError', `OpenAI Codex returned a failed response${detail ? `: ${detail}` : '.'}`);
      }
      else if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete') {
        const responseData = event.response;
        const counts = (responseData as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage;
        if (Number.isSafeInteger(counts?.input_tokens) && Number.isSafeInteger(counts?.output_tokens) && counts!.input_tokens! >= 0 && counts!.output_tokens! >= 0) usage = { inputTokens: counts!.input_tokens!, outputTokens: counts!.output_tokens! };
        const status = responseData && typeof responseData === 'object' && !Array.isArray(responseData) ? asString((responseData as Json).status) : undefined;
        if (status && !['completed', 'in_progress', 'queued'].includes(status)) throw new ForgeError('ProviderUnavailableError', 'OpenAI Codex response was incomplete.');
        complete = true;
      }
    }
    if (!complete) throw new ForgeError('ProviderUnavailableError', 'OpenAI Codex stream ended prematurely.');
    const toolCalls: ToolCall[] = [];
    for (const call of tools.values()) {
      if (!call.id || !call.name) throw new ForgeError('InvalidToolCallError', 'OpenAI Codex returned an incomplete tool call.');
      let args: unknown;
      try { args = JSON.parse(call.json || '{}'); } catch { throw new ForgeError('InvalidToolCallError', 'OpenAI Codex returned malformed tool arguments.'); }
      toolCalls.push({ id: call.id, name: call.name, arguments: args });
    }
    yield { type: 'done', message: { role: 'assistant', content, toolCalls }, usage };
  }
}
