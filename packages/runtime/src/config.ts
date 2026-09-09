import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ForgeError } from '../../core/src/index.js';
import type { Policy } from './index.js';

export interface MarsConfig {
  model: { default?: string };
  routing: {
    enabled: boolean;
    planner?: string;
    implementer?: string;
    reviewer?: string;
    verifier?: string;
  };
  permissions: {
    shell: Policy;
    destructiveShell: Policy;
    network: Policy;
    gitCommit: Policy;
    gitPush: Policy;
  };
  limits: {
    maxTurns: number;
    maxToolCalls: number;
    timeoutMs: number;
    maxContextChars: number;
    maxRetries: number;
    retryDelayMs: number;
  };
  verification: { commands: string[] };
  mcp: { servers: McpServerConfig[] };
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ConfigPaths {
  user: string;
  legacyUser: string;
  project: string;
  legacyProject: string;
}
export type ConfigPatch = {
  model?: Partial<MarsConfig['model']>;
  routing?: Partial<MarsConfig['routing']>;
  permissions?: Partial<MarsConfig['permissions']>;
  limits?: Partial<MarsConfig['limits']>;
  verification?: Partial<MarsConfig['verification']>;
  mcp?: Partial<MarsConfig['mcp']>;
};

export const DEFAULT_CONFIG: MarsConfig = {
  model: {},
  routing: { enabled: false },
  permissions: { shell: 'ask', destructiveShell: 'deny', network: 'ask', gitCommit: 'ask', gitPush: 'ask' },
  limits: { maxTurns: 24, maxToolCalls: 64, timeoutMs: 120_000, maxContextChars: 200_000, maxRetries: 0, retryDelayMs: 500 },
  verification: { commands: [] },
  mcp: { servers: [] },
};

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE ?? env.HOME ?? process.cwd();
  const root = process.platform === 'win32'
    ? env.APPDATA ?? join(home, 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(root, 'mars', 'config.json');
}

export function projectConfigPath(workspace: string): string { return join(workspace, '.mars', 'config.json'); }
export function configPaths(workspace: string, env: NodeJS.ProcessEnv = process.env): ConfigPaths {
  const user = defaultConfigPath(env);
  return { user, legacyUser: join(dirname(user), '..', 'forge', 'config.json'), project: projectConfigPath(workspace), legacyProject: join(workspace, '.forge', 'config.json') };
}

function isPolicy(value: unknown): value is Policy { return value === 'allow' || value === 'ask' || value === 'deny'; }
function optionalString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function positive(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) throw new ForgeError('ConfigurationError', 'Config limits must be positive integers.');
  return parsed;
}
function parseConfig(value: unknown): ConfigPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ForgeError('ConfigurationError', 'MARS config must be a JSON object.');
  const source = value as Record<string, unknown>;
  const model = source.model;
  const routing = source.routing;
  const permissions = source.permissions;
  const limits = source.limits;
  const verification = source.verification;
  const mcp = source.mcp;
  const result: ConfigPatch = {};
  if (model !== undefined) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw new ForgeError('ConfigurationError', 'Config model must be an object.');
    result.model = { default: optionalString((model as Record<string, unknown>).default) };
  }
  if (routing !== undefined) {
    if (!routing || typeof routing !== 'object' || Array.isArray(routing)) throw new ForgeError('ConfigurationError', 'Config routing must be an object.');
    const value = routing as Record<string, unknown>;
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new ForgeError('ConfigurationError', 'Config routing.enabled must be boolean.');
    result.routing = { ...(value.enabled === undefined ? {} : { enabled: value.enabled }), ...(optionalString(value.planner) ? { planner: optionalString(value.planner) } : {}), ...(optionalString(value.implementer) ? { implementer: optionalString(value.implementer) } : {}), ...(optionalString(value.reviewer) ? { reviewer: optionalString(value.reviewer) } : {}), ...(optionalString(value.verifier) ? { verifier: optionalString(value.verifier) } : {}) };
  }
  if (permissions !== undefined) {
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) throw new ForgeError('ConfigurationError', 'Config permissions must be an object.');
    const value = permissions as Record<string, unknown>;
    for (const key of ['shell', 'destructiveShell', 'network', 'gitCommit', 'gitPush']) {
      if (value[key] !== undefined && !isPolicy(value[key])) throw new ForgeError('ConfigurationError', `Config permissions.${key} must be allow, ask or deny.`);
    }
    result.permissions = {};
    for (const key of ['shell', 'destructiveShell', 'network', 'gitCommit', 'gitPush'] as const) if (value[key] !== undefined) result.permissions[key] = value[key] as Policy;
  }
  if (limits !== undefined) {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new ForgeError('ConfigurationError', 'Config limits must be an object.');
    const value = limits as Record<string, unknown>;
    result.limits = {};
    const maxRetries = value.maxRetries;
    if (maxRetries !== undefined) {
      const parsed = typeof maxRetries === 'number' ? maxRetries : Number(maxRetries);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) throw new ForgeError('ConfigurationError', 'Config limits.maxRetries must be an integer from 0 to 100.');
      result.limits.maxRetries = parsed;
    }
    for (const key of ['maxTurns', 'maxToolCalls', 'timeoutMs', 'maxContextChars', 'retryDelayMs'] as const) if (value[key] !== undefined) result.limits[key] = positive(value[key], DEFAULT_CONFIG.limits[key]);
  }
  if (verification !== undefined) {
    if (!verification || typeof verification !== 'object' || Array.isArray(verification)) throw new ForgeError('ConfigurationError', 'Config verification must be an object.');
    const commands = (verification as Record<string, unknown>).commands;
    if (!Array.isArray(commands) || commands.length > 32 || commands.some(command => typeof command !== 'string' || !command.trim() || command.length > 4096)) throw new ForgeError('ConfigurationError', 'Config verification.commands must contain at most 32 non-empty commands.');
    result.verification = { commands: commands.map(command => command.trim()) };
  }
  if (mcp !== undefined) {
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) throw new ForgeError('ConfigurationError', 'Config mcp must be an object.');
    const servers = (mcp as Record<string, unknown>).servers;
    if (!Array.isArray(servers) || servers.length > 32) throw new ForgeError('ConfigurationError', 'Config mcp.servers must be an array with at most 32 entries.');
    result.mcp = { servers: servers.map(parseMcpServer) };
  }
  return result;
}

