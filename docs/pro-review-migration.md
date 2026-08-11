---
title: Pro Review Migration
date: 2026-08-11
type: guide
status: prerelease
---

# Pro Review Migration

Existing `codex-chatgpt-control` users can keep that plugin installed. The new plugin ID and skill name do not collide:

- general surface control: `codex-chatgpt-control` / `$codex-chatgpt-control`
- focused repository review: `chatgpt-pro-review` / `$chatgpt-pro-code-review`

Move long code-review snippets to `chatgpt.reviews.codeReview(...)`. The first-class workflow owns packet generation, Pro verification, submit-once evidence, bounded resume, full response capture, artifact delta handling, and configuration restoration.

After any plugin upgrade, start a new Codex task. Existing in-progress reviews must resume from their original archive directory and thread URL; do not reconstruct and resend their prompts.

The Agent Skill instructions can be copied to other skill-aware products for planning, but live browser execution currently requires the Codex/browser host that provides `globalThis.agent`.
