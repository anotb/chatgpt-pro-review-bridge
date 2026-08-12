# Changelog

## 0.6.0-alpha.7

- Adds caller-directed `$chatgpt-pro-ask` delegation without imposed review
  categories, output schemas, patch restrictions, or repository-warning prose.
- Reconciles prompts rendered with visible attachment labels and resumes an
  ambiguous submitted receipt without attaching, composing, or submitting again.
- Leaves Chat on Pro by default and avoids touching its control when Pro is
  already strictly verified; restoration remains an explicit opt-in.
- Adds an explicitly confirmed `messages.stop` primitive for safely replacing
  a genuinely obsolete visible response while preserving the original run.

## 0.6.0-alpha.6

- Fails closed around file transfer: no page-script byte injection, immediate
  abort on explicit denial or bridge disconnect, composer-scoped attachment
  evidence, and parsed ChatGPT-origin allowlisting.
- Binds packet evidence to the requested Git commit, excludes secret/archive
  paths from every evidence channel, rescans serialized packets, checks Git
  failures, and enforces final byte budgets without silent truncation.
- Adds durable pre-submit intent, exact visible-turn confirmation, crash
  reconciliation without resubmission, immutable resume binding, archive
  leases, strict configuration restoration evidence, and required terminal
  provenance commits.
- Stabilizes image artifact identity and download indexing, narrows blocker
  detection to system UI, and requests private archive permissions.

## 0.6.0-alpha.5

- Excludes untracked local `.codex/` state from review packet paths, source
  snapshots, and working-tree evidence while recording each exclusion in the
  manifest. Tracked repository `.codex/` changes remain reviewable.
- Opens Chat's hidden file input through the Chrome bridge's origin-scoped CDP
  user gesture, then hands absolute paths to the approved native file chooser.
  This supports multi-megabyte review packets without copying their bytes
  through the browser-control transport.
- Separates browser disconnects and incompatible upload surfaces from genuine
  upload-permission denials while keeping every attachment failure pre-submit.

## 0.6.0-alpha.4

- Records deterministic plugin runtime bundles in packet provenance while
  excluding their generated contents from source snapshots and unified diffs.
  The source and bundle-parity gate remain authoritative, avoiding multi-megabyte
  duplicate review context without silent truncation.
- Promotes both per-machine browser upload permission gates into pinned-install
  onboarding and the Pro review skill's mandatory preflight.

## 0.6.0-alpha.3

- Supports the current compact Chat power slider and Advanced effort picker
  while still requiring an exact visible Pro postcondition.
- Targets the current focusable `Add photos & files` command-palette row and
  settles early file-chooser rejection paths without terminating the host.
- Makes the immutable archive receipt authoritative for resume, reconciles a
  provisional `WEB:` conversation to its stable visible Chat ID, and rejects
  mismatched caller-supplied targets without resubmitting.
- Reads and archives the full Markdown once, reuses its verified hash on later
  polls, leaves Pro active while a response is still generating, and restores
  the prior setting only after a terminal outcome.
- Preserves every new artifact with per-file hashes and crash-safe checkpoints,
  including Chat's download-prefixed workbook controls, without duplicating
  already archived files on repeated resumes.
- Reuses already-controlled Chat tabs before external claims and verifies that
  direct navigation reached the exact requested conversation.
- Removes marker-echo and throwaway-artifact requirements from the optional
  Pro canary in favor of byte-for-byte archive agreement and visible turn count.

## 0.6.0-alpha.2

- Correctly classifies the current logged-out Chat shell even though it exposes
  generic `New chat` and `Search chats` navigation, so review preflight returns
  `login_required` before configuration inspection or submission.

## 0.6.0-alpha.1

- Adds the separate `chatgpt-pro-review` marketplace plugin and `chatgpt-pro-code-review` Agent Skill with bundled runtime files.
- Adds `chatgpt.reviews.codeReview(...)`: deterministic Git evidence packets, exclusions and secret scanning, coherent partitioning, strict visible Chat/Pro verification, exactly-once submission, bounded resume polling, complete Markdown capture, and provenance archives.
- Adds configuration snapshot/restore, specific Pro unavailability/fallback blockers, artifact baseline/delta attribution, selected-image downloads, collision-safe artifact preservation, hashing, and raw-first findings appendix parsing.
- Adds an opt-in installed-runtime canary and host orchestration qualification path; generated patches and scripts remain untrusted and are never executed automatically.
- Fixes Windows Node 24 npm launcher handling across deterministic release gates.

## 0.5.1-alpha.1

- Fixes current Chat/Work pane switching by selecting the visible
  `Select chat surface` radios while retaining legacy button, menu-item, tab,
  link, and bounded DOM fallbacks.
- Correctly detects the checked Work pane and active Work tasks whose home
  surface radio is no longer visible.
- Expands reusable live qualification to cover explicit Chat/Work round trips,
  strict no-op configuration verification, the complete Work lifecycle,
  Work-backed Runner and Responses calls, artifact enumeration, and safe Chat
  restoration.
- Upgrades all bundled skills and plugin packaging validation, and adds an
  opt-in Work configuration mutation test that restores the original setting.

## 0.5.0-alpha.1

- Adds first-class Chat/Work experience detection and verified surface switching.
- Adds surface-aware `configuration.inspect` and strict `configuration.apply` for Chat intelligence/model controls and Work model/effort/speed axes.
- Adds submit-once Work lifecycle commands for start, status, wait, steering, response capture, and artifact access.
- Adds sanitized legacy Chat, simplified Chat, Work basic, Work advanced, and sidebar false-positive profile fixtures to the shared Node/Python conformance suite.
- Adds sync and async Python parity, recursive snake-case wire conversion, runner/Responses support, and Work artifact aliases.
- Rebrands the plugin promise to ChatGPT Surface Control and adds `chatgpt-delegate`; package coordinates, legacy mode APIs, and `chatgpt-pro-consult` remain compatible.

## 0.3.0-alpha.1

- Hardens visible mode selection against thread/sidebar action menus: short mode words such as `Pro` no longer match inside pinned-thread titles, localized thread-action labels and `Pin`/`Unpin` prefixes are rejected, and menu enumeration is scoped to open menu containers.
- Adds `modes.get` for reading the visible mode labels without changing them, plus post-selection verification warnings on `modes.set` when the composer does not visibly reflect the requested mode.
- Rewrites `messages.wait` polling around one combined DOM snapshot per poll with length/hash change detection; the full answer crosses the browser bridge once at completion instead of on every poll.
- Adds a persistent-session mode to the Python `NodeSidecarTransport` (context manager or `open()`/`close()`) so multi-command workflows reuse one backend process.
- Adds Windows and Linux clipboard capture (PowerShell `Get-Clipboard`, `xclip`/`xsel`/`wl-paste`) with the existing DOM fallback.
- Fixes report `createdAt` to honor the injected clock so regenerated contract fixtures are deterministic.

## 0.2.0-alpha.1

- Adds cross-platform Windows and macOS path handling, subprocess gates, and public CI coverage.
- Adds broader localized ChatGPT label detection through the shared locale registry.
- Adds untrusted-output envelopes, integrity sidecars, and expanded diagnostics contracts.

## 0.1.0-alpha.1

- Initial public source preparation for `codex-chatgpt-control`.
- Includes the TypeScript visible-session runtime, backend protocol fixtures, and Python parity client.
- Registry publication is intentionally deferred until package allowlists and install smokes pass.
