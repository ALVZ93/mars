import type { AgentMessage, ModelEvent, ModelProvider, ModelRequest, ToolCall } from '../../core/src/index.js';
import { checkAbort, MarsError } from '../../core/src/index.js';
import type { ApiKeyCredential, Credential, OAuthCredential } from '../../auth/src/index.js';
import { randomUUID } from 'node:crypto';
import { jsonSse } from './sse.js';

type FetchLike = typeof fetch;
type Json = Record<string, unknown>;

function safeRoot(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch { throw new MarsError('ConfigurationError', 'Gemini endpoint must use HTTPS.'); }
}
function asObject(value: unknown): Json | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined; }
function asString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function contents(messages: AgentMessage[]): { systemInstruction?: { parts: Array<{ text: string }> }; contents: unknown[] } {
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n').trim();
  const names = new Map<string, string>();
  for (const message of messages) if (message.role === 'assistant') for (const call of message.toolCalls) names.set(call.id, call.name);
  const values: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') values.push({ role: 'user', parts: [{ text: message.content }] });
    else if (message.role === 'assistant') {
      const parts: unknown[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls) parts.push({ functionCall: { name: call.name, args: call.arguments } });
      if (parts.length) values.push({ role: 'model', parts });
    } else if (message.role === 'tool') values.push({ role: 'user', parts: [{ functionResponse: { name: names.get(message.callId) ?? message.callId, response: { content: message.error ? `${message.error}: ${message.content}` : message.content } } }] });
  }
  return { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents: values };
}
function tools(request: ModelRequest): unknown[] { return [{ functionDeclarations: request.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }]; }

export interface GeminiProviderOptions { fetch?: FetchLike; baseUrl?: string; projectId?: string }
export class GeminiProvider implements ModelProvider {
  readonly id = 'gemini';
  readonly #credential: ApiKeyCredential | OAuthCredential;
  readonly #fetch: FetchLike;
  readonly #root: string;
  readonly #projectId?: string;
  constructor(credential: Credential, options: GeminiProviderOptions = {}) {
    if (credential.provider !== this.id || (credential.kind !== 'api-key' && credential.kind !== 'oauth')) throw new MarsError('AuthenticationError', 'A Gemini API key or Google Cloud browser credential is required.');
    this.#credential = credential;
    this.#fetch = options.fetch ?? fetch;
    this.#root = safeRoot(options.baseUrl ?? process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com');
    this.#projectId = options.projectId ?? (credential.kind === 'oauth' ? credential.metadata?.projectId ?? process.env.GOOGLE_CLOUD_PROJECT : undefined);
  }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    checkAbort(signal);
    const url = `${this.#root}/v1beta/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`;
    const headers = new Headers({ accept: 'text/event-stream', 'content-type': 'application/json' });
    if (this.#credential.kind === 'api-key') headers.set('x-goog-api-key', this.#credential.secret);
    else {
      headers.set('authorization', `Bearer ${this.#credential.accessToken}`);
      if (this.#projectId) headers.set('x-goog-user-project', this.#projectId);
    }
    const converted = contents(request.messages);
    const body = { ...converted, ...(request.tools.length ? { tools: tools(request) } : {}) };
    let response: Response;
    try { response = await this.#fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }); }
    catch { checkAbort(signal); throw new MarsError('ProviderUnavailableError', 'Gemini request failed. Check connectivity and model availability.'); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new MarsError('AuthenticationError', 'Gemini rejected the credential or project access.');
      if (response.status === 429) throw new MarsError('RateLimitError', 'Gemini rate or quota limit reached.');
      if (response.status === 413) throw new MarsError('ContextLimitError', 'Gemini rejected the request because it is too large.');
      throw new MarsError('ProviderUnavailableError', 'Gemini request failed. Check connectivity and model availability.');
    }
    let content = '';
    let finished = false;
    let outputSize = 0;
    const toolCalls: ToolCall[] = [];
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const event of jsonSse(response, signal)) {
      outputSize += JSON.stringify(event).length;
      if (outputSize > 1_000_000) throw new MarsError('ContextLimitError', 'Provider output exceeded the limit.');
      const candidates = event.candidates;
      const counts = asObject(event.usageMetadata);
      if (counts && Number.isSafeInteger(counts.promptTokenCount) && Number.isSafeInteger(counts.candidatesTokenCount)) usage = { inputTokens: counts.promptTokenCount as number, outputTokens: counts.candidatesTokenCount as number };
      const candidate = Array.isArray(candidates) ? asObject(candidates[0]) : undefined;
      if (candidate?.finishReason) {
        if (candidate.finishReason !== 'STOP') throw new MarsError('ProviderUnavailableError', 'Gemini response was incomplete.');
        finished = true;
      }
      const responseContent = asObject(candidate?.content);
      const parts = Array.isArray(responseContent?.parts) ? responseContent.parts : [];
      for (const part of parts) {
        const value = asObject(part);
        if (!value) continue;
        const text = asString(value.text);
        if (text) { content += text; yield { type: 'text', text }; }
        const call = asObject(value.functionCall);
        if (call) {
          const name = asString(call.name);
          if (!name) throw new MarsError('InvalidToolCallError', 'Gemini returned a tool call without a name.');
          toolCalls.push({ id: randomUUID(), name, arguments: call.args ?? {} });
        }
      }
    }
    if (!finished) throw new MarsError('ProviderUnavailableError', 'Gemini stream ended prematurely.');
    yield { type: 'done', message: { role: 'assistant', content, toolCalls }, usage };
  }
}
