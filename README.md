# ChatGPT Bridge

Send any question or files from Codex to ChatGPT and bring the complete result back into the same task.

This is an unofficial public-alpha project and is not affiliated with or endorsed by OpenAI.

[![Release](https://img.shields.io/github/v/release/anotb/chatgpt-bridge?label=release)](https://github.com/anotb/chatgpt-bridge/releases)
[![Release checks](https://img.shields.io/github/actions/workflow/status/anotb/chatgpt-bridge/release.yml?label=release%20checks&logo=github)](https://github.com/anotb/chatgpt-bridge/actions/workflows/release.yml)
![License](https://img.shields.io/badge/license-MIT-yellow)

Use it for a second opinion, a code or design review, an explanation, research, file analysis, image generation, or any other task you want to hand to a visible ChatGPT mode. Pro, Instant, and other available modes are read from the current ChatGPT interface rather than assumed in advance.

## What it does

- Uses a ChatGPT session where you are already signed in.
- Selects the exact visible mode you asked for and checks that it is active.
- Sends your prompt and zero, one, or several explicit files once.
- Waits for long responses and can continue after Codex or your computer restarts.
- Returns the complete answer plus generated files and images.
- Supports deliberate follow-up questions in the same ChatGPT conversation.

File uploads happen in the background and do not open the system file picker. The bridge does not use ChatGPT API keys, cookies, private endpoints, or hidden account state.

If it cannot prove that it has the right tab, mode, prompt, files, or response, it stops instead of guessing or sending a second message.

## Install

The easiest option is to give this repository to Codex or another assistant that can configure Codex plugins:

> Install the latest tagged release of https://github.com/anotb/chatgpt-bridge as a Codex plugin, then verify that the ChatGPT Bridge skill is available in a new task.

For a manual install, pin the marketplace to `v0.8.0`, then install the plugin:

```text
codex plugin marketplace add anotb/chatgpt-bridge --ref v0.8.0
codex plugin add chatgpt-bridge@chatgpt-bridge
```

The repository is the marketplace. Codex checks out the selected public tag, reads its marketplace manifest, and installs the plugin contained in that checkout. Users do not need to clone the repository or copy anything into the Codex plugin cache.

Start a new Codex task after installation. Sign in to `chatgpt.com` in the Codex in-app browser or Chrome. The skill normally uses the in-app browser and can use Chrome if that session is not ready; it never changes browsers after submission starts.

## Use

Ask naturally from any Codex task:

> Ask ChatGPT Pro for a second opinion on this design.

> Send these three files to Pro and bring back its complete analysis and any generated files.

> Use Instant to answer this quick question.

> Ask ChatGPT to create an image from this brief and download the result.

> Continue in the same ChatGPT conversation and ask for a simpler approach.

You can also name `$chatgpt-bridge` directly. The skill sends only the prompt and files chosen for that request; it does not scan a repository or assemble a review packet on its own.

Pro work can take minutes or more than an hour. Codex checks the same operation at a gradually slower cadence and never resends merely because it timed out or restarted.

## Results and recovery

The answer comes back into the current Codex task and says whether it was captured as original Markdown or visible page text. Generated files and images include their downloaded path, size, and SHA-256 hash when transfer succeeds.

Small redacted operation records under `.codex/chatgpt-bridge/` let the same request recover without another Send. They contain hashes and identifiers for the exact tab and conversation—not prompt text, response text, filenames, file paths, cookies, tokens, or account details.

Generated code and files remain proposals until you choose to use them.

## Update or remove

To update, ask Codex to reinstall the plugin from a newer tagged release. A manually pinned marketplace stays on its selected tag until you change it.

To remove it:

```text
codex plugin remove chatgpt-bridge@chatgpt-bridge
codex plugin marketplace remove chatgpt-bridge
```

## Package and documentation

Most people only need the Codex plugin. The reusable TypeScript runtime is also published as [`chatgpt-pro-review-bridge` on npm](https://www.npmjs.com/package/chatgpt-pro-review-bridge).

- [Usage](docs/usage.md)
- [Setup and upgrades](docs/setup.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Privacy](docs/plugin-privacy.md)
- [Terms](docs/plugin-terms.md)
- [Architecture](docs/architecture.md)
- [Development and releases](docs/release-process.md)

This project is a focused fork of [adamallcock/codex-chatgpt-control](https://github.com/adamallcock/codex-chatgpt-control).

[MIT](LICENSE)
