import { randomUUID } from 'node:crypto';
import type { AgentEvent, ErrorCode } from '../../core/src/index.js';
import type { VerificationReport } from '../../tools/src/index.js';
import type { BudgetReport } from './budget.js';

export interface RunReport {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  kind: 'run' | 'workflow' | 'verify';
  workflow?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  error?: ErrorCode;
  models: string[];
  modelRequests: number;
  modelRetries: number;
  toolCalls: number;
  toolErrors: number;
  permissionDenials: number;
  repairAttempts: number;
  /** Reported usage only; an empty array means unknown, not zero consumption. */
  usage: Array<{ provider: string; inputTokens: number; outputTokens: number; samples: number }>;
  verificationStatus: 'not-run' | 'passed' | 'failed';
  verifications: Array<{ phase: string; attempt: number; report: VerificationReport }>;
  budget?: BudgetReport;
  /** Red→green proof of a reproduction phase: the declared test failed before the fix and passed after it. */
  proof?: { phase: string; command: string; files: string[]; red: { exitCode: number | null; output: string }; green?: { exitCode: number } };
  /** Files the implementation could not change; `modified` lists violations detected by hash. */
  contract?: { files: string[]; modified: string[] };
  /** Isolated runs only: the agent's diff is exactly base..result. */
  isolation?: { id: string; base: string; result: string; files: string[] };
}

export class RunReports {
  #current?: RunReport;
  #last?: RunReport;
  #started = 0;
  get last(): RunReport | undefined { return this.#last ? structuredClone(this.#last) : undefined; }
  start(sessionId: string, kind: RunReport['kind'], workflow?: string): void {
    this.#started = performance.now();
    this.#current = {
      schemaVersion: 1, id: randomUUID(), sessionId, kind, ...(workflow ? { workflow } : {}),
      startedAt: new Date().toISOString(), durationMs: 0, status: 'active', models: [],
      modelRequests: 0, modelRetries: 0, toolCalls: 0, toolErrors: 0, permissionDenials: 0,
      repairAttempts: 0, usage: [], verificationStatus: 'not-run', verifications: [],
    };
  }
  observe(event: AgentEvent): void {
    const report = this.#current;
    if (!report) return;
    if (event.type === 'model:request') {
      report.modelRequests++;
      const model = `${event.provider ?? 'unknown'}:${event.model}`;
      if (!report.models.includes(model)) report.models.push(model);
    }
    if (event.type === 'model:retry') report.modelRetries++;
    if (event.type === 'tool:start') report.toolCalls++;
    if (event.type === 'tool:error') report.toolErrors++;
    if (event.type === 'permission:denied') report.permissionDenials++;
    if (event.type === 'model:usage') {
      let usage = report.usage.find(item => item.provider === event.provider);
      if (!usage) { usage = { provider: event.provider, inputTokens: 0, outputTokens: 0, samples: 0 }; report.usage.push(usage); }
      usage.inputTokens += event.inputTokens; usage.outputTokens += event.outputTokens; usage.samples++;
    }
  }
  invalidateVerification(): void { if (this.#current) { this.#current.verificationStatus = 'not-run'; delete this.#current.proof?.green; } }
  workflow(id: string): void { if (this.#current) this.#current.workflow = id; }
  verification(phase: string, attempt: number, value: VerificationReport): void {
    if (!this.#current) return;
    this.#current.verifications.push({ phase, attempt, report: structuredClone(value) });
    this.#current.verificationStatus = value.verified ? 'passed' : 'failed';
  }
  budget(value: BudgetReport): void { if (this.#current) this.#current.budget = structuredClone(value); }
  isolation(value: NonNullable<RunReport['isolation']>): void { if (this.#current) this.#current.isolation = structuredClone(value); }
  proof(value: NonNullable<RunReport['proof']>): void { if (this.#current) this.#current.proof = structuredClone(value); }
  proofGreen(exitCode: number): void { if (this.#current?.proof) this.#current.proof.green = { exitCode }; }
  contract(value: NonNullable<RunReport['contract']>): void { if (this.#current) this.#current.contract = structuredClone(value); }
  repair(): void { if (this.#current) this.#current.repairAttempts++; }
  finish(status: RunReport['status'], error?: ErrorCode): void {
    if (!this.#current) return;
    this.#current.status = status;
    this.#current.finishedAt = new Date().toISOString();
    this.#current.durationMs = Math.max(0, performance.now() - this.#started);
    if (error) this.#current.error = error;
    this.#last = this.#current;
    this.#current = undefined;
  }
  fail(error?: ErrorCode, budget?: BudgetReport): void { if (this.#last) { this.#last.status = 'failed'; if (error) this.#last.error = error; if (budget) this.#last.budget = structuredClone(budget); } }
}
