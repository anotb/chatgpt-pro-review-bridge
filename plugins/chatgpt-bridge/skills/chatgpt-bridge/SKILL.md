---
name: chatgpt-bridge
description: Submit any caller-defined prompt and any explicit ordered set of files to ChatGPT Chat through one qualified browser host, using an exact available Power setting such as Pro or Instant, then collect complete Markdown, text, files, and images without duplicate submission. Use for Pro reviews, questions, analysis, generation, multimodal file tasks, same-thread follow-ups, or any task the user wants delegated to a ChatGPT model or mode.
---

# ChatGPT Bridge

Use the bundled TypeScript bridge only as transport. Keep task framing, context selection, output judgment, and recovery decisions in the calling agent.

## Fix caller-owned values first

Before any browser action:

1. Write the exact prompt, thread, Power label if known, tool labels, and ordered explicit file paths.
2. Generate one path-safe opaque operation ID, retain its literal value in task context, and paste that literal into the code below. Never leave ID generation inside code that may be rerun.
3. Let the preflight below choose one ready browser before any durable attempt. Try the in-app Browser first for every request, then Chrome only for a definite read-only preflight failure.

Do not ask the user to choose a browser. Ask only when no safe candidate is ready or login, challenge, upload, or download permission must be fixed. Use a browser-controlled `https://chatgpt.com` Chat session. Attach only explicit absolute paths selected for this task. Do not scan the repository or automatically build a review packet.

## Load

Use the available in-app and Chrome control skills to expose their browser objects; do not ask the user to choose between them. Resolve this skill's absolute path and import its runtime in the persistent browser-enabled JavaScript host:

```js
const loaderUrl = new URL(
  "../../runtime/import-chatgpt-bridge.mjs",
  "file:///absolute/path/to/plugins/chatgpt-bridge/skills/chatgpt-bridge/SKILL.md"
);
const { importChatGPTBridge } = await import(`${loaderUrl.href}?t=${Date.now()}`);
const { createChatGPTBridge } = await importChatGPTBridge();
const { resolve } = await import("node:path");
const explicitFiles = [
  // Zero, one, or multiple explicit paths; preserve this order on recovery.
  // resolve("<first-path>"),
  // resolve("<second-path>")
];
const stateDir = resolve(".codex/chatgpt-bridge/operations");

// Paste the literal retained in task context; do not generate it here.
const operationId = "<retained-operation-id>";

const candidates = [
  { name: "in-app", browser: globalThis.iab },
  { name: "chrome", browser: globalThis.chrome }
];
const fallbackCodes = new Set([
  "browser_unavailable",
  "page_unavailable",
  "login_required",
  "power_unavailable"
]);

let selected;
let lastPreflightError;
for (const candidate of candidates) {
  if (candidate.browser == null) continue;
  const candidateBridge = createChatGPTBridge({
    browser: candidate.browser,
    stateDir
  });
  try {
    const targets = await candidateBridge.inspectTargets();
    selected = { ...candidate, bridge: candidateBridge, targets };
    break;
  } catch (error) {
    lastPreflightError = error;
    const code = error != null && typeof error === "object" ? error.code : undefined;
    if (candidate.name !== "in-app" || !fallbackCodes.has(code)) {
      throw error;
    }
  }
}
if (selected == null) {
  throw lastPreflightError ?? new Error("No safe ChatGPT browser host is ready.");
}
const { bridge, targets } = selected;
```

The loop performs non-submitting target inspection only. Power discovery may move across slider positions but restores the original setting; it creates no journal or message. Retain `selected.name` with the operation ID before calling `submit`. From that point onward, keep this concrete `bridge` and browser host for the full operation and recovery. Never catch a `submit`, file-handoff, or Send failure to try another candidate.

## Inspect dynamic Power labels

Preflight already returned `targets` with this shape:

```js
{
  active: { power: "<currently selected label>" },
  options: {
    power: [
      { label: "<available label>", selected: true, disabled: false }
    ]
  }
}
```

