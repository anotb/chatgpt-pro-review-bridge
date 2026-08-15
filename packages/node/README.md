# chatgpt-pro-review-bridge

TypeScript runtime for one visible ChatGPT Chat operation: bind an exact tab/thread, select an exact visible setting, attach explicit files, compose, record the attempt, activate Send once, and collect the owned output.

```bash
npm install chatgpt-pro-review-bridge
```

```ts
import { createChatGPTBridge } from "chatgpt-pro-review-bridge";

const selectedBrowser = globalThis.browser;
if (selectedBrowser == null) throw new Error("Select a visible browser first.");
const bridge = createChatGPTBridge({ browser: selectedBrowser });
const submitted = await bridge.submit({
  operationId: crypto.randomUUID(),
  prompt: "Return a concise answer in Markdown.",
  selection: { power: "Pro" },
  wait: false
});
const result = await bridge.collect(submitted.handle, { wait: true });
```

Public API:

- `createChatGPTBridge(options)` — ordinary visible-browser factory.
- `createBridge({ port, ... })` — injected host seam for tests or another compatible visible browser.
- `inspectTargets()` — discover exact dynamic Power labels.
- `submit(request)` — prepare and attempt one message.
- `collect(handle, options)` — observe and capture; structurally cannot submit.
- `run(request)` — convenience composition of `submit` and `collect`.

`operationId` is required and makes caller retries idempotent. A reused ID with a different prompt, thread, selection, tool list, or file list is rejected before browser interaction.

Choose `selectedBrowser` before creating the bridge and keep it fixed for the operation. The in-app host supports the same background file handoff when it exposes the required tab-scoped CDP capability; no native chooser is used.

The journal stores hashes, counts, exact UI selection, timestamps, and tab/thread affinity. It does not store prompt text, response text, filenames, file paths, account data, cookies, or tokens.

Current scope is Chat, TypeScript, and English visible UI. No Python client, backend service, hidden API, Work mode, history search, locale registry, or legacy command layer is included.
