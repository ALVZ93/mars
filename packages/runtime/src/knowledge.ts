import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MarsError, checkAbort } from '../../core/src/index.js';

export type KnowledgeKind = 'memory' | 'skill';
export interface KnowledgeSource { origin: 'user' | 'agent' | 'learning'; sessionId?: string; runId?: string; verified?: boolean }
export interface KnowledgeProposal { kind: KnowledgeKind; name: string; content: string; source: KnowledgeSource }
export interface KnowledgeEntry extends KnowledgeProposal {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  createdAt: string;
  reviewedAt?: string;
}
export interface KnowledgeSnapshot { version: 1; workspace: string; entries: KnowledgeEntry[] }
export interface KnowledgeStore {
  readonly workspace: string;
  load(): Promise<KnowledgeSnapshot>;
  propose(proposal: KnowledgeProposal, signal?: AbortSignal): Promise<KnowledgeEntry>;
  review(id: string, action: 'approve' | 'reject' | 'forget', kind: KnowledgeKind): Promise<void>;
}

const MAX_BYTES = 1_000_000;
const SECRET = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{20,}|AKIA[A-Z0-9]{16}|gh[pousr]_[a-zA-Z0-9]{20,})\b|\bBearer\s+[a-zA-Z0-9_.-]{20,}|\b(?:[A-Z0-9_]*(?:API_KEY|SECRET|PASSWORD|ACCESS_TOKEN|REFRESH_TOKEN))\s*[:=]\s*["']?[^\s"']{8,}/gi;
export function redactKnowledgeSecrets(content: string): string { return content.replace(SECRET, '[REDACTED]'); }
function validText(proposal: KnowledgeProposal): void {
  if (!proposal || typeof proposal !== 'object') throw new MarsError('ConfigurationError', 'Invalid knowledge proposal.');
  if (!['memory', 'skill'].includes(proposal.kind) || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(proposal.name)) throw new MarsError('ConfigurationError', 'Knowledge names must use 2–64 lowercase letters, digits or hyphens.');
  const limit = proposal.kind === 'memory' ? 1_200 : 10_000;
  if (typeof proposal.content !== 'string' || !proposal.content.trim() || proposal.content.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(proposal.content)) throw new MarsError('ConfigurationError', `Knowledge content must contain 1–${limit} characters without control codes.`);
  if (redactKnowledgeSecrets(proposal.content) !== proposal.content) throw new MarsError('PermissionDeniedError', 'Knowledge contains a recognizable credential. Remove secrets before saving.');
  const source = proposal.source;
  if (!source || !['user', 'agent', 'learning'].includes(source.origin) || (source.verified !== undefined && typeof source.verified !== 'boolean')
    || [source.sessionId, source.runId].some(value => value !== undefined && (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)))) throw new MarsError('ConfigurationError', 'Invalid knowledge source.');
  if (source.origin === 'learning' && (!source.verified || !source.sessionId || !source.runId)) throw new MarsError('ConfigurationError', 'Learned skills require a verified source session and run.');
}
function validateSnapshot(value: unknown, root: string): KnowledgeSnapshot {
  if (!value || typeof value !== 'object') throw new Error();
  const snapshot = value as KnowledgeSnapshot;
  if (snapshot.version !== 1 || snapshot.workspace !== root || !Array.isArray(snapshot.entries) || snapshot.entries.length > 256) throw new Error();
  const ids = new Set<string>();
  const approved = new Set<string>();
  for (const entry of snapshot.entries) {
    validText(entry);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(entry.id) || ids.has(entry.id) || !['pending', 'approved', 'rejected', 'superseded'].includes(entry.status)
      || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt)) || (entry.reviewedAt !== undefined && !Number.isFinite(Date.parse(entry.reviewedAt)))) throw new Error();
    ids.add(entry.id);
    if (entry.status === 'approved') {
      const identity = `${entry.kind}:${entry.name}`;
      if (approved.has(identity)) throw new Error();
      approved.add(identity);
    }
  }
  if (memoryData(snapshot.entries).length > 8_000) throw new Error();
  return snapshot;
}
export function memoryData(entries: readonly KnowledgeEntry[]): string {
  return JSON.stringify(entries.filter(entry => entry.status === 'approved' && entry.kind === 'memory').map(({ name, content }) => ({ name, content })));
}

