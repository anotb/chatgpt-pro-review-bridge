# Changelog

## 0.6.0-alpha.4

- Treats `plugins/*/runtime/node/*.mjs` as deterministic generated artifacts:
  they remain listed in the review manifest but are excluded from packet source
  snapshots and diffs in favor of the source plus bundle-parity evidence.

## 0.6.0-alpha.3

- Adds strictly verified selection through the current five-position Chat
  power slider, with the current Advanced effort picker as a fallback.
- Updates file attachment for Chat's focusable upload command-palette row and
  handles early chooser timeouts without unhandled rejections.
- Makes archived submission evidence authoritative for bounded resume and
  checkpoints the stable conversation ID recovered from visible Chat history.
- Keeps Pro active across `in_progress` results, reads full Markdown once, and
  restores the prior visible setting only for terminal results.
- Normalizes current download-prefixed artifact controls, supports workbook
  previews, and checkpoints each verified artifact for duplicate-free resume.
- Makes immutable archive writes idempotent for equal content while rejecting
  changed content, and prefers controlled tabs before external tab claims.
- Replaces canary marker and synthetic-artifact checks with full-response hash
  agreement and exactly-one-visible-user-turn verification.

## 0.6.0-alpha.2

- Fixes logged-out shell detection so visible login walls fail closed as
  `login_required` instead of being masked by generic navigation markers.

## 0.6.0-alpha.1

- Adds the resumable, exactly-once `chatgpt.reviews.codeReview` workflow with
  deterministic review packets, strict visible Chat Pro verification, full
  Markdown capture, provenance archives, and verified setting restoration.
- Adds visible artifact baselines, complete delta downloads (including
  duplicate same-name files), collision-safe archive names, and SHA-256
  manifests.
- Adds portable plugin packaging and a bounded live canary while preserving the
  visible-session boundary and fail-closed model/fallback behavior.

## 0.5.1-alpha.1

- Fixes current Chat/Work switching through the visible surface-radio group and
  preserves older selector fallbacks.
- Correctly identifies checked Work home state, active Work tasks, and the
  current compound Work configuration opener.
- Adds reusable live-smoke coverage for Chat/Work routing, strict configuration
  verification, Work start/status/wait/read/steer/artifacts, and Work-backed
  Runner and Responses paths.

## 0.5.0-alpha.1

- Adds `experience.detect/open`, `configuration.inspect/apply`, and the Work task lifecycle command group.
- Adds scoped Chat/Work selector profiles, strict configuration postcondition verification, and sanitized profile fixtures.
- Adds runner/Responses experience and configuration inputs plus milestone events.
- Preserves existing `mode`, `modes.set/get`, commands, package imports, and wire fields for backward compatibility.

## 0.3.0-alpha.1

- Hardens mode-menu detection and selection against thread/sidebar action menus, with locale-registry-backed thread-action vetoes and container-scoped menu enumeration.
- Adds the `modes.get` primitive and post-selection verification warnings on `modes.set`.
- Rewrites wait polling around a single combined DOM snapshot per poll; response text is fetched once at completion instead of every poll.
- Adds Windows and Linux clipboard capture with DOM fallback.
- Fixes report `createdAt` to honor the injected clock for deterministic fixtures.

## 0.2.0-alpha.1

- Adds Windows-safe host path validation and cross-platform backend gates.
- Adds localized ChatGPT selector support through the locale-label registry.
- Adds untrusted-output safety envelopes and integrity sidecar verification helpers.

## 0.1.0-alpha.1

- Initial public alpha package metadata and source layout.
