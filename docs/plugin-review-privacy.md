---
title: ChatGPT Pro Review Plugin Privacy
date: 2026-08-11
type: reference
status: stable
---

# ChatGPT Pro Review Plugin Privacy

For a context-free question, the plugin sends only the prompt through visible ChatGPT browser controls and uploads no files. When repository context is deliberately requested, it builds local review packets and attaches those approved files visibly. It archives the prompt, response, artifact files, hashes, configuration evidence, and a redacted diagnostic report; packet-backed requests also archive their manifest and packets.

The plugin has no hosted service. It does not call private ChatGPT endpoints or read cookies, localStorage, sessionStorage, hidden headers, credentials, or auth tokens. Each computer uses its own visible signed-in session and permissions.

Repository content and raw archives may be sensitive. Conventional credential and browser-profile paths are excluded, but path policy cannot prove that every included file is appropriate to share. Review packet scope when needed and keep `.codex/pro-reviews/` uncommitted unless evidence retention is intentional.