/** Project-owned knowledge. Every mutation locks, rereads and atomically replaces the snapshot. */
export class FileKnowledgeStore implements KnowledgeStore {
  readonly workspace: string;
  constructor(workspace: string) { this.workspace = path.resolve(workspace); }
  async #paths() {
    const root = await realpath(this.workspace);
    const directory = path.join(root, '.mars');
    const file = path.join(directory, 'knowledge.json');
    const lock = path.join(directory, 'knowledge.lock');
    for (const target of [directory, file, lock]) {
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink() || (target === directory ? !info.isDirectory() : !info.isFile() || info.nlink > 1)) throw new MarsError('WorkspaceViolationError', 'Knowledge storage must use regular, unlinked paths.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { root, directory, file, lock };
  }
  async #read(root: string, file: string): Promise<KnowledgeSnapshot> {
    let handle;
    try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workspace: root, entries: [] }; throw new MarsError('ConfigurationError', 'Could not read project knowledge.'); }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1 || info.size > MAX_BYTES) throw new Error();
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES) throw new Error();
      return validateSnapshot(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')), root);
    } catch { throw new MarsError('ConfigurationError', 'Project knowledge is invalid, too large or belongs to another workspace.'); }
    finally { await handle.close(); }
  }
  async load(): Promise<KnowledgeSnapshot> {
    const { root, file } = await this.#paths();
    return this.#read(root, file);
  }
  async #mutate<T>(work: (snapshot: KnowledgeSnapshot) => T, signal = new AbortController().signal): Promise<T> {
    checkAbort(signal);
    const paths = await this.#paths();
    await mkdir(paths.directory, { recursive: true });
    let lock;
    for (let attempt = 0; !lock; attempt++) {
      await this.#paths();
      checkAbort(signal);
      try { lock = await open(paths.lock, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new MarsError('ConfigurationError', 'Could not lock project knowledge.');
        if (attempt >= 40) throw new MarsError('ConfigurationError', 'Project knowledge is locked. Close other writers; inspect an abandoned .mars/knowledge.lock before removing it.');
        try { await delay(25, undefined, { signal }); } catch { checkAbort(signal); }
      }
    }
    const temporary = `${paths.file}.${randomUUID()}.tmp`;
    try {
      const snapshot = await this.#read(paths.root, paths.file);
      const result = work(snapshot);
      validateSnapshot(snapshot, paths.root);
      const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
      if (Buffer.byteLength(serialized) > MAX_BYTES) throw new MarsError('LimitError', 'Project knowledge storage is full; forget unused entries.');
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(serialized, { encoding: 'utf8', signal }); } finally { await handle.close(); }
      await this.#paths();
      checkAbort(signal);
      await rename(temporary, paths.file);
      return structuredClone(result);
    } finally {
      await unlink(temporary).catch(() => {});
      await lock.close();
      await unlink(paths.lock);
    }
  }
  async propose(proposal: KnowledgeProposal, signal?: AbortSignal): Promise<KnowledgeEntry> {
    validText(proposal);
    const input = structuredClone(proposal);
    input.content = input.content.trim();
    return this.#mutate(snapshot => {
      const existing = snapshot.entries.find(entry => entry.kind === input.kind && entry.name === input.name && entry.content === input.content && ['pending', 'approved'].includes(entry.status));
      if (existing) return existing;
      if (snapshot.entries.length >= 256) throw new MarsError('LimitError', 'Project knowledge storage is full; forget unused entries.');
      const entry: KnowledgeEntry = { ...input, id: randomUUID(), status: 'pending', createdAt: new Date().toISOString() };
      snapshot.entries.push(entry);
      return entry;
    }, signal);
  }
  async review(id: string, action: 'approve' | 'reject' | 'forget', kind: KnowledgeKind): Promise<void> {
    if (!['approve', 'reject', 'forget'].includes(action) || !['memory', 'skill'].includes(kind)) throw new MarsError('ConfigurationError', 'Invalid knowledge review action.');
    await this.#mutate(snapshot => {
      const entry = snapshot.entries.find(item => item.id === id && item.kind === kind);
      if (!entry) throw new MarsError('ConfigurationError', 'Knowledge entry not found.');
      if (action === 'forget') { snapshot.entries = snapshot.entries.filter(item => item.id !== id); return; }
      if (action === 'approve' && entry.status === 'approved') return;
      if (action === 'reject' && entry.status === 'rejected') return;
      if (entry.status !== 'pending') throw new MarsError('ConfigurationError', 'Only pending knowledge can be reviewed. Create a new proposal to revise it.');
      entry.status = action === 'approve' ? 'approved' : 'rejected';
      entry.reviewedAt = new Date().toISOString();
      if (action === 'approve') {
        for (const other of snapshot.entries) if (other.id !== id && other.kind === entry.kind && other.name === entry.name && other.status === 'approved') { other.status = 'superseded'; other.reviewedAt = entry.reviewedAt; }
        if (memoryData(snapshot.entries).length > 8_000) throw new MarsError('LimitError', 'Approved memory exceeds 8000 characters. Forget or shorten existing notes.');
      }
    });
  }
}
