import { MarsError } from '../../core/src/index.js';
import type { ModelEvent, ModelProvider, ModelRequest } from '../../core/src/index.js';

export interface TaskBudgetLimits {
  /** Wall-clock limit for one operation, shared by every phase, repair and check. */
  maxDurationMs?: number;
  /** Model requests, including retries, across every phase and repair. */
  maxModelRequests?: number;
  /** Reported input+output tokens. Unreported usage is never counted as zero. */
  maxTokens?: number;
}

export interface BudgetReport {
  limits: TaskBudgetLimits;
  modelRequests: number;
  tokens: number;
  /** False when at least one response did not report usage; `tokens` is then a lower bound. */
  tokensKnown: boolean;
  exceeded?: 'duration' | 'requests' | 'tokens';
}

export function validateBudget(limits: TaskBudgetLimits = {}): TaskBudgetLimits {
  for (const [key, value] of Object.entries(limits)) {
    if (!['maxDurationMs', 'maxModelRequests', 'maxTokens'].includes(key)) throw new MarsError('ConfigurationError', `Unknown budget limit: ${key}`);
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new MarsError('ConfigurationError', 'Budget limits must be positive integers.');
  }
  return { ...limits };
}

const EXCEEDED = 'MarsBudgetExceeded';

export class TaskBudget {
  readonly #limits: TaskBudgetLimits;
  readonly #controller = new AbortController();
  #timer?: NodeJS.Timeout;
  #requests = 0;
  #tokens = 0;
  #tokensKnown = true;
  /** Attempts that have not (yet) reported usage: cancelled, failing or still streaming. */
  #unmetered = 0;
  #exceeded?: BudgetReport['exceeded'];
  readonly signal: AbortSignal;

  constructor(limits: TaskBudgetLimits, parent?: AbortSignal) {
    this.#limits = validateBudget(limits);
    this.signal = parent ? AbortSignal.any([parent, this.#controller.signal]) : this.#controller.signal;
    if (limits.maxDurationMs) {
      this.#timer = setTimeout(() => this.#exceed('duration'), limits.maxDurationMs);
      this.#timer.unref?.();
    }
  }

  get exceeded(): BudgetReport['exceeded'] { return this.#exceeded; }

  report(): BudgetReport {
    return { limits: { ...this.#limits }, modelRequests: this.#requests, tokens: this.#tokens, tokensKnown: this.#tokensKnown && this.#unmetered === 0, ...(this.#exceeded ? { exceeded: this.#exceeded } : {}) };
  }

  dispose(): void { clearTimeout(this.#timer); }

  /** Fails an operation that finished after its budget ran out, so it never records success. */
  assertWithin(): void { if (this.#exceeded) throw this.#error(); }

  /** Converts the abort caused by an exhausted budget into a stable, non-retryable error. */
  translate(error: unknown): unknown {
    if (!this.#exceeded) return error;
    if (error instanceof MarsError && error.code === 'BudgetExceededError') return error;
    if (error instanceof MarsError && !['CancelledError', 'TimeoutError'].includes(error.code)) return error;
    return this.#error();
  }

  /** Checks the budget before each model request; never interrupts a running tool. */
  provider(inner: ModelProvider): ModelProvider {
    const budget = this;
    return {
      id: inner.id,
      ...(inner.listModels ? { listModels: inner.listModels.bind(inner) } : {}),
      async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
        budget.#before();
        budget.#requests++;
        // Counted as unmetered until usage arrives, so an abandoned or failing attempt never reads as known.
        budget.#unmetered++;
        for await (const event of inner.stream(request, signal)) {
          if (event.type === 'done') {
            budget.#unmetered--;
            if (event.usage) budget.#tokens += event.usage.inputTokens + event.usage.outputTokens;
            else budget.#tokensKnown = false;
          }
          yield event;
        }
      },
    };
  }

  #before(): void {
    if (this.#exceeded) throw this.#error();
    if (this.#limits.maxModelRequests && this.#requests >= this.#limits.maxModelRequests) this.#exceed('requests');
    else if (this.#limits.maxTokens && this.#tokens >= this.#limits.maxTokens) this.#exceed('tokens');
    if (this.#exceeded) throw this.#error();
  }

  #exceed(reason: NonNullable<BudgetReport['exceeded']>): void {
    if (this.#exceeded) return;
    this.#exceeded = reason;
    // Only the timer aborts: request/token limits throw from the provider instead, so no pending promise is orphaned.
    if (reason === 'duration') this.#controller.abort(Object.assign(new Error('Task budget exceeded.'), { name: EXCEEDED }));
  }

  #error(): MarsError {
    const limit = this.#exceeded === 'duration' ? `${this.#limits.maxDurationMs} ms` : this.#exceeded === 'requests' ? `${this.#limits.maxModelRequests} model requests` : `${this.#limits.maxTokens} reported tokens`;
    return new MarsError('BudgetExceededError', `Task budget exceeded (${limit}). Raise budget.* or split the task.`);
  }
}
