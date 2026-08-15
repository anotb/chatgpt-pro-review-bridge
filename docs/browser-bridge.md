# Browser host contract

The bridge needs a user-controlled visible browser host with:

- controlled tab list/get/create operations and stable tab IDs;
- Playwright-shaped `locator`, semantic role/text locators, `evaluate`, `goto`, and bounded waits;
- for file submissions, the documented tab-scoped `cdp` capability;
- for artifact downloads, visible download events with a bounded completed local path;
- the tab clipboard when available for exact response Markdown with lossless snapshot/restore; DOM text remains the labelled fallback.

Only exact `https://chatgpt.com` pages are accepted. Lookalike origins, ambiguous controlled tabs, missing tab IDs, login walls, unsupported routes, and conversation drift stop before mutation.

The bridge core receives one bound host and never routes between browsers. A caller or skill selects that host before the operation from the capabilities required by the request. No host or upload-mechanism switch occurs after file handoff or submission begins.

## Current English UI paths

- Composer: `#prompt-textarea`
- Composer upload input: exact form containing `#prompt-textarea` → `#upload-files`
- Send: `button[data-testid='send-button']`
- Setting: the visible `Power` menu item and its current ARIA slider range
- Completion: no visible Stop control plus a completed owned assistant turn; structural artifact-only image turns are valid
- Markdown: one visible response-level Copy inside the owned assistant turn, used only with lossless clipboard snapshot/restore

Power labels are learned from the slider’s current ARIA announcements and restored after inspection. The bridge does not own a list of model names.

For a file-bearing request, the adapter requires exactly one composer-scoped `#upload-files` input and the documented `cdp` capability. One scoped background action constructs the ordered browser `File` list, assigns it to that input, and dispatches its normal input/change events. No upload control is clicked and no native picker opens. Multi-file support and every new ready basename are verified before Send; an ambiguous action is never repeated.

Send itself requires the same scoped capability. A single page action verifies the complete composer envelope—route, prompt with inline pills excluded, exact ordered ready attachments, exact active tool set, Power echo, both turn baselines and tail IDs, and one ready Send control—then invokes `requestSubmit` once. There is no click/Enter fallback.

Selectors are kept small on purpose. If a redesigned or localized UI cannot prove the same postconditions, use browser/computer interaction to understand or repair the visible state, then update the narrow selector with a real fixture and live check.
