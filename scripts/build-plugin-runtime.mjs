#!/usr/bin/env node
import { copyFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { npmInvocation } from "./npm.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, "packages/node");
const source = path.join(packageDir, "dist/chatgpt-bridge.bundle.mjs");
const destinationDir = path.join(root, "plugins/chatgpt-bridge/runtime/node");
const destination = path.join(destinationDir, "chatgpt-bridge.bundle.mjs");

if (!process.argv.includes("--skip-build")) {
  for (const script of ["build", "bundle"]) {
    const npm = npmInvocation(["run", script]);
    execFileSync(npm.program, npm.args, { cwd: packageDir, stdio: "inherit" });
  }
}

await mkdir(destinationDir, { recursive: true });
await copyFile(source, destination);
console.log(`Plugin runtime updated: ${path.relative(root, destination)}`);
