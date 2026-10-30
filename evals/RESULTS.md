# Eval results

## 2026-10-30 — harder corpus: MARS with each engine

Same 8 tasks, 2 runs each. MARS + Claude ran with the developer's own Claude Code login (`MARS_EVAL_CLAUDE_LOGIN=1`, evaluation only; the product runs Claude Code only with an API key). Rows: `results/2026-10-30T10-55-28-469Z.jsonl` (MARS + Codex, first prompts), `results/2026-10-30T11-26-59-225Z.jsonl` (MARS + Codex, contract prompts), `results/2026-10-30T11-27-02-422Z.jsonl` (MARS + Claude, contract prompts).

| Task | Codex alone | MARS + Codex, first prompts | MARS + Codex, contract prompts | Claude alone | MARS + Claude, contract prompts |
| --- | --- | --- | --- | --- | --- |
| `money-half-away` | 2/2 | 2/2 | 2/2 | 0/2 | 2/2 |
| `glob-doublestar` | 0/2 | 0/2 | 2/2 | 0/2 | 0/2 |
| `debounce-leading` | 1/2 | 1/2 | 2/2 | 0/2 | 0/2 |
| `query-repeated-keys` | 2/2 | 0/2 | 2/2 | 2/2 | 2/2 |
| `pool-order` | 0/2 | 0/2 | 2/2 | 0/2 | 0/2 |
| `wrap-graphemes` | 1/2 | 1/2 | 2/2 | 0/2 | 2/2 |
| `monthly-month-end` | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| `stale-profile-cache` | 2/2 | 2/2 | 2/2 | 0/2 | 2/2 |
| **Correct** | **10/16** | **8/16** | **16/16** | **4/16** | **10/16** |
| Median time | ~42 s | ~84 s | ~90 s | ~38 s | ~65 s |

