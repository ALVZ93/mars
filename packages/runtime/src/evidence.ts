import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ForgeError } from '../../core/src/index.js';

export interface SkillEvidence {
  name: string;
  path?: string;
  executions: number;
  successes: number;
  failures: number;
  lastUsedAt?: string;
  confidence: number;
}

export interface WorkflowEvidence {
  id: string;
  executions: number;
  successes: number;
  failures: number;
  lastUsedAt?: string;
  confidence: number;
}

export interface EvidenceSnapshot {
  version: 1;
  updatedAt: string;
  skills: Record<string, SkillEvidence>;
  workflows: Record<string, WorkflowEvidence>;
}

export interface EvidenceRun {
  skills?: Array<{ name: string; path?: string }>;
  workflow?: string;
  passed: boolean;
  verificationPassed?: boolean;
}

export interface EvidenceSuggestion {
  kind: 'skill';
  name: string;
  executions: number;
  confidence: number;
  reason: string;
}

export interface EvidenceStore {
  load(): Promise<EvidenceSnapshot>;
  record(run: EvidenceRun): Promise<EvidenceSnapshot>;
  suggestions(options?: { minExecutions?: number; minConfidence?: number }): Promise<EvidenceSuggestion[]>;
  clear(): Promise<void>;
}

export function evidencePath(workspace: string): string { return join(workspace, '.mars', 'evidence.json'); }

function emptySnapshot(): EvidenceSnapshot {
  return { version: 1, updatedAt: new Date(0).toISOString(), skills: {}, workflows: {} };
}
function clone<T>(value: T): T { return structuredClone(value); }
function validCounter(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validSnapshot(value: unknown): value is EvidenceSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || typeof source.updatedAt !== 'string') return false;
  for (const collection of ['skills', 'workflows']) {
    const entries = source[collection];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false;
    for (const [key, raw] of Object.entries(entries)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const item = raw as Record<string, unknown>;
      if (typeof item.name !== 'string' && typeof item.id !== 'string') return false;
      if (![item.executions, item.successes, item.failures].every(validCounter)) return false;
      if ((item.successes as number) + (item.failures as number) !== item.executions) return false;
      if (typeof item.confidence !== 'number' || item.confidence < 0 || item.confidence > 1) return false;
      if (typeof item.lastUsedAt !== 'undefined' && typeof item.lastUsedAt !== 'string') return false;
      if (collection === 'skills' && typeof item.path !== 'undefined' && typeof item.path !== 'string') return false;
      if (key.length === 0 || key.length > 512) return false;
    }
  }
  return true;
}

/** Atomic, local evidence store. It records outcomes, never task contents or model output. */
export class FileEvidenceStore implements EvidenceStore {
  readonly path: string;
  #queue: Promise<void> = Promise.resolve();
  constructor(filePath: string) { this.path = filePath; }

  async load(): Promise<EvidenceSnapshot> {
    return this.#serial(async () => {
      let raw: string;
      try { raw = await readFile(this.path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySnapshot(); throw new ForgeError('ConfigurationError', 'Could not read MARS evidence.'); }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!validSnapshot(parsed)) throw new Error();
        return clone(parsed);
      } catch { throw new ForgeError('ConfigurationError', 'MARS evidence is invalid or corrupted.'); }
    });
  }

  async record(run: EvidenceRun): Promise<EvidenceSnapshot> {
    if (!run || typeof run !== 'object' || typeof run.passed !== 'boolean') throw new ForgeError('ConfigurationError', 'Invalid evidence record.');
    return this.#serial(async () => {
      const snapshot = await this.#loadUnsafe();
      const now = new Date().toISOString();
      const success = run.passed && run.verificationPassed !== false;
      for (const skill of run.skills ?? []) {
        if (!skill || typeof skill.name !== 'string' || !skill.name.trim() || skill.name.length > 256) continue;
        const key = skill.path ? `${skill.name}\u0000${skill.path}` : skill.name;
        const current = snapshot.skills[key] ?? { name: skill.name.trim(), ...(skill.path ? { path: skill.path } : {}), executions: 0, successes: 0, failures: 0, confidence: 0 };
        current.executions++;
        if (success) current.successes++; else current.failures++;
        current.lastUsedAt = now;
        current.confidence = current.executions ? current.successes / current.executions : 0;
        snapshot.skills[key] = current;
      }
      if (run.workflow?.trim()) {
        const id = run.workflow.trim();
        const current = snapshot.workflows[id] ?? { id, executions: 0, successes: 0, failures: 0, confidence: 0 };
        current.executions++;
        if (success) current.successes++; else current.failures++;
        current.lastUsedAt = now;
        current.confidence = current.executions ? current.successes / current.executions : 0;
        snapshot.workflows[id] = current;
      }
      snapshot.updatedAt = now;
      await this.#write(snapshot);
      return clone(snapshot);
    });
  }

  async suggestions(options: { minExecutions?: number; minConfidence?: number } = {}): Promise<EvidenceSuggestion[]> {
    const snapshot = await this.load();
    const minExecutions = options.minExecutions ?? 3;
    const minConfidence = options.minConfidence ?? 0.8;
    return Object.values(snapshot.skills)
      .filter(item => item.executions >= minExecutions && item.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence || b.executions - a.executions || a.name.localeCompare(b.name))
      .map(item => ({ kind: 'skill' as const, name: item.name, executions: item.executions, confidence: item.confidence, reason: 'Repeated successful runs; review and promote it manually to a reusable skill.' }));
  }

  async clear(): Promise<void> {
    await this.#serial(async () => { await unlink(this.path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ForgeError('ConfigurationError', 'Could not clear MARS evidence.'); }); });
  }

  async #loadUnsafe(): Promise<EvidenceSnapshot> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!validSnapshot(parsed)) throw new Error();
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySnapshot();
      if (error instanceof ForgeError) throw error;
      throw new ForgeError('ConfigurationError', 'MARS evidence is invalid or corrupted.');
    }
  }
  async #write(snapshot: EvidenceSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await rename(temporary, this.path); }
    catch { await unlink(temporary).catch(() => {}); throw new ForgeError('ConfigurationError', 'Could not write MARS evidence.'); }
  }
  async #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.then(() => {}, () => {});
    return next;
  }
}
