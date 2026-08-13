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
├── response.md
├── terminal-outcome.json (non-resumable blockers only)
├── artifacts/manifest.json
├── configuration.json
├── receipt.json
└── run-report.redacted.json
```
