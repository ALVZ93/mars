import type { TaskRole } from './routing.js';

export interface WorkflowPhase {
  id: string;
  role: TaskRole;
  instruction: string;
  verification?: boolean;
  allowedTools?: readonly string[];
  /** Writes a failing test and declares it; MARS requires it to fail now and pass at verification. */
  reproduction?: boolean;
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
  id: 'bugfix', description: 'Reproduce with a failing test, fix, and prove it: red before, green after, test untouched.',
  repairPhase: 'implement',
  phases: [
    { id: 'inspect', role: 'planner', allowedTools: ['read_file', 'search_files', 'git'], instruction: 'Read-only phase: inspect only the files needed to establish a concrete reproduction. Do not modify files or implement the fix. Read the documentation and comments of the code involved: every documented rule that the current code breaks is part of the bug, even if the report shows only one symptom. Separate the reported example from the required behavior: if the report names a rule, spec or expected behavior ("should follow X", "like a normal Y"), state that contract and the cases of it the code likely gets wrong, not only the example. If the code already meets the contract and an existing test expects something else, say that the test is outdated and why. As soon as the failing behavior and likely boundary are clear, report them concisely and stop.' },
    { id: 'reproduce', role: 'implementer', reproduction: true, allowedTools: ['read_file', 'search_files', 'git', 'write_file'], instruction: 'Reproduction phase: write a focused automated test that fails because of the reported bug, using the project\'s existing test framework and conventions. Assert the required behavior, not only the reported example: when the report names a rule or spec, cover its representative cases and the edge cases next to the reported one. Only create or edit test files; do not fix the bug and do not run commands. Then call declare_reproduction with the exact shell command that runs only that test from the workspace root, the test file paths, the report\'s own example as the test asserts it, the behavior it covers and the cases it asserts, and stop. One case must be the report\'s own example: if no test can reproduce it, the diagnosis is wrong, so keep inspecting. Only if the code is right and an existing test is outdated: edit that test to the correct expectation instead and call declare_outdated_test; MARS skips the fix and asks a human to review the test change. MARS runs the command and requires it to fail before any fix.' },
    { id: 'implement', role: 'implementer', instruction: 'Start from the reproduction already established in the prior phases. Fix the code so that it meets its documented contract, without repeating broad inspection: the reproduction test is the minimum, not the goal, so also fix any other documented rule the code involved breaks. The reproduction test files are protected: change the implementation, never the test. Preserve unrelated behavior, then report the focused diff and stop.' },
    { id: 'verify', role: 'verifier', allowedTools: ['read_file', 'search_files', 'git'], instruction: 'Verification review only: do not modify files or run shell commands. Briefly identify the relevant checks and stop; MARS executes the reproduction test and the configured verification commands immediately after this phase and owns their exit status.', verification: true },
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
