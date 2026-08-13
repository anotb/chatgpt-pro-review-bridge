import { describe, expect, it } from "vitest";

import {
  probeProcessLiveness,
  queryWindowsPid,
  tasklistPidResult,
  windowsTasklistPath,
  type ProcessLiveness
} from "../../src/reviews/process-liveness.js";

function signalError(code: string): (pid: number) => void {
  return () => {
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    throw error;
  };
}

describe("process liveness probing", () => {
  it("reports a process as live when signal zero succeeds", async () => {
    await expect(probeProcessLiveness(42, {
      signal: () => undefined
    })).resolves.toBe("live");
  });

  it("reports ESRCH as a dead process", async () => {
    await expect(probeProcessLiveness(42, {
      signal: signalError("ESRCH")
    })).resolves.toBe("dead");
  });

  it("does not treat POSIX EINVAL as proof that a process is dead", async () => {
    await expect(probeProcessLiveness(42, {
      platform: "linux",
      signal: signalError("EINVAL")
    })).resolves.toBe("unknown");
  });

  it.each(["EPERM", "EACCES"])("keeps POSIX %s fail-closed as a live process", async code => {
    let queriedWindows = false;
    await expect(probeProcessLiveness(42, {
      platform: "linux",
      signal: signalError(code),
      queryWindowsPid: async () => {
        queriedWindows = true;
        return "dead";
      }
    })).resolves.toBe("live");
    expect(queriedWindows).toBe(false);
  });

  it.each<ProcessLiveness>(["live", "dead", "unknown"])(
    "uses the exact Windows PID query after EPERM and preserves its %s result",
    async result => {
      await expect(probeProcessLiveness(42, {
        platform: "win32",
        signal: signalError("EPERM"),
        queryWindowsPid: async pid => {
          expect(pid).toBe(42);
          return result;
        }
      })).resolves.toBe(result);
    }
  );

  it("falls back to the exact Windows PID query for unrecognized signal failures", async () => {
    await expect(probeProcessLiveness(42, {
      platform: "win32",
      signal: signalError("UNKNOWN"),
      queryWindowsPid: async () => "dead"
    })).resolves.toBe("dead");
  });

  it("routes Windows EINVAL through the exact PID query", async () => {
    await expect(probeProcessLiveness(42, {
      platform: "win32",
      signal: signalError("EINVAL"),
      queryWindowsPid: async () => "live"
    })).resolves.toBe("live");
  });

  it("falls back to the exact Windows PID query when signal probing is unavailable", async () => {
    await expect(probeProcessLiveness(42, {
      platform: "win32",
      signal: () => {
        throw new TypeError("process.kill is not a function");
      },
      queryWindowsPid: async () => "dead"
    })).resolves.toBe("dead");
  });

  it("recognizes an exact PID in tasklist CSV output", () => {
    expect(tasklistPidResult('"node.exe","42","Console","1","12,000 K"\r\n', 42)).toBe("live");
  });

  it("resolves tasklist only from the absolute Windows system directory", async () => {
    expect(windowsTasklistPath({ SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\tasklist.exe");
    expect(windowsTasklistPath({ SystemRoot: "relative\\windows" })).toBeUndefined();
    let invocation: { executable: string; args: string[] } | undefined;
    await expect(queryWindowsPid(42, {
      environment: { SystemRoot: "D:\\TrustedWindows" },
      execute: async (executable, args) => {
        invocation = { executable, args };
        return '"node.exe","42","Console"\r\n';
      }
    })).resolves.toBe("live");
    expect(invocation).toEqual({
      executable: "D:\\TrustedWindows\\System32\\tasklist.exe",
      args: ["/FI", "PID eq 42", "/FO", "CSV", "/NH"]
    });
  });

  it("fails closed when the trusted Windows system directory is unavailable", async () => {
    await expect(queryWindowsPid(42, {
      environment: {},
      execute: async () => {
        throw new Error("must not execute");
      }
    })).resolves.toBe("unknown");
  });

  it("recognizes tasklist's explicit no-match result independent of locale", () => {
    expect(tasklistPidResult("INFO: No tasks are running which match the specified criteria.\r\n", 42)).toBe("dead");
    expect(tasklistPidResult("INFORMATION: Aucun processus ne correspond.\r\n", 42)).toBe("dead");
  });

  it("does not treat empty or malformed tasklist output as proof of death", () => {
    expect(tasklistPidResult("\r\n", 42)).toBe("unknown");
    expect(tasklistPidResult('"node.exe","not-a-pid"\r\n', 42)).toBe("unknown");
    expect(tasklistPidResult('"node.exe","41","Console"\r\n', 42)).toBe("unknown");
  });
});
