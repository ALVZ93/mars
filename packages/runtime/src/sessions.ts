import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ForgeError } from '../../core/src/index.js';
import type { AgentMessage } from '../../core/src/index.js';

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  model: string;
  messages: AgentMessage[];
  metadata: Record<string, unknown>;
  status?: 'active' | 'completed' | 'failed' | 'cancelled';
}
export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  model: string;
  status?: Session['status'];
  messageCount: number;
  lastMessage?: string;
}
export interface SessionStore {
  get(id: string): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  list(workspace?: string): Promise<SessionSummary[]>;
  delete?(id: string): Promise<void>;
}

export function defaultSessionDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE ?? env.HOME ?? process.cwd();
  const root = process.platform === 'win32'
    ? env.APPDATA ?? join(home, 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(root, 'mars', 'sessions');
}

function validId(id: string): boolean { return /^[a-zA-Z0-9_-]{8,100}$/.test(id); }
function isMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!['system', 'user', 'assistant', 'tool'].includes(String(item.role)) || typeof item.content !== 'string') return false;
  if (item.role === 'assistant') {
    if (!Array.isArray(item.toolCalls)) return false;
    return item.toolCalls.every(call => call && typeof call === 'object' && typeof (call as Record<string, unknown>).id === 'string' && typeof (call as Record<string, unknown>).name === 'string');
  }
  if (item.role === 'tool') return typeof item.callId === 'string' && (item.error === undefined || typeof item.error === 'string');
  return true;
}
function parseSession(value: unknown): Session {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !validId(item.id) || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || typeof item.workspace !== 'string' || typeof item.model !== 'string' || !Array.isArray(item.messages) || !item.messages.every(isMessage) || !item.metadata || typeof item.metadata !== 'object' || Array.isArray(item.metadata)) throw new Error();
  if (item.status !== undefined && !['active', 'completed', 'failed', 'cancelled'].includes(String(item.status))) throw new Error();
  return structuredClone(item as unknown as Session);
}

/** Append-like snapshots are stored as atomic JSON files for simple recovery and debugging. */
export class FileSessionStore implements SessionStore {
  readonly directory: string;
  #queue: Promise<void> = Promise.resolve();
  constructor(directory = defaultSessionDirectory()) { this.directory = directory; }
  async get(id: string): Promise<Session | undefined> {
    if (!validId(id)) throw new ForgeError('ConfigurationError', 'Invalid session ID.');
    return this.#serial(async () => {
      let raw: string;
      try { raw = await readFile(join(this.directory, `${id}.json`), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new ForgeError('ConfigurationError', 'Could not read MARS session.'); }
      try { return parseSession(JSON.parse(raw)); } catch { throw new ForgeError('ConfigurationError', 'MARS session is invalid or corrupted.'); }
    });
  }
  async save(session: Session): Promise<void> {
    if (!validId(session.id)) throw new ForgeError('ConfigurationError', 'Invalid session ID.');
    const snapshot = parseSession(session);
    await this.#serial(async () => {
      try { await mkdir(this.directory, { recursive: true }); }
      catch { throw new ForgeError('ConfigurationError', 'Could not create the MARS session directory.'); }
      const file = join(this.directory, `${snapshot.id}.json`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } catch {
        await unlink(temporary).catch(() => {});
        throw new ForgeError('ConfigurationError', 'Could not write MARS session.');
      }
    });
  }
  async list(workspace?: string): Promise<SessionSummary[]> {
    return this.#serial(async () => {
      const requestedWorkspace = workspace
        ? await realpath(workspace).catch(() => resolve(workspace))
        : undefined;
      const normalizedWorkspace = process.platform === 'win32'
        ? requestedWorkspace?.toLowerCase()
        : requestedWorkspace;
      let names: string[];
      try { names = await readdir(this.directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new ForgeError('ConfigurationError', 'Could not list MARS sessions.'); }
      const results: SessionSummary[] = [];
      for (const name of names.filter(item => item.endsWith('.json'))) {
        const id = name.slice(0, -5);
        if (!validId(id)) continue;
        try {
          const raw = await readFile(join(this.directory, name), 'utf8');
          const session = parseSession(JSON.parse(raw));
          const sessionWorkspace = process.platform === 'win32' ? session.workspace.toLowerCase() : session.workspace;
          if (normalizedWorkspace && sessionWorkspace !== normalizedWorkspace) continue;
          const last = session.messages.at(-1);
          results.push({ id: session.id, createdAt: session.createdAt, updatedAt: session.updatedAt, workspace: session.workspace, model: session.model, status: session.status, messageCount: session.messages.length, lastMessage: last?.content.slice(0, 120) });
        } catch { /* Ignore an incomplete snapshot while listing. */ }
      }
      return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }
  async delete(id: string): Promise<void> {
    if (!validId(id)) throw new ForgeError('ConfigurationError', 'Invalid session ID.');
    await this.#serial(async () => { await unlink(join(this.directory, `${id}.json`)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ForgeError('ConfigurationError', 'Could not delete MARS session.'); }); });
  }
  async #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.then(() => {}, () => {});
    return next;
  }
}
