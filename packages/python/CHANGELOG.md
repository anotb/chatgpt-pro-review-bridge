# Changelog

## 0.6.0b1

- Aligns the Python parity package with the first focused AskPro beta.

## 0.6.0a14

- Aligns the Python package with the context-free AskPro and stale-lease recovery
  release implemented by the shared Node backend.

## 0.6.0a13

- Aligns the Python package with the stricter Pro and prompt-ownership proof
  release implemented by the shared Node backend.

## 0.6.0a12

- Aligns the Python package with the whitespace-stable visible prompt resume
  release implemented by the shared Node backend.

## 0.6.0a11

- Aligns the Python package with the visible prompt-identical resume release;
  browser behavior remains implemented by the shared Node backend.

## 0.6.0a10

- Keeps the Python package version aligned with the provisional-thread recovery
  release; the browser workflow behavior is provided by the shared Node backend.

## 0.6.0a9

- Picks up canonical post-submit thread binding and resumable ambiguous-submit
  handling from the bundled Node backend.

## 0.6.0a8

- Picks up the simplified askPro packet policy and the cross-platform release
  preflight correction from the bundled Node backend.

## 0.6.0a7

- Exposes the explicitly confirmed `messages.stop` backend primitive and picks
  up the flexible visible-Pro workflow and duplicate-safe resume fixes.

## 0.6.0a6

- Picks up the hardened upload, packet, exactly-once resume, artifact, and
  archive behavior from the bundled Node backend without changing Python APIs.

## 0.6.0a5

- Picks up untracked local `.codex/` packet exclusion from the bundled Node
  backend without changing Python APIs.

## 0.6.0a4

- Picks up generated plugin-runtime packet exclusion from the bundled Node
  backend without changing Python APIs.

## 0.6.0a3

- Picks up current Chat slider, upload-palette, exact conversation targeting,
  archive-backed resume, one-read response capture, terminal restoration, and
  checkpointed artifact fixes from the bundled Node backend without changing
  Python APIs.

## 0.6.0a2

- Picks up corrected logged-out Chat shell classification from the bundled
  Node backend without changing the Python API or shared wire shapes.

## 0.6.0a1

- Qualifies the Python package against the fork's hardened visible-session
  backend and cross-platform release gates.
- Keeps the Python API unchanged; the new first-class Pro review orchestrator
  is currently provided by the Node SDK and Codex plugin.

## 0.5.1a1

- Picks up the corrected Node-backed Chat/Work radio selection and active Work
  detection without changing the Python API or shared wire shapes.
- Retains sync/async experience, configuration, Work, Runner, and Responses
  parity while the expanded cross-language and package-install gates qualify
  the replacement alpha.

## 0.5.0a1

- Adds matching sync and async `experience`, `configuration`, and `work` clients.
- Adds typed surface-profile, configuration, and Work lifecycle models.
- Recursively converts nested snake-case Python dictionaries to the shared camel-case backend wire shape.
- Preserves existing mode methods and package imports while adding runner/Responses support for Chat and Work preferences.

## 0.3.0a1

- Adds `chatgpt.modes.get()` to the sync and async facades, matching the new backend `modes.get` primitive.
- Adds a persistent-session mode to `NodeSidecarTransport` (context manager or `open()`/`close()`) so multi-command workflows reuse one backend process; transport failures close the session while protocol errors keep it open.
- Keeps parity with the Node backend's hardened mode selection and status-only wait polling.

## 0.2.0a1

- Adds Windows parity coverage for backend command splitting, subprocess handling, and integrity verification.
- Adds Python access to untrusted-output envelopes and integrity sidecar verification.
- Keeps the Python package aligned with the Node backend protocol used by the localized selector and diagnostics updates.

## 0.1.0a1

- Initial Python parity client metadata for the public source repo.
