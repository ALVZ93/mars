import type { TaskRole } from './routing.js';

export interface WorkflowPhase {
  id: string;
  role: TaskRole;
  instruction: string;
  verification?: boolean;
}
export interface WorkflowDefinition {
  id: string;
  description: string;
  phases: readonly WorkflowPhase[];
  matches(task: string): boolean;
}

const bugfix: WorkflowDefinition = {
  id: 'bugfix', description: 'Reproduce, fix and verify a failing behavior.',
  phases: [
    { id: 'inspect', role: 'planner', instruction: 'Inspect the repository and establish a concrete reproduction. Do not claim a fix yet.' },
    { id: 'implement', role: 'implementer', instruction: 'Implement the smallest correct fix. Preserve unrelated behavior.' },
    { id: 'verify', role: 'verifier', instruction: 'Run the project verification commands and report their real exit status.', verification: true },
  ],
  matches: task => /bug|fix|fail|error|broken|regression|falla|error/i.test(task),
};
const review: WorkflowDefinition = {
  id: 'review', description: 'Inspect changes, identify risks and verify the current tree.',
  phases: [
    { id: 'review', role: 'reviewer', instruction: 'Review the current diff and report concrete correctness, security and test risks.' },
    { id: 'verify', role: 'verifier', instruction: 'Run the project verification commands and report their real exit status.', verification: true },
  ],
  matches: task => /review|audit|critique|revis|audita|revisión/i.test(task),
};
const feature: WorkflowDefinition = {
  id: 'feature', description: 'Plan, implement and verify a requested change.',
  phases: [
    { id: 'plan', role: 'planner', instruction: 'Inspect the project and make a short implementation plan. Avoid unrelated edits.' },
    { id: 'implement', role: 'implementer', instruction: 'Implement the requested change and keep the diff focused.' },
    { id: 'verify', role: 'verifier', instruction: 'Run the project verification commands and report their real exit status.', verification: true },
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
