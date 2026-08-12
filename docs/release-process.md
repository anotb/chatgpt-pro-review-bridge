---
title: Release Process
date: 2026-08-12
type: runbook
status: stable
---

# Release Process

ChatGPT Pro Review Bridge ships as a tagged Codex marketplace plugin, an npm
package, a Python distribution, and a GitHub release. All four use one version.

## Prepare

1. Update the version in the root, Node, Python, and both plugin manifests.
2. Rebuild the bundled plugin runtime:

   ```bash
   npm --prefix packages/node ci
   npm run plugin:build
   npm run plugin:check
   npm run plugin:validate
   ```

3. Run the deterministic release gates:

   ```bash
   npm run release:check-version
   npm run release:check-names
   npm run node:test
   npm run node:build
   npm run node:bundle
   npm run node:contracts
   npm run python:test
   npm run python:compile
   npm run python:pyright
   npm run python:ordinary-shell
   npm run release:check-node-pack
   npm run release:build-python
   npm run release:check-python
   npm run release:smoke-source
   ```

4. Confirm `.codex/`, live review archives, conversation URLs, and local reports
   are not part of the release commit.

## Live qualification

Run the installed plugin from a fresh Codex task. Qualify a plain AskPro
question, a repository-backed request, a bounded resume, and a same-thread
follow-up. Pro requests can run for more than an hour; resume the same archive
instead of resending the prompt.

Use a fast Chat setting for repetitive artifact and interruption checks when
the behavior does not depend on Pro. Record the exact installed plugin version
and archive used by the live qualification.

## Registries

The public distribution name is `chatgpt-pro-review-bridge` on npm and PyPI.
The Python import remains `codex_chatgpt_control` for compatibility.

Registry publishing is enabled by setting the repository variable
`PUBLISH_REGISTRIES=true` after npm and PyPI trusted publishers are configured
for:

- repository: `anotb/chatgpt-pro-review-bridge`
- workflow: `.github/workflows/release.yml`
- environment: `release`
- package/project: `chatgpt-pro-review-bridge`

The tag workflow builds and checks both distributions before publishing. It
then installs the exact registry versions and exercises the Node/Python bridge.

## Tag and verify

Create a tag that exactly matches the package version:

```bash
git tag v0.7.0
git push origin v0.7.0
```

The release workflow reruns the complete preflight and clean-package smoke on
macOS, then creates the stable GitHub release. When registry publishing is
enabled, verify the published packages too:

```bash
npm view chatgpt-pro-review-bridge version dist-tags --json
python -m pip index versions chatgpt-pro-review-bridge
npm run release:verify-published
```

Finally, install the tag as a user would:

```bash
codex plugin marketplace add anotb/chatgpt-pro-review-bridge --ref v0.7.0
codex plugin add chatgpt-pro-review@chatgpt-pro-review-bridge
```

Start a new Codex task and confirm the installed skill is discoverable.