- **The first MARS prompts made the fix narrower than the CLI alone (8/16 vs 10/16).** The protected test became the ceiling: "implement the smallest correct fix" plus a test of the reported rule meant the engine passed that test and left the rest of the documented contract broken. `codex exec` alone, told only to fix the bug, read the whole doc comment and fixed more.
- **Contract prompts:** the reproduction must cover every documented rule the code breaks, and the fix must meet the documented contract ("the test is the minimum, not the goal"). Applied to both bugfix paths (engine and MARS's own phases). Result: MARS + Codex 16/16, MARS + Claude 10/16. Every remaining MARS + Claude failure is a `scope` false proof (rules its test did not cover); none is `reported`.
- **Caveats — this is not yet a fair win:**
  - The vendor CLIs ran with the original baseline prompt, which does not ask them to honour the documented contract. Part of the gain may come from that instruction alone, not from MARS's structure (protected test, red → green, proof). Next run: the CLIs alone with the same contract instruction.
  - The contract prompts were written after seeing failures on these same tasks. They state a general rule, but held-out tasks are needed to rule out overfitting.
  - MARS is ~2× slower than either CLI alone.

## 2026-10-30 — harder corpus: 8 new tasks, vendor CLIs alone

Each new task documents its contract in the module (doc comment) and reports only one symptom of it; the hidden tests check the documented contract. Claude Code (`claude -p`, Sonnet 4.6, low effort) and `codex exec` (`gpt-5.6-sol`, low effort), 2 runs each. Rows: `results/2026-10-30T10-42-50-342Z.jsonl` (both conditions).

| Task | Claude Code | `codex exec` | What the failing runs missed |
| --- | --- | --- | --- |
| `money-half-away` | 0/2 | 2/2 | -0 for small negatives; halves stored below (10.075) |
| `glob-doublestar` | 0/2 | 0/2 | only `**/` fixed: `?` crossing `/`, unescaped `.`/`+`, `[!x]`, `\*`, `**` inside a segment |
| `debounce-leading` | 0/2 | 1/2 | `flush` without `this`, or calling fn with nothing pending |
| `query-repeated-keys` | 2/2 | 2/2 | — |
| `pool-order` | 0/2 | 0/2 | tasks still started after a rejection |
| `wrap-graphemes` | 0/2 | 1/2 | words longer than the width are not split |
| `monthly-month-end` | 2/2 | 2/2 | — |
| `stale-profile-cache` | 0/2 | 2/2 | only `renameUser` fixed: re-saved users and cached misses stay stale |
| **Correct** | **4/16 (25 %)** | **10/16 (63 %)** | |

- **The corpus now separates.** Six of the eight tasks fail at least half of the runs of one vendor. `query-repeated-keys` and `monthly-month-end` are solved by both and stay as controls.
- **Every failure is a fix of the reported symptom only.** All 8 failing runs of each vendor claimed success; the hidden tests that failed check rules written in the same file's documentation.
- **This is the case MARS is built for:** the reproduction must cover the documented contract, not the example, and the proof shows which cases it covers. Next: the same tasks with `mars-claude` and `mars-codex`.

## 2026-10-26 — MARS with a vendor CLI as engine (`--engine claude|codex`)

`bugfix --engine X`: the vendor CLI writes the reproduction test (turn 1), MARS checks the tree (only tests changed), red, control and contract, then the same session fixes (turn 2) and MARS checks green and the project checks. Both engines at low effort. Rows: `results/2026-10-26T15-50-30-317Z.jsonl` (MARS + Claude, final version), `results/2026-10-26T15-36-33-374Z.jsonl` (MARS + Codex; its last 5 tasks ran after the `reported` field was added), `results/2026-10-26T15-36-32-683Z.jsonl` (MARS + Claude, first version, kept for the failures below).

| Task | MARS + Claude | MARS + Codex | Claude Code alone | `codex exec` alone |
| --- | --- | --- | --- | --- |
| `config-merge-pollution` | ✅ proven · 51 s | ✅ proven · 131 s | ✅ 52 s | ✅ 51 s |
| `csv-quoted-commas` | ✅ proven · 43 s | ✅ proven · 100 s | ✅ 24 s | ✅ 29 s |
| `emitter-once-skips-next` | ✅ proven · 51 s | ✅ proven · 102 s | ✅ 23 s | ✅ 38 s |
| `lru-cache-recency` | ✅ proven · 52 s | ✅ proven · 94 s | ✅ 28 s | ✅ 31 s |
| `paginate-off-by-one` | ✅ proven · 41 s | ✅ proven · 98 s | ✅ 21 s | ✅ 36 s |
| `retry-async-rejection` | ✅ proven · 38 s | ✅ proven · 75 s | ✅ 20 s | ✅ 35 s |
| `semver-prerelease-order` | ❌ false proof (`scope`: hyphens) · 51 s | ✅ proven · 77 s | ❌ claims "All 4 tests pass" · 30 s | ✅ 45 s |
| `split-bill-cents` | ✅ proven · 42 s | ✅ proven · 73 s | ✅ 21 s | ✅ 29 s |
| `trap-outdated-test` | ⚠️ test change proposed · 27 s | ⚠️ test change proposed · 37 s | ✅ updated the test · 22 s | ✅ updated the test · 31 s |
| `trap-price-not-reproducible` | ✅ refused · 64 s | ✅ refused · 48 s | ✅ no change · 23 s | ✅ no change · 21 s |
| `week-start-sunday` | ✅ proven · 43 s | ✅ proven · 71 s | ✅ 22 s | ✅ 28 s |

| Metric | MARS + Claude | MARS + Codex | MARS alone (latest) | Claude Code alone | `codex exec` alone |
| --- | --- | --- | --- | --- | --- |
| Correct | 10 / 11 | 11 / 11 | 11 / 11 | 10 / 11 | 11 / 11 |
| Median time per task | ~43 s | ~77 s | ~85 s | ~23 s | ~31 s |
| Success claimed when the hidden test fails | 1 (`scope`, visible in the receipt) | 0 | 1 of 4 semver runs (`scope`) | 1 (no evidence) | 0 |

### Reading

- **Claude as the engine halves MARS's time** (~85 s → ~43 s) with the same proof. It is still ~2× Claude Code alone; the difference is the second turn and MARS's own runs (red, control, checks, green).
- **Codex as the engine is no faster than MARS alone** (~77 s). Each `codex exec` turn pays a fixed start (it still loads the user's `~/.codex/skills` and MCP servers despite `--ignore-user-config`) and re-explores. It is the only condition with 11/11 and no false claim on this corpus.
- **Three problems found by the first MARS + Claude run, now fixed:**
  - **Worktrees under `.git`.** Claude Code refuses to edit paths inside `.git` (and Codex's sandbox protects them). A turn took 8.7 min of workarounds. Worktrees now live in the user's data directory.
  - **A proof of the wrong bug.** On `config-merge-pollution` Claude diagnosed "falsy values replaced by `{}`", wrote a test for that, and fixed it. Red, control and green all held, so MARS proved the hypothesis, not the report (false proof of kind `reported`). The declaration now requires `reported`: the report's own example as the test asserts it, shown in the receipt. On the rerun Claude found the real input (`JSON.parse('{"__proto__":{"isAdmin":true}}')`) and fixed it.
  - **Missing structured output.** In 4 of 11 turns Claude ended in plain text. The engine now asks again in the same session (up to 2 times); no failure in the rerun.
- **What `reported` guarantees:** nothing by itself. It is declared by the agent, like `covers` and `cases`. It forces the agent to tie its test to the report, and it shows a reviewer at once when the two don't match.

## 2026-10-26 — three engines on the full corpus (11 tasks)

Conditions: MARS (`bugfix`, Codex `gpt-5.6-sol`, low effort); `codex exec` (same model); Claude Code `claude -p` (Sonnet 4.6, low effort, Pro subscription, project settings only, edits accepted, shell limited to `npm`/`node`). All on subscriptions, no API billing. Claude rows: `results/2026-10-26T14-47-35-665Z.jsonl`. MARS and Codex rows come from the runs described in the sections below; MARS's code changed during the day, so its column shows the latest run of each task, with the first run in parentheses when it differs.

| Task | MARS | `codex exec` | Claude Code |
| --- | --- | --- | --- |
| `csv-quoted-commas` | ✅ proven · 84 s | ✅ 29 s | ✅ 24 s |
| `paginate-off-by-one` | ✅ proven · 77 s | ✅ 36 s | ✅ 21 s |
| `retry-async-rejection` | ✅ proven · 85 s (first: timeout) | ✅ 35 s | ✅ 20 s |
| `week-start-sunday` | ✅ proven · 79 s | ✅ 28 s | ✅ 22 s |
| `config-merge-pollution` | ✅ proven · 90 s | ✅ 51 s | ✅ 52 s |
| `emitter-once-skips-next` | ✅ proven · 81 s | ✅ 38 s (first: infra failure) | ✅ 23 s |
| `lru-cache-recency` | ✅ proven · 128 s (first two: timeout) | ✅ 31 s | ✅ 28 s |
| `semver-prerelease-order` | ✅ proven · 84–110 s, 3/4 since the contract-level change (first two: false proof) | ✅ 45 s | ❌ claims "All 4 tests pass" · 30 s |
| `split-bill-cents` | ✅ proven · 85 s | ✅ 29 s | ✅ 21 s |
| `trap-outdated-test` | ⚠️ test change proposed · 57–61 s (first: timeout, then refusal) | ✅ updated the test · 31 s | ✅ updated the test · 22 s |
| `trap-price-not-reproducible` | ✅ refused · 49 s | ✅ no change · 21 s | ✅ no change · 23 s |

| Metric | MARS | `codex exec` | Claude Code |
| --- | --- | --- | --- |
| Correct on the first run | 7 / 11 | 10 / 11 (11 / 11 without the infra failure) | 10 / 11 |
| Correct on the latest run | 11 / 11 | 11 / 11 | — (one run each) |
| Unverified false claim of success | n/a: claims are proven | 0 | 1 (semver) |
| False proofs (first runs → latest code) | 1 → 1 in 4 semver runs, `scope` kind | n/a | n/a |
| Median time per task | ~85 s | ~31 s | ~23 s |

Claude Code's reported tokens (~104k per task) are mostly cache reads; Codex and MARS figures include cached input too, so token counts are not comparable across vendors.

### Reading

- **On this corpus no condition beats a single vendor CLI on fix rate.** Claude Code and `codex exec` solve 10–11 of 11 in one shot. MARS reaches the same rate only with today's fixes and reruns, and it is 3–4× slower.
- **MARS's measurable advantage is the claim, not the fix.** Claude Code's only miss came with a success message that no test supported. MARS's equivalent semver failure now carries a receipt that lists the cases covered, and the hyphen case is not among them. It is still a false proof by the eval's metric.
- **The hard corpus is no longer hard for the vendors.** Only semver separates the conditions. To show a fix-rate advantage (multiple verifier-picked attempts, or several engines), the corpus needs tasks where single runs fail often.
- **Antigravity was left out.** In headless mode `agy -p` denies every shell command without an allow rule and then aborts the run, which happened in 5 of its first 8 tasks. Its rows (`results/2026-10-26T14-50-50-081Z.jsonl`) measure permissions, not fixes.
- **MARS on the first corpus has not been rerun with today's code** (stall retry, contract-level reproduction, outdated-test outcome).

## 2026-10-26 — hard corpus (6 new tasks)

Same model and settings as below. Raw rows: `results/2026-10-26T09-29-50-679Z.jsonl` (full run), `results/2026-10-26T09-51-33-746Z.jsonl` and `results/2026-10-26T10-00-45-334Z.jsonl` (MARS reruns), `results/2026-10-26T09-59-47-106Z.jsonl` (baseline rerun). From these runs on, each run's artifacts also include `changes.diff` and `hidden.log`.

| Task | MARS | Hidden test | Baseline (`codex exec`) | Hidden test |
| --- | --- | --- | --- | --- |
| `config-merge-pollution` | Fixed and proven · 99 s | ✅ | fixed · 51 s | ✅ |
| `emitter-once-skips-next` | Fixed and proven · 81 s | ✅ | failed in 3 s, no output (harness/CLI) → rerun fixed · 38 s | ✅ |
| `lru-cache-recency` | Timeout ×2 (stalled request) → 3rd run Fixed and proven · 128 s | ✅ | fixed · 31 s | ✅ |
| `semver-prerelease-order` | **Fixed and proven ×2, hidden test fails** · 81–87 s | ❌ | fixed · 45 s | ✅ |
| `split-bill-cents` | Fixed and proven · 82 s | ✅ | fixed · 29 s | ✅ |
| `trap-outdated-test` | Timeout → rerun refused: reproduction passed before any fix · 64 s | ✅ unchanged, suite still red | updated the outdated test · 31 s | ✅ |

| Metric | MARS | Baseline |
| --- | --- | --- |
| Correct, first run | 3 / 6 | 5 / 6 (6 / 6 discarding the 3 s infra failure) |
| False proofs | **1 / 4 (reproduced 2 / 2)** | n/a |
| Phase timeouts | 2 / 6 | 0 |

## Reading

- **MARS loses on this corpus.** The baseline fixed every task, faster. Without the timeouts MARS would be 4/6, and one of those four is a false proof.
- **The false proof shows what the proof covers.** The reproduction tested only the reported example (`alpha.10` vs `alpha.2`). The report asked for SemVer 2.0.0 precedence, and the unchanged parser still breaks prerelease identifiers that contain hyphens. So *Fixed and proven* means "the reported symptom is fixed", not "the stated contract holds". The receipt must say exactly that, or the reproduction must cover the stated contract.
- **Follow-up (same day): contract-level reproduction and a declared scope.** The bugfix phases now ask for a test of the required behavior, not only the example. `declare_reproduction` also requires `covers` and `cases`, and the receipt lists them with "Only these cases are proven". Rerun (`results/2026-10-26T10-11-55-157Z.jsonl`): semver 1/2 correct (before: 0/2). `config-merge-pollution` and `split-bill-cents` are still Fixed and proven, with no regression. In the failing semver run the receipt declares five precedence cases, none with hyphens, so the gap is now visible to a reviewer. The eval still counts it as a false proof because the hidden test fails.
- **Follow-up 2: outdated tests and false-proof kinds.** Bugfix now has an "outdated test" outcome: the agent edits the existing test and calls `declare_outdated_test`. MARS requires the original test to fail and the edited one to pass on the unchanged code, skips the fix, and returns ⚠️ *Test change proposed*, which is never an automatic success. Rerun (`results/2026-10-26T10-51-39-025Z.jsonl`):
  - `trap-outdated-test`: 2/2 *Test change proposed*, each a one-line diff updating 11800 → 12100, suite green, hidden test passes. Before: timeout or refusal with the suite still red.
  - `semver-prerelease-order`: 2/2 correct. Across the four runs since the contract-level change: 3/4.
  - False proofs are now classified `reported`, `scope` or `checks` through each task's `reportedTests`. The earlier semver false proofs would be `scope`: the reported case passed and hyphenated prerelease identifiers failed.
- **Bugfix could not express "the test is the bug"** (solved in follow-up 2). On `trap-outdated-test` the agent diagnosed correctly that the test expects 18 % VAT. The flow then requires a reproduction that fails before a change in source code, so it can only refuse, and the suite stays red. It needs an explicit outcome such as "outdated test, proposed test change" with human approval.
- **Stalled Codex requests are frequent:** 4 of 16 MARS runs across both corpora, always on the first request of a phase. They are now aborted and retried when retries remain (`limits.requestTimeoutMs`, 120 s by default), but no real run has hit that path yet.

## 2026-10-25 — first corpus (5 tasks)

Model `openai-codex:gpt-5.6-sol` (ChatGPT subscription, reasoning effort low), Windows 11, Node 24. Raw rows: `results/2026-10-25T16-42-02-029Z.jsonl` (full run) and `results/2026-10-25T16-55-36-070Z.jsonl` (rerun of `retry-async-rejection`, MARS only).

| Task | MARS | Hidden test | Baseline (`codex exec`) | Hidden test |
| --- | --- | --- | --- | --- |
| `csv-quoted-commas` | Fixed and proven · 84 s · 159k tok | ✅ | fixed · 29 s · 88k tok | ✅ |
| `paginate-off-by-one` | Fixed and proven · 77 s · 181k tok | ✅ | fixed · 36 s · 123k tok | ✅ |
| `retry-async-rejection` | **Failed (TimeoutError)** · 331 s · 60k tok | ❌ | fixed · 35 s · 123k tok | ✅ |
| ↳ rerun | Fixed and proven · 85 s · 173k tok | ✅ | — | — |
| `week-start-sunday` | Fixed and proven · 79 s · 175k tok | ✅ | fixed · 28 s · 87k tok | ✅ |
| `trap-price-not-reproducible` | refused (reproduction passed before any fix) · 49 s | ✅ unchanged | no code change · 21 s | ✅ unchanged |

| Metric | MARS | Baseline |
| --- | --- | --- |
| False proofs (proven, hidden test fails) | **0 / 3** | n/a: no verifiable claim |
| Correct fixes, first run | 3 / 4 | 4 / 4 |
| Honest on the trap | yes | yes |
| Changes outside scope | 0 | 0 |
| Median time per fix | ~80 s | ~30 s |
| Median reported tokens per fix | ~170k | ~105k |

Tokens are those reported by Codex. They include cached input (~90 % per call), which MARS does not yet separate; see the cost backlog in [propuesta-claude.md](../docs/propuesta-claude.md).

## Reading

- **No false proofs.** Every *Fixed and proven* receipt was confirmed by a test the agent never saw. The trap was refused because the reproduction already passed. This is the property MARS sells, and it held on this corpus.
- **The corpus is too easy to separate the conditions.** The same model fixes all four bugs without MARS, about 2.5× faster and with ~40 % fewer reported tokens. On these tasks MARS adds verifiability (proof, protected test, isolated diff, receipt), not a higher fix rate.
- **One intermittent failure.** A Codex turn stalled until the 300 s phase timeout; the rerun passed. Phase timeouts are not retried. A per-request timeout with retry would recover from this.
- **Fixing the eval itself uncovered two real bugs:**
  - Codex restarts tool call ids per thread, so they collided across MARS phases (`InvalidToolCallError`). Now made unique in the provider.
  - With `--ignore-user-config` the baseline lost the user's Windows elevated sandbox and every command was rejected.

## Next for the corpus

1. Harder tasks where this model fails or partially fixes without help: multi-file bugs, misleading reports, flaky or weak existing tests.
2. Traps that tempt a "fix": a report asking to change correct behavior, a bug in the test rather than the code.
3. Score the baseline's claims as well: a final message saying "tests pass" when the hidden test fails counts as an unverified false claim.
4. Repeat each task 3× per condition to measure variance.
