# Dogfooding findings

| ID | Priority | Run | Finding | Status | Regression coverage |
| --- | --- | --- | --- | --- | --- |
| 2B-F01 | P2 | preflight | `mars auth status` can report Codex connected from its global session while `mars models` reports it unavailable until `mars login openai-codex` stores the local marker. | Deferred to Milestone 2C auth hardening | Pending |
| 2B-F02 | P0 | 2B-01 | Codex rejected the provider's structured-output schema because `toolCalls[].arguments` had no JSON Schema type. | Fixed | `tests/subscriptions.test.mjs` validates the strict string schema, JSON decoding and malformed arguments. |
| 2B-F03 | P0 | 2B-01 | A single user task with several tool cycles could exceed the context limit because compaction only removed complete user-message groups. | Fixed | `tests/loop.test.mjs` verifies removal of old complete tool cycles while retaining the task and latest correlated cycle. |
| 2B-F04 | P1 | 2B-01 | The Codex adapter created a new SDK thread and resent the complete transcript on every turn, producing 262,685 input tokens and 9m 46s latency for seven turns. | Fixed | `tests/subscriptions.test.mjs` verifies one reused thread and delta-only non-assistant updates. |
| 2B-F05 | P1 | 2B-02 | Subscription-backed Codex inherited the user's global reasoning effort; even Luna took about 2.5 minutes for a single search call and the bugfix workflow timed out before editing. | Fixed | `tests/subscriptions.test.mjs` pins the isolated model component to `modelReasoningEffort: low`. |
| 2B-F06 | P1 | 2B-02 | The `bugfix` inspect-phase prompt did not forbid edits or tell the model when to stop; a detailed task spent the whole phase investigating and then modified files before timing out. | Fixed | `tests/v02.test.mjs` pins read-only inspect, focused implement and verification-only stop conditions. |
| 2B-F07 | P2 | 2B-02 | A full disk surfaced only as generic `Could not write MARS session`, hiding the actionable `ENOSPC` cause. | Fixed | `FileSessionStore` includes the safe filesystem error code without exposing a path. |
| 2B-F08 | P1 | 2B-02 | The verifier model ran `pnpm verify` and reported failure while MARS then ran the configured checks successfully, producing contradictory output and duplicate work. | Fixed | The built-in verifier phase now reviews checks without shell; MARS alone executes and judges the configured verification. `tests/v02.test.mjs` pins the boundary. |
| 2B-F09 | P1 | 2B-03 | One malformed JSON argument from Codex aborted the task before any tool ran, despite configured transient retries. | Fixed | `runAgent` treats provider-side `InvalidToolCallError` as safely retryable before output/tool execution; `tests/loop.test.mjs` covers recovery. |
| 2B-F10 | P0 | 2B-03 | MARS accepted `content=""` with no tool calls as a completed task and recorded positive evidence. | Fixed | `runAgent` rejects an empty final response as provider-unavailable and can retry it before side effects; `tests/loop.test.mjs` covers recovery. |
| 2B-F11 | P1 | 2B-04 | The review workflow did not explicitly require inspection tools, so a reviewer could return a review without reading the diff; its verifier also repeated project checks and could contradict MARS's configured verification. | Fixed | Review phase requires `git`/`read_file`; all built-in verifier phases are review-only and MARS owns configured checks. `tests/v02.test.mjs` pins both boundaries. |
| 2B-F12 | P1 | 2B-05 | `mars resume <id>` loaded the session but the interactive REPL created a new session because the restored ID was not passed through. | Fixed | CLI now forwards the resume ID into the interactive session factory; `tests/v02.test.mjs` verifies the same ID and prior messages are restored. |

Priority definitions:

- P0: breaks the task or creates danger.
- P1: reduces reliability.
- P2: disruptive user experience.
- P3: future improvement.
