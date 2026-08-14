---
name: chatgpt-pro-code-review
description: Offload a caller-defined repository question—including a code review, design discussion, explanation, brainstorming request, or patch proposal—to visible ChatGPT Chat Pro with strict verification, exactly-once submission, resumable polling, complete Markdown return, artifact downloads, and provenance archiving.
---

# ChatGPT Pro Code Review

Use the bundled first-class workflow. Keep Codex responsible for repository evidence, finding verification, edits, tests, commits, and releases. Target visible Chat, never Work.

## Before invoking

- Read [review-contract.md](references/review-contract.md) and [packet-policy.md](references/packet-policy.md).
- For a change review, infer base/head only when repository state makes them unambiguous; otherwise ask. For a full-repository review, use repository scope and omit `baseRef`; never manufacture an empty commit or pass Git's empty-tree hash as a commit reference.
- Do not attach unexpectedly sensitive material without the caller's approval. Conventional credential and browser-profile paths are excluded from repository packets.
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
  target: { experience: "chat", intelligence: "Pro" },
  context: {
    mode: "review-packets",
    scope: "changes",
    includeWorkingTree: true,
    includeInstructions: false,
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
    restorePreviousConfiguration: false
  },
  polling: {
    callTimeoutMs: 20000,
    maxPollCallsPerInvocation: 1
  }
});
```

Pass the user's actual question faithfully. Use `focus` when the caller or session agent wants named areas of emphasis. `reviews.codeReview(...)` remains a compatibility alias for `reviews.askPro(...)`.

Submit-once behavior, pre/post Pro verification, and fallback rejection are workflow invariants. Older boolean fields for those safeguards remain accepted for compatibility but cannot weaken them; only configuration restoration is caller-selectable.

For a full-repository review—including a Git repository with no commits yet—omit `baseRef` and select repository scope:

```js
const review = await chatgpt.reviews.askPro({
  repositoryRoot: "/absolute/repository/root",
  request: {
    additionalInstructions: "<faithful caller-defined full-repository question or task>"
  },
  context: {
    mode: "review-packets",
    scope: "repository",
    onBudgetExceeded: "partition"
  },
  // Use the same target, output, safeguards, and polling options as above.
});
```

`repositoryRoot` without `baseRef` also defaults to repository scope. Set `scope: "repository"` explicitly in skill-driven calls so the archived intent is obvious. Committed repository scope defaults to a commit-only snapshot; set `includeWorkingTree: true` only when the caller wants local changes included. An unborn repository defaults to its index and working tree because no committed snapshot exists.

When the caller explicitly asks to include current local edits, add this field to
the repository context:

```js
includeWorkingTree: true
```

Do not branch on the selected Codex host model. Do not replace this call with a model-written repository summary.

## Timeout budgets

Give a fresh file-backed review a 5–10 minute outer browser-host envelope (`node_repl timeout_ms: 300000`, or up to `600000` for a large repository). `polling.callTimeoutMs` bounds only each post-submit metadata poll. If the outer call times out, preserve the archive and tabs and resume the same archive; never reattach, replace the chat, or resend the prompt.

## Resume without duplication

If `status === "in_progress"` or the result is explicitly resumable, require `resubmitAllowed === false`, keep the archive directory, and invoke the same workflow again with:

```js
const resumed = await chatgpt.reviews.codeReview({
  repositoryRoot: "/absolute/repository/root",
  baseRef: "origin/main",
  headRef: "HEAD",
  resume: {
    archiveDirectory: review.archiveDirectory
  },
  polling: {
    callTimeoutMs: 20000,
    maxPollCallsPerInvocation: 1
  }
});
```

Use durable phase, not `submitted === false` alone, to decide what a resume may do:

- A validated `pre-submit-checkpoint.json` with no intent or receipt may continue to the first and only submit.
- A submission intent means submission may already have been attempted; reconcile the visible thread but never submit again.
- A receipt resumes only the existing response.

Require `resubmitAllowed === false` in every phase. Never reattach packets, manually send the archived prompt, or start a replacement review. Caller-supplied conversation values are mismatch-only cross-checks.

Treat `existing_tab_handoff_completed` as a task-turn boundary. Make no more browser calls, end the turn, then resume the same archive in a later turn with a fresh browser-host invocation. Never reuse the old client or submit in the handoff turn; the phase rules above still apply.

Keep every invocation on its bound canonical conversation and browser tab. A
provisional `WEB:` receipt may adopt a canonical conversation only after exact
archived-prompt ownership is proven. Require one exact recovery candidate, or
one candidate uniquely selected by the archived tab ID; surface
`review_thread_recovery_ambiguous` instead of guessing among repeated identical
prompts. On any affinity blocker, preserve the archive and never create a
replacement submission.

After a post-submit `in_progress` result, follow this prose-only cadence between invocations: 30 seconds, 60 seconds, 2 minutes, 4 minutes, then no more than once every 5 minutes. Wait outside the SDK; do not add a timer, recurse, or busy-poll. Do not count a tab handoff as a polling result.

## Return and verify

- Read [output-and-artifacts.md](references/output-and-artifacts.md).
- In `full` mode, return `responseMarkdown` completely and exactly once. Do not summarize it away.
- Surface every artifact path, hash, archive directory, thread URL, warning, and blocker.
- Surface conversation, tab, prompt-affinity, recovery-ambiguity, and archive-terminal-commit blockers as recorded; do not reinterpret them as authentication or retry by resubmitting.
- If Pro is unavailable, fallback is visible, or post-completion Pro verification fails, report the structured blocker and do not label the answer a verified Pro response. Configuration restoration is optional and disabled by default; if the caller explicitly enables it, require verified restoration.
- Independently validate material findings against repository code and tests before editing. Clearly separate delegated findings from Codex-verified conclusions.
- Never execute or automatically apply generated patches, scripts, or artifacts.

Read [troubleshooting.md](references/troubleshooting.md) only when blocked or when installing on another machine.

## Portability boundary

The Agent Skill instructions are portable. Live execution requires a Codex/browser host that provides the visible bridge and a separately signed-in ChatGPT session on each machine. Do not copy browser profiles, cookies, auth state, or storage between computers. Installing this skill in a host without that bridge provides planning instructions, not equivalent live control.
