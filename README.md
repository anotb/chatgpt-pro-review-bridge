# ChatGPT Pro Review Bridge

Send a question from Codex to ChatGPT Pro and get the complete answer back in the same task.

[![Release](https://img.shields.io/github/v/release/anotb/chatgpt-pro-review-bridge?label=release)](https://github.com/anotb/chatgpt-pro-review-bridge/releases)
[![Release checks](https://img.shields.io/github/actions/workflow/status/anotb/chatgpt-pro-review-bridge/release.yml?label=release%20checks&logo=github)](https://github.com/anotb/chatgpt-pro-review-bridge/actions/workflows/release.yml)
![License](https://img.shields.io/badge/license-MIT-yellow)

Use it for code reviews, design feedback, debugging ideas, explanations, or any other question where you want a second pass from Pro. The current Codex task decides what to ask and how much context to send.

## What it does

- Opens ChatGPT in the Chrome session where you are already signed in.
- Selects Pro and checks that Pro is active.
- Sends the question once.
- Waits for long responses and resumes the same chat when needed.
- Returns the full Markdown response and any new files or images.
- Keeps a local archive so an interrupted task can continue without sending the question again.
- Supports follow-up questions in the same ChatGPT conversation.

If Pro cannot be confirmed, the request stops and Codex tells you what needs attention.

## Install

The easiest option is to give this repository to Codex or another assistant that can configure Codex plugins:

> Install the latest tagged release of https://github.com/anotb/chatgpt-pro-review-bridge as a Codex plugin, then verify that the ChatGPT Pro Review skills are available in a new task.

For a manual install, add this repository as a marketplace pinned to `v0.7.10` with `codex plugin marketplace add anotb/chatgpt-pro-review-bridge --ref v0.7.10`, then install it with `codex plugin add chatgpt-pro-review@chatgpt-pro-review-bridge`.

Start a new Codex task after installation.

### Before the first file-backed review

You need Codex Desktop, Chrome, and a signed-in ChatGPT account with Pro available.

For reviews that upload repository context, allow uploads to `chatgpt.com` under **Codex Settings > Computer Use > Google Chrome > Permissions > Uploads**. Then open the Codex extension details in Chrome and enable **Allow access to file URLs**.

Plain questions do not upload repository files.

## Use

Ask naturally from any Codex task:

> Ask Pro for a second opinion on this design.

> Ask Pro to review this branch against main and focus on anything we may have missed.

> Ask Pro for a full repository review, including the current working tree—even if this repo has no commits yet.

> Ask Pro to explain why this test is flaky.

> Follow up in the same Pro chat and ask for a simpler approach.

Codex will choose the general AskPro skill or the repository-aware review skill based on the request. You can also name `$chatgpt-pro-ask` or `$chatgpt-pro-code-review` directly.

Pro work can take minutes or more than an hour. Codex polls the same conversation with increasing delays—30 seconds, 60 seconds, 2 minutes, 4 minutes, then at most once every 5 minutes—and can resume after a timeout or restart. It does not send the prompt again while a request is already running.

Supplying only `repositoryRoot` reviews the complete committed repository; it does not require a fake base commit. Working-tree files are included only when requested (and automatically for a repository with no commits yet), so an ordinary full-repository request does not unexpectedly upload local edits or untracked filenames.

## Results and recovery

Each request gets its own folder under `.codex/pro-reviews/`. It contains the submitted prompt, the final response, downloaded artifacts, the ChatGPT conversation link, and the information needed to resume.

Generated patches stay in the response until you choose to apply them.

## Update or remove

To update, ask Codex to reinstall the plugin from a newer tagged release. A manually pinned marketplace stays on its selected tag until you change it.

To remove it, run `codex plugin remove chatgpt-pro-review@chatgpt-pro-review-bridge`, then `codex plugin marketplace remove chatgpt-pro-review-bridge`.

## Packages and documentation

Most people only need the Codex plugin. The reusable runtime is also available as [`chatgpt-pro-review-bridge` on npm](https://www.npmjs.com/package/chatgpt-pro-review-bridge), and Python packages are attached to each [GitHub release](https://github.com/anotb/chatgpt-pro-review-bridge/releases).

- [Detailed bridge guide](docs/pro-review-bridge.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Privacy](docs/plugin-review-privacy.md)
- [Terms](docs/plugin-review-terms.md)
- [Development and releases](docs/release-process.md)

This project is a focused fork of [adamallcock/codex-chatgpt-control](https://github.com/adamallcock/codex-chatgpt-control).

[MIT](LICENSE)
