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

Each task: `task.json` (report given to the agent, hidden test command, project checks, scope), `repo/` (initial project), `hidden/` (never shown to the agent), `reference/` (a correct solution, `fix` only).

Running models against the corpus (`mars bench`, MARS vs baseline) is phase D. Evals consume real quota and are not part of `pnpm test`.
