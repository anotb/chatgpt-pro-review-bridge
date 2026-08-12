---
name: chatgpt-pro-ask
description: Ask visible ChatGPT Chat Pro a caller-defined question with optional repository context, strict Pro verification, duplicate-safe resumable polling, complete answer capture, and artifact preservation. Use for reviews, ideas, explanations, comparisons, code proposals, or other questions that would benefit from Pro.
---

# ChatGPT Pro Ask

Use the bundled bridge to send the caller's actual question to visible ChatGPT Chat with Pro strictly verified. Do not reinterpret every task as a code review. The caller or current session agent decides the question, context, depth, method, format, and whether code or patches would be useful.

## Before invoking

- Do not attach unexpectedly sensitive material without the caller's approval. Conventional credential and browser-profile paths are excluded from repository packets.
- Use the installed `browser:control-in-app-browser` skill to initialize the compatible visible browser runtime when `globalThis.agent` is absent.
- A first file-backed run on each computer requires a visibly signed-in ChatGPT session, Codex Chrome uploads allowed for `chatgpt.com`, and Chrome's Codex extension allowed to access file URLs. Never change those settings for the user.

## Invoke

Resolve this skill's absolute path and import the bundled runtime from the persistent browser-enabled JavaScript host:

```js
const loaderUrl = new URL(
  "../../runtime/import-chatgpt-control.mjs",
  "file:///absolute/path/to/plugins/chatgpt-pro-review/skills/chatgpt-pro-ask/SKILL.md"
);
const { importChatGPTControl } = await import(`${loaderUrl.href}?t=${Date.now()}`);
const { createChatGPT } = await importChatGPTControl();
const chatgpt = createChatGPT({ agent: globalThis.agent });

const result = await chatgpt.reviews.askPro({
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
    submitOnce: true,
    verifyTargetBeforeSubmit: true,
    verifyTargetAfterCompletion: true,
    failOnFallback: true,
    restorePreviousConfiguration: false
  }
});
```

Pass the user's question faithfully. Do not add review categories, a findings schema, output restrictions, or patch prohibitions unless the caller asked for them. Tune packet contents to the question: callers, tests, validation output, and broad source context are opt-in when useful, not a default checklist.

## Resume without duplication

If the result is `in_progress`, or an attempted submission was durably recorded but completion was not captured, call `reviews.askPro` again with only the original repository refs and `resume: { archiveDirectory: result.archiveDirectory }`. Never reattach files or resend the prompt. The archive's immutable receipt and thread checkpoint are authoritative.

## Stop and replace an obsolete request

Only do this when the caller or current session explicitly decides the running request is obsolete. Do not auto-stop merely because files changed.

1. Open the exact archived thread from its receipt/checkpoint and verify the latest visible user turn contains the archived prompt exactly.
2. Inspect `chatgpt.messages.status()`. If generation is active, call `chatgpt.messages.stop({ confirmStop: true })` once and require `data.stopped === true`. If it is already inactive, do not click anything.
3. Preserve the old archive and any partial answer; never edit or delete the original prompt or receipt.
4. Build fresh context from the revised Git state and invoke a new `reviews.askPro(...)` request in a fresh thread. Its exactly-once rule starts anew because this is an explicitly superseding question, not a retry.
5. Include `diagnosticMetadata: { supersedesArchiveDirectory: "<old archive>" }` so the relationship remains recoverable without burdening the normal answer.

## Return

- Normally return the complete `responseMarkdown` as the answer, plus any downloaded artifacts. The durable archive and hashes exist so the session can resume safely; surface them when the caller asks for provenance or when diagnosing a blocker, not as mandatory ceremony in every answer.
- Require Pro verification before submission and after completion. Fail closed on unavailability or fallback.
- The normal workflow leaves Chat on Pro. Restoration is opt-in only.
- Treat generated code and patches as proposals. Do not automatically execute or apply them; the current Codex task decides what to verify and implement.

Read the sibling `chatgpt-pro-code-review` references when packet policy, output/artifact details, or troubleshooting guidance is needed.
