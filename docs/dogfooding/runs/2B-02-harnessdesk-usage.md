# 2B-02 — HarnessDesk ACP usage regression

- Task: Fix public issue `HarnessDesk/HarnessDesk#159`.
- Repository: `HarnessDesk/HarnessDesk`
- Revision: `990229b216820f3f4e69e3dd940642a4f1b3b49d`
- Provider/model: `openai-codex` / `gpt-5.6-luna` through ChatGPT subscription
- Workflow: `bugfix` (`inspect`, `implement`, `verify`)
- Roles: planner, implementer, verifier
- Accepted session: `c8606443-5e7e-4b65-8cac-4e6e2fe4582a`
- Started: 2026-09-10 16:00:38 UTC
- Duration: 6m 27s
- Turns: 5
- Tool calls: 2 (`git`, `shell`)
- Tool errors: 0
- Permission prompts: 0; configured shell permission was granted without a prompt
- Input/output tokens: 120,338 / 454 (SDK-reported per-turn usage)
- Estimated cost: unavailable for subscription-backed execution
- Retries: 0 automatic
- Context compactions: 0
- Verification: workflow automatic verification exited successfully; direct TypeScript build and the new named regression test also passed
- Outcome: changed one runtime branch and added a two-turn regression test
- Accepted: yes
- Issues: `2B-F05`, `2B-F06`, `2B-F07`, `2B-F08`

## Result

When an ACP response has no wire usage, quota usage or readable usage record, `AcpSession` now always calls `#forgetLastTurn()`. The regression test sends one turn with `response.usage=900`, then a turn without usage, and asserts `last.totalTokens=0` while cumulative `total.totalTokens` remains 900.

The compiled focused suite passed the new test. The complete ACP test file remains 54/55 on Windows because the pre-existing extensionless executable test reports `version: null`; the same unrelated failure was recorded in preflight before this change.

Several earlier attempts exposed and drove fixes for workflow phase boundaries, inherited reasoning effort and full-disk diagnostics. The accepted workflow completed all three phases with exit code zero. Its verifier model also printed an unrelated `pnpm verify` failure before MARS's configured verification passed; `2B-F08` removes that duplicate shell responsibility from future verifier phases.
