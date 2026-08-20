# Release process

Releases are made from reviewed commits on `main`. Do not tag feature work before the local and visible-session checks are complete.

## Prepare

1. Choose the version intentionally. While this project remains a public `0.x` alpha, a breaking redesign increments the minor version.
2. Update the repository package, Node package, and plugin base version together. Plugin build metadata may retain its Codex build date.
3. Move the changelog entry from `Unreleased` to the chosen version and date, and add concise user-facing notes under `docs/releases/<version>.md`.
4. Build the committed plugin runtime and run every local gate:

```bash
npm test
npm run build
npm run bundle
npm run plugin:build
npm run plugin:check
npm run plugin:validate
npm run pack:check
```

5. Verify one TypeScript package, one public bundle, one plugin, and one skill; no `.codex/` state, live content, local paths, credentials, or browser state may enter the commit or package.
6. Qualify Pro, another visible Power label, same-thread follow-up, long polling, file upload, tool use, generated file, generated image, recovery, and duplicate-Send prevention in real visible sessions.

## Commit and tag

Commit the complete reviewed release, push `main`, and wait for the `TypeScript CI` workflow to pass. Then create one annotated tag on that exact commit:

```bash
VERSION=x.y.z
git tag -a "v${VERSION}" -m "ChatGPT Bridge ${VERSION}"
git push origin "v${VERSION}"
```

Do not move or reuse a release tag. A correction after tagging gets a new version.

## Automation

Pushing the tag starts `.github/workflows/release.yml`. The workflow:

1. verifies the tag against the repository, npm package, and plugin base versions;
2. reruns the test, build, bundle, plugin, and package gates;
3. builds the npm tarball and SHA-256 checksum;
4. publishes the package with npm trusted publishing when `PUBLISH_NPM=true`;
5. creates the GitHub release only after every enabled stage succeeds.

The workflow never creates or pushes the tag. That remains the deliberate release action after `main` passes CI.
