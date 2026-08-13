import { execFile } from "node:child_process";
import { platform as operatingSystemPlatform } from "node:os";
import { win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessLiveness = "live" | "dead" | "unknown";

type ProcessLivenessProbeOptions = {
  platform?: NodeJS.Platform;
  signal?: (pid: number) => void;
  queryWindowsPid?: (pid: number) => Promise<ProcessLiveness>;
};

type WindowsPidQueryOptions = {
  environment?: NodeJS.ProcessEnv;
  execute?: (executable: string, args: string[]) => Promise<string>;
};

// Windows resolves this device path through the kernel's SystemRoot link, so
// it remains absolute and does not depend on a repository-controlled cwd/PATH
// or on environment variables omitted by restricted browser hosts.
const WINDOWS_GLOBALROOT_TASKLIST = "\\\\.\\GLOBALROOT\\SystemRoot\\System32\\tasklist.exe";

function runtimeEnvironment(): NodeJS.ProcessEnv | undefined {
  try {
    return typeof process === "undefined" || process.env === undefined ? undefined : process.env;
  } catch {
    return undefined;
  }
}

function signalProcess(targetPid: number): void {
  if (typeof process === "undefined" || typeof process.kill !== "function") {
    throw new TypeError("process.kill is unavailable");
  }
  process.kill(targetPid, 0);
}

export async function probeProcessLiveness(
  pid: number,
  options: ProcessLivenessProbeOptions = {}
): Promise<ProcessLiveness> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  const platform = options.platform ?? operatingSystemPlatform();
  const signal = options.signal ?? signalProcess;
  try {
    signal(pid);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (platform !== "win32") {
      // On POSIX, EPERM/EACCES means the process exists but cannot be signalled.
      return code === "EPERM" || code === "EACCES" ? "live" : "unknown";
    }
    // A Windows sandbox can deny or omit the process handle, including by
    // making process.kill unavailable. Use a filtered system process query for
    // every indeterminate signal failure before deciding the lease is dead.
  }

  return (options.queryWindowsPid ?? queryWindowsPid)(pid);
}

function tasklistPathWithin(systemRoot: string | undefined): string | undefined {
  if (systemRoot === undefined || systemRoot.includes("\0") || !win32.isAbsolute(systemRoot)) return undefined;
  const normalizedRoot = win32.resolve(systemRoot);
  const executable = win32.join(normalizedRoot, "System32", "tasklist.exe");
  const relative = win32.relative(normalizedRoot, executable);
  if (relative.startsWith("..") || win32.isAbsolute(relative)) return undefined;
  return executable;
}

function windowsTasklistCandidates(environment: NodeJS.ProcessEnv | undefined): string[] {
  const candidates = [
    ...[environment?.SystemRoot, environment?.windir, environment?.WINDIR]
      .map(tasklistPathWithin)
      .filter((candidate): candidate is string => candidate !== undefined),
    WINDOWS_GLOBALROOT_TASKLIST
  ]
    .filter((candidate): candidate is string => candidate !== undefined);
  return candidates.filter((candidate, index) =>
    candidates.findIndex(other => other.toLocaleLowerCase("en-US") === candidate.toLocaleLowerCase("en-US")) === index
  );
}

export function windowsTasklistPath(environment: NodeJS.ProcessEnv | undefined = runtimeEnvironment()): string | undefined {
  return windowsTasklistCandidates(environment)[0];
}

export async function queryWindowsPid(
  pid: number,
  options: WindowsPidQueryOptions = {}
): Promise<ProcessLiveness> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  const args = ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"];
  for (const executable of windowsTasklistCandidates(options.environment ?? runtimeEnvironment())) {
    try {
      const stdout = options.execute === undefined
        ? (await execFileAsync(executable, args, {
            encoding: "utf8",
            maxBuffer: 64 * 1024,
            timeout: 2_000,
            windowsHide: true
          })).stdout
        : await options.execute(executable, args);
      return tasklistPidResult(stdout, pid);
    } catch {
      // A validated environment path can still be stale or unavailable. Try
      // the next absolute system-directory candidate without consulting PATH.
    }
  }
  return "unknown";
}

export function tasklistPidResult(output: string, pid: number): ProcessLiveness {
  let sawPlainTextResult = false;
  let sawCsvResult = false;
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^"[^"]*","(\d+)"(?:,|$)/u.exec(trimmed);
    if (match !== null && Number(match[1]) === pid) return "live";
    if (trimmed.startsWith('"')) sawCsvResult = true;
    else sawPlainTextResult = true;
  }
  // With /FO CSV /NH, a successful exact-PID query returns either a CSV row
  // for that PID or a localized plain-text no-match message. CSV that does not
  // identify the requested PID is ambiguous and must remain fail-closed.
  return sawPlainTextResult && !sawCsvResult ? "dead" : "unknown";
}
