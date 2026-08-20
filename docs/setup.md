# Setup

## Requirements

- Codex Desktop with plugin support.
- A ChatGPT account signed in at `chatgpt.com` in the Codex in-app browser or Chrome.
- Access to the ChatGPT mode you want to use, such as Pro or Instant.

The bridge does not need a ChatGPT API key. File requests do not use the system file picker.

## Install with Codex

Give Codex this instruction:

> Install the latest tagged release of https://github.com/anotb/chatgpt-bridge as a Codex plugin, then verify that the ChatGPT Bridge skill is available in a new task.

Start a new Codex task after installation so the new skill is loaded.

## Manual install

This GitHub repository is also the Codex plugin marketplace. Pin it to this release and install the plugin it contains:

```text
codex plugin marketplace add anotb/chatgpt-bridge --ref v0.8.2
codex plugin add chatgpt-bridge@chatgpt-bridge
```

Codex checks out the public tag, reads [the marketplace manifest](../.agents/plugins/marketplace.json), and installs `plugins/chatgpt-bridge` into its managed plugin cache. Do not clone the repository or copy files into the cache manually. Then start a new Codex task.

## Sign in

Open `https://chatgpt.com/` in the Codex in-app browser and sign in. Chrome can also be used when its controlled ChatGPT session is signed in. The skill checks the in-app browser first and can consider Chrome only before submission begins.

You do not need to choose a browser for each request. If neither session is ready, Codex will tell you what needs attention.

## Verify the installation

In a new Codex task, ask:

> Use `$chatgpt-bridge` with Instant to reply with exactly `BRIDGE-OK`.

A successful check opens or reuses a controlled ChatGPT tab, returns `BRIDGE-OK` to the Codex task, and does not ask you to choose a browser.

For a file check, give Codex one or more explicit local files and ask it to return a value from each file. The files should appear in the ChatGPT composer without opening a system file picker.

## Upgrade from 0.8.x

A marketplace pinned to an earlier tag does not move by itself. Ask Codex to reinstall ChatGPT Bridge from tag `v0.8.2`, or run:

```text
codex plugin remove chatgpt-bridge@chatgpt-bridge
codex plugin marketplace remove chatgpt-bridge
codex plugin marketplace add anotb/chatgpt-bridge --ref v0.8.2
codex plugin add chatgpt-bridge@chatgpt-bridge
```

Start a new Codex task afterward.

## Upgrade from 0.7

Version 0.8 replaces `$chatgpt-pro-ask` and `$chatgpt-pro-code-review` with the single `$chatgpt-bridge` skill. Old saved prompts should use the new name.

The simplest upgrade is to ask Codex to reinstall the plugin from tag `v0.8.2`. For a manual clean reinstall:

```text
codex plugin remove chatgpt-pro-review@chatgpt-pro-review-bridge
codex plugin marketplace remove chatgpt-pro-review-bridge
codex plugin marketplace add anotb/chatgpt-bridge --ref v0.8.2
codex plugin add chatgpt-bridge@chatgpt-bridge
```

Start a new Codex task afterward. Existing `.codex/pro-reviews/` archives from 0.7 are not used by the new bridge and can be retained for reference.

## Remove

```text
codex plugin remove chatgpt-bridge@chatgpt-bridge
codex plugin marketplace remove chatgpt-bridge
```

See [Troubleshooting](troubleshooting.md) when sign-in, mode discovery, file transfer, recovery, or artifact download does not complete.
