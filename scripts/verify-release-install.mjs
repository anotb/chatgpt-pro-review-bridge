#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

import { npmInvocation } from "./lib/npm-command.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_ROOT = join(REPO_ROOT, "packages", "node");
const PYTHON_ROOT = join(REPO_ROOT, "packages", "python");
const NPM_PACKAGE = "chatgpt-pro-review-bridge";
const PYTHON_PACKAGE = "chatgpt-pro-review-bridge";
const PYTHON_IMPORT = "codex_chatgpt_control";
const NPM_REGISTRY = "https://registry.npmjs.org";
const REQUEST_SCHEMA = "chatgpt.browser_control.backend_request.v1";
const RESPONSE_SCHEMA = "chatgpt.browser_control.backend_response.v1";
const DEFAULT_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  const options = { mode: undefined, artifactsDir: undefined, timeoutMs: DEFAULT_TIMEOUT_MS };
  const selectMode = mode => {
    if (options.mode !== undefined && options.mode !== mode) {
      throw new Error("Choose exactly one mode: --source, --npm-registry, or --artifacts <dir>");
    }
    options.mode = mode;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") selectMode("source");
    else if (arg === "--npm-registry") selectMode("npm-registry");
    else if (arg === "--artifacts") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error("--artifacts requires a directory");
      options.artifactsDir = resolve(value);
    }
    else if (arg === "--timeout-ms") {
      const value = Number.parseInt(argv[++index] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout-ms must be a positive integer");
      options.timeoutMs = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/verify-release-install.mjs (--source|--npm-registry|--artifacts <dir>) [--artifacts <dir>] [--timeout-ms <ms>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.mode === undefined && options.artifactsDir !== undefined) selectMode("artifacts");
  if (options.mode === undefined) throw new Error("Choose a mode: --source, --npm-registry, or --artifacts <dir>");
  if (options.mode === "source" && options.artifactsDir !== undefined) {
    throw new Error("--source cannot be combined with --artifacts");
  }
  if ((options.mode === "artifacts" || options.mode === "npm-registry") && options.artifactsDir === undefined) {
    throw new Error(`${options.mode} mode requires --artifacts <dir> so the exact Python release assets are installed`);
  }
  return options;
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false
  });
  if (result.error) {
    throw new Error(`${program} ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(`${program} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

async function metadata() {
  const node = JSON.parse(await readFile(join(NODE_ROOT, "package.json"), "utf8"));
  const pythonText = await readFile(join(PYTHON_ROOT, "pyproject.toml"), "utf8");
  const pythonName = /^name\s*=\s*"([^"]+)"/m.exec(pythonText)?.[1];
  const pythonVersion = /^version\s*=\s*"([^"]+)"/m.exec(pythonText)?.[1];
  if (node.name !== NPM_PACKAGE || pythonName !== PYTHON_PACKAGE || !node.version || !pythonVersion) {
    throw new Error("Release package names or versions are inconsistent");
  }
  return { nodeVersion: node.version, pythonVersion };
}

