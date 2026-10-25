# Eval results

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
