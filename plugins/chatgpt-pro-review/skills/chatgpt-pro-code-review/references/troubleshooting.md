# Troubleshooting and per-machine setup

## Setup

Install a pinned release, start a new Codex task, sign into ChatGPT in the compatible visible browser, initialize the browser bridge, and grant uploads/downloads only when needed. Run the plugin doctor/canary before sending repository material.

Do not transfer profiles, cookies, localStorage, sessionStorage, auth headers, tokens, or bridge internals between machines.

## Blockers

- `browser_bridge_unavailable`: initialize the installed visible-browser skill/runtime; ordinary shell execution cannot provide `globalThis.agent`.
- `login_required`: inspect the visible page. An exact visible login control outside message content is authoritative when authenticated structural evidence is absent; generic **New chat** or **Search chats** navigation is not proof of sign-in. Sign in visibly only when the current page is actually logged out, then retry.
- `model_unavailable` or `model_fallback`: stop. Do not accept or relabel the answer.
- `configuration_restore_failed`: leave the browser visible, report candidates/evidence, and restore manually if needed.
- upload permission: enable Codex Chrome uploads and Chrome extension file-URL access, then resume before submission.
- `in_progress`: use the archived thread URL and archive directory; never create a replacement prompt. Back off 30s, 60s, 2m, 4m, then to at most one resume every 5m for the same archive.
- `review_archive_locked`: do not delete the lease manually or create a replacement review. A demonstrably live owner remains locked. For an archive with a durable submitted/non-resubmittable receipt, if a restricted browser host cannot determine PID liveness, the runtime may reclaim the lease only after five minutes without a heartbeat; pre-submit archives remain fail-closed. Its generation-specific marker prevents delayed cleanup from deleting a successor's lease.
- `conversation_binding_lost`, `conversation_tab_affinity_lost`, or `conversation_prompt_affinity_lost`: leave the visible tabs intact. Resume a post-submit review from the same archive; never resend its prompt. Start fresh only when the blocker explicitly reports a pre-submit non-resumable loss.
- `review_thread_recovery_ambiguous`: repeated identical prompts matched multiple canonical conversations and no archived tab ID uniquely selected one. Leave the candidates visible and resume only when the exact archived target can be identified; do not guess.
- `existing_tab_handoff_completed`: make no further browser calls; handoff must end the task turn. Resume the same archive once from a later turn with a fresh browser-host invocation, following the [durable phase rules](review-contract.md).
- `existing_tab_unresponsive` or `existing_tab_temporarily_claimed`: preserve the archive and visible tabs. Retry the same archive only after the browser is responsive or the prior owner exits; never open a duplicate chat or resend the prompt.
- `archive_terminal_commit_failed`: terminal provenance could not be committed. Treat the result and any `archive-commit-failure.json` marker as non-resumable; do not retry the archive or relabel a response as successfully archived.
- artifact download failure: preserve the response and thread, report the missing delta item, and do not claim the artifact contract passed.

This plugin controls only visible UI. Do not add hidden endpoints, credential extraction, login/CAPTCHA bypass, background history scraping, or account rotation.
