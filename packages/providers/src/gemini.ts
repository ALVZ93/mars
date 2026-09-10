import type { AgentMessage, ModelEvent, ModelProvider, ModelRequest, ToolCall } from '../../core/src/index.js';
import { checkAbort, ForgeError } from '../../core/src/index.js';
import type { ApiKeyCredential, Credential, OAuthCredential } from '../../auth/src/index.js';

type FetchLike = typeof fetch;
type Json = Record<string, unknown>;

function safeRoot(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch { throw new ForgeError('ConfigurationError', 'Gemini endpoint must use HTTPS.'); }
}
function asObject(value: unknown): Json | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined; }
function asString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function contents(messages: AgentMessage[]): { system?: { parts: Array<{ text: string }> }; contents: unknown[] } {
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
  return { ...(system ? { system: { parts: [{ text: system }] } } : {}), contents: values };
}
function tools(request: ModelRequest): unknown[] { return [{ functionDeclarations: request.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }]; }
async function* parseSse(response: Response, signal: AbortSignal): AsyncGenerator<Json> {
  if (!response.body) throw new ForgeError('ProviderUnavailableError', 'Gemini returned no stream body.');
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
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n').trim();
        if (data) {
          try { const value: unknown = JSON.parse(data); if (asObject(value)) yield value as Json; }
          catch { throw new ForgeError('ProviderUnavailableError', 'Gemini returned malformed streaming data.'); }
        }
        index = buffer.indexOf('\n\n');
      }
      if (chunk.done) break;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface GeminiProviderOptions { fetch?: FetchLike; baseUrl?: string; projectId?: string }
export class GeminiProvider implements ModelProvider {
  readonly id = 'gemini';
  readonly #credential: ApiKeyCredential | OAuthCredential;
  readonly #fetch: FetchLike;
  readonly #root: string;
  readonly #projectId?: string;
  constructor(credential: Credential, options: GeminiProviderOptions = {}) {
    if (credential.provider !== this.id || (credential.kind !== 'api-key' && credential.kind !== 'oauth')) throw new ForgeError('AuthenticationError', 'A Gemini API key or Google Cloud browser credential is required.');
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
    catch { checkAbort(signal); throw new ForgeError('ProviderUnavailableError', 'Gemini request failed. Check connectivity and model availability.'); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new ForgeError('AuthenticationError', 'Gemini rejected the credential or project access.');
      if (response.status === 429) throw new ForgeError('RateLimitError', 'Gemini rate or quota limit reached.');
      if (response.status === 413) throw new ForgeError('ContextLimitError', 'Gemini rejected the request because it is too large.');
      throw new ForgeError('ProviderUnavailableError', 'Gemini request failed. Check connectivity and model availability.');
    }
    let content = '';
    const toolCalls: ToolCall[] = [];
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const event of parseSse(response, signal)) {
      const candidates = event.candidates;
      const counts = asObject(event.usageMetadata);
      if (counts && Number.isSafeInteger(counts.promptTokenCount) && Number.isSafeInteger(counts.candidatesTokenCount)) usage = { inputTokens: counts.promptTokenCount as number, outputTokens: counts.candidatesTokenCount as number };
      const candidate = Array.isArray(candidates) ? asObject(candidates[0]) : undefined;
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
          if (!name) throw new ForgeError('InvalidToolCallError', 'Gemini returned a tool call without a name.');
          toolCalls.push({ id: `${name}-${toolCalls.length + 1}`, name, arguments: call.args ?? {} });
        }
      }
    }
    yield { type: 'done', message: { role: 'assistant', content, toolCalls }, usage };
  }
}
