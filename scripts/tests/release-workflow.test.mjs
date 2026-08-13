import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");

test("smokes and publishes the exact preflight release artifacts", () => {
  assert.match(workflow, /package-smoke-macos:[\s\S]*actions\/download-artifact@v8[\s\S]*release:smoke-artifacts/);
  assert.match(workflow, /publish-npm:[\s\S]*actions\/download-artifact@v8[\s\S]*npm publish dist\/node\/\*\.tgz/);
  assert.match(workflow, /verify-published:[\s\S]*actions\/download-artifact@v8[\s\S]*release:verify-published -- --artifacts dist/);
});

test("blocks the GitHub release on every enabled publication and verification stage", () => {
  assert.match(workflow, /release-gate:[\s\S]*needs: \[preflight, package-smoke-macos, publish-npm, verify-published\]/);
  assert.match(workflow, /if \[ "\$PUBLISH_NPM" = true \]; then[\s\S]*PUBLISH_RESULT[\s\S]*VERIFY_RESULT/);
  assert.match(workflow, /github-release:[\s\S]*needs: release-gate/);
});
