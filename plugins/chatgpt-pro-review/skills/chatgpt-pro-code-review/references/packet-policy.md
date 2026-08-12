# Packet and sensitivity policy

For change scope, the packet builder mechanically records refs, resolved SHAs, merge base, status, rename-aware name status, a context-rich diff, changed text snapshots, governing `AGENTS.md`, related manifests/tests, deterministic symbol references, caller-supplied validation output, exclusions, partitions, and SHA-256 hashes.

For repository scope, it records the complete committed snapshot plus the approved working-tree overlay. The canonical empty Git tree is used internally as a diff baseline, not misrepresented as a commit. Repositories with no commits are supported directly when the working tree is included; untracked files appear as line-numbered source snapshots and explicit status entries.

It never asks the host model to paraphrase the repository. Oversized input is partitioned or blocked; it is not silently clipped.

Known credential paths, private-key files, credential stores, browser profiles, token caches, generated trees, binary files, symlinks, and oversized files are excluded and recorded. Content classification remains the caller's responsibility; keep unexpectedly sensitive files out of the requested context.

Raw archives may contain source, prompts, and the complete response. Recommend adding `.codex/pro-reviews/` to `.gitignore` unless the repository intentionally commits review evidence. Never commit private live transcripts or unredacted diagnostic reports by default.
