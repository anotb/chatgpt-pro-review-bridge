---
title: ChatGPT Pro Review Bridge
date: 2026-08-13
type: guide
status: stable
---

# ChatGPT Pro Review Bridge

The bridge lets any Codex host invoke the same installed workflow while a caller-defined question runs through the user's visible ChatGPT Chat session with the Pro setting strictly verified. Questions can be context-free or intentionally backed by repository packets. Host model identity is never passed into target selection.

## Install a pinned release

```bash
codex plugin marketplace add anotb/chatgpt-pro-review-bridge --ref v0.7.14
codex plugin add chatgpt-pro-review@chatgpt-pro-review-bridge
```

Before the first file-backed review on each computer, sign into ChatGPT in the
visible browser and enable both upload gates:

1. Codex Settings > Computer Use > Google Chrome > Permissions > Uploads:
   allow `chatgpt.com` or choose **Always allow**.
2. Chrome `chrome://extensions` > Codex extension > Details: enable
   **Allow access to file URLs**.

The workflow stops before submission when either permission is absent.

Authentication preflight combines visible structural account, conversation
history, composer, and conversation evidence. An exact visible login control
outside message content still classifies the current shell as logged out, even
when generic navigation such as **New chat** or **Search chats** is present.
This avoids treating either one brittle selector or ordinary message text as an
authentication decision.

The current Chrome bridge opens Chat's hidden file input with an origin-scoped
browser user gesture and then uses the approved native file chooser. It does
not copy review-packet bytes through page scripts or call hidden ChatGPT
endpoints. Upload-surface failures remain distinct from permission denials and
always stop before prompt submission.

Start a new Codex task so skill metadata reloads. A marketplace pinned with
`--ref` remains pinned when refreshed. To move it to a newer immutable tag,
remove the installed plugin and marketplace snapshot, then add the new tag:

```bash
codex plugin remove chatgpt-pro-review@chatgpt-pro-review-bridge
codex plugin marketplace remove chatgpt-pro-review-bridge
codex plugin marketplace add anotb/chatgpt-pro-review-bridge --ref v0.7.14
codex plugin add chatgpt-pro-review@chatgpt-pro-review-bridge
```

Uninstall:

```bash
codex plugin remove chatgpt-pro-review@chatgpt-pro-review-bridge
codex plugin marketplace remove chatgpt-pro-review-bridge
```

On each computer, install the pinned tag, sign into ChatGPT in the visible browser, and grant uploads/downloads when required.

## Skill use

Ask:

```text
Use $chatgpt-pro-code-review to review this branch against main and return the complete Pro review and every artifact.
```

For a broader question, use `$chatgpt-pro-ask` and state the task normally. The calling session decides what to ask and what context to include.

The skill calls:

```js
const result = await chatgpt.reviews.askPro({
  request: {
    additionalInstructions: "<faithful caller-defined question or task>"
  },
  target: { experience: "chat", intelligence: "Pro" },
  output: {
    mode: "full",
    archive: true,
    archiveRoot: ".codex/pro-reviews",
    downloadArtifacts: "all",
    returnFullMarkdown: true
  },
  safeguards: {
    restorePreviousConfiguration: false
  },
  polling: {
    callTimeoutMs: 20000,
    maxPollCallsPerInvocation: 1
  }
});
```

That form sends the caller's question as the visible user turn, performs no Git commands, and uploads nothing. Submit-once behavior, strict pre/post Pro verification, and fallback rejection are invariants rather than optional switches; only prior-configuration restoration is caller-selectable. Add repository evidence in one of two explicit scopes:

- Change review: add `repositoryRoot`, `baseRef`, optional `headRef`, and `context: { mode: "review-packets", scope: "changes", ... }`.
- Full repository: add `repositoryRoot` and `context: { mode: "review-packets", scope: "repository", ... }`, and omit `baseRef`.

When `repositoryRoot` is present and `baseRef` is omitted, repository scope is inferred. It uses Git's empty tree internally as a diff baseline without requiring callers to invent an unattached commit. A committed repository defaults to a commit-only snapshot, so local edits and untracked filenames are not uploaded accidentally. Set `includeWorkingTree: true` when the caller wants that overlay. A repository with no commits is supported directly and defaults to including its index and working tree.

One invocation performs one bounded poll by default. If it returns `in_progress`, resume the same archive without manually sending its prompt. Give a fresh file-backed browser-host call a separate 5–10 minute outer envelope; `callTimeoutMs` controls only each post-submit metadata poll.

The calling agent owns the post-submit cadence in prose: 30 seconds, 60 seconds, 2 minutes, 4 minutes, then no more than once every 5 minutes while generation continues. Wait outside browser-host calls; the SDK imposes no sleep. A tab handoff does not count as a polling result and needs no artificial delay.

`existing_tab_handoff_completed` is a task-turn boundary: handoff must be the final browser action. End the turn, then resume the same archive from a later turn with a fresh browser-host invocation; never reuse the old client or submit in the handoff turn.

