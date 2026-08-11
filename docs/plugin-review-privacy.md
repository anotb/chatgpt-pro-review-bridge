---
title: ChatGPT Pro Review Plugin Privacy
date: 2026-08-11
type: reference
status: prerelease
---

# ChatGPT Pro Review Plugin Privacy

The plugin builds local repository review packets, then sends approved packet files and prompt text through visible ChatGPT browser controls. It archives the complete prompt, packets, response, artifact files, hashes, configuration evidence, and a redacted diagnostic report under the configured local archive root.

The plugin has no hosted service. It does not call private ChatGPT endpoints or read cookies, localStorage, sessionStorage, hidden headers, credentials, or auth tokens. Each computer uses its own visible signed-in session and permissions.

Repository content and raw archives may be sensitive. Secret-path exclusions and pattern scanning reduce risk but cannot prove safety. Review the packet manifest and keep `.codex/pro-reviews/` uncommitted unless evidence retention is intentional.
