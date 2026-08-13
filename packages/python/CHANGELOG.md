# Changelog

## 0.7.10

- Aligns with the shared backend's restricted-host-safe Windows PID probe.
- Aligns the parity package with the shared backend's bounded no-heartbeat
  fallback for already-submitted reviews with unknown process liveness and
  generation-safe lease cleanup.

## 0.7.9

- Aligns the parity package with the shared backend's conservative Windows
  dead-owner lease recovery: only an exact missing PID unlocks the archive.

## 0.7.8

- Aligns the parity package with the shared backend's soft preferred-tab
  recovery while preserving duplicate-safe exact conversation resumes.

## 0.7.7

- Aligns the parity package with the shared backend's canonical AskPro resume,
  authenticated-page detection, and duplicate-tab prevention fixes.

## 0.7.6

- Aligns the parity package version with the corrected gated release path.

## 0.7.5

- Aligns the parity package version with the shared backend fixes and verifies
  both the exact wheel and sdist assembled for the release.

## 0.7.4

- Aligns the parity package version with the shared backend's faster committed
  full-repository packet construction.

## 0.7.3

- Aligns the parity package version with the shared backend fix that maps
  actively generating partial Pro responses to resumable `in_progress`.

## 0.7.2

- Aligns the parity package with the shared Node backend/runtime release and
  clarifies that first-class review packet orchestration remains Node/plugin
  functionality rather than a divergent Python browser implementation.

## 0.7.1

- Aligns the parity client with stable completed-archive artifact recovery in
  the shared backend.

## 0.7.0

- Publishes the stable Python distribution as `chatgpt-pro-review-bridge` while
  retaining the `codex_chatgpt_control` import namespace.
- Aligns the parity client with the stable shared backend and wire contracts.

## 0.6.0b9

- Aligns the Python parity package with the current Chat generation-control
  detection fix in the shared backend.

## 0.6.0b8

- Aligns the Python parity package with stale incomplete-lease recovery in the
  shared backend.

## 0.6.0b7

- Aligns the Python parity package with existing-thread AskPro follow-ups in the
  shared backend.

## 0.6.0b6

- Aligns the Python parity package with visible-history recovery, resilient
  leases, and validation-path containment fixes in the shared backend.

## 0.6.0b5

- Aligns the Python parity package with the long-running resume documentation.

## 0.6.0b4

- Aligns the Python parity package with the host-safe default polling release.

## 0.6.0b3

- Aligns the Python parity package with the bounded-poll lease recovery release.

## 0.6.0b2

- Aligns the Python parity package with the cross-platform beta.2 release.

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
