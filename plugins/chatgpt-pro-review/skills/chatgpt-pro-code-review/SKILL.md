---
name: chatgpt-pro-code-review
description: Offload a caller-defined repository question—including a code review, design discussion, explanation, brainstorming request, or patch proposal—to visible ChatGPT Chat Pro with strict verification, exactly-once submission, resumable polling, complete Markdown return, artifact downloads, and provenance archiving.
---

# ChatGPT Pro Code Review

Use the bundled first-class workflow. Keep Codex responsible for repository evidence, finding verification, edits, tests, commits, and releases. Target visible Chat, never Work.

## Before invoking

- Read [review-contract.md](references/review-contract.md) and [packet-policy.md](references/packet-policy.md).
- Infer base/head only when repository state makes them unambiguous; otherwise ask.
- Request approval before sending unexpectedly sensitive material. Never override a secret blocker without explicit approval.
- Use the installed `browser:control-in-app-browser` skill to initialize the compatible visible browser runtime when `globalThis.agent` is absent. Do not inspect cookies, storage, tokens, or private endpoints.
- Before the first file-backed review on each computer, tell the user to sign into ChatGPT visibly and enable both upload gates: Codex Settings > Computer Use > Google Chrome > Permissions > Uploads must allow `chatgpt.com` (or be set to Always allow), and Chrome `chrome://extensions` > Codex extension > Details must enable Allow access to file URLs. Never change these settings on the user's behalf. The workflow must fail closed before submission when either gate is missing.

## Invoke the workflow

Resolve this skill's absolute path, then import `../../runtime/import-chatgpt-control.mjs` from it in the browser-enabled persistent JavaScript runtime:

```js
const loaderUrl = new URL(
  "../../runtime/import-chatgpt-control.mjs",
  "file:///absolute/path/to/plugins/chatgpt-pro-review/skills/chatgpt-pro-code-review/SKILL.md"
);
const { importChatGPTControl } = await import(`${loaderUrl.href}?t=${Date.now()}`);
const { createChatGPT } = await importChatGPTControl();
const chatgpt = createChatGPT({ agent: globalThis.agent });

const review = await chatgpt.reviews.askPro({
  repositoryRoot: "/absolute/repository/root",
  baseRef: "origin/main",
  headRef: "HEAD",
  request: {
    additionalInstructions: "<faithful caller-defined question or task>"
  },
  target: { experience: "chat", intelligence: "Pro", strict: true },
  context: {
    mode: "review-packets",
    includeWorkingTree: true,
    includeInstructions: true,
    includeChangedFiles: true,
    includeRelevantCallers: false,
    includeRelatedTests: false,
    includeValidationOutput: false,
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
    restorePreviousConfiguration: false,
    scanPacketsForSecrets: true,
    secretPolicy: "block"
  }
});
```

Pass the user's actual question faithfully. Do not silently add exhaustive review dimensions, a required findings schema, patch prohibitions, or other constraints the user did not request. Use `focus` only when the caller or session agent intentionally wants named areas of emphasis. `reviews.codeReview(...)` remains a compatibility alias for `reviews.askPro(...)`.

Do not branch on the selected Codex host model. Do not replace this call with a model-written repository summary.

## Resume without duplication

If `status === "in_progress"`, require `submitted === true` and `resubmitAllowed === false`, keep the archive directory, and invoke the same workflow again with:

```js
const resumed = await chatgpt.reviews.codeReview({
  repositoryRoot: "/absolute/repository/root",
  baseRef: "origin/main",
  headRef: "HEAD",
  resume: {
    archiveDirectory: review.archiveDirectory
  }
});
```

Never submit the original prompt again after an attempted submission. The immutable submission receipt is authoritative: it restores and validates the canonical Chat conversation ID/URL, original packet manifest, artifact baseline, and configuration snapshot. Caller-supplied `conversationId` or `threadUrl` values are optional cross-checks and must match the receipt.

## Return and verify

- Read [output-and-artifacts.md](references/output-and-artifacts.md).
- In `full` mode, return `responseMarkdown` completely and exactly once. Do not summarize it away.
- Surface every artifact path, hash, archive directory, thread URL, warning, and blocker.
- If Pro is unavailable, fallback is visible, or post-completion Pro verification fails, report the structured blocker and do not label the answer a verified Pro response. Configuration restoration is optional and disabled by default; if the caller explicitly enables it, require verified restoration.
- Independently validate material findings against repository code and tests before editing. Clearly separate delegated findings from Codex-verified conclusions.
- Never execute or automatically apply generated patches, scripts, or artifacts.

Read [troubleshooting.md](references/troubleshooting.md) only when blocked or when installing on another machine.

## Portability boundary

The Agent Skill instructions are portable. Live execution requires a Codex/browser host that provides the visible bridge and a separately signed-in ChatGPT session on each machine. Do not copy browser profiles, cookies, auth state, or storage between computers. Installing this skill in a host without that bridge provides planning instructions, not equivalent live control.