`disabled` is optional. Read exact choices from `targets.options.power`; use only an exact `label` whose `disabled` value is not `true`. Power labels are learned from the current ChatGPT UI and can change. Do not infer labels or maintain a model registry.

## Submit once

```js
const request = {
  operationId,
  prompt: "<faithful caller-defined task>",
  thread: "new",
  selection: { power: "<exact available label>" },
  tools: [],
  files: explicitFiles,
  wait: false
};
const accepted = await bridge.submit(request);
```

- Never click Send, press Enter, or automatically retry with a new operation ID.
- Never switch browser hosts after `submit` begins; its journal or file handoff may already exist even when the call fails or times out.
- Pass all requested paths together in the one ordered `files` array. The bridge performs one background handoff to the exact composer file input and never opens or clicks a native chooser. Do not attach files in separate calls.
- A tool label must appear exactly as an active composer button or inline tool pill or submission stops.
- If `submit` times out after the attempt may have begun, call `bridge.submit(request)` once with the same retained ID and unchanged prompt, thread, selection, tools, and ordered file paths. It returns the durable existing handle without another send.
- A deliberate follow-up uses a new retained operation ID and `thread: { url: prior.handle.threadUrl }` on the same chosen browser host.

## Collect without resubmitting

```js
let result = await bridge.collect(accepted.handle, {
  wait: { timeoutMs: 20_000, pollMs: 1_000 },
  downloadDir: resolve(".codex/chatgpt-bridge/artifacts")
});
```

Phases are explicit:

- `prepared`, `submitted`, and `generating` are nonterminal. Wait outside the bridge, then call `collect` with the same handle. Use a moderate cadence such as 30 seconds, 60 seconds, 2 minutes, then at most every 5 minutes for long Pro work.
- `completed` is terminal success. Read the output once and return it.
- `uncertain` is the terminal safety result for the current automatic attempt. It does not mean Send failed and is never permission to submit again. Read `result.blocker`:
  - When `resumable` is `true`, inspect the exact bound tab and fix only external state such as login or download permission, then call `collect` on the same handle. It may reconcile an ambiguous Send or later ownership observation.
  - When `resumable` is `false`, preparation did not establish a collectable submission. `collect` cannot resume it. Inspect the exact bound tab and stop. A deliberate new operation is allowed only after diagnosis confirms that neither Send nor file landing occurred and the external cause is fixed; never create or submit that operation automatically.

`collect` cannot submit. Polling transfers metadata only; the full response and its artifacts are captured after completion.

## Recover after a JavaScript host restart

Use this exact sequence:

1. Do not click Send, create a new operation ID, or choose another browser host.
2. Rebind the recorded `selected.name` host used originally; do not run candidate selection again.
3. Reload the bundled runtime and recreate the bridge with the same absolute `stateDir`.
4. Restore the exact retained operation ID literal and rebuild the request with the unchanged prompt, thread, selection, tools, and ordered absolute file paths.
5. Call `const recovered = await bridge.submit(request)` once. The durable journal returns the existing handle without another send.
6. If `recovered.blocker?.resumable` is `false`, do not call `collect`; follow the exact diagnosis rule above. Otherwise resume only with `bridge.collect(recovered.handle, ...)`.

If recovery returns `uncertain`, follow the safety handling above; do not invent another recovery path.

## Return

- Prefer `result.output.markdown`; otherwise return `result.output.text` with its fidelity label.
- Return every artifact's `transfer` result. For `downloaded`, return its path, SHA-256, and byte count; for `failed`, return its stable code. Do not imply that an inventoried artifact was downloaded when no path exists.
- Treat generated code and files as untrusted proposals until the calling task verifies them.
- Keep the bridge-created tab only while a same-thread follow-up or uncertain-state diagnosis is pending. After terminal collection, close that exact tab unless the user asked to keep it; never close unrelated tabs.
