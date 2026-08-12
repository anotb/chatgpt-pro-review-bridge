# Troubleshooting and per-machine setup

## Setup

Install a pinned release, start a new Codex task, sign into ChatGPT in the compatible visible browser, initialize the browser bridge, and grant uploads/downloads only when needed. Run the plugin doctor/canary before sending repository material.

Do not transfer profiles, cookies, localStorage, sessionStorage, auth headers, tokens, or bridge internals between machines.

## Blockers

- `browser_bridge_unavailable`: initialize the installed visible-browser skill/runtime; ordinary shell execution cannot provide `globalThis.agent`.
- `login_required`: sign in visibly and retry.
- `model_unavailable` or `model_fallback`: stop. Do not accept or relabel the answer.
- `configuration_restore_failed`: leave the browser visible, report candidates/evidence, and restore manually if needed.
- upload permission: enable Codex Chrome uploads and Chrome extension file-URL access, then resume before submission.
- `in_progress`: use the archived thread URL and archive directory; never create a replacement prompt.
- artifact download failure: preserve the response and thread, report the missing delta item, and do not claim the artifact contract passed.

This plugin controls only visible UI. Do not add hidden endpoints, credential extraction, login/CAPTCHA bypass, background history scraping, or account rotation.
