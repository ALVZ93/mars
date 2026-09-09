import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentEvent, EventSink } from '../../core/src/index.js';

export interface ProviderHealth {
  provider: string;
  authenticated: boolean;
  reachable: boolean;
  rateLimited: boolean;
  lastLatencyMs?: number;
  lastError?: string;
  lastUsedAt?: string;
}

interface HealthState extends ProviderHealth { startedAt?: number }

/** Last-known health derived from runtime events. It never probes a provider. */
export class ProviderHealthTracker {
  #states = new Map<string, HealthState>();
  markAuthenticated(provider: string, authenticated = true): void {
    const state = this.#states.get(provider) ?? { provider, authenticated, reachable: false, rateLimited: false };
    state.authenticated = authenticated;
    this.#states.set(provider, state);
  }
  observe(event: AgentEvent, at = Date.now()): void {
    if (!('provider' in event) || !event.provider) return;
    const provider = event.provider;
    const state = this.#states.get(provider) ?? { provider, authenticated: false, reachable: false, rateLimited: false };
    state.lastUsedAt = new Date(at).toISOString();
    if (event.type === 'model:request') { state.startedAt = at; state.lastError = undefined; }
    if (event.type === 'model:response') {
      state.reachable = true;
      state.rateLimited = false;
      if (state.startedAt !== undefined) state.lastLatencyMs = Math.max(0, at - state.startedAt);
    }
    if (event.type === 'model:error') {
      state.reachable = event.error !== 'ProviderUnavailableError';
      state.rateLimited = event.error === 'RateLimitError';
      state.lastError = event.error;
      if (state.startedAt !== undefined) state.lastLatencyMs = Math.max(0, at - state.startedAt);
    }
    this.#states.set(provider, state);
  }
  get(provider: string): ProviderHealth | undefined {
    const state = this.#states.get(provider);
    return state ? clonePublic(state) : undefined;
  }
  list(): ProviderHealth[] { return [...this.#states.values()].map(clonePublic).sort((a, b) => a.provider.localeCompare(b.provider)); }
  clear(): void { this.#states.clear(); }
}

function clonePublic(state: HealthState): ProviderHealth {
  return structuredClone({
    provider: state.provider,
    authenticated: state.authenticated,
    reachable: state.reachable,
    rateLimited: state.rateLimited,
    ...(state.lastLatencyMs === undefined ? {} : { lastLatencyMs: state.lastLatencyMs }),
    ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    ...(state.lastUsedAt === undefined ? {} : { lastUsedAt: state.lastUsedAt }),
  });
}

function safeEvent(event: AgentEvent): Record<string, unknown> {
  if (event.type === 'model:text') return { type: event.type, chars: event.text.length };
  if (event.type === 'permission:requested' || event.type === 'permission:granted' || event.type === 'permission:denied') return { type: event.type, permission: event.permission };
  if (event.type === 'evidence:recorded') return { type: event.type, workflow: event.workflow, skills: event.skills, passed: event.passed };
  return { ...event };
}

export interface FileEventLogOptions { maxBytes?: number }
/** Opt-in local JSONL event log. Text and permission targets are deliberately redacted. */
export class FileEventLog {
  readonly path: string;
  readonly maxBytes: number;
  readonly sink: EventSink;
  #queue: Promise<void> = Promise.resolve();
  constructor(filePath: string, options: FileEventLogOptions = {}) {
    this.path = filePath;
    this.maxBytes = options.maxBytes ?? 8_000_000;
    this.sink = event => {
      const line = `${JSON.stringify({ at: new Date().toISOString(), event: safeEvent(event) })}\n`;
      this.#queue = this.#queue.then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        let current = 0;
        try { current = (await readFile(this.path)).byteLength; } catch { /* create on first event */ }
        if (current + Buffer.byteLength(line) > this.maxBytes) return;
        await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 });
      }, () => {});
    };
  }
  async flush(): Promise<void> { await this.#queue; }
}

export function eventLogPath(workspace: string): string { return join(workspace, '.mars', 'events.jsonl'); }

export interface EventLogEntry { at: string; event: AgentEvent }
export async function readEventLogEntries(filePath: string): Promise<EventLogEntry[]> {
  let raw: string;
  try { raw = await readFile(filePath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const result: EventLogEntry[] = [];
  for (const line of raw.split(/\r?\n/).slice(-20_000)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as { at?: unknown; event?: unknown };
      const event = entry.event;
      if (event && typeof event === 'object' && !Array.isArray(event) && typeof (event as { type?: unknown }).type === 'string') {
        result.push({ at: typeof entry.at === 'string' ? entry.at : '', event: event as AgentEvent });
      }
    } catch { /* ignore a partial final line */ }
  }
  return result;
}
export async function readEventLog(filePath: string): Promise<AgentEvent[]> {
  return (await readEventLogEntries(filePath)).map(entry => entry.event);
}
