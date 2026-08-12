#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { npmInvocation } from "./lib/npm-command.mjs";

const execFileAsync = promisify(execFile);

const npmPackage = "chatgpt-pro-review-bridge";

async function readNodeVersion() {
  const pkg = JSON.parse(await readFile(new URL("../packages/node/package.json", import.meta.url), "utf8"));
  return String(pkg.version);
}

async function npmView(spec) {
  try {
    const npm = npmInvocation(["view", spec, "name", "version", "--json"]);
    const { stdout } = await execFileAsync(npm.program, npm.args, {
      maxBuffer: 1024 * 1024
    });
    return { exists: true, data: JSON.parse(stdout) };
  } catch (error) {
    const combined = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    if (combined.includes("E404")) return { exists: false };
    throw error;
  }
}

async function main() {
  const nodeVersion = await readNodeVersion();

  const npmPackageState = await npmView(npmPackage);
  const npmVersionState = await npmView(`${npmPackage}@${nodeVersion}`);

  const summary = {
    npm: {
      package: npmPackage,
      version: nodeVersion,
      packageExists: npmPackageState.exists,
      versionExists: npmVersionState.exists
    }
  };

  console.log(JSON.stringify(summary, null, 2));

  if (npmVersionState.exists) {
    console.error("Refusing release: the target npm version is already published.");
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
