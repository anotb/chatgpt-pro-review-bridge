# Output and artifacts

Default `full` mode returns the complete final Markdown and saves the identical bytes to `response.md`. Do not summarize, trim, or repeatedly stream the growing response.

Use explicit `indexed` mode only when the caller requests it. An explicitly configured hard transport limit returns a section index and exact archive path while preserving the complete source. The workflow reports the limit; it never silently switches modes.

Artifact attribution uses a pre-submit visible inventory and post-completion multiset delta. Each new visible file or image is downloaded separately, assigned a traversal-safe collision-resistant name, hashed, and recorded in `artifacts/manifest.json`. Older thread artifacts are excluded. The current Codex session decides how to verify and use generated files.

Archive layout:

```text
.codex/pro-reviews/<timestamp>-<head>/
├── request.md
├── prompt.md
├── configuration.before.json
├── submission-intent.json
├── submission.json
├── context/manifest.json
├── context/manifest.upload.json
├── context/packet-*.md
├── thread-checkpoint.json (current conversation and opaque tab recovery hint)
├── response.md
├── terminal-outcome.json (non-resumable blockers; published last)
├── archive-commit-failure.json (only when terminal provenance cannot commit)
├── artifacts/manifest.json
├── configuration.json
├── receipt.json
└── run-report.redacted.json
```

Treat terminal provenance as an ordered commit. The workflow writes
`configuration.json`, `run-report.redacted.json`, and `receipt.json` first, then
publishes immutable `terminal-outcome.json` for a non-resumable blocker. If a
late provenance write fails, it records non-resumable
`archive_terminal_commit_failed` in
`archive-commit-failure.json` when the filesystem permits. Future resume first
validates the immutable archive bindings, then treats that failure marker as
authoritative without contacting the browser.
