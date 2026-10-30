import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MarsError } from '../../core/src/index.js';

/** A vendor agent CLI as declared in `.mars/agents/<name>.md` (ADR 010). */
export interface AgentDefinition {
  name: string;
  description: string;
  engine: 'claude' | 'codex';
  model?: string;
  effort?: string;
  /** `deny`: read-only, enforced in the engine and checked by MARS on the tree. */
  edit: 'allow' | 'deny';
  /** Shell command prefixes the agent may run. */
  commands: string[];
  /** Markdown body: extra instructions appended to this agent's prompts. */
  instructions: string;
  source: 'builtin' | string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEYS = new Set(['description', 'engine', 'model', 'effort', 'edit', 'commands']);

export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  { name: 'codex', description: 'Codex CLI; edits files', engine: 'codex', edit: 'allow', commands: ['npm', 'node'], instructions: '', source: 'builtin' },
  { name: 'claude', description: 'Claude Code (API key only); edits files', engine: 'claude', edit: 'allow', commands: ['npm', 'node'], instructions: '', source: 'builtin' },
];

const unquote = (value: string) => /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;

/** Flat YAML subset: `key: value`, `key: [a, b]`, `#` comments. Anything nested is rejected, not half-read. */
export function parseAgent(name: string, text: string, source: string): AgentDefinition {
  const fail = (reason: string): never => { throw new MarsError('ConfigurationError', `Agent ${name} (${source}): ${reason}`); };
  if (!NAME.test(name)) fail('the file name must be lowercase letters, digits and dashes.');
  const match = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/) ?? fail('missing frontmatter between --- lines.');
  const fields: Record<string, string | string[]> = {};
  for (const raw of match[1]!.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) fail(`nested values are not supported: "${line.trim()}".`);
    const [, key, value] = line.match(/^([a-z_]+):\s*(.*)$/) ?? fail(`invalid line: "${line}".`);
    if (!KEYS.has(key!)) fail(`unknown key "${key}".`);
    if (key! in fields) fail(`duplicate key "${key}".`);
    const list = value!.match(/^\[(.*)\]$/);
    fields[key!] = list ? list[1]!.split(',').map(item => unquote(item.trim())).filter(Boolean) : unquote(value!.trim());
  }
  const single = (key: string) => { const value = fields[key]; if (Array.isArray(value)) fail(`"${key}" must be a single value.`); return (value as string | undefined) || undefined; };
  const engine = single('engine');
  if (engine !== 'claude' && engine !== 'codex') fail('engine must be claude or codex.');
  const edit = single('edit') ?? 'allow';
  if (edit !== 'allow' && edit !== 'deny') fail('edit must be allow or deny.');
  const commands = fields.commands === undefined ? ['npm', 'node'] : Array.isArray(fields.commands) ? fields.commands : [fields.commands];
  for (const command of commands) if (!/^[A-Za-z0-9_.-]+$/.test(command)) fail(`invalid command prefix "${command}".`);
  const model = single('model');
  const effort = single('effort');
  return {
    name, description: single('description') ?? '', engine: engine as AgentDefinition['engine'],
    ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    edit: edit as AgentDefinition['edit'], commands, instructions: match[2]!.trim(), source,
  };
}

export function agentsDirectory(root: string): string { return path.join(root, '.mars', 'agents'); }

/** Built-in agents, overridden by `.mars/agents/*.md` files of the same name. */
export async function loadAgents(root: string): Promise<Map<string, AgentDefinition>> {
  const agents = new Map(BUILTIN_AGENTS.map(agent => [agent.name, { ...agent, commands: [...agent.commands] }]));
  const directory = agentsDirectory(root);
  let files: string[];
  try { files = (await readdir(directory)).filter(file => file.endsWith('.md')).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return agents; throw error; }
  for (const file of files) {
    const name = file.slice(0, -3);
    agents.set(name, parseAgent(name, await readFile(path.join(directory, file), 'utf8'), path.join('.mars', 'agents', file)));
  }
  return agents;
}
