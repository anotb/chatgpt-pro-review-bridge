---
title: ChatGPT Pro Review Plugin Privacy
date: 2026-08-13
type: reference
status: stable
---

# ChatGPT Pro Review Plugin Privacy

For a context-free question, the plugin sends only the prompt through visible ChatGPT browser controls and uploads no files. When repository context is deliberately requested, it builds local review packets and attaches those approved files visibly. It archives the prompt, response, artifact files, hashes, configuration evidence, and a redacted diagnostic report; packet-backed requests also archive their manifest and packets.

The plugin has no hosted service. It does not call private ChatGPT endpoints or read cookies, localStorage, sessionStorage, hidden headers, credentials, or auth tokens. Each computer uses its own visible signed-in session and permissions. Local recovery records may retain the visible Chat conversation URL/ID and an opaque browser-tab ID; those values stay in `.codex/pro-reviews/` and are not part of the uploaded packet manifest.

Repository content and raw archives may be sensitive. Repository-root
`credentials/` and `secrets/` stores, provider/browser store ancestry, specific
secret filenames, private keys, generated content, binaries, oversized files,
committed symlinks, and gitlinks are excluded from packet evidence. Ordinary
nested application source under names such as `src/credentials/`,
`packages/service/secrets/`, and `tests/fixtures/auth.json` remains reviewable;
a source-oriented path name alone is not proof of a live secret. Store ancestry
and hard filename rules still win when a path ends in a fixture-looking name.

Disabling changed-file source snapshots does not disable packet safety: the
inventory, safe diff evidence, and all exclusions still run. Path policy cannot
prove that every included file is appropriate to share, so review packet scope
when needed and keep `.codex/pro-reviews/` uncommitted unless evidence retention
is intentional. The local manifest may contain host provenance; only the
sanitized upload manifest is sent to ChatGPT.
