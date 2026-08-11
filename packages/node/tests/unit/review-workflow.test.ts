import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCodeReviewWithPort, type ReviewWorkflowPort } from "../../src/reviews/code-review.js";
import type {
  ArtifactInventoryData,
  CommandResult,
  ConfigurationInspectionData,
  ConfigurationSnapshotData,
  DownloadedFile
} from "../../src/types.js";

const beforeInspection: ConfigurationInspectionData = {
  experience: "chat",
  selectorProfile: "chat_simplified_v1",
  availableAxes: ["intelligence"],
  active: { intelligence: "Instant" },
  options: {},
  verified: true,
  evidence: []
};
const proInspection: ConfigurationInspectionData = {
  ...beforeInspection,
  active: { intelligence: "Pro" }
};
const snapshot: ConfigurationSnapshotData = {
  capturedAt: "2026-08-11T12:00:00.000Z",
  experience: "chat",
  selectorProfile: "chat_simplified_v1",
  selection: { intelligence: "Instant" },
  inspection: beforeInspection
};
const baseline: ArtifactInventoryData = { capturedAt: "before", items: [] };

describe("Pro review state machine", () => {
  it("submits once, polls metadata, reads full Markdown once, downloads all delta artifacts, and restores", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    let waitCalls = 0;
    const port = makePort(calls, {
      waitMetadata: async () => {
        waitCalls += 1;
        return waitCalls === 1
          ? failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
          : success({ complete: true, assistantTurnCount: 1, elapsedMs: 20, responseChars: 400, responseSha256: "abc", responseContent: "metadata" });
      },
      artifactDelta: async () => success({
        baseline,
        current: { capturedAt: "after", items: [] },
        added: [
          { key: "file", kind: "file", assistantIndex: 0, filename: "review.csv", tag: "button", occurrenceIndex: 0, downloadAvailable: true },
          {
            key: "image",
            kind: "image",
            artifact: { kind: "image", index: 0, visible: true, alt: "canary image", turnId: "conversation-turn-2", downloadAvailable: true, selectorProvenance: "fixture" }
          }
        ]
      })
    });

    const result = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      output: { mode: "full", archiveRoot: ".codex/pro-reviews", downloadArtifacts: "all" },
      polling: { callTimeoutMs: 10, totalTimeoutMs: 30, maxPollCallsPerInvocation: 2, stableMs: 1, pollMs: 1 }
    }, port);

    expect(result.status).toBe("completed");
    expect(result.responseMarkdown).toContain("# Complete review");
    expect(result.submitted).toBe(true);
    expect(result.resubmitAllowed).toBe(false);
    expect(result.configuration).toMatchObject({
      verifiedBeforeSubmit: true,
      verifiedAfterCompletion: true,
      restored: true,
      restorationVerified: true
    });
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every(item => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
    expect(calls.filter(call => call === "submit")).toHaveLength(1);
    expect(calls.filter(call => call === "readFullMarkdown")).toHaveLength(1);
    expect(calls.filter(call => call === "waitMetadata")).toHaveLength(2);
    expect(calls.indexOf("restoreConfiguration")).toBeGreaterThan(calls.indexOf("artifactDelta"));
    expect(await readFile(join(result.archiveDirectory!, "response.md"), "utf8")).toBe(result.responseMarkdown);
    expect(JSON.parse(await readFile(join(result.archiveDirectory!, "artifacts", "manifest.json"), "utf8"))).toHaveLength(2);
  });

  it("returns resumable in_progress evidence after a possible submission and never reads or resubmits", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    const port = makePort(calls, {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    });

    const result = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, port);

    expect(result).toMatchObject({
      ok: false,
      status: "in_progress",
      submitted: true,
      resubmitAllowed: false,
      nextAction: "poll_same_thread",
      thread: { url: "https://chatgpt.com/c/review-thread" }
    });
    expect(calls.filter(call => call === "submit")).toHaveLength(1);
    expect(calls).not.toContain("readFullMarkdown");
    expect(calls).toContain("restoreConfiguration");
  });

  it("fails closed when Pro drifts after completion while preserving the raw response archive", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    const port = makePort(calls, {
      inspectConfiguration: async () => success(beforeInspection)
    });

    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, port);

    expect(result.status).toBe("blocked");
    expect(result.blocker).toMatchObject({ kind: "model_fallback", code: "pro_postcondition_unverified" });
    expect(result.responseMarkdown).toBeUndefined();
    expect(result.provenance.responseSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(result.archiveDirectory!, "response.md"), "utf8")).toContain("# Complete review");
    expect(calls).toContain("restoreConfiguration");
  });

  it("resumes the same archived thread without attaching or submitting again", async () => {
    const repo = await fixtureRepository();
    const firstCalls: string[] = [];
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort(firstCalls, {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    const resumeCalls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: {
        threadUrl: first.thread!.url!,
        submitted: true,
        archiveDirectory: first.archiveDirectory!,
        artifactBaseline: baseline
      }
    }, makePort(resumeCalls));

    expect(resumed.status).toBe("completed");
    expect(resumeCalls).toContain("openThread");
    expect(resumeCalls).not.toContain("newThread");
    expect(resumeCalls).not.toContain("attach");
    expect(resumeCalls).not.toContain("compose");
    expect(resumeCalls).not.toContain("submit");
    expect(resumeCalls.filter(call => call === "readFullMarkdown")).toHaveLength(1);
  });

  it("returns an explicit index while preserving the complete archived response", async () => {
    const repo = await fixtureRepository();
    const result = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      output: { mode: "indexed" }
    }, makePort([]));

    expect(result.status).toBe("completed");
    expect(result.responseMarkdown).toBeUndefined();
    expect(result.responseIndex).toEqual(expect.arrayContaining([expect.objectContaining({ heading: "Complete review" })]));
    expect(await readFile(join(result.archiveDirectory!, "response.md"), "utf8")).toContain("No material defects");
  });

  it("surfaces restoration failure as a non-ok completed warning with a structured blocker", async () => {
    const repo = await fixtureRepository();
    const restoreFailure: CommandResult<{ restored: false }> = {
      ok: false,
      status: "blocked",
      data: { restored: false },
      warnings: [],
      blocker: { kind: "configuration_restore_failed", code: "restore_failed", message: "Visible prior setting is unavailable.", resumable: false },
      context: context()
    };
    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([], {
      restoreConfiguration: async () => restoreFailure as CommandResult<never>
    }));

    expect(result.status).toBe("completed_with_warnings");
    expect(result.ok).toBe(false);
    expect(result.blocker).toMatchObject({ kind: "configuration_restore_failed", code: "restore_failed" });
    expect(result.configuration.restorationVerified).toBe(false);
  });
});

