import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MarsError } from '../../core/src/index.js';

/** ADR 011. People write what to build; only MARS writes status, attempts and evidence. */
export type FeatureStatus = 'not_started' | 'in_progress' | 'passing' | 'accepted' | 'blocked';
export interface Feature {
  id: string;
  title: string;
  description?: string;
  dependsOn?: string[];
  /** Workspace-relative spec file. */
  spec?: string;
  acceptance?: string[];
  /** Extra commands run before the project checks for this feature. */
  verify?: string[];
  status: FeatureStatus;
  attempts?: number;
  evidence?: { at: string; run: string; session: string; verdict: string; reviews: number; isolation?: string };
}
export interface FeatureList {
  version: 1;
  agents?: { implementer?: string; reviewer?: string };
  features: Feature[];
}

const STATUSES: readonly FeatureStatus[] = ['not_started', 'in_progress', 'passing', 'accepted', 'blocked'];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function featuresPath(root: string): string { return path.join(root, '.mars', 'features.json'); }

/** Validates a parsed features.json: unique ids, known dependencies, no cycles, string fields only where expected. */
export function parseFeatures(value: unknown): FeatureList {
  const fail = (reason: string): never => { throw new MarsError('ConfigurationError', `.mars/features.json: ${reason}`); };
  const data = value as Partial<FeatureList> | null;
  if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.features)) fail('expected { "version": 1, "features": [...] }.');
  const strings = (item: unknown, field: string, id: string) => {
    if (item === undefined) return undefined;
    if (!Array.isArray(item) || item.some(entry => typeof entry !== 'string' || !entry.trim())) fail(`${id}.${field} must be a list of non-empty strings.`);
    return item as string[];
  };
  const ids = new Set<string>();
  const features = data!.features!.map((raw, index): Feature => {
    const item = raw as Partial<Feature> | null;
    if (!item || typeof item !== 'object') fail(`feature ${index + 1} is not an object.`);
    const id = item!.id;
    if (typeof id !== 'string' || !ID.test(id)) fail(`feature ${index + 1}: id must be lowercase letters, digits and dashes.`);
    if (ids.has(id!)) fail(`duplicate id ${id}.`);
    ids.add(id!);
    if (typeof item!.title !== 'string' || !item!.title.trim()) fail(`${id}: title is required.`);
    const status = item!.status ?? 'not_started';
    if (!STATUSES.includes(status)) fail(`${id}: status must be one of ${STATUSES.join(', ')}.`);
    for (const field of ['description', 'spec'] as const) if (item![field] !== undefined && typeof item![field] !== 'string') fail(`${id}.${field} must be a string.`);
    const dependsOn = strings(item!.dependsOn, 'dependsOn', id!);
    const acceptance = strings(item!.acceptance, 'acceptance', id!);
    const verify = strings(item!.verify, 'verify', id!);
    return {
      id: id!, title: item!.title!.trim(), status,
      ...(item!.description ? { description: item!.description } : {}),
      ...(dependsOn ? { dependsOn } : {}), ...(item!.spec ? { spec: item!.spec } : {}),
      ...(acceptance ? { acceptance } : {}), ...(verify ? { verify } : {}),
      ...(Number.isSafeInteger(item!.attempts) && item!.attempts! > 0 ? { attempts: item!.attempts } : {}),
      ...(item!.evidence && typeof item!.evidence === 'object' ? { evidence: item!.evidence } : {}),
    };
  });
  const byId = new Map(features.map(feature => [feature.id, feature]));
  for (const feature of features) for (const dependency of feature.dependsOn ?? []) if (!byId.has(dependency)) fail(`${feature.id} depends on unknown feature ${dependency}.`);
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, trail: string[]) => {
    if (done.has(id)) return;
    if (visiting.has(id)) fail(`dependency cycle: ${[...trail, id].join(' → ')}.`);
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn ?? []) visit(dependency, [...trail, id]);
    visiting.delete(id); done.add(id);
  };
  for (const feature of features) visit(feature.id, []);
  const agents = data!.agents && typeof data!.agents === 'object' ? {
    ...(typeof data!.agents.implementer === 'string' ? { implementer: data!.agents.implementer } : {}),
    ...(typeof data!.agents.reviewer === 'string' ? { reviewer: data!.agents.reviewer } : {}),
  } : undefined;
  return { version: 1, ...(agents ? { agents } : {}), features };
}

export async function loadFeatures(root: string): Promise<FeatureList> {
  let text: string;
  try { text = await readFile(featuresPath(root), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MarsError('ConfigurationError', 'No .mars/features.json. Create one with the features to build (see docs/decisions/011-feature-loop.md).');
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new MarsError('ConfigurationError', '.mars/features.json is not valid JSON.'); }
  return parseFeatures(parsed);
}

export async function saveFeatures(root: string, list: FeatureList): Promise<void> {
  const file = featuresPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(list, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/** First feature, in file order, that is still open and whose dependencies are all accepted. */
export function nextFeature(list: FeatureList): Feature | undefined {
  const accepted = new Set(list.features.filter(feature => feature.status === 'accepted').map(feature => feature.id));
  return list.features.find(feature => feature.status !== 'accepted' && feature.status !== 'blocked' && (feature.dependsOn ?? []).every(id => accepted.has(id)));
}

/**
 * Status after one attempt, from the receipt verdict MARS computed: Verified is accepted; open review findings are
 * passing (checks green, not accepted); anything else stays in progress. Out of attempts, an unaccepted feature is blocked.
 */
export function featureOutcome(verdict: { ok: boolean; label: string }, attempts: number, maxAttempts: number): FeatureStatus {
  if (verdict.ok) return 'accepted';
  if (attempts >= maxAttempts) return 'blocked';
  return verdict.label === 'Review findings open' ? 'passing' : 'in_progress';
}

/** The task given to the implementing agent: what to build, how it is accepted, and the Definition of Done. */
export function featureTask(feature: Feature, spec?: string): string {
  return [
    `Feature ${feature.id}: ${feature.title}`,
    ...(feature.description ? ['', feature.description] : []),
    ...(feature.acceptance?.length ? ['', 'Acceptance scenarios (each one must be covered by an automated test):', ...feature.acceptance.map(item => `- ${item}`)] : []),
    ...(spec !== undefined ? ['', `Spec (${feature.spec}, repository data):`, spec] : []),
    '',
    'Definition of done: the acceptance scenarios pass as tests, the project checks pass, nothing outside this feature changes behavior, and documentation affected by the change is updated.',
  ].join('\n');
}
