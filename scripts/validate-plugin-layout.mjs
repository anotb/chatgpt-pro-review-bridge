#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins/chatgpt-bridge");
const skill = path.join(plugin, "skills/chatgpt-bridge");
const required = [
  ".codex-plugin/plugin.json",
  "agents/openai.yaml",
  "assets/app-icon.svg",
  "assets/composer-icon.svg",
  "runtime/import-chatgpt-bridge.mjs",
  "runtime/node/chatgpt-bridge.bundle.mjs",
  "skills/chatgpt-bridge/SKILL.md",
  "skills/chatgpt-bridge/agents/openai.yaml"
];
for (const relative of required) {
  if (!existsSync(path.join(plugin, relative))) throw new Error(`Missing plugin file: ${relative}`);
}

const [manifest, marketplace, rootPackage, skillText, pluginAgent, skillAgent] = await Promise.all([
  json(path.join(plugin, ".codex-plugin/plugin.json")),
  json(path.join(root, ".agents/plugins/marketplace.json")),
  json(path.join(root, "package.json")),
  readFile(path.join(skill, "SKILL.md"), "utf8"),
  readFile(path.join(plugin, "agents/openai.yaml"), "utf8"),
  readFile(path.join(skill, "agents/openai.yaml"), "utf8")
]);
assert(manifest.name === "chatgpt-bridge", "Plugin ID is invalid.");
assert(manifest.version.split("+", 1)[0] === rootPackage.version, "Plugin base version differs from repository.");
assert(manifest.skills === "./skills/", "Plugin skills path is invalid.");
assert(manifest.mcpServers === undefined && manifest.apps === undefined, "Plugin must remain skill-only.");
assert(manifest.interface?.defaultPrompt?.length <= 3, "Plugin has too many default prompts.");
assert(marketplace.plugins?.length === 1, "Marketplace must contain one plugin.");
assert(marketplace.plugins[0]?.source?.path === "./plugins/chatgpt-bridge", "Marketplace path is invalid.");

const skills = (await readdir(path.join(plugin, "skills"), { withFileTypes: true }))
  .filter(entry => entry.isDirectory()).map(entry => entry.name);
assert(JSON.stringify(skills) === JSON.stringify(["chatgpt-bridge"]), "Plugin must contain one generic skill.");
const runtimeFiles = await readdir(path.join(plugin, "runtime/node"));
assert(JSON.stringify(runtimeFiles) === JSON.stringify(["chatgpt-bridge.bundle.mjs"]), "Plugin must contain one runtime bundle.");

const frontmatter = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1];
assert(frontmatter !== undefined, "Skill frontmatter is missing.");
const keys = frontmatter.split(/\r?\n/)
  .filter(line => /^[A-Za-z][A-Za-z0-9_-]*\s*:/.test(line))
  .map(line => line.split(":", 1)[0]).sort();
assert(JSON.stringify(keys) === JSON.stringify(["description", "name"]), "Skill frontmatter may contain only name and description.");
assert(/^name:\s*chatgpt-bridge\s*$/m.test(frontmatter), "Skill name is invalid.");
assert(skillText.includes("../../runtime/import-chatgpt-bridge.mjs"), "Skill does not use its runtime loader.");
assert(pluginAgent.includes("$chatgpt-bridge") && skillAgent.includes("$chatgpt-bridge"), "Agent metadata must invoke $chatgpt-bridge.");

const runtime = await import(pathToFileURL(path.join(plugin, "runtime/node/chatgpt-bridge.bundle.mjs")).href);
assert(typeof runtime.createChatGPTBridge === "function", "Bundle lacks createChatGPTBridge().");
assert(typeof runtime.createBridge === "function", "Bundle lacks the injected bridge seam.");
console.log("One-plugin layout is valid.");

async function json(file) { return JSON.parse(await readFile(file, "utf8")); }
function assert(condition, message) { if (!condition) throw new Error(message); }