Use durable archive phase—not `submitted: false` alone—to decide what a resume may do. A validated `pre-submit-checkpoint.json` with no intent or receipt may continue to the first and only submit. A `submission-intent.json` means submission may already have been attempted, so reconcile but never submit again; a receipt only polls and captures the existing response. Every phase keeps `resubmitAllowed: false`. The receipt holds the canonical conversation URL and ID; caller-supplied values are mismatch-only cross-checks.

Within each invocation, the workflow remains bound to the same visible browser
tab and canonical conversation before attachment and submission and during
every poll, final prompt/response read, post-completion Pro verification, and
artifact operation. A conflicting known tab or conversation returns a
structured affinity blocker; missing tab metadata alone does not imply drift.
Pre-submit drift is non-resumable and requires a fresh request. Post-submit
drift is resumable from the same archive and never permits resubmission.

A provisional `WEB:` receipt is not treated as an immutable canonical route.
Resume first claims an exact already-open tab when possible, then searches
visible history for the exact archived prompt. It adopts a canonical
conversation only when the proof is unique. If repeated identical prompts
produce multiple exact candidates, the archived tab ID may select one stable
candidate; otherwise `review_thread_recovery_ambiguous` stops without choosing
or creating another conversation.

When a running request has genuinely become obsolete, the session may explicitly stop and replace it. Open and verify the archived thread, call `chatgpt.messages.stop({ confirmStop: true })`, preserve the old archive/partial answer, then start a fresh `reviews.askPro(...)` request from the revised state. The bridge never auto-stops or silently edits an existing prompt.

## Archive and trust boundary

The bridge keeps durable local state so a long answer can resume without duplicate submission. For packet-backed questions, that state includes the request, prompt, packets, complete response, artifacts, and enough receipt/configuration evidence to recover safely. Submission receipts bind the prompt, local and upload manifests, every packet, the configuration snapshot, artifact baseline, canonical conversation, and stable tab metadata when available. A non-resumable fallback or verification failure is recorded as a terminal outcome and cannot later be upgraded by resuming the archive. Normal callers can simply use the answer; archive paths and hashes are primarily for recovery, diagnostics, or explicit provenance requests. `.codex/pro-reviews/` is gitignored here and should normally remain uncommitted.

Terminal provenance is an ordered commit: `configuration.json`,
`run-report.redacted.json`, and `receipt.json` are written first. For a
non-resumable blocker, `terminal-outcome.json` is then published last. If the
provenance commit fails, the workflow returns non-resumable
`archive_terminal_commit_failed` and writes an authoritative
`archive-commit-failure.json` marker when the filesystem still permits it.
Future resume validates the immutable prompt, configuration, packet, and
submission bindings before treating that marker as authoritative, without
contacting the browser. If the filesystem refuses the failure marker too, the
returned warning makes that loss of durable authority explicit.

The local `context/manifest.json` retains host provenance. ChatGPT receives `context/manifest.upload.json`, which removes the absolute repository path and suppresses sensitive excluded filenames. Packet text is explicitly marked as untrusted repository evidence. Repository-root credential/secret stores, provider/browser store ancestry, hard secret filenames, committed symlinks/gitlinks, generated content, binary files, and oversized sources are excluded consistently from source snapshots, path listings, and diffs. Ordinary nested application source and test fixtures under names such as `src/credentials/`, `packages/service/secrets/`, and `tests/fixtures/auth.json` are not excluded by directory name alone; store ancestry and hard filename rules still take precedence over fixture-looking suffixes. Setting `includeChangedFiles: false` omits changed-file source snapshots; it does not bypass the safety inventory, safe diff evidence, or any exclusion.

Archive creation requests owner-only directory/file modes (`0700`/`0600`) and never overwrites immutable records. Windows does not implement POSIX modes as an ACL boundary, so use a user-private workspace or an explicitly private NTFS directory when review packets contain confidential source.

The workflow uses visible browser controls and leaves any generated changes for the calling Codex task to evaluate.

## Opt-in installed-runtime canary

From the browser-enabled persistent JavaScript host, import the installed plugin's `runtime/node/chatgpt-pro-review-canary.bundle.mjs` and call:

```js
let canary = await module.runProReviewCanaryStep(globalThis, {
  reportDir: "/absolute/local/report/directory"
});

// Repeat in a later bounded host call while in progress:
if (canary.status === "in_progress") {
  canary = await module.runProReviewCanaryStep(globalThis, {
    reportDir: "/absolute/local/report/directory",
    resume: canary.resume
  });
}
```

The optional canary uses a harmless synthetic Git repository. It verifies byte-for-byte full-response/archive agreement, one visible user prompt, Pro before/after evidence, and restoration without asking Pro to echo a magic marker or create a throwaway artifact. Prefer a substantive repository review for release qualification. Exercise artifact transport separately with the fast Chat setting unless the real review naturally creates artifacts. Diagnostics are redacted; raw review archives remain local.

## Platform status

Deterministic CI targets Windows, macOS, and Linux. Live qualification requires a supported visible Codex/browser host and is reported per operating system; deterministic support is not presented as live browser qualification.
