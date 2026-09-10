# MARS dogfooding

Milestone 2B validates the compiled CLI against public, real-world repositories. Disposable clones live in `.dogfood/` and never enter Git.

## Run set

| ID | Repository | Task | Mode | Expected verification |
| --- | --- | --- | --- | --- |
| 2B-01 | `ALVZ93/mars` | Architecture analysis with file-backed claims | normal | No workspace changes; claims match inspected files |
| 2B-02 | `HarnessDesk/HarnessDesk` | Fix public issue [#159](https://github.com/HarnessDesk/HarnessDesk/issues/159) | `bugfix` workflow | Focused regression tests and repository checks |
| 2B-03 | `looksawful/sophisticate` | Fix public issue [#14](https://github.com/looksawful/sophisticate/issues/14) | normal | Cancellation regression tests and project checks |
| 2B-04 | `HarnessDesk/HarnessDesk` | Review the diff produced by 2B-02 | `review` workflow | Concrete findings tied to the diff |
| 2B-05 | `looksawful/sophisticate` | Resume 2B-03 and verify the result | resumed session | Context and tool history survive resume |

All five runs are complete and accepted. The remaining deferred observation is the P2 authentication marker mismatch in `2B-F01`, which belongs to Milestone 2C rather than this dogfooding gate.

Only public repository content may be sent to a model. Credentials, `.mars/`, dependency caches and unrelated local files are excluded.

## Per-run record

Each Markdown file in `runs/` records repository revision, provider/model, workflow, timestamps, duration, turns, tool calls, tool errors, permission prompts, token usage, retries, compactions, verification and whether the result was accepted.

Findings are classified in [findings.md](findings.md). P0 and P1 findings require a fix and regression coverage before Milestone 2B can close.
