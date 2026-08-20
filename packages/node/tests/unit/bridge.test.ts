import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { createBridge } from "../../src/bridge/bridge.js";
import { readOperationRecord } from "../../src/bridge/journal.js";
import type { BridgeObservedArtifact, BridgeResponseSnapshot } from "../../src/bridge/output.js";
import type { BridgeObservation, BridgePort, BridgeSubmission } from "../../src/bridge/port.js";
import type { BridgeHandle, BridgeTargetSnapshot, BridgeThread } from "../../src/bridge/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("lean ChatGPT bridge", () => {
  it("persists the attempt before visible file handoff and its one Send activation", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    let phaseDuringSend: string | undefined;
    let presentationDuringSend: string[] | undefined;
    let journalExistedDuringTool = true;
    port.onTool = async () => {
      try {
        await readdir(stateDir);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
          journalExistedDuringTool = false;
          return;
        }
        throw error;
      }
    };
    port.onSubmit = async () => {
      const [name] = await readdir(stateDir);
      const record = await readOperationRecord(join(stateDir, name!));
      phaseDuringSend = record.phase;
      presentationDuringSend = record.handle.promptPresentationSha256s;
    };
    const result = await createTestBridge(port, stateDir).submit({
      operationId: "file-send",
      prompt: "Review this design.",
      selection: { power: "Pro" },
      tools: ["Web search"],
      files: ["C:/fixtures/design.md"]
    });

    expect(phaseDuringSend).toBe("prepared");
    expect(presentationDuringSend).toEqual(["d".repeat(64)]);
    expect(journalExistedDuringTool).toBe(false);
    expect(result.phase).toBe("submitted");
    expect(port.submitCalls).toBe(1);
    expect(port.events).toEqual([
      "files:preflight:1",
      "bind:new",
      "targets:inspect",
      "target:power=Pro",
      "targets:inspect",
      "compose",
      "tool:Web search",
      "presentations:hash",
      "attach:1",
      "presentations:hash",
      "submit"
    ]);
  });

  it("leaves reversible tool failures outside the durable attempt boundary", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    port.onTool = async () => {
      throw Object.assign(new Error("tool row is temporarily unavailable"), {
        code: "tool_unavailable",
        uncertain: false
      });
    };

    await expect(createTestBridge(port, stateDir).submit({
      operationId: "tool-not-ready",
      prompt: "Use the exact tool.",
      tools: ["Web search"],
      files: ["C:/fixtures/context.txt"]
    })).rejects.toMatchObject({ code: "tool_unavailable" });

    expect(port.events).toEqual([
      "files:preflight:1",
      "bind:new",
      "compose",
      "tool:Web search"
    ]);
    await expect(readdir(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not journal, compose, or Send when visible Power is genuinely ambiguous", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    port.onInspect = async () => {
      throw Object.assign(new Error("Visible Power control is ambiguous."), {
        code: "power_ambiguous"
      });
    };

    await expect(createTestBridge(port, stateDir).submit({
      operationId: "ambiguous-power",
      prompt: "Do not send this.",
      selection: { power: "Pro" }
    })).rejects.toMatchObject({ code: "power_ambiguous" });

    expect(port.events).toEqual(["bind:new", "targets:inspect"]);
    expect(port.submitCalls).toBe(0);
    await expect(readdir(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves an exact pre-handoff composer conflict outside the journal", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    port.onPresentation = async () => {
      throw new Error("composer contains an unrequested staged attachment");
    };

    await expect(createTestBridge(port, stateDir).submit({
      operationId: "staged-file-conflict",
      prompt: "Prompt-only request."
    })).rejects.toThrow("unrequested staged attachment");

    expect(port.events).toEqual(["bind:new", "compose", "presentations:hash"]);
    expect(port.submitCalls).toBe(0);
    await expect(readdir(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects deterministic file failures before journaling or visible browser work", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    port.onPreflight = async () => {
      throw Object.assign(new Error("missing local file"), {
        code: "file_not_readable",
        uncertain: false
      });
    };

    await expect(createTestBridge(port, stateDir).submit({
      operationId: "invalid-file",
      prompt: "Use the missing file.",
      selection: { power: "Pro" },
      files: ["C:/fixtures/missing.txt"]
    })).rejects.toMatchObject({ code: "file_not_readable", uncertain: false });

    expect(port.events).toEqual(["files:preflight:1"]);
    await expect(readdir(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("journals ambiguous preparation so the same ID cannot repeat file handoff", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    let phaseDuringAttach: string | undefined;
    port.onAttach = async () => {
      const [name] = await readdir(stateDir);
      phaseDuringAttach = (await readOperationRecord(join(stateDir, name!))).phase;
      throw Object.assign(new Error("handoff acknowledgement lost at C:/fixtures/input.txt"), {
        code: "file_handoff_uncertain",
        cause: new Error("private cause for input.txt")
      });
    };
    const bridge = createTestBridge(port, stateDir);
    const request = {
      operationId: "stable-preparation",
      prompt: "Use the file.",
      selection: { power: "Pro" },
      files: ["C:/fixtures/input.txt"]
    };

    const first = await bridge.submit(request);
    expect(first.phase).toBe("uncertain");
    expect(first.selection).toBeUndefined();
    expect(first.blocker).toEqual({
      code: "file_handoff_uncertain",
      message: "Visible preparation could not be completed safely.",
      resumable: false
    });
    expect(phaseDuringAttach).toBe("prepared");
    const journal = await readFile(first.handle.statePath!, "utf8");
    expect(journal).toContain("file_handoff_uncertain");
    expect(journal).not.toContain("C:/fixtures");
    expect(journal).not.toContain("input.txt");
    expect(journal).not.toContain("private cause");
    const restarted = fakePort();
    const restartedBridge = createTestBridge(restarted, stateDir);
    const recovered = await restartedBridge.submit(request);
    expect(recovered.handle).toEqual(first.handle);
    const notResumed = await restartedBridge.collect(recovered.handle);
    expect(notResumed.blocker).toEqual(first.blocker);
    expect(restarted.events).toEqual([]);
    expect(port.submitCalls).toBe(0);
  });

  it("does not journal an unrecognized error code or private preparation text", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    port.onAttach = async () => {
      throw Object.assign(new Error("private-file.txt at C:/private"), {
        code: "private_file_txt"
      });
    };
    const result = await createTestBridge(port, stateDir).submit({
      operationId: "redacted-preparation",
      prompt: "Use the file.",
      files: ["C:/private/private-file.txt"]
    });

    expect(result.blocker).toEqual({
      code: "preparation_uncertain",
      message: "Visible preparation could not be completed safely.",
      resumable: false
    });
    const journal = await readFile(result.handle.statePath!, "utf8");
    expect(journal).not.toContain("private_file_txt");
    expect(journal).not.toContain("private-file.txt");
    expect(journal).not.toContain("C:/private");
  });

  it("serializes overlapping same-ID calls before any browser mutation repeats", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    const bridge = createTestBridge(port, stateDir);
    const request = {
      operationId: "overlap-id",
      prompt: "Exactly one browser operation.",
      files: ["C:/fixtures/input.txt"]
    };

    const [first, second] = await Promise.all([
      bridge.submit(request),
      bridge.submit(request)
    ]);
    expect(second.handle).toEqual(first.handle);
    expect(port.submitCalls).toBe(1);
    expect(port.events.filter(event => event === "attach:1")).toHaveLength(1);
  });

  it("turns an ambiguous or thrown Send into collect-only uncertainty", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    port.submission = { confirmed: false };
    const bridge = createTestBridge(port, stateDir);
    const submitted = await bridge.submit({ operationId: "ambiguous-send", prompt: "One attempt only." });
    expect(submitted.blocker).toMatchObject({ code: "operation_uncertain", resumable: true });
    const collected = await bridge.collect(submitted.handle);
    expect(collected.phase).toBe("submitted");
    expect(port.submitCalls).toBe(1);

    const otherDir = await temporaryStateDir();
    const thrown = fakePort();
    thrown.submitError = new Error("click acknowledgement unavailable");
    const result = await createTestBridge(thrown, otherDir).submit({
      operationId: "thrown-send",
      prompt: "No fallback."
    });
    expect(result).toMatchObject({
      phase: "uncertain",
      blocker: { code: "operation_uncertain", resumable: true }
    });
    expect(thrown.submitCalls).toBe(1);
  });

  it("recovers a successful Send when receipt persistence failed after activation", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    let statePath: string | undefined;
    port.onSubmit = async () => {
      const [name] = await readdir(stateDir);
      statePath = join(stateDir, name!);
      await writeFile(`${statePath}.lock`, "concurrent-owner", { flag: "wx" });
    };
    const input = {
      operationId: "receipt-write-failed",
      prompt: "first line\nsecond line"
    };

    await expect(createTestBridge(port, stateDir).submit(input))
      .rejects.toMatchObject({ code: "operation_busy" });
    const prepared = await readOperationRecord(statePath!);
    expect(prepared).toMatchObject({
      phase: "prepared",
      handle: { promptPresentationSha256s: ["d".repeat(64)] }
    });
    expect(port.submitCalls).toBe(1);
    await unlink(`${statePath}.lock`);

    const restarted = fakePort();
    restarted.observations.push({
      phase: "completed",
      responseOwned: true,
      userTurnId: "user-message-1",
      assistantTurnId: "assistant-message-1"
    });
    restarted.markdown = "Recovered Markdown";
    const recovered = await createTestBridge(restarted, stateDir).run(input);
    expect(recovered).toMatchObject({
      phase: "completed",
      handle: {
        userTurnId: "user-message-1",
        assistantTurnId: "assistant-message-1"
      },
      output: { markdown: "Recovered Markdown", fidelity: "clipboard_markdown" }
    });
    expect(restarted.submitCalls).toBe(0);
  });

  it("reconciles an uncertain handle by reads without another submission", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    port.submission = { confirmed: false };
    const bridge = createTestBridge(port, stateDir);
    const submitted = await bridge.submit({
      operationId: "lost-acknowledgement",
      prompt: "Lost acknowledgement."
    });
    port.observations.push({ phase: "generating", responseOwned: true });
    const result = await bridge.collect(submitted.handle);
    expect(result).toMatchObject({ phase: "generating" });
    expect(result.output).toBeUndefined();
    expect(port.submitCalls).toBe(1);
  });

  it("persists the user identity immediately and the assistant identity only at completion", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    port.submission = { ...port.submission, userTurnId: "user-message-1" };
    port.observations.push({
      phase: "generating",
      responseOwned: true,
      userTurnId: "user-message-1",
      assistantTurnId: "request-placeholder-1"
    }, {
      phase: "completed",
      responseOwned: true,
      userTurnId: "user-message-1",
      assistantTurnId: "assistant-message-1"
    });
    const bridge = createTestBridge(port, stateDir);
    const submitted = await bridge.submit({
      operationId: "durable-turns",
      prompt: "Keep exact turn affinity."
    });
    expect(submitted.handle.userTurnId).toBe("user-message-1");

    const observed = await bridge.collect(submitted.handle);
    expect(observed.handle).toMatchObject({
      userTurnId: "user-message-1"
    });
    expect(observed.handle.assistantTurnId).toBeUndefined();
    const completed = await bridge.collect(observed.handle);
    expect(completed.handle).toMatchObject({
      userTurnId: "user-message-1",
      assistantTurnId: "assistant-message-1"
    });
    await expect(readOperationRecord(completed.handle.statePath!)).resolves.toMatchObject({
      handle: {
        userTurnId: "user-message-1",
        assistantTurnId: "assistant-message-1"
      }
    });
  });

  it("rejects completion without owned assistant output", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    const bridge = createTestBridge(port, stateDir);
    const submitted = await bridge.submit({
      operationId: "owned-response",
      prompt: "Owned response only."
    });
    port.observations.push({ phase: "completed", responseOwned: false });
    const result = await bridge.collect(submitted.handle);
    expect(result.phase).toBe("uncertain");
    expect(result.blocker?.message).toContain("ownership");
  });

  it("polls metadata then captures exact Markdown and owned artifacts once", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    port.observations.push(
      { phase: "generating", responseOwned: true },
      { phase: "completed", responseOwned: true }
    );
    port.markdown = "# Exact\n\n- result  \n";
    port.artifacts = [{ key: "b".repeat(64), kind: "file", name: "new.csv" }];
    let clock = Date.parse("2026-08-14T12:00:00.000Z");
    const bridge = createBridge({
      port,
      stateDir,
      now: () => new Date(clock),
      sleep: async milliseconds => { clock += milliseconds; }
    });
    const result = await bridge.run({
      operationId: "capture-output",
      prompt: "Create the result.",
      wait: { timeoutMs: 5_000, pollMs: 10 },
      downloadDir: "C:/outputs"
    });
    expect(result).toMatchObject({
      phase: "completed",
      output: {
        markdown: port.markdown,
        fidelity: "clipboard_markdown",
        artifacts: [{ kind: "file", name: "new.csv", path: "C:/outputs/new.csv", bytes: 10 }]
      }
    });
    expect(port.submitCalls).toBe(1);
    expect(port.downloads).toEqual(["new.csv"]);
    expect(port.events.slice(-5)).toEqual([
      "observe",
      "bind:handle",
      "output:copy",
      "artifacts:list",
      "artifact:download"
    ]);
  });

  it("uses collect(wait:false) as cheap status and run(wait:false) never captures output", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    const bridge = createTestBridge(port, stateDir);
    const submitted = await bridge.run({
      operationId: "return-immediately",
      prompt: "Return immediately.",
      wait: false
    });
    expect(submitted.phase).toBe("submitted");
    expect(port.events).not.toContain("output:copy");

    port.events.length = 0;
    port.observations.push({ phase: "generating", responseOwned: true });
    const status = await bridge.collect(submitted.handle, { wait: false });
    expect(status.phase).toBe("generating");
    expect(port.events).toEqual(["bind:handle", "observe"]);
  });

  it("bounds polling sleep by the remaining timeout and at least one millisecond", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    port.observations.push(
      { phase: "generating", responseOwned: true },
      { phase: "generating", responseOwned: true },
      { phase: "generating", responseOwned: true }
    );
    let clock = Date.parse("2026-08-14T12:00:00.000Z");
    const sleeps: number[] = [];
    const bridge = createBridge({
      port,
      stateDir,
      now: () => new Date(clock),
      sleep: async milliseconds => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      }
    });
    const submitted = await bridge.submit({
      operationId: "bounded-wait",
      prompt: "Bound the wait."
    });
    const result = await bridge.collect(submitted.handle, {
      wait: { timeoutMs: 2, pollMs: 0.5 }
    });

    expect(result.phase).toBe("generating");
    expect(sleeps).toEqual([1, 1]);
  });

  it("makes caller-supplied operation IDs idempotent before browser interaction", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    const bridge = createTestBridge(port, stateDir);
    const input = { operationId: "stable-id", prompt: "Exactly once." };
    const first = await bridge.submit(input);
    port.events.length = 0;
    const second = await bridge.submit(input);
    expect(second.handle).toEqual(first.handle);
    expect(port.events).toEqual([]);
    expect(port.submitCalls).toBe(1);
    const restarted = fakePort();
    const recovered = await createTestBridge(restarted, stateDir).submit(input);
    expect(recovered.handle).toEqual(first.handle);
    expect(restarted.events).toEqual([]);
    await expect(bridge.submit({ ...input, prompt: "Different." })).rejects.toThrow("different request");
  });

  it("rejects a missing operation ID before browser interaction", async () => {
    const stateDir = await temporaryStateDir();
    const port = fakePort();
    const bridge = createTestBridge(port, stateDir);

    await expect(bridge.submit({ prompt: "Unsafe implicit identity." } as never))
      .rejects.toThrow("operation ID");
    expect(port.events).toEqual([]);
  });
});

