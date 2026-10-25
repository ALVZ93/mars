import type { TaskRole } from './routing.js';

export interface WorkflowPhase {
  id: string;
  role: TaskRole;
  instruction: string;
  verification?: boolean;
  allowedTools?: readonly string[];
}
export interface WorkflowDefinition {
  id: string;
  description: string;
  phases: readonly WorkflowPhase[];
  /** Explicit implementation phase to reuse after a failing verification check. */
  repairPhase?: string;
  matches(task: string): boolean;
}

const bugfix: WorkflowDefinition = {
  id: 'bugfix', description: 'Reproduce, fix and verify a failing behavior.',
  repairPhase: 'implement',
  phases: [
    { id: 'inspect', role: 'planner', allowedTools: ['read_file', 'search_files', 'git'], instruction: 'Read-only phase: inspect only the files needed to establish a concrete reproduction. Do not modify files or implement the fix. As soon as the failing behavior and likely boundary are clear, report them concisely and stop.' },
    { id: 'implement', role: 'implementer', instruction: 'Start from the reproduction already established in the prior phase. Implement the smallest correct fix without repeating broad inspection. Preserve unrelated behavior, then report the focused diff and stop.' },
    { id: 'verify', role: 'verifier', allowedTools: ['read_file', 'search_files', 'git'], instruction: 'Verification review only: do not modify files or run shell commands. Briefly identify the relevant checks and stop; MARS executes the configured verification commands immediately after this phase and owns their exit status.', verification: true },
  ],
  matches: task => /bug|fix|fail|error|broken|regression|falla|error/i.test(task),
};
const review: WorkflowDefinition = {
  id: 'review', description: 'Inspect changes, identify risks and verify the current tree.',
  phases: [
    { id: 'review', role: 'reviewer', allowedTools: ['read_file', 'search_files', 'git'], instruction: 'Use the read_file and git tools to inspect the current diff. Do not modify files, run shell commands or use the network. Report concrete correctness, security and test risks tied to the inspected changes.' },
    { id: 'verify', role: 'verifier', allowedTools: ['read_file', 'search_files', 'git'], instruction: 'Verification review only: do not modify files or run shell commands. Identify the relevant configured checks briefly; MARS executes them and owns their exit status.', verification: true },
  ],
  matches: task => /review|audit|critique|revis|audita|revisión/i.test(task),
};
const feature: WorkflowDefinition = {
  id: 'feature', description: 'Plan, implement and verify a requested change.',
  repairPhase: 'implement',
  phases: [
    { id: 'plan', role: 'planner', allowedTools: ['read_file', 'search_files', 'git'], instruction: 'Inspect the project and make a short implementation plan. Avoid unrelated edits.' },
    { id: 'implement', role: 'implementer', instruction: 'Implement the requested change and keep the diff focused.' },
    { id: 'verify', role: 'verifier', allowedTools: ['read_file', 'search_files', 'git'], instruction: 'Verification review only: do not modify files or run shell commands. Identify the relevant configured checks briefly; MARS executes them and owns their exit status.', verification: true },
  ],
  matches: () => true,
};

export const BUILTIN_WORKFLOWS: readonly WorkflowDefinition[] = [bugfix, review, feature];

export class WorkflowRegistry {
  #workflows = new Map<string, WorkflowDefinition>();
  constructor(workflows: readonly WorkflowDefinition[] = BUILTIN_WORKFLOWS) { for (const workflow of workflows) this.register(workflow); }
  register(workflow: WorkflowDefinition): void { if (this.#workflows.has(workflow.id)) throw new Error(`Duplicate workflow: ${workflow.id}`); this.#workflows.set(workflow.id, workflow); }
  get(id: string): WorkflowDefinition | undefined { return this.#workflows.get(id); }
  list(): WorkflowDefinition[] { return [...this.#workflows.values()]; }
  select(task: string): WorkflowDefinition { return this.list().find(workflow => workflow.matches(task)) ?? feature; }
}

export function selectWorkflow(task: string, registry = new WorkflowRegistry()): WorkflowDefinition { return registry.select(task); }