function parseMcpServer(value: unknown): McpServerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ForgeError('ConfigurationError', 'Each MCP server must be an object.');
  const source = value as Record<string, unknown>;
  const name = optionalString(source.name);
  const command = optionalString(source.command);
  if (!name || !command) throw new ForgeError('ConfigurationError', 'Each MCP server needs a name and command.');
  const args = source.args;
  if (args !== undefined && (!Array.isArray(args) || args.length > 128 || args.some(item => typeof item !== 'string' || item.length > 4096))) throw new ForgeError('ConfigurationError', `MCP server ${name} has invalid args.`);
  const cwd = source.cwd === undefined ? undefined : optionalString(source.cwd);
  if (source.cwd !== undefined && !cwd) throw new ForgeError('ConfigurationError', `MCP server ${name} has an invalid cwd.`);
  const env = source.env;
  if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || Object.entries(env).some(([key, item]) => !key || key.length > 256 || typeof item !== 'string' || item.length > 16_000))) throw new ForgeError('ConfigurationError', `MCP server ${name} has invalid env.`);
  const timeoutMs = source.timeoutMs === undefined ? undefined : positive(source.timeoutMs, 30_000);
  return { name, command, ...(args ? { args: [...args] } : {}), ...(cwd ? { cwd } : {}), ...(env ? { env: { ...(env as Record<string, string>) } } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

export function mergeConfig(...configs: Array<ConfigPatch | undefined>): MarsConfig {
  const result: MarsConfig = structuredClone(DEFAULT_CONFIG);
  for (const config of configs) {
    if (!config) continue;
    if (config.model) result.model = { ...result.model, ...config.model };
    if (config.routing) result.routing = { ...result.routing, ...config.routing };
    if (config.permissions) result.permissions = { ...result.permissions, ...config.permissions };
    if (config.limits) result.limits = { ...result.limits, ...config.limits };
    if (config.verification?.commands) result.verification = { commands: [...config.verification.commands] };
    if (config.mcp?.servers) result.mcp = { servers: config.mcp.servers.map(server => structuredClone(server)) };
  }
  return result;
}

function mergePatch(...configs: Array<ConfigPatch | undefined>): ConfigPatch {
  const result: ConfigPatch = {};
  for (const config of configs) {
    if (!config) continue;
    if (config.model) result.model = { ...result.model, ...config.model };
    if (config.routing) result.routing = { ...result.routing, ...config.routing };
    if (config.permissions) result.permissions = { ...result.permissions, ...config.permissions };
    if (config.limits) result.limits = { ...result.limits, ...config.limits };
    if (config.verification?.commands) result.verification = { commands: [...config.verification.commands] };
    if (config.mcp?.servers) result.mcp = { servers: config.mcp.servers.map(server => structuredClone(server)) };
  }
  return result;
}

async function readConfig(path: string): Promise<ConfigPatch | undefined> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ForgeError('ConfigurationError', `Could not read MARS config: ${path}`);
  }
  try { return parseConfig(JSON.parse(raw)); }
  catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError('ConfigurationError', `Invalid JSON in MARS config: ${path}`);
  }
}

export async function loadConfig(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<{ config: MarsConfig; paths: ConfigPaths; sources: string[] }> {
  const paths = configPaths(workspace, env);
  const sources: string[] = [];
  const user = await readConfig(paths.user);
  const legacyUser = user ? undefined : await readConfig(paths.legacyUser);
  if (user) sources.push(paths.user);
  if (legacyUser) sources.push(paths.legacyUser);
  const project = await readConfig(paths.project);
  const legacy = project ? undefined : await readConfig(paths.legacyProject);
  if (project) sources.push(paths.project);
  if (legacy) sources.push(paths.legacyProject);
  return { config: mergeConfig(legacyUser, user, legacy, project), paths, sources };
}

export async function saveConfig(path: string, config: ConfigPatch): Promise<void> {
  const current = await readConfig(path);
  const merged = mergePatch(current, parseConfig(config));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch {
    await unlink(temporary).catch(() => {});
    throw new ForgeError('ConfigurationError', `Could not write MARS config: ${path}`);
  }
}