function createTestBridge(port: FakePort, stateDir: string) {
  return createBridge({
    port,
    stateDir,
    now: () => new Date("2026-08-14T12:00:00.000Z"),
    sleep: async () => undefined
  });
}

type FakePort = BridgePort & {
  events: string[];
  submitCalls: number;
  downloads: string[];
  submission: BridgeSubmission;
  submitError?: Error;
  onSubmit?: () => Promise<void>;
  onPreflight?: () => Promise<void>;
  onTool?: (label: string) => Promise<void>;
  onInspect?: () => Promise<void>;
  onAttach?: () => Promise<void>;
  onPresentation?: () => Promise<void>;
  observations: BridgeObservation[];
  markdown?: string;
  response: BridgeResponseSnapshot;
  artifacts: BridgeObservedArtifact[];
};

function fakePort(): FakePort {
  const events: string[] = [];
  let targets: BridgeTargetSnapshot = {
    active: { power: "Instant" },
    options: { power: [{ label: "Instant", selected: true }, { label: "Pro", selected: false }] }
  };
  const port: FakePort = {
    events,
    submitCalls: 0,
    downloads: [],
    submission: {
      confirmed: true,
      threadUrl: "https://chatgpt.com/c/thread-1",
      conversationId: "thread-1",
      tabId: "tab-1",
      renderedPromptSha256: "a".repeat(64)
    },
    observations: [],
    response: { partial: false },
    artifacts: [],
    async preflightFiles(paths) {
      events.push(`files:preflight:${paths.length}`);
      await port.onPreflight?.();
    },
    async bindThread(thread: BridgeThread) {
      events.push(`bind:${typeof thread === "string" ? thread : "exact"}`);
      return binding();
    },
    async bindHandle() { events.push("bind:handle"); return binding(); },
    async inspectTargets() {
      events.push("targets:inspect");
      await port.onInspect?.();
      return targets;
    },
    async selectTarget(axis, label) {
      events.push(`target:${axis}=${label}`);
      targets = {
        active: { ...targets.active, [axis]: label },
        options: {
          ...targets.options,
          [axis]: (targets.options[axis] ?? []).map(option => ({
            ...option,
            selected: option.label === label
          }))
        }
      };
    },
    async selectTool(label) {
      events.push(`tool:${label}`);
      await port.onTool?.(label);
    },
    async attachFiles(paths) {
      events.push(`attach:${paths.length}`);
      await port.onAttach?.();
    },
    async composePrompt() { events.push("compose"); },
    async submissionPresentationSha256s() {
      events.push("presentations:hash");
      await port.onPresentation?.();
      return ["d".repeat(64)];
    },
    async submitPrompt() {
      events.push("submit");
      port.submitCalls += 1;
      await port.onSubmit?.();
      if (port.submitError !== undefined) throw port.submitError;
      return port.submission;
    },
    async observe() {
      events.push("observe");
      return port.observations.shift() ?? { phase: "submitted", responseOwned: false };
    },
    async copyResponseMarkdown() { events.push("output:copy"); return port.markdown; },
    async readResponseSnapshot() { events.push("output:dom"); return port.response; },
    async listArtifacts() { events.push("artifacts:list"); return port.artifacts; },
    async downloadArtifact(artifact, dir) {
      events.push("artifact:download");
      port.downloads.push(artifact.name ?? artifact.key);
      return { kind: artifact.kind, path: `${dir}/${artifact.name}`, bytes: 10 };
    }
  };
  return port;
}

function binding() {
  return {
    tabId: "tab-1",
    threadUrl: "https://chatgpt.com/",
    userTurnCount: 0,
    assistantTurnCount: 0
  };
}

async function temporaryStateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-bridge-core-"));
  roots.push(root);
  return join(root, "operations");
}
