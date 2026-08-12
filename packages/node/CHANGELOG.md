# Changelog

## 0.6.0-beta.8

- Recovers archives whose previous bounded browser call was interrupted while
  creating its lease record.

## 0.6.0-beta.7

- Adds `thread` targeting for new AskPro questions so follow-ups retain strict
  Pro verification, exactly-once submission, and bounded resume behavior.

## 0.6.0-beta.6

- Adds visible-history recovery for provisional Chat conversation IDs.
- Makes archive leases resilient to process-ID reuse after bounded browser
  calls exit.
- Restores lexical containment checks before validation-path canonicalization.

## 0.6.0-beta.5

- Documents the distinction between one bounded poll invocation and the
  unbounded same-archive resume loop used for long Pro work.

## 0.6.0-beta.4

- Uses a 20-second default metadata wait so a bounded browser host can return
  and release its archive lease before the next resume call.

## 0.6.0-beta.3

- Recovers archive ownership when a bounded browser evaluator is still exiting
  at the start of the next resume call.

## 0.6.0-beta.2

- Handles platform path aliases before enforcing validation-output containment
  without following a symbolic-link leaf.
- Updates audited development-only transitive dependencies.

## 0.6.0-beta.1

- Promotes the context-free AskPro workflow after deterministic and live
  alpha qualification.
- Pins generated runtime line endings for Windows source-install parity.

## 0.6.0-alpha.14

- Supports repository-free Pro questions with exact prompt submission, no packet
  attachment step, and the same durable completion/resume workflow.
- Recovers an interrupted workflow when its recorded lease owner has exited.

## 0.6.0-alpha.13

- Tightens strict Pro verification and prompt-to-response ownership proof after
  incorporating the completed live Pro review's concrete findings.

## 0.6.0-alpha.12

- Compares prompt-identical visible user turns modulo whitespace layout so DOM
  line-break flattening does not prevent safe same-thread resume.

## 0.6.0-alpha.11

- Resumes a prompt-identical currently visible Chat conversation before history
  search, preserving the same-thread and no-resubmit guarantees.

## 0.6.0-alpha.10

- Routes provisional ambiguous receipts through visible history recovery before
  browser bootstrap while retaining the no-resubmit guarantee.

## 0.6.0-alpha.9

- Preserves the canonical post-submit Chat thread and makes ambiguous visible
  submission evidence explicitly resumable without allowing a resend.

## 0.6.0-alpha.8

- Fixes cross-platform npm launcher path resolution in the release gates.
- Removes heuristic packet-content scanning and structured-findings parsing,
  while making instruction, caller, and related-test expansion opt-in.

## 0.6.0-alpha.7

- Adds flexible `reviews.askPro`, rendered-prompt reconciliation, ambiguous
  receipt recovery without resubmission, Pro no-op selection, opt-in setting
  restoration, and explicitly confirmed `messages.stop` support.

## 0.6.0-alpha.6

- Hardens visible uploads, origin checks, packet provenance and secret
  exclusion, crash-safe exactly-once submission, archive-bound resume,
  concurrent archive leases, artifact identity, blocker scoping, and terminal
  provenance publication.

## 0.6.0-alpha.5

- Prevents untracked local `.codex/` archives and task state from recursively
  entering review packets, while retaining tracked `.codex/` repository files
  and explicit exclusion provenance.
- Uses the Chrome bridge's scoped CDP capability only to open Chat's hidden
  file input with a user gesture; the approved chooser remains responsible for
  transferring absolute local paths, including large review packets.
- Reports native-pipe disconnects and unavailable upload surfaces separately
  from explicit Chrome/Codex permission denials.

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
