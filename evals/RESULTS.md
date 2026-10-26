# Eval results

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
