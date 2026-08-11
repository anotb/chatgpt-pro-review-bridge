# Packet and sensitivity policy

The packet builder mechanically records refs, resolved SHAs, merge base, status, rename-aware name status, a context-rich diff, changed text snapshots, governing `AGENTS.md`, related manifests/tests, deterministic symbol references, caller-supplied validation output, exclusions, partitions, and SHA-256 hashes.

It never asks the host model to paraphrase the repository. Oversized input is partitioned or blocked; it is not silently clipped.

Known secret paths, private keys, credential stores, browser profiles, token caches, generated trees, binary files, symlinks, and oversized files are excluded and recorded. Text and diff evidence are scanned for high-confidence secret forms. Default `secretPolicy: "block"` stops before browser submission. Use `"redact"` only after explicit approval and after reviewing the exclusion manifest; pattern scanning cannot prove that material is safe.

Raw archives may contain source, prompts, and the complete response. Recommend adding `.codex/pro-reviews/` to `.gitignore` unless the repository intentionally commits review evidence. Never commit private live transcripts or unredacted diagnostic reports by default.
