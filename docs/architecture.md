# Architecture

The repository has one runtime path:

```text
calling agent
  -> createChatGPTBridge()
  -> bridge core (submit / collect)
  -> visible-browser port
  -> controlled chatgpt.com tab
```

## Source map

- `bridge.ts` — operation policy, idempotent caller IDs, polling, and public facade.
- `journal.ts` — create-only write-ahead attempt plus atomic phase updates.
- `browser-runtime.ts` — acquire or reclaim an exact controlled ChatGPT tab.
- `browser-targets.ts` and `targets.ts` — dynamic Power discovery and exact selection.
- `browser-inputs.ts` — exact tool selection and capability-selected file handoff.
- `browser-output.ts` and `output.ts` — cheap metadata snapshots, exact Copy capture, DOM fallback, assistant-owned artifacts, and downloads.
- `browser-port.ts` — the direct adapter tying those mechanics to the core.
- `factory.ts` — ordinary public factory.

There is no backend process or protocol boundary. The injected `BridgePort` is the only test/custom-host seam.

The core receives one concrete browser and has no router. Any host choice happens before the operation from the capabilities the request needs. Once an attempt begins, no browser-host fallback exists.

## Submit transaction

1. Reuse an existing durable operation when the caller supplies the same operation ID and request hash.
2. Validate explicit local file paths before tab work or persistence; deterministic local failures do not consume an operation.
3. Bind a fresh tab, current tab, or exact canonical thread.
4. Preflight every requested target before mutating one, then select exact targets.
5. Fill and read back the exact prompt, then select exact tools and verify their active inline-pill or composer-button signals.
6. Persist a redacted `prepared` attempt record with create-only semantics before file handoff or Send.
7. If files were requested, pass the complete explicit list once to the exact background composer input and require the exact ordered ready-card set.
8. In one scoped page action, re-verify the bound route, exact prompt, exact attachments and tools, Power echo, both user/assistant baselines and tail identities, and the unique ready Send control; then call `requestSubmit` once.
9. Reconcile the resulting user-turn advance, structural prompt bubble, tab, and conversation. Ambiguity becomes `uncertain`; no fallback activation exists.

For upload, the adapter uses one scoped CDP action to populate the exact composer `#upload-files` input and dispatch its normal events. It never clicks the input, opens a native picker, or falls through to another mechanism after an ambiguous action.

The record is intentionally written before the first ambiguous file action or Send. A crash after that point may strand an operation, but it cannot authorize repeated file handoff or a duplicate message. Browser-facing cycles are serialized per bridge instance; polling sleeps are not.

## Collection

`collect` reclaims the stored tab when available. If that tab closed and the journal has a canonical conversation, it may open a fresh controlled tab and navigate directly to that conversation; the replacement binding is accepted only with the same conversation, structural prompt bubble, and both turn baselines. Polls return counts and generation flags only. After visible completion, one collect call performs one full response read. It uses the unique owned Copy action only with lossless clipboard snapshot/restore, otherwise returns labelled DOM text without clicking Copy. Artifacts are inventoried only inside the new assistant turn; a structural artifact-only image turn is also valid. A later explicit collect intentionally re-captures so a caller can recover after enabling download permission.

Generated file downloads address the exact assistant index, exact visible label, and occurrence. Generated image capture fetches only a structurally identified visible source inside the owned assistant turn through a bounded, cancellable scoped transfer. Every requested artifact transfer reports `downloaded` or a stable failure code. There is no page-wide “latest artifact” fallback.

## Deliberately absent

Python parity, Work, private APIs, background scraping, history/title search, locale packs, mode registries, command registries, wire schemas, child processes, runner abstractions, report builders, review packets, compatibility shims, and multiple plugin bundles.
