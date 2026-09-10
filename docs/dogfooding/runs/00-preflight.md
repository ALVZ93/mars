# 2B preflight

- Date: 2026-09-10
- MARS revision: `08e28198514ba2f6e56f1ad4ec631fb80b692d40`
- Host: Windows x64, Node.js 24
- Provider available: `openai-codex:gpt-5.6-sol`
- Additional providers: Ollama adapter present, but no Ollama executable installed; using another provider is not viable on this host.

## Repositories

| Repository | Revision | Dependency install | Baseline |
| --- | --- | --- | --- |
| `ALVZ93/mars` | `08e28198514ba2f6e56f1ad4ec631fb80b692d40` | frozen pnpm install | build, 71 tests and package smoke green |
| `HarnessDesk/HarnessDesk` | `990229b216820f3f4e69e3dd940642a4f1b3b49d` | frozen pnpm 10.4.1 install | Node build green; focused ACP suite 53/54, with one unrelated Windows extensionless-executable failure |
| `looksawful/sophisticate` | `271cbae7b64ddab18a41125c7a843776efd083cb` | frozen npm install | 193/198 tests green; five existing integration failures caused by absent MP4 fixtures |

The two external repositories are public MIT projects cloned under ignored `.dogfood/` directories. Their pre-existing baseline failures must remain distinguishable from changes made during the runs.

## Auth observation

Codex itself was already authenticated, so `mars auth status` reported it connected. `mars models` initially reported it unavailable because MARS had no local external-credential marker. Running `mars login openai-codex` detected the existing Codex session without opening a browser and stored the marker; the model catalog then reported the provider as authenticated.
