import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** Node 24 cannot spawn Windows npm.cmd directly; use npm-cli.js when available. */
export function npmInvocation(args) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
  ];
  const cli = candidates.find(candidate => candidate && existsSync(candidate));
  if (cli) return { program: process.execPath, args: [cli, ...args] };
  if (process.platform === "win32") throw new Error("Unable to locate npm-cli.js.");
  return { program: "npm", args };
}
