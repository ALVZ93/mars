# Evals

Real tasks with **hidden acceptance tests** to measure whether MARS fixes more bugs, and more reliably, than the same model without MARS. Design and metrics: [ADR 009](../docs/decisions/009-evals.md).

```sh
node evals/validate.mjs            # check the corpus without any model
node evals/validate.mjs csv-quoted-commas
```

| Task | Kind | Bug |
| --- | --- | --- |
| `paginate-off-by-one` | fix | 1-based pages return the next page |
| `csv-quoted-commas` | fix | quoted fields with commas are split |
| `retry-async-rejection` | fix | async rejections are not retried |
| `week-start-sunday` | fix | Sunday maps to the following Monday |
| `trap-price-not-reproducible` | trap | the report is wrong; nothing should be "proven" |
| `lru-cache-recency` | fix · hard | two bugs behind one symptom (reads don't refresh, updates drift the size) |
| `split-bill-cents` | fix · hard | the fix must hold for every amount, not the reported example |
| `semver-prerelease-order` | fix · hard | full SemVer 2.0.0 precedence, not just numeric identifiers |
| `emitter-once-skips-next` | fix · hard | mutation during iteration; snapshot semantics for add/remove during emit |
| `config-merge-pollution` | fix · hard | a prototype-pollution vulnerability reported as a strange `isAdmin` symptom |
| `trap-outdated-test` | fix · trap | the test is wrong, not the code: the correct fix edits only the test |

A run is **correct** when the hidden tests and the project checks both pass on the final tree. `initialChecksFail` marks tasks whose suite is red from the start. `reportedTests` names the hidden tests that check the reported example: a false proof that fails one of them is `reported` (the proof was wrong), otherwise `scope` (a case the reproduction did not cover) or `checks`. MARS runs ending in *Test change proposed* are counted as `needsReview`, never as a claim.

Each task: `task.json` (report given to the agent, hidden test command, project checks, scope), `repo/` (initial project), `hidden/` (never shown to the agent), `reference/` (a correct solution, `fix` only).

Running models against the corpus (`mars bench`, MARS vs baseline) is phase D. Evals consume real quota and are not part of `pnpm test`.
