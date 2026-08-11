# Upstream tracking

## Baseline

- Upstream: `https://github.com/adamallcock/codex-chatgpt-control`
- Reviewed release: `v0.5.1-alpha.1` (`884b605`)
- Reviewed main: `73c5737f222709e324a1c7ba1637cef9966000ce`
- Rechecked: 2026-08-11. Upstream main and tags contained no newer release or implementation of this review bridge.

The fork remote is `origin`; the original repository is retained as `upstream`. Rebase or merge only after running the unchanged baseline gates and reviewing bundled-runtime conflicts.

```bash
git fetch upstream --tags
git switch main
git merge --ff-only upstream/main
git switch agent/chatgpt-pro-review-bridge
git rebase main
```

## Upstream-ready commits

These commits are general visible-session transport/safety improvements and should remain separately cherry-pickable:

- `b923653` — Windows Node 24 npm launcher handling for release gates.
- `2a2ea7c` — precise model unavailable/fallback/restoration blocker categories.
- `333330d` — visible configuration snapshot and strict restoration.
- `1f5546e` — visible artifact inventory baseline/delta.
- `747f9c9` — selected visible image artifact downloads.

Any selector, configuration, polling, file, or artifact compatibility fix discovered during live qualification belongs in this upstream-ready group unless it depends on review packet/archive policy.

## Fork-only commits

The first-class repository review API, deterministic packet/archive policy, review prompt/finding contract, separate plugin ID, Agent Skill, installed-runtime canary, host orchestration matrix, and fork release documentation are opinionated fork features.

## Compatibility policy

The bundled Node runtime is authoritative. The review workflow composes public Node primitives without adding a shared backend command, so the Python parity client remains unchanged. If a future change adds a backend command, update TypeScript protocol descriptors, schemas, fixtures, Python sync/async surfaces, docs, and conformance tests together.

Build both plugins from the same source bundle and require `npm run plugin:check` before release. Never hand-edit bundled runtime output.
