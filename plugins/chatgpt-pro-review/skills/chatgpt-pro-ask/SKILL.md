---
name: chatgpt-pro-ask
description: Ask visible ChatGPT Chat Pro a caller-defined question with optional repository context, strict Pro verification, duplicate-safe resumable polling, complete answer capture, and artifact preservation. Use for reviews, ideas, explanations, comparisons, code proposals, or other questions that would benefit from Pro.
---

# ChatGPT Pro Ask

Use the bundled bridge to send the caller's actual question to visible ChatGPT Chat with Pro strictly verified. Do not reinterpret every task as a code review. The caller or current session agent decides the question, context, depth, method, format, and whether code or patches would be useful.

## Before invoking

- Use the installed `browser:control-in-app-browser` skill to initialize the compatible visible browser runtime when `globalThis.agent` is absent.
- A context-free question uploads nothing. When the caller intentionally adds repository packets, do not attach unexpectedly sensitive material without approval; conventional credential and browser-profile paths are excluded.
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
  request: {
    additionalInstructions: "<faithful caller-defined question or task>"
  },
  target: { experience: "chat", intelligence: "Pro", strict: true },
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
  },
  polling: {
    callTimeoutMs: 20000,
    totalTimeoutMs: 1800000,
    maxPollCallsPerInvocation: 1
  }
});
```

This context-free form sends the question itself as the visible user turn and performs no Git commands or uploads. Pass the caller's question faithfully. Add context, focus, or output instructions only when the caller or current session wants them.

When repository material is useful, use the sibling `chatgpt-pro-code-review` skill or add `repositoryRoot`, `baseRef`, `headRef`, and `context: { mode: "review-packets", ... }` deliberately.

## Resume without duplication

If the result is `in_progress`, or an attempted submission was durably recorded but completion was not captured, resume it with:

```js
const resumed = await chatgpt.reviews.askPro({
  resume: { archiveDirectory: result.archiveDirectory },
  polling: {
    callTimeoutMs: 20000,
    totalTimeoutMs: 1800000,
    maxPollCallsPerInvocation: 1
  }
});
```

Never reattach files or resend the prompt. The archive's immutable receipt, original context, and thread checkpoint are authoritative. Keep each browser-host call longer than `callTimeoutMs` (30 seconds is sufficient for the 20-second example) and continue bounded resume calls until completion or a structured blocker; Pro answers can take minutes.

## Stop and replace an obsolete request

Only do this when the caller or current session explicitly decides the running request is obsolete. Do not auto-stop merely because files changed.

1. Open the exact archived thread from its receipt/checkpoint and verify the latest visible user turn contains the archived prompt exactly.
2. Inspect `chatgpt.messages.status()`. If generation is active, call `chatgpt.messages.stop({ confirmStop: true })` once and require `data.stopped === true`. If it is already inactive, do not click anything.
3. Preserve the old archive and any partial answer; never edit or delete the original prompt or receipt.
4. Build a fresh request with only the context the current session wants and invoke `reviews.askPro(...)` in a fresh thread. Its exactly-once rule starts anew because this is an explicitly superseding question, not a retry.
5. Include `diagnosticMetadata: { supersedesArchiveDirectory: "<old archive>" }` so the relationship remains recoverable without burdening the normal answer.

## Return

- Normally return the complete `responseMarkdown` as the answer, plus any downloaded artifacts. The durable archive and hashes exist so the session can resume safely; surface them when the caller asks for provenance or when diagnosing a blocker, not as mandatory ceremony in every answer.
- Require Pro verification before submission and after completion. Fail closed on unavailability or fallback.
- The normal workflow leaves Chat on Pro. Restoration is opt-in only.
- Treat generated code and patches as proposals. Do not automatically execute or apply them; the current Codex task decides what to verify and implement.

Read the sibling `chatgpt-pro-code-review` references when packet policy, output/artifact details, or troubleshooting guidance is needed.
