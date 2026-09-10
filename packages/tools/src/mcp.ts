import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { MarsError, checkAbort } from '../../core/src/index.js';
import type { Tool, ToolContext } from '../../core/src/index.js';

type Json = Record<string, unknown>;

export interface McpStdioServerOptions {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}
export interface McpToolDefinition { name: string; description?: string; inputSchema?: Record<string, unknown> }
export interface McpConnectResult { client: McpStdioClient; tools: Tool[] }

function allowedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'appdata', 'localappdata', 'lang', 'lc_all', 'term']);
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toLowerCase())));
}
function object(value: unknown): Json | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined; }
function textContent(value: unknown): string {
  const record = object(value);
  if (!record) return typeof value === 'string' ? value : JSON.stringify(value);
  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content.map(item => {
    const entry = object(item);
    if (entry?.type === 'text' && typeof entry.text === 'string') return entry.text;
    return entry ? JSON.stringify(entry) : '';
  }).filter(Boolean);
  if (record.isError === true) throw new MarsError('ToolExecutionError', parts.join('\n') || 'MCP tool reported an error.');
  return parts.join('\n') || (record.structuredContent ? JSON.stringify(record.structuredContent) : JSON.stringify(value));
}
function validateSchema(input: unknown, schema: Record<string, unknown>, label = 'input'): unknown {
  const type = schema.type;
  if (type === 'object') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MarsError('InvalidToolCallError', `${label} must be an object.`);
    const source = input as Record<string, unknown>;
    const properties = object(schema.properties) ?? {};
    const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : [];
    for (const key of required) if (!(key in source)) throw new MarsError('InvalidToolCallError', `${label}.${key} is required.`);
    if (schema.additionalProperties === false) for (const key of Object.keys(source)) if (!(key in properties)) throw new MarsError('InvalidToolCallError', `${label}.${key} is not allowed.`);
    for (const [key, value] of Object.entries(source)) {
      const property = object(properties[key]);
      if (property) validateSchema(value, property, `${label}.${key}`);
    }
    return input;
  }
  if (type === 'string' && typeof input !== 'string') throw new MarsError('InvalidToolCallError', `${label} must be a string.`);
  if (type === 'number' && (typeof input !== 'number' || !Number.isFinite(input))) throw new MarsError('InvalidToolCallError', `${label} must be a number.`);
  if (type === 'integer' && (!Number.isSafeInteger(input))) throw new MarsError('InvalidToolCallError', `${label} must be an integer.`);
  if (type === 'boolean' && typeof input !== 'boolean') throw new MarsError('InvalidToolCallError', `${label} must be a boolean.`);
  if (type === 'array') {
    if (!Array.isArray(input)) throw new MarsError('InvalidToolCallError', `${label} must be an array.`);
    const items = object(schema.items);
    if (items) input.forEach((value, index) => validateSchema(value, items, `${label}[${index}]`));
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(value => Object.is(value, input))) throw new MarsError('InvalidToolCallError', `${label} has an invalid value.`);
  return input;
}
function toolName(server: string, name: string): string { return `mcp_${server}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120); }

interface Pending { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }

/** Minimal MCP 2024-11-05 stdio client. Servers are opt-in and run as separate processes. */
export class McpStdioClient {
  readonly options: Required<Pick<McpStdioServerOptions, 'name' | 'command' | 'timeoutMs'>> & Omit<McpStdioServerOptions, 'name' | 'command' | 'timeoutMs'>;
  #child?: ChildProcessWithoutNullStreams;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #buffer = '';
  #start?: Promise<McpToolDefinition[]>;
  #closed = false;
  #tools: McpToolDefinition[] = [];
  constructor(options: McpStdioServerOptions) {
    if (!options.name.trim() || !options.command.trim()) throw new MarsError('ConfigurationError', 'MCP server name and command are required.');
    this.options = { ...options, name: options.name.trim(), command: options.command.trim(), args: [...(options.args ?? [])], timeoutMs: options.timeoutMs ?? 30_000 };
  }
  async start(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    if (this.#start) return this.#start;
    this.#start = this.#startInternal(signal).catch(error => { this.#start = undefined; throw error; });
    return this.#start;
  }
  async #startInternal(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    checkAbort(signal ?? new AbortController().signal);
    this.#closed = false;
    const child = spawn(this.options.command, this.options.args, { cwd: this.options.cwd, env: { ...allowedEnvironment(process.env), ...(this.options.env ?? {}) }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#onData(String(chunk)));
    child.on('error', error => this.#failPending(new MarsError('ToolExecutionError', `MCP server could not start: ${error.message}`)));
    child.on('close', code => this.#failPending(new MarsError('ToolExecutionError', `MCP server exited with code ${code ?? 'unknown'}.`)));
    try {
      await this.#request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mars', version: '0.1.0' } }, signal);
      this.#notify('notifications/initialized', {});
      const result = object(await this.#request('tools/list', {}, signal));
      const values = Array.isArray(result?.tools) ? result.tools : [];
      this.#tools = values.filter(item => {
        const value = object(item);
        return typeof value?.name === 'string' && value.name.trim();
      }).map(item => {
        const value = item as Json;
        const inputSchema = object(value.inputSchema);
        return { name: String(value.name), ...(typeof value.description === 'string' ? { description: value.description } : {}), ...(inputSchema ? { inputSchema } : {}) };
      });
      return [...this.#tools];
    } catch (error) {
      await this.close();
      if (error instanceof MarsError) throw error;
      throw new MarsError('ToolExecutionError', 'MCP initialization failed.');
    }
  }
  asTools(definitions = this.#tools): Tool[] {
    return definitions.map(definition => ({
      name: toolName(this.options.name, definition.name),
      description: `[MCP ${this.options.name}] ${definition.description ?? definition.name}`,
      parameters: definition.inputSchema ?? { type: 'object', additionalProperties: true },
      validate: (input: unknown) => definition.inputSchema ? validateSchema(input, definition.inputSchema) : input,
      execute: async (input: unknown, context: ToolContext) => textContent(await this.callTool(definition.name, input, context.signal)),
    }));
  }
  async callTool(name: string, argumentsValue: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.#child || this.#closed) throw new MarsError('ToolExecutionError', `MCP server ${this.options.name} is not connected.`);
    return this.#request('tools/call', { name, arguments: argumentsValue ?? {} }, signal);
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#failPending(new MarsError('CancelledError', 'MCP server closed.'));
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, 500); child.once('close', () => { clearTimeout(timer); resolve(); }); });
  }
  get connected(): boolean { return Boolean(this.#child && !this.#closed && this.#child.exitCode === null); }
  get definitions(): McpToolDefinition[] { return structuredClone(this.#tools); }
  #notify(method: string, params: Json): void {
    if (!this.#child?.stdin.writable || this.#closed) return;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  #request(method: string, params: Json, signal: AbortSignal | undefined): Promise<unknown> {
    checkAbort(signal ?? new AbortController().signal);
    if (!this.#child?.stdin.writable || this.#closed) return Promise.reject(new MarsError('ToolExecutionError', `MCP server ${this.options.name} is not connected.`));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let abort = () => {};
      let settled = false;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const wrappedResolve = (value: unknown) => settle(() => resolve(value));
      const wrappedReject = (error: unknown) => settle(() => reject(error));
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        wrappedReject(new MarsError('TimeoutError', `MCP request ${method} timed out.`));
      }, this.options.timeoutMs);
      abort = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
        wrappedReject(new MarsError(signal?.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'CancelledError', 'MCP request cancelled.'));
      };
      this.#pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, timer });
      if (signal) {
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
      }
      try { this.#child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); wrappedReject(new MarsError('ToolExecutionError', error instanceof Error ? error.message : 'MCP request failed.')); }
    });
  }
  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line) this.#onLine(line);
      index = this.#buffer.indexOf('\n');
    }
  }
  #onLine(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return; }
    const record = object(value);
    const id = typeof record?.id === 'number' ? record.id : undefined;
    if (id === undefined) return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = object(record?.error);
    if (error) pending.reject(new MarsError('ToolExecutionError', typeof error.message === 'string' ? `MCP ${error.message}` : 'MCP request failed.'));
    else pending.resolve(record?.result);
  }
  #failPending(error: MarsError): void {
    for (const [id, pending] of this.#pending) { clearTimeout(pending.timer); pending.reject(error); this.#pending.delete(id); }
  }
}

export async function connectMcpTools(options: McpStdioServerOptions, signal?: AbortSignal): Promise<McpConnectResult> {
  const client = new McpStdioClient(options);
  try { const definitions = await client.start(signal); return { client, tools: client.asTools(definitions) }; }
  catch (error) { await client.close(); throw error; }
}
