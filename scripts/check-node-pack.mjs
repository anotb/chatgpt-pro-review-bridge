#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";

import { npmInvocation } from "./npm.mjs";

const npm = npmInvocation(["pack", "--dry-run", "--json"]);
const output = execFileSync(npm.program, npm.args, {
  cwd: new URL("../packages/node", import.meta.url),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
const pack = JSON.parse(output)[0];
if (pack === undefined) throw new Error("npm pack returned no summary.");
const files = pack.files.map(file => file.path).sort();
const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/chatgpt-bridge.bundle.mjs"
];
const missing = required.filter(file => !files.includes(file));
const forbidden = files.filter(file => /^(?:src|tests)\//.test(file) || /\.map$/.test(file));
console.log(JSON.stringify({
  name: pack.name,
  version: pack.version,
  files: files.length,
  unpackedSize: pack.unpackedSize,
  missing,
  forbidden
}, null, 2));
if (missing.length > 0 || forbidden.length > 0) process.exitCode = 1;
