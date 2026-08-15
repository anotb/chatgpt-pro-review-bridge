# Troubleshooting

## Browser or tab unavailable

Initialize a compatible browser host, or pass an exact page/browser. If several controlled ChatGPT tabs exist, pass the intended page; the bridge will not guess.

## Login or challenge

Sign in or complete the visible challenge manually, then retry the same pre-submit operation ID. Do not provide cookies or tokens to the bridge.

## Target unavailable

Call `inspectTargets()` and use one exact returned `power` label. The adapter reads the English Power slider's current ARIA range instead of assuming labels or a position count. Use browser/computer interaction to inspect a changed UI rather than inventing a fuzzy label.

## Tool unverified

Use the exact visible tool label. Selection succeeds only when that label appears exactly as an active composer button or inline tool pill.

## File upload does not become ready

The selected host must expose the tab-scoped `cdp` capability and exactly one composer `#upload-files` input. The bridge reads every explicit file, transfers the complete ordered list in one background action, and never clicks an upload control or opens a native picker. Every path must be absolute, readable, and regular; multi-file support and every new ready basename are verified before Send.

`upload_path_unavailable` means the background path was unavailable before action. `file_handoff_uncertain` means the one background transfer lacked an exact postcondition. `upload_readiness_uncertain` means the visible attachment cards did not all become ready.

Deterministic local checks run before the write-ahead attempt. Once file handoff begins, reusing the operation ID returns that record and does not repeat an ambiguous transfer. Preparation blockers have `resumable: false`: inspect the exact tab and stop. Start a deliberate new operation only after exact diagnosis confirms that neither Send nor file landing occurred and the cause is fixed.

## `uncertain` after Send

Do not resend. The click may have acted even if the browser host reported an error. Inspect the exact tab and call `collect` with the returned handle. If a stable operation ID was used and the caller lost the result, call `submit` again with the identical request to recover the durable handle without another activation.

## Markdown falls back to DOM text

The owned Copy action or clipboard read was unavailable. `output.fidelity` reports `dom_text`; no output is silently labelled exact Markdown.

## Artifact visible but not downloaded

Downloads require an exact assistant-owned control or structurally identified visible image source plus host download capability. Inspect each artifact's `transfer`: `downloaded`, `not_requested`, or `failed` with `artifact_preview_timeout`, `artifact_download_unavailable`, or `artifact_transfer_failed`. The bridge will not use a page-wide or “latest artifact” fallback.
