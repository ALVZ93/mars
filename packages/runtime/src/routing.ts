import type { ModelDescriptor } from '../../core/src/index.js';
import type { MarsConfig } from './config.js';

const base = (provider: string, model: string, capabilities: ModelDescriptor['capabilities'], metadata: Record<string, unknown> = {}): ModelDescriptor => ({ id: `${provider}:${model}`, provider, model, capabilities, metadata });
const coding = { tools: true, vision: false, reasoning: true, structuredOutput: true, streaming: true } as const;

/** Static fallbacks are intentionally conservative; a provider may expose a fresher catalog later. */
export const MODEL_CATALOG: readonly ModelDescriptor[] = [
  base('openai-codex', 'gpt-5.6-sol', coding, { subscription: true, default: true }),
  base('openai-codex', 'gpt-5.6-luna', coding, { subscription: true, fast: true }),
  base('openai', 'gpt-4o-mini', coding, { apiKey: true, economical: true }),
  base('openai', 'gpt-5.6-sol', coding, { apiKey: true }),
  base('anthropic', 'claude-sonnet-4-5', coding, { subscription: true }),
  base('anthropic', 'claude-3-7-sonnet-latest', coding, { apiKey: true }),
  base('kimi-code', 'kimi-for-coding', coding, { subscription: true }),
  base('gemini', 'gemini-2.5-pro', coding, { apiKey: true }),
  base('qwen', 'qwen3-coder-plus', coding, { apiKey: true }),
  base('openrouter', 'anthropic/claude-sonnet-4-5', coding, { apiKey: true, aggregator: true }),
  base('openrouter', 'openai/gpt-4o-mini', coding, { apiKey: true, aggregator: true, economical: true }),
  base('ollama', 'qwen3-coder', coding, { local: true }),
  base('fake', 'scripted', coding, { offline: true }),
];

export class ModelRegistry {
  #models = new Map<string, ModelDescriptor>();
  constructor(models: readonly ModelDescriptor[] = MODEL_CATALOG) { for (const model of models) this.register(model); }
  register(model: ModelDescriptor): void { if (this.#models.has(model.id)) throw new Error(`Duplicate model: ${model.id}`); this.#models.set(model.id, structuredClone(model)); }
  get(id: string): ModelDescriptor | undefined { const value = this.#models.get(id); return value && structuredClone(value); }
  list(): ModelDescriptor[] { return [...this.#models.values()].map(model => structuredClone(model)); }
  byProvider(provider: string): ModelDescriptor[] { return this.list().filter(model => model.provider === provider); }
}

export type TaskRole = 'planner' | 'implementer' | 'reviewer' | 'verifier' | 'researcher';
export interface RouteOptions {
  explicit?: string;
  config?: Partial<MarsConfig>;
  authenticatedProviders?: Iterable<string>;
  catalog?: readonly ModelDescriptor[];
  role?: TaskRole;
  allowedProviders?: Iterable<string>;
  required?: Partial<ModelDescriptor['capabilities']> & { contextWindow?: number };
  allowOffline?: boolean;
}
export interface RouteDecision {
  target: string;
  role: TaskRole;
  reason: string;
  candidates: string[];
}

export function classifyTask(task: string): TaskRole {
  const value = task.toLowerCase();
  if (/review|reviewer|revis|audit|critique|code review|revisión/.test(value)) return 'reviewer';
  if (/test|verify|verification|check|ci|lint|typecheck|prueba|verifica/.test(value)) return 'verifier';
  if (/research|investig|compare|document|buscar información|fuentes/.test(value)) return 'researcher';
  if (/plan|design|architecture|arquitect|strategy|estrategia/.test(value)) return 'planner';
  return 'implementer';
}

function configuredTarget(config: Partial<MarsConfig> | undefined, role: TaskRole): string | undefined {
  if (!config?.routing) return undefined;
  const values = config.routing as Record<string, unknown>;
  const roleTarget = values[role];
  return typeof roleTarget === 'string' && roleTarget.includes(':') ? roleTarget : undefined;
}

export function routeTask(task: string, options: RouteOptions = {}): RouteDecision {
  const role = options.role ?? classifyTask(task);
  if (options.explicit) return { target: options.explicit, role, reason: 'explicit model selection', candidates: [options.explicit] };
  const configured = configuredTarget(options.config, role) ?? (options.config?.model?.default);
  if (configured) return { target: configured, role, reason: configuredTarget(options.config, role) ? `configured ${role} model` : 'configured default model', candidates: [configured] };
  const allowed = new Set(options.authenticatedProviders ?? []);
  const providerFilter = options.allowedProviders ? new Set(options.allowedProviders) : undefined;
  const catalog = options.catalog ?? MODEL_CATALOG;
  const routingEnabled = options.config?.routing?.enabled ?? true;
  const candidates = catalog.filter(model => {
    if (providerFilter && !providerFilter.has(model.provider)) return false;
    if (!(allowed.has(model.provider) || (model.provider === 'fake' && options.allowOffline === true))) return false;
    const required = options.required;
    if (!required) return true;
    for (const key of ['tools', 'vision', 'reasoning', 'structuredOutput', 'streaming'] as const) if (required[key] === true && !model.capabilities[key]) return false;
    return required.contextWindow === undefined || (model.contextWindow ?? Number.POSITIVE_INFINITY) >= required.contextWindow;
  });
  if (!candidates.length) throw new Error('No authenticated model provider is available. Run `mars auth status` or configure MARS_MODEL.');
  const scored = candidates.map((model, index) => {
    let score = index === 0 ? 1 : 0;
    if (model.metadata?.default) score += routingEnabled ? 3 : 10;
    if (routingEnabled && role === 'verifier' && model.metadata?.economical) score += 3;
    if (routingEnabled && role === 'researcher' && model.provider === 'gemini') score += 2;
    if (routingEnabled && role === 'reviewer' && model.provider === 'anthropic') score += 2;
    if (routingEnabled && role === 'implementer' && model.metadata?.default) score += 3;
    if (model.provider === 'fake') score -= 1;
    return { model, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = scored[0]!.model;
  return { target: selected.id, role, reason: routingEnabled ? `deterministic ${role} routing from authenticated providers` : 'configured default provider selection', candidates: scored.map(item => item.model.id) };
}
