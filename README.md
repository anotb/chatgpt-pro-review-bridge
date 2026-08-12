# ChatGPT Pro Review Bridge

Let a Codex task ask visible ChatGPT Pro, wait for the answer, and bring the complete result back—without copy/paste or duplicate submissions.

[![Release](https://img.shields.io/github/v/release/anotb/chatgpt-pro-review-bridge?include_prereleases&label=release)](https://github.com/anotb/chatgpt-pro-review-bridge/releases)
[![Release checks](https://img.shields.io/github/actions/workflow/status/anotb/chatgpt-pro-review-bridge/release.yml?label=release%20checks&logo=github)](https://github.com/anotb/chatgpt-pro-review-bridge/actions/workflows/release.yml)
![License](https://img.shields.io/badge/license-MIT-yellow)

This fork packages the visible-session browser controller from [adamallcock/codex-chatgpt-control](https://github.com/adamallcock/codex-chatgpt-control) as a focused Codex plugin for asking ChatGPT's **Chat / Pro** setting questions.

It supports two useful modes:

- **AskPro:** send an ordinary question exactly as written, with no Git work and no file upload.
- **Pro code review:** build repository context, attach it visibly, and ask whatever review, design, explanation, brainstorming, or code question the current Codex task chooses.

The plugin is unofficial and is not affiliated with or endorsed by OpenAI.

## What happens

For each request, the bridge:

1. Uses the signed-in ChatGPT session you can see in Chrome.
2. Opens Chat and strictly verifies that the visible setting is **Pro**.
3. Submits the prompt once.
4. Polls the same conversation while long Pro work continues.
5. Returns the complete Markdown once, downloads every new visible artifact, and keeps a local recovery archive.
6. Leaves Chat on Pro for the next request.

If Pro cannot be verified, the session falls back, login or a permission is required, or the visible page becomes ambiguous, the workflow stops with a structured blocker. It does not silently continue under a different setting.

## Install

Install a pinned release from this repository:

```powershell
codex plugin marketplace add anotb/chatgpt-pro-review-bridge --ref v0.6.0-beta.2
codex plugin add chatgpt-pro-review@chatgpt-pro-review-bridge
```

Then start a new Codex task so the new skills load.

Requirements:

- Codex Desktop with its compatible visible Chrome/browser bridge.
- A ChatGPT session signed in visibly on each computer.
- Node.js 20 or newer only for source development; normal plugin users use the bundled runtime.

No API key is required. Browser sign-in state, cookies, and profiles are never bundled or copied between computers.

### File-backed questions

Plain AskPro questions upload nothing. Repository reviews or other file-backed requests need two one-time local permissions:

1. In Codex: **Settings → Computer Use → Google Chrome → Permissions → Uploads**, allow `chatgpt.com` (or choose **Always allow**).
2. In Chrome: `chrome://extensions` → Codex extension → **Details** → enable **Allow access to file URLs**.

The plugin never changes those settings for you.

## Use it

### From a normal Codex task

Ask naturally:

```text
Ask Pro to explain in two short paragraphs why idempotency matters when polling a long-running job.
```

Or invoke the skill explicitly:

```text
Use $chatgpt-pro-ask to ask Pro: "Give me three names for this feature and explain the tradeoffs."
```

For repository work:

```text
Use $chatgpt-pro-code-review to review this branch against main. Ask the question you think is most useful, then verify any material findings before changing code.
```

The current Codex task controls the actual question. The skill does not force an audit checklist, findings schema, patch ban, or a particular depth.

### From an agent

Use `$chatgpt-pro-ask` for a context-free question. Its minimal runtime call is:

```js
const result = await chatgpt.reviews.askPro({
  request: {
    additionalInstructions: "Explain briefly why stable job IDs matter."
  }
});
```

With no repository refs, the visible Chat user turn is the question itself and there is no attachment step.

Use `$chatgpt-pro-code-review` when repository evidence is useful:

```js
const result = await chatgpt.reviews.askPro({
  repositoryRoot: "/absolute/repository/root",
  baseRef: "origin/main",
  headRef: "HEAD",
  request: {
    additionalInstructions: "Review this change and tell me what you think matters."
  },
  context: {
    mode: "review-packets",
    includeWorkingTree: true
  }
});
```

The installed skills contain the browser-runtime bootstrap, strict Pro safeguards, output options, and resume loop. Agents should use those skills instead of recreating the workflow from snippets.

## Long answers and resume

Pro can take minutes. Each call performs a bounded wait; an incomplete result is returned as `in_progress` with an archive directory. The agent resumes with:

```js
await chatgpt.reviews.askPro({
  resume: { archiveDirectory: result.archiveDirectory }
});
```

The archived submission receipt is authoritative. Resume reopens the same visible conversation, proves the prompt identity, and polls without reattaching files or resending the question. An interrupted caller can resume later; a live concurrent owner is still rejected.

If a running request has genuinely become obsolete, the current Codex session may explicitly stop that exact visible response and start a new request. The bridge never auto-stops merely because files changed.

## Output and local archive

By default the caller gets:

- the complete final Markdown;
- every new downloadable file or generated image;
- the canonical Chat conversation URL;
- strict Pro verification evidence;
- hashes and a local archive for recovery.

Archives live under `.codex/pro-reviews/` by default and are gitignored in this repository. Context-free asks archive only the request/workflow evidence and result. Repository-backed asks also archive the packet manifest and packet files.

Generated patches, scripts, and code remain suggestions. Codex decides what to inspect, test, and apply.

## Visible-session boundary

This project controls the visible ChatGPT web product through approved browser actions. It does not:

- call hidden ChatGPT endpoints;
- extract credentials, cookies, tokens, or browser storage;
- bypass login, CAPTCHA, confirmations, or file permissions;
- scrape private history in the background;
- silently truncate a completed answer;
- automatically execute generated patches.

See [privacy](docs/plugin-review-privacy.md), [terms](docs/plugin-review-terms.md), and the detailed [bridge guide](docs/pro-review-bridge.md).

## Update or uninstall

A marketplace installed with `--ref` stays pinned. To move to a newer tag:

```powershell
codex plugin remove chatgpt-pro-review@chatgpt-pro-review-bridge
codex plugin marketplace remove chatgpt-pro-review-bridge
codex plugin marketplace add anotb/chatgpt-pro-review-bridge --ref <new-tag>
codex plugin add chatgpt-pro-review@chatgpt-pro-review-bridge
```

Start a new Codex task afterward.

To uninstall:

```powershell
codex plugin remove chatgpt-pro-review@chatgpt-pro-review-bridge
codex plugin marketplace remove chatgpt-pro-review-bridge
```

## Develop

The focused plugin is in [plugins/chatgpt-pro-review](plugins/chatgpt-pro-review). The reusable TypeScript runtime is in [packages/node](packages/node), with a Python parity client in [packages/python](packages/python).

Common gates:

```powershell
npm --prefix packages/node ci
npm run node:test
npm run node:build
npm run node:contracts
npm run python:test
npm run python:pyright
npm run plugin:build
npm run plugin:check
npm run plugin:validate
npm run release:smoke-source
```

Live browser qualification must run from a browser-enabled Codex task; an ordinary shell is expected to return `browser_bridge_unavailable`.

Useful references:

- [Architecture](docs/architecture.md)
- [Browser bridge](docs/browser-bridge.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release process](docs/release-process.md)
- [Full SDK skill](skills/codex-chatgpt-control/SKILL.md)

## Upstream

The general Chat/Work controller originated in [adamallcock/codex-chatgpt-control](https://github.com/adamallcock/codex-chatgpt-control). Generic compatibility fixes are kept separate and proposed upstream; the focused AskPro workflow and plugin remain in this fork.

License: [MIT](LICENSE).