function makePort(calls: string[], overrides: Partial<ReviewWorkflowPort> = {}): ReviewWorkflowPort {
  let tick = 0;
  const record = <T extends (...args: never[]) => unknown>(name: string, fn: T): T => ((...args: never[]) => {
    calls.push(name);
    return fn(...args);
  }) as T;
  const markdown = `# Complete review\n\nNo material defects.\n\n\`\`\`json\n[]\n\`\`\``;
  const defaults: ReviewWorkflowPort = {
    now: () => new Date(1786459200000 + tick++),
    bootstrap: record("bootstrap", async () => success({})),
    openChat: record("openChat", async () => success({})),
    newThread: record("newThread", async () => success({ url: "https://chatgpt.com/", title: "New chat" })),
    openThread: record("openThread", async url => success({ url, conversationId: "review-thread" })),
    snapshotConfiguration: record("snapshotConfiguration", async () => success(snapshot)),
    applyPro: record("applyPro", async () => success({ requested: { intelligence: "Pro" }, selected: [{ axis: "intelligence", requested: "Pro", selected: "Pro" }], before: beforeInspection, after: proInspection, verified: true })),
    inspectConfiguration: record("inspectConfiguration", async () => success(proInspection)),
    restoreConfiguration: record("restoreConfiguration", async () => success({ snapshot, restored: true, after: beforeInspection })),
    pageState: record("pageState", async () => ({ url: "https://chatgpt.com/c/review-thread", conversationId: "review-thread", title: "Review", visibleText: "New chat Search chats", signedIn: true })),
    artifactBaseline: record("artifactBaseline", async () => success(baseline)),
    artifactDelta: record("artifactDelta", async () => success({ baseline, current: baseline, added: [] })),
    attach: record("attach", async () => success({ attached: true })),
    messageStatus: record("messageStatus", async () => success({ turnCount: 0, assistantTurnCount: 0, completionState: "unknown", generationActive: false, generationSignals: [] })),
    compose: record("compose", async () => success({})),
    submit: record("submit", async () => ({ ...success({ submitted: true, turnCount: 1, submissionState: "submitted" }), context: context("https://chatgpt.com/c/review-thread") })),
    waitMetadata: record("waitMetadata", async () => success({ complete: true, assistantTurnCount: 1, elapsedMs: 10, responseChars: markdown.length, responseSha256: "abc", responseContent: "metadata" })),
    readFullMarkdown: record("readFullMarkdown", async () => success({ role: "assistant", text: markdown, markdown, format: "markdown" })),
    downloadFile: record("downloadFile", async (destDir: string, filename: string) => downloaded(destDir, filename, "file-body")),
    downloadImage: record("downloadImage", async (destDir: string, index: number) => downloaded(destDir, `image-${index}.png`, "image-body"))
  };
  return { ...defaults, ...Object.fromEntries(Object.entries(overrides).map(([name, fn]) => [name, typeof fn === "function" ? record(name, fn as (...args: never[]) => unknown) : fn])) } as ReviewWorkflowPort;
}

async function downloaded(destDir: string, filename: string, body: string): Promise<CommandResult<DownloadedFile>> {
  await mkdir(destDir, { recursive: true });
  const path = join(destDir, filename);
  await writeFile(path, body);
  return success({ path, suggestedFilename: filename, bytes: Buffer.byteLength(body) });
}

function success<T>(data: T): CommandResult<T> {
  return { ok: true, status: "ok", data, warnings: [], context: context() };
}

function failure<T>(status: CommandResult<T>["status"], data: T): CommandResult<T> {
  return { ok: false, status, data, warnings: [], context: context() };
}

function context(url = "https://chatgpt.com/") {
  return { timestamp: "2026-08-11T12:00:00.000Z", url };
}

async function fixtureRepository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "chatgpt-pro-review-workflow-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "example.ts"), "export const value = 1;\n");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Workflow Test");
  git(repo, "config", "user.email", "workflow-test@example.invalid");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  await writeFile(join(repo, "src", "example.ts"), "export const value = 2;\n");
  return repo;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}
