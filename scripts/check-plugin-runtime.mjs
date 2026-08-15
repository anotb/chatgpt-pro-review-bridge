#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages/node/dist/chatgpt-bridge.bundle.mjs");
const runtime = path.join(root, "plugins/chatgpt-bridge/runtime/node/chatgpt-bridge.bundle.mjs");
const loader = path.join(root, "plugins/chatgpt-bridge/runtime/import-chatgpt-bridge.mjs");

const [sourceBytes, runtimeBytes, loaderText] = await Promise.all([
  readFile(source),
  readFile(runtime),
  readFile(loader, "utf8")
]);
const hash = value => createHash("sha256").update(value).digest("hex");
if (hash(sourceBytes) !== hash(runtimeBytes)) throw new Error("Plugin runtime bundle is stale.");
if (!loaderText.includes("./node/chatgpt-bridge.bundle.mjs")) {
  throw new Error("Plugin loader does not import the single bridge bundle.");
}
console.log(`Plugin runtime matches package bundle (${runtimeBytes.length} bytes).`);
