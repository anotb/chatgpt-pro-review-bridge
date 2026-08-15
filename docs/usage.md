# Usage

## Create a bridge

```ts
import { createChatGPTBridge } from "chatgpt-pro-review-bridge";

const selectedBrowser = globalThis.browser;
if (selectedBrowser == null) throw new Error("Select a visible browser first.");
const bridge = createChatGPTBridge({
  browser: selectedBrowser,
  stateDir: ".codex/chatgpt-bridge/operations"
});
```

Direct API callers pass one concrete browser and keep it for the operation. The plugin skill selects a ready host before submission from the capabilities the request needs. No host or upload-mechanism switch is allowed after file handoff or a durable attempt begins. Advanced tests and custom hosts can inject a `BridgePort` through `createBridge`.

## Discover settings

```ts
const targets = await bridge.inspectTargets();
// { active: { power: "Pro" }, options: { power: [...] } }
```

Discovery reads all current Power positions dynamically and restores the original selection. Submit accepts the exact returned label.

## Submit

```ts
const request = {
  operationId: crypto.randomUUID(),
  prompt: "Analyze the attached data and return a Markdown summary.",
  thread: "new",
  selection: { power: "Pro" },
  tools: ["Web search"],
  files: ["C:/absolute/input.csv"],
  wait: false
};
const submitted = await bridge.submit(request);
```

`thread` may be `"new"`, `"current"`, `{ url }`, or `{ conversationId }`. Exact canonical thread targets are required; titles and history search are not supported.

Tools and files are optional. Tool labels are exact visible strings and must appear as active composer buttons or inline pills. Files may be any ordered list of explicit absolute readable regular paths. The adapter transfers the complete ordered list once to the exact composer `#upload-files` input without clicking it or opening a native picker, then verifies the exact ordered ready-card set.

## Collect

```ts
const result = await bridge.collect(submitted.handle, {
  wait: { timeoutMs: 20_000, pollMs: 1_000 },
  downloadDir: "C:/absolute/output"
});
```

Phases:

- `prepared` — the write-ahead attempt exists; Send outcome is not yet reconciled.
- `submitted` — the user turn is owned; no assistant turn yet.
- `generating` — exactly one owned assistant turn exists and is active/incomplete.
- `completed` — visible completion controls exist and full output was captured.
- `uncertain` — ownership or action outcome cannot be proven. Follow `blocker.resumable`: collect only when it is `true`; preparation blockers are not collectable and never authorize an automatic retry.

`collect` never submits. While the response is nonterminal, a zero-wait collect is a cheap status read. After completion it transfers the full response and artifacts once.

Each artifact reports `transfer.status`: `not_requested` when no `downloadDir` was supplied, `downloaded` with a verified path/hash/byte count, or `failed` with a stable code. The response is still returned after an artifact transfer failure. Calling `collect` again is allowed after fixing download permission; it re-captures the completed owned turn without submitting.

## Recover after a caller timeout

Call `bridge.submit(request)` again with the same operation ID and byte-for-byte equivalent request fields. The request hash is checked before browser interaction. If the durable attempt exists, its current handle is returned without Send.

Changing prompt, thread, selection, tools, or files requires a new operation ID.

## Follow up

```ts
const followUp = await bridge.submit({
  operationId: crypto.randomUUID(),
  prompt: "Now give me the smallest implementation plan.",
  thread: { url: result.handle.threadUrl! },
  selection: { power: "Pro" },
  wait: false
});
```

Reuse the same bridge instance so it retains the controlled tab. Each deliberate message has its own operation ID and attempt record.
