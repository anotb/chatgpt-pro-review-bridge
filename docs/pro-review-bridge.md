---
title: ChatGPT Pro Review Bridge
date: 2026-08-11
type: guide
status: prerelease
---

# ChatGPT Pro Review Bridge

The bridge lets any Codex host invoke the same installed workflow while a caller-defined repository question runs through the user's visible ChatGPT Chat session with the Pro setting strictly verified. The question may request a review, explanation, ideas, a design comparison, concrete code, or another grounded answer. Host model identity is never passed into target selection.

## Install a pinned release

```bash
codex plugin marketplace add anotb/chatgpt-pro-review-bridge --ref v0.6.0-alpha.10
codex plugin add chatgpt-pro-review@chatgpt-pro-review-bridge
```

Before the first file-backed review on each computer, sign into ChatGPT in the
visible browser and enable both upload gates:

1. Codex Settings > Computer Use > Google Chrome > Permissions > Uploads:
   allow `chatgpt.com` or choose **Always allow**.
2. Chrome `chrome://extensions` > Codex extension > Details: enable
   **Allow access to file URLs**.

The workflow fails closed before submission when either permission is absent.
The signed-in session and these local settings are not distributed by the
plugin.

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
codex plugin marketplace add anotb/chatgpt-pro-review-bridge --ref v0.6.0-alpha.10
codex plugin add chatgpt-pro-review@chatgpt-pro-review-bridge
```

Uninstall:

```bash
codex plugin remove chatgpt-pro-review@chatgpt-pro-review-bridge
codex plugin marketplace remove chatgpt-pro-review-bridge
```

Each computer must independently install the pinned tag, sign into ChatGPT visibly, initialize the compatible browser bridge, grant uploads/downloads when required, and run a harmless canary. Do not sync cookies, profiles, browser storage, auth headers, or tokens.

## Skill use

Ask:

```text
Use $chatgpt-pro-code-review to review this branch against main and return the complete Pro review and every artifact.
```

For a broader question, use `$chatgpt-pro-ask` and state the task normally. The bridge does not add exhaustive review dimensions or a required findings format unless the calling session requests them.

The skill calls:

```js
const result = await chatgpt.reviews.askPro({
  repositoryRoot: process.cwd(),
  baseRef: "origin/main",
  headRef: "HEAD",
  request: {
    additionalInstructions: "<faithful caller-defined question or task>"
  },
  target: { experience: "chat", intelligence: "Pro", strict: true },
  context: {
    mode: "review-packets",
    includeWorkingTree: true,
    includeInstructions: false,
    includeChangedFiles: true,
    includeRelevantCallers: false,
    includeRelatedTests: false,
    includeValidationOutput: true,
    onBudgetExceeded: "partition"
  },
  output: {
    mode: "full",
    archive: true,
    archiveRoot: ".codex/pro-reviews",
    downloadArtifacts: "all",
    returnFullMarkdown: true
  },
  safeguards: {
    submitOnce: true,
    verifyTargetBeforeSubmit: true,
    verifyTargetAfterCompletion: true,
    failOnFallback: true,
    restorePreviousConfiguration: false
  }
});
```

One invocation performs one bounded poll by default. If it returns `in_progress`, call the workflow again with `resume: { archiveDirectory }`; never resend the prompt. The immutable submission receipt holds the canonical `/c/<conversation-id>` URL and conversation ID. Optional caller-supplied `threadUrl` or `conversationId` values are treated only as mismatch-detecting cross-checks.

When a running request has genuinely become obsolete, the session may explicitly stop and replace it. Open and verify the archived thread, call `chatgpt.messages.stop({ confirmStop: true })`, preserve the old archive/partial answer, then start a fresh `reviews.askPro(...)` request from the revised state. The bridge never auto-stops or silently edits an existing prompt.

## Archive and trust boundary

The bridge keeps durable local state so a long answer can resume without duplicate submission. For packet-backed questions, that state includes the request, prompt, packets, complete response, artifacts, and enough receipt/configuration evidence to recover safely. Normal callers can simply use the answer; archive paths and hashes are primarily for recovery, diagnostics, or explicit provenance requests. `.codex/pro-reviews/` is gitignored here and should normally remain uncommitted.

Archive creation requests owner-only directory/file modes (`0700`/`0600`) and never overwrites immutable records. Windows does not implement POSIX modes as an ACL boundary, so use a user-private workspace or an explicitly private NTFS directory when review packets contain confidential source.

The workflow uses only visible browser controls. It does not call hidden ChatGPT endpoints, extract credentials, bypass login/CAPTCHA, scrape history in the background, rotate accounts, silently truncate output, or execute generated patches. Codex must independently verify material suggestions before edits.

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
