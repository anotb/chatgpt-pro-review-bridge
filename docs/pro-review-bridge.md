---
title: ChatGPT Pro Review Bridge
date: 2026-08-11
type: guide
status: prerelease
---

# ChatGPT Pro Review Bridge

The bridge lets any Codex host invoke the same installed workflow while the delegated review runs through the user's visible ChatGPT Chat session with the Pro setting strictly verified. Host model identity is never passed into target selection.

## Install a pinned release

```bash
codex plugin marketplace add anotb/chatgpt-pro-review-bridge --ref v0.6.0-alpha.3
codex plugin add chatgpt-pro-review@chatgpt-pro-review-bridge
```

Start a new Codex task so skill metadata reloads. A marketplace pinned with
`--ref` remains pinned when refreshed. To move it to a newer immutable tag,
remove the installed plugin and marketplace snapshot, then add the new tag:

```bash
codex plugin remove chatgpt-pro-review@chatgpt-pro-review-bridge
codex plugin marketplace remove chatgpt-pro-review-bridge
codex plugin marketplace add anotb/chatgpt-pro-review-bridge --ref v0.6.0-alpha.3
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

The skill calls:

```js
const result = await chatgpt.reviews.codeReview({
  repositoryRoot: process.cwd(),
  baseRef: "origin/main",
  headRef: "HEAD",
  request: {
    focus: ["correctness", "security", "concurrency", "compatibility", "tests"]
  },
  target: { experience: "chat", intelligence: "Pro", strict: true },
  context: {
    mode: "review-packets",
    includeWorkingTree: true,
    includeInstructions: true,
    includeChangedFiles: true,
    includeRelevantCallers: true,
    includeRelatedTests: true,
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
    restorePreviousConfiguration: true,
    scanPacketsForSecrets: true
  }
});
```

One invocation performs one bounded poll by default. If it returns `in_progress`, call the workflow again with `resume: { archiveDirectory }`; never resend the prompt. The immutable submission receipt holds the canonical `/c/<conversation-id>` URL and conversation ID. Optional caller-supplied `threadUrl` or `conversationId` values are treated only as mismatch-detecting cross-checks.

## Archive and trust boundary

The default archive contains the request, prompt, deterministic packets, manifest and hashes, complete response, optional parsed findings, every new downloaded artifact and hash, configuration evidence, receipt, and a redacted run report. `.codex/pro-reviews/` is gitignored here and should normally remain uncommitted.

The workflow uses only visible browser controls. It does not call hidden ChatGPT endpoints, extract credentials, bypass login/CAPTCHA, scrape history in the background, rotate accounts, silently truncate output, or execute generated patches. Secret scanning is a guardrail, not proof of safety. Codex must independently verify findings before edits.

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