async function waitForNpmVersion(version, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "registry metadata not checked";
  while (Date.now() <= deadline) {
    try {
      const npm = npmInvocation([
        "view",
        `${NPM_PACKAGE}@${version}`,
        "version",
        "--json",
        `--registry=${NPM_REGISTRY}`
      ]);
      const npmVersion = JSON.parse(run(npm.program, npm.args, { capture: true }));
      if (npmVersion === version) return;
      last = `npm=${String(npmVersion)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5_000));
  }
  throw new Error(`Timed out waiting for npm ${NPM_PACKAGE}@${version}: ${last}`);
}

async function buildPythonDistributions(root) {
  const pythonDist = join(root, "python-dist");
  await mkdir(pythonDist, { recursive: true });
  const python = process.env.PYTHON ?? (process.platform === "win32" ? "python.exe" : "python3");
  run(python, ["-m", "build", "--sdist", "--wheel", "--outdir", pythonDist, PYTHON_ROOT]);
  const files = await readdir(pythonDist);
  const wheel = files.find(file => file.endsWith(".whl"));
  const sdist = files.find(file => file.endsWith(".tar.gz"));
  if (wheel === undefined || sdist === undefined) throw new Error("Python build did not produce both a wheel and sdist");
  return [join(pythonDist, wheel), join(pythonDist, sdist)];
}

async function sourceSpecs(root) {
  const nodeDist = join(root, "node-dist");
  await mkdir(nodeDist, { recursive: true });
  const npm = npmInvocation(["pack", "--json", "--pack-destination", nodeDist]);
  const packed = JSON.parse(run(npm.program, npm.args, {
    cwd: NODE_ROOT,
    capture: true
  }));
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not return a tarball filename");
  return { nodeSpec: join(nodeDist, basename(filename)), pythonSpecs: await buildPythonDistributions(root), nodeRegistry: false };
}

async function artifactSpecs(artifactsDir, versions, nodeRegistry = false) {
  const expectedNames = [
    `node/${NPM_PACKAGE}-${versions.nodeVersion}.tgz`,
    `python/chatgpt_pro_review_bridge-${versions.pythonVersion}-py3-none-any.whl`,
    `python/chatgpt_pro_review_bridge-${versions.pythonVersion}.tar.gz`
  ];
  await verifyArtifactChecksums(artifactsDir, versions.nodeVersion, expectedNames);
  const nodeFiles = await readdir(join(artifactsDir, "node"));
  const pythonFiles = await readdir(join(artifactsDir, "python"));
  const nodeName = nodeFiles.find(file => file === `${NPM_PACKAGE}-${versions.nodeVersion}.tgz`);
  const wheel = pythonFiles.find(file => file === `chatgpt_pro_review_bridge-${versions.pythonVersion}-py3-none-any.whl`);
  const sdist = pythonFiles.find(file => file === `chatgpt_pro_review_bridge-${versions.pythonVersion}.tar.gz`);
  if (nodeName === undefined || wheel === undefined || sdist === undefined) {
    throw new Error(`Release artifacts do not contain the exact npm tarball, Python wheel, and Python sdist for ${versions.nodeVersion}`);
  }
  return {
    nodeSpec: nodeRegistry ? `${NPM_PACKAGE}@${versions.nodeVersion}` : join(artifactsDir, "node", nodeName),
    pythonSpecs: [join(artifactsDir, "python", wheel), join(artifactsDir, "python", sdist)],
    nodeRegistry
  };
}

async function verifyArtifactChecksums(artifactsDir, version, expectedNames) {
  const checksumName = `SHA256SUMS-${version}.txt`;
  const lines = (await readFile(join(artifactsDir, checksumName), "utf8")).split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error("Release checksum file is empty");
  const verified = new Set();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
    if (match === null) throw new Error(`Malformed release checksum line: ${line}`);
    const normalizedName = match[2].replaceAll("\\", "/");
    if (normalizedName.startsWith("/") || /^[a-z]:\//i.test(normalizedName)) {
      throw new Error(`Release checksum path must be relative: ${normalizedName}`);
    }
    const path = resolve(artifactsDir, ...normalizedName.split("/").filter(Boolean));
    const rel = relative(artifactsDir, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error(`Release checksum path escapes the artifact directory: ${normalizedName}`);
    }
    const actual = createHash("sha256").update(await readFile(path)).digest("hex");
    if (actual !== match[1]) throw new Error(`Release checksum mismatch for ${normalizedName}`);
    verified.add(normalizedName);
  }
  for (const expectedName of expectedNames) {
    if (!verified.has(expectedName)) throw new Error(`${checksumName} does not cover ${expectedName}`);
  }
}

async function npmRegistrySpecs(versions, timeoutMs, artifactsDir) {
  await waitForNpmVersion(versions.nodeVersion, timeoutMs);
  return artifactSpecs(artifactsDir, versions, true);
}

async function installAndVerify(root, specs, versions) {
  const nodeEnv = join(root, "node-env");
  await mkdir(nodeEnv, { recursive: true });
  await writeFile(join(nodeEnv, "package.json"), '{"private":true,"type":"module"}\n', "utf8");
  const npmInstallArgs = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (specs.nodeRegistry) npmInstallArgs.push(`--registry=${NPM_REGISTRY}`);
  npmInstallArgs.push(specs.nodeSpec);
  const npm = npmInvocation(npmInstallArgs);
  run(npm.program, npm.args, { cwd: nodeEnv });

  const installedNodeRoot = join(nodeEnv, "node_modules", NPM_PACKAGE);
  const installedNode = JSON.parse(await readFile(join(installedNodeRoot, "package.json"), "utf8"));
  if (installedNode.version !== versions.nodeVersion) {
    throw new Error(`Installed npm version ${installedNode.version} did not match ${versions.nodeVersion}`);
  }
  const sdk = await import(`${pathToFileURL(join(installedNodeRoot, "dist", "src", "index.js")).href}?t=${Date.now()}`);
  if (typeof sdk.createChatGPT !== "function") throw new Error("Installed npm package does not export createChatGPT");

  const backendPath = join(installedNodeRoot, "dist", "src", "scripts", "backend-server.js");
  const health = await backendRequest(backendPath, "backend.health");
  if (health?.ok !== true || health?.status !== "ok") {
    throw new Error("Installed backend health check did not report ok");
  }
  const capabilities = await backendRequest(backendPath, "backend.capabilities");
  if (capabilities?.protocolVersion !== REQUEST_SCHEMA) {
    throw new Error("Installed backend capabilities returned an unexpected protocol version");
  }

  const backendLiteral = backendPath.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  for (const [index, pythonSpec] of specs.pythonSpecs.entries()) {
    const pythonEnv = join(root, `python-env-${index}`);
    const python = process.env.PYTHON ?? (process.platform === "win32" ? "python.exe" : "python3");
    run(python, ["-m", "venv", pythonEnv]);
    const venvPython = process.platform === "win32"
      ? join(pythonEnv, "Scripts", "python.exe")
      : join(pythonEnv, "bin", "python");
    const venvCli = process.platform === "win32"
      ? join(pythonEnv, "Scripts", "chatgpt-thread.exe")
      : join(pythonEnv, "bin", "chatgpt-thread");
    run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", pythonSpec]);
    const pythonCheck = [
      "from importlib.metadata import version",
      `import ${PYTHON_IMPORT}`,
      `assert version('${PYTHON_PACKAGE}') == '${versions.pythonVersion}'`,
      `from ${PYTHON_IMPORT} import BackendClient, ChatGPT, StdioBackendTransport`,
      `transport = StdioBackendTransport(command=['node', r'${backendLiteral}'], timeout_seconds=30)`,
      "client = BackendClient(transport)",
      "health = client.health()",
      "assert health['ok'] is True and health['status'] == 'ok'",
      "capabilities = client.capabilities()",
      `assert capabilities['protocolVersion'] == '${REQUEST_SCHEMA}'`,
      "assert isinstance(client.request('commands'), list)",
      "client.close()"
    ].join("; ");
    run(venvPython, ["-c", pythonCheck]);
    run(venvCli, ["--help"]);
  }
  return {
    nodeVersion: installedNode.version,
    pythonVersion: versions.pythonVersion,
    backendProtocol: capabilities.protocolVersion
  };
}

function backendRequest(backendPath, commandName) {
  return new Promise((resolveRequest, rejectRequest) => {
    const child = spawn("node", [backendPath], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      callback(value);
    };
    const timer = setTimeout(
      () => finish(rejectRequest, new Error(`Installed backend ${commandName} request timed out`)),
      30_000
    );
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.on("data", chunk => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(stdout.slice(0, newline));
        if (response.schemaVersion !== RESPONSE_SCHEMA || response.ok !== true) {
          throw new Error(`Unexpected backend response: ${stdout.slice(0, newline)}`);
        }
        finish(resolveRequest, response.result);
      } catch (error) {
        finish(rejectRequest, error);
      }
    });
    child.on("error", error => finish(rejectRequest, error));
    child.on("exit", code => {
      if (!settled) {
        finish(rejectRequest, new Error(`Installed backend exited ${String(code)}: ${stderr.trim()}`));
      }
    });
    child.stdin.write(`${JSON.stringify({
      schemaVersion: REQUEST_SCHEMA,
      command: commandName,
      payload: {},
      requestId: `package_install_smoke_${commandName.replaceAll(".", "_")}`
    })}\n`);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const versions = await metadata();
  const root = await mkdtemp(join(tmpdir(), "codex-chatgpt-control-release-smoke-"));
  try {
    const specs = options.mode === "source"
      ? await sourceSpecs(root)
      : options.mode === "artifacts"
        ? await artifactSpecs(options.artifactsDir, versions)
        : await npmRegistrySpecs(versions, options.timeoutMs, options.artifactsDir);
    const verified = await installAndVerify(root, specs, versions);
    console.log(JSON.stringify({ ok: true, mode: options.mode, ...verified }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
