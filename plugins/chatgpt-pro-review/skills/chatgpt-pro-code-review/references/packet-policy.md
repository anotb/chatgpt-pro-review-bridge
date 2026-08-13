# Packet and sensitivity policy

For change scope, the packet builder mechanically records refs, resolved SHAs, merge base, status, rename-aware name status, a context-rich diff, changed text snapshots, governing `AGENTS.md`, related manifests/tests, deterministic symbol references, caller-supplied validation output, exclusions, partitions, and SHA-256 hashes.

For repository scope, it records the complete committed snapshot plus an explicitly requested working-tree overlay. A committed repository defaults to commit-only evidence, so local edits and untracked filenames are not disclosed merely because `repositoryRoot` was supplied. The canonical empty Git tree is used internally as a diff baseline, not misrepresented as a commit. Repositories with no commits are supported directly and default to their index and working tree; untracked files appear as line-numbered source snapshots and explicit status entries.

It never asks the host model to paraphrase the repository. Oversized input is partitioned or blocked; it is not silently clipped.

Known credential paths, private-key files, credential stores, browser profiles, token caches, generated trees, binary files, committed symlinks/gitlinks, and oversized files are excluded consistently from source snapshots, status/path evidence, and diffs. Ordinary source names such as `tokens.ts` remain reviewable. Git path collection is NUL-delimited, and Markdown fences are balanced when packets split. Content classification remains the caller's responsibility; keep unexpectedly sensitive files out of the requested context.

The local `context/manifest.json` retains the canonical repository path for recovery. Only `context/manifest.upload.json` is attached; it uses the repository basename and suppresses excluded credential/local-state filenames. Repository contents are labeled as untrusted evidence in the submitted prompt and never override the caller's request.

Raw archives may contain source, prompts, and the complete response. Recommend adding `.codex/pro-reviews/` to `.gitignore` unless the repository intentionally commits review evidence. Never commit private live transcripts or unredacted diagnostic reports by default.
