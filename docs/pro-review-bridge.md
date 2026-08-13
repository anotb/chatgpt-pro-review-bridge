---
title: ChatGPT Pro Review Bridge
date: 2026-08-11
type: guide
status: stable
---

# ChatGPT Pro Review Bridge

The bridge lets any Codex host invoke the same installed workflow while a caller-defined question runs through the user's visible ChatGPT Chat session with the Pro setting strictly verified. Questions can be context-free or intentionally backed by repository packets. Host model identity is never passed into target selection.

## Install a pinned release

```bash
codex plugin marketplace add anotb/chatgpt-pro-review-bridge --ref v0.7.2
codex plugin add chatgpt-pro-review@chatgpt-pro-review-bridge
```

Before the first file-backed review on each computer, sign into ChatGPT in the
visible browser and enable both upload gates:

1. Codex Settings > Computer Use > Google Chrome > Permissions > Uploads:
   allow `chatgpt.com` or choose **Always allow**.
2. Chrome `chrome://extensions` > Codex extension > Details: enable
   **Allow access to file URLs**.

The workflow stops before submission when either permission is absent.

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
codex plugin marketplace add anotb/chatgpt-pro-review-bridge --ref v0.7.2
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
    totalTimeoutMs: 1800000,
    maxPollCallsPerInvocation: 1
  }
});
```

That form sends the caller's question as the visible user turn, performs no Git commands, and uploads nothing. Submit-once behavior, strict pre/post Pro verification, and fallback rejection are invariants rather than optional switches; only prior-configuration restoration is caller-selectable. Add repository evidence in one of two explicit scopes:

- Change review: add `repositoryRoot`, `baseRef`, optional `headRef`, and `context: { mode: "review-packets", scope: "changes", ... }`.
- Full repository: add `repositoryRoot` and `context: { mode: "review-packets", scope: "repository", ... }`, and omit `baseRef`.

When `repositoryRoot` is present and `baseRef` is omitted, repository scope is inferred. It uses Git's empty tree internally as a diff baseline without requiring callers to invent an unattached commit. A committed repository defaults to a commit-only snapshot, so local edits and untracked filenames are not uploaded accidentally. Set `includeWorkingTree: true` when the caller wants that overlay. A repository with no commits is supported directly and defaults to including its index and working tree.

One invocation performs one bounded poll by default. If it returns `in_progress`, call the workflow again with `resume: { archiveDirectory }`; never resend the prompt. The calling agent waits 30 seconds before the first resume, then 60 seconds, 2 minutes, and 4 minutes, and thereafter resumes no more often than every 5 minutes. The delay happens outside browser-host calls. Pro can run for minutes or more than an hour, and `totalTimeoutMs` limits one invocation rather than the repeated resume loop. The immutable submission receipt holds the canonical `/c/<conversation-id>` URL and conversation ID. Optional caller-supplied `threadUrl` or `conversationId` values are treated only as mismatch-detecting cross-checks.

When a running request has genuinely become obsolete, the session may explicitly stop and replace it. Open and verify the archived thread, call `chatgpt.messages.stop({ confirmStop: true })`, preserve the old archive/partial answer, then start a fresh `reviews.askPro(...)` request from the revised state. The bridge never auto-stops or silently edits an existing prompt.

## Archive and trust boundary

The bridge keeps durable local state so a long answer can resume without duplicate submission. For packet-backed questions, that state includes the request, prompt, packets, complete response, artifacts, and enough receipt/configuration evidence to recover safely. Submission receipts bind the prompt, local and upload manifests, every packet, the configuration snapshot, and the artifact baseline. A non-resumable fallback or verification failure is recorded as a terminal outcome and cannot later be upgraded by resuming the archive. Normal callers can simply use the answer; archive paths and hashes are primarily for recovery, diagnostics, or explicit provenance requests. `.codex/pro-reviews/` is gitignored here and should normally remain uncommitted.

The local `context/manifest.json` retains host provenance. ChatGPT receives `context/manifest.upload.json`, which removes the absolute repository path and suppresses sensitive excluded filenames. Packet text is explicitly marked as untrusted repository evidence. Credential-store paths, committed symlinks/gitlinks, generated content, binary files, and oversized sources are excluded consistently from source snapshots, path listings, and diffs.

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
