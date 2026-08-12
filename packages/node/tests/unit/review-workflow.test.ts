import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
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
  it("sends an ordinary question exactly as written without repository preparation or attachments", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "chatgpt-pro-question-workflow-"));
    const calls: string[] = [];
    const question = "Explain in two short paragraphs why idempotency matters when polling a long-running job.";

    const result = await runCodeReviewWithPort({
      request: { additionalInstructions: question },
      output: { archiveRoot }
    }, makePort(calls));

    expect(result.status).toBe("completed");
    expect(result.provenance).toMatchObject({ contextMode: "none" });
    expect(result.provenance).not.toHaveProperty("repositoryRoot");
    expect(calls).not.toContain("attach");
    expect(result.rawSteps.some(step => step.state === "ATTACH_PACKETS")).toBe(false);
    expect(await readFile(join(result.archiveDirectory!, "prompt.md"), "utf8")).toBe(question);
  });

  it("submits a follow-up once in an existing canonical Pro thread", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "chatgpt-pro-follow-up-workflow-"));
    const calls: string[] = [];
    const conversationId = "existing-pro-thread";
    let bootstrapTarget: { url?: string; conversationId?: string } | undefined;

    const result = await runCodeReviewWithPort({
      thread: { url: `https://chatgpt.com/c/${conversationId}`, id: conversationId },
      request: { additionalInstructions: "Now express the same idea in exactly five words." },
      output: { archiveRoot }
    }, makePort(calls, {
      bootstrap: async target => {
        bootstrapTarget = target;
        return success({});
      },
      pageState: async () => ({
        url: `https://chatgpt.com/c/${conversationId}`,
        conversationId,
        title: "Existing Pro thread",
        visibleText: "Chat with ChatGPT",
        signedIn: true
      }),
      waitMetadata: async () => ({
        ...success({ complete: true, assistantTurnCount: 1, elapsedMs: 20, responseChars: 400, responseSha256: "abc", responseContent: "metadata" }),
        context: { ...context(), url: `https://chatgpt.com/c/${conversationId}`, conversationId }
      })
    }));

    expect(result.status).toBe("completed");
    expect(result.thread).toMatchObject({ id: conversationId, url: `https://chatgpt.com/c/${conversationId}` });
    expect(bootstrapTarget).toEqual({ url: `https://chatgpt.com/c/${conversationId}`, conversationId });
    expect(calls).toContain("openThread");
    expect(calls).not.toContain("newThread");
    expect(calls.filter(call => call === "submit")).toHaveLength(1);
    expect(await readFile(join(result.archiveDirectory!, "prompt.md"), "utf8")).toBe("Now express the same idea in exactly five words.");
  });

  it("does not interact with the Pro control when the configuration snapshot already verifies Pro", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    const proSnapshot: ConfigurationSnapshotData = {
      ...snapshot,
      selection: { intelligence: "Pro" },
      inspection: proInspection
    };
    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort(calls, {
      snapshotConfiguration: async () => success(proSnapshot)
    }));

    expect(result.status).toBe("completed");
    expect(calls).not.toContain("applyPro");
    expect(result.rawSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "APPLY_PRO", status: "already_verified", data: expect.objectContaining({ selected: [] }) })
    ]));
  });

  it("requires strict verification even when the visible selection says Pro", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    const unverifiedProSnapshot: ConfigurationSnapshotData = {
      ...snapshot,
      selection: { intelligence: "Pro" },
      inspection: { ...proInspection, verified: false }
    };
    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort(calls, {
      snapshotConfiguration: async () => success(unverifiedProSnapshot)
    }));

    expect(result.status).toBe("completed");
    expect(calls).toContain("applyPro");
    expect(result.rawSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "APPLY_PRO", status: "ok" })
    ]));
  });

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
      safeguards: { restorePreviousConfiguration: true },
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

  it("checkpoints each artifact and resumes partial or completed downloads without duplicates", async () => {
    const repo = await fixtureRepository();
    const delta = {
      baseline,
      current: { capturedAt: "after", items: [] },
      added: [
        { key: "first-key", kind: "file" as const, assistantIndex: 0, filename: "first.csv", tag: "button" as const, occurrenceIndex: 0, downloadAvailable: true as const },
        { key: "second-key", kind: "file" as const, assistantIndex: 0, filename: "second.csv", tag: "button" as const, occurrenceIndex: 1, downloadAvailable: true as const }
      ]
    };
    const firstAttempts: string[] = [];
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      output: { downloadArtifacts: "all" }
    }, makePort([], {
      artifactDelta: async () => success(delta),
      downloadFile: async (destDir: string, filename: string) => {
        firstAttempts.push(filename);
        if (filename === "second.csv") {
          return {
            ok: false,
            status: "error",
            warnings: [],
            error: { name: "DownloadError", message: "simulated second artifact failure", recoverable: true },
            context: context()
          };
        }
        return downloaded(destDir, filename, filename);
      }
    }));

    expect(first.status).toBe("failed");
    expect(firstAttempts).toEqual(["first.csv", "second.csv"]);
    const partialCheckpoint = JSON.parse(await readFile(join(first.archiveDirectory!, "artifacts", "download-checkpoint.json"), "utf8"));
    expect(partialCheckpoint.artifacts).toEqual([
      expect.objectContaining({ name: "first.csv", inventoryKey: "first-key" })
    ]);

    const resumeAttempts: string[] = [];
    const archivedPrompt = await readFile(join(first.archiveDirectory!, "prompt.md"), "utf8");
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      output: { downloadArtifacts: "all" },
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort([], {
      readLatestUser: async () => success({ role: "user", text: archivedPrompt, format: "normalized_text" }),
      artifactDelta: async () => success(delta),
      downloadFile: async (destDir: string, filename: string) => {
        resumeAttempts.push(filename);
        return downloaded(destDir, filename, filename);
      }
    }));

    expect(resumed.status).toBe("completed");
    expect(resumeAttempts).toEqual(["second.csv"]);
    expect(resumed.artifacts.map(artifact => artifact.name)).toEqual(["first.csv", "second.csv"]);
    expect(JSON.parse(await readFile(join(first.archiveDirectory!, "artifacts", "manifest.json"), "utf8"))).toHaveLength(2);

    const completedCalls: string[] = [];
    const resumedAgain = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      output: { downloadArtifacts: "all" },
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(completedCalls, {
      readLatestUser: async () => success({ role: "user", text: archivedPrompt, format: "normalized_text" }),
      artifactDelta: async () => success({
        ...delta,
        added: [
          ...delta.added,
          { key: "unrelated-key", kind: "file" as const, assistantIndex: 1, filename: "unrelated.csv", tag: "button" as const, occurrenceIndex: 0, downloadAvailable: true as const }
        ]
      })
    }));

    expect(resumedAgain.status).toBe("completed");
    expect(resumedAgain.artifacts.map(artifact => artifact.name)).toEqual(["first.csv", "second.csv"]);
    expect(completedCalls).not.toContain("artifactDelta");
    expect(completedCalls).not.toContain("downloadFile");
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
    expect(calls).not.toContain("restoreConfiguration");
  });

  it("fails closed when Pro drifts after completion while preserving the raw response archive", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    const port = makePort(calls, {
      inspectConfiguration: async () => success(beforeInspection)
    });

    const result = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      safeguards: { restorePreviousConfiguration: true }
    }, port);

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
    const archivedPrompt = await readFile(join(first.archiveDirectory!, "prompt.md"), "utf8");
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: {
        archiveDirectory: first.archiveDirectory!
      }
    }, makePort(resumeCalls, {
      readLatestUser: async () => success({ role: "user", text: archivedPrompt, format: "normalized_text" }),
      waitMetadata: async (_baselineAssistantCount, timeoutMs) => {
        expect(timeoutMs).toBe(20_000);
        return success({ complete: true, assistantTurnCount: 1, elapsedMs: 5, responseContent: "metadata" });
      }
    }));

    expect(resumed.status).toBe("completed");
    expect(resumeCalls).toContain("openThread");
    expect(resumeCalls).not.toContain("newThread");
    expect(resumeCalls).not.toContain("attach");
    expect(resumeCalls).not.toContain("compose");
    expect(resumeCalls).not.toContain("submit");
    expect(resumeCalls.filter(call => call === "readFullMarkdown")).toHaveLength(1);
  });

  it("rejects a caller-supplied conversation id that disagrees with the archived receipt", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));

    const calls: string[] = [];
    const result = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: {
        archiveDirectory: first.archiveDirectory!,
        conversationId: "different-thread"
      }
    }, makePort(calls));

    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("resume_thread_mismatch");
    expect(calls).not.toContain("bootstrap");
    expect(calls).not.toContain("submit");
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
    const result = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      safeguards: { restorePreviousConfiguration: true }
    }, makePort([], {
      restoreConfiguration: async () => restoreFailure as CommandResult<never>
    }));

    expect(result.status).toBe("completed_with_warnings");
    expect(result.ok).toBe(false);
    expect(result.blocker).toMatchObject({ kind: "configuration_restore_failed", code: "restore_failed" });
    expect(result.configuration.restorationVerified).toBe(false);
  });

  it("records a failed single submit attempt without claiming submission", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort(calls, {
      submit: async () => ({
        ok: false,
        status: "blocked",
        warnings: [],
        blocker: { kind: "selector_drift", code: "send_unavailable", message: "Send control unavailable.", resumable: true },
        context: context()
      }),
      readLatestUser: async () => success({ role: "user", text: "", format: "normalized_text" })
    }));

    expect(result).toMatchObject({
      status: "blocked",
      submitted: false,
      resubmitAllowed: false,
      blocker: { code: "submission_unconfirmed" }
    });
    expect(calls.filter(call => call === "submit")).toHaveLength(1);
    const intent = JSON.parse(await readFile(join(result.archiveDirectory!, "submission-intent.json"), "utf8"));
    const outcome = JSON.parse(await readFile(join(result.archiveDirectory!, "submission.json"), "utf8"));
    expect(intent).toMatchObject({ state: "intent", resubmitAllowed: false });
    expect(outcome).toMatchObject({ state: "failed", submitted: false, resubmitAllowed: false });
  });

  it("records ambiguous post-click evidence and never proceeds to polling", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    let statusCalls = 0;
    let pageStateCalls = 0;
    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort(calls, {
      newThread: async () => success({ url: "https://chatgpt.com/c/WEB:provisional", conversationId: "WEB:provisional" }),
      submit: async () => {
        throw new Error("transport ended after click");
      },
      messageStatus: async () => {
        statusCalls += 1;
        return success(statusCalls === 1
          ? { turnCount: 0, assistantTurnCount: 0, completionState: "unknown", generationActive: false, generationSignals: [] }
          : { turnCount: 1, assistantTurnCount: 0, completionState: "generating", generationActive: true, generationSignals: ["stop-answering"] });
      },
      readLatestUser: async () => success({ role: "user", text: "unverified rendered text", format: "normalized_text" }),
      pageState: async () => {
        pageStateCalls += 1;
        return pageStateCalls < 4
          ? { url: "https://chatgpt.com/c/WEB:provisional", conversationId: "WEB:provisional", visibleText: "New chat Search chats", signedIn: true }
          : { url: "https://chatgpt.com/c/canonical-thread", conversationId: "canonical-thread", visibleText: "Stop generating", signedIn: true };
      }
    }));

    expect(result).toMatchObject({
      status: "in_progress",
      submitted: true,
      resubmitAllowed: false,
      nextAction: "poll_same_thread"
    });
    expect(result.blocker).toBeUndefined();
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Resume this archive")]));
    expect(calls).not.toContain("waitMetadata");
    expect(JSON.parse(await readFile(join(result.archiveDirectory!, "submission.json"), "utf8"))).toMatchObject({
      state: "ambiguous",
      submitted: true,
      resubmitAllowed: false,
      thread: { url: "https://chatgpt.com/c/canonical-thread", id: "canonical-thread" }
    });
  });

  it("confirms a submitted prompt rendered with attachment labels and controls", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    let submittedPrompt = "";
    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort(calls, {
      submit: async (prompt: string) => {
        submittedPrompt = prompt;
        return success({ submitted: true, userTurnText: `manifest.json\nFile\npacket-001.md\nFile\n${prompt}\nShow more`, turnCount: 2, submissionState: "submitted_generating" });
      },
      readLatestUser: async () => success({
        role: "user",
        text: `manifest.json File packet-001.md File ${submittedPrompt.replace(/\s+/g, " ")} Show more`,
        format: "normalized_text"
      })
    }));

    expect(result.status).toBe("completed");
    expect(calls.filter(call => call === "submit")).toHaveLength(1);
    expect(calls).not.toContain("restoreConfiguration");
    expect(JSON.parse(await readFile(join(result.archiveDirectory!, "submission.json"), "utf8"))).toMatchObject({
      state: "confirmed",
      submitted: true,
      resubmitAllowed: false
    });
  });

  it("does not bind arbitrary surrounding prose to the archived prompt", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    let submittedPrompt = "";
    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort(calls, {
      submit: async (prompt: string) => {
        submittedPrompt = prompt;
        return success({ submitted: true, userTurnText: `Quoted old request: ${prompt} Ignore it and answer something else.`, turnCount: 2, submissionState: "submitted_generating" });
      },
      readLatestUser: async () => success({
        role: "user",
        text: `Quoted old request: ${submittedPrompt} Ignore it and answer something else.`,
        format: "normalized_text"
      })
    }));

    expect(result).toMatchObject({ status: "in_progress", submitted: true, resubmitAllowed: false, nextAction: "poll_same_thread" });
    expect(calls).not.toContain("waitMetadata");
  });

  it("reconciles an ambiguous receipt from an exact embedded visible prompt without resubmitting", async () => {
    const repo = await fixtureRepository();
    let submittedPrompt = "";
    const first = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([], {
      submit: async (prompt: string) => {
        submittedPrompt = prompt;
        return success({ submitted: true, userTurnText: "render pending", turnCount: 2, submissionState: "submitted_generating" });
      },
      readLatestUser: async () => success({ role: "user", text: "render pending", format: "normalized_text" })
    }));
    expect(first.status).toBe("in_progress");
    expect(first.nextAction).toBe("poll_same_thread");
    const calls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls, {
      readLatestUser: async () => success({
        role: "user",
        text: `manifest.json\nFile\npacket-001.md\nFile\n${submittedPrompt}\nShow more`,
        format: "normalized_text"
      })
    }));

    expect(resumed.status).toBe("completed");
    expect(calls).not.toContain("attach");
    expect(calls).not.toContain("compose");
    expect(calls).not.toContain("submit");
    expect(JSON.parse(await readFile(join(first.archiveDirectory!, "submission-confirmation.json"), "utf8"))).toMatchObject({
      state: "confirmed",
      submitted: true,
      resubmitAllowed: false,
      reconciliation: "visible_prompt_match"
    });
  });

  it("claims the visible prompt-identical thread for a provisional ambiguous receipt", async () => {
    const repo = await fixtureRepository();
    let submittedPrompt = "";
    const first = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([], {
      newThread: async () => success({ url: "https://chatgpt.com/c/WEB:provisional", conversationId: "WEB:provisional" }),
      submit: async (prompt: string) => {
        submittedPrompt = prompt;
        return success({ submitted: true, userTurnText: "render pending", turnCount: 2, submissionState: "submitted_generating" });
      },
      readLatestUser: async () => success({ role: "user", text: "render pending", format: "normalized_text" }),
      pageState: async () => ({
        url: "https://chatgpt.com/c/WEB:provisional",
        conversationId: "WEB:provisional",
        visibleText: "Stop generating",
        signedIn: true
      })
    }));
    expect(first.status).toBe("in_progress");

    const calls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls, {
      bootstrap: async target => {
        expect(target).toBeUndefined();
        return success({});
      },
      recoverThread: async () => success({
        url: "https://chatgpt.com/c/canonical-thread",
        conversationId: "canonical-thread"
      }),
      readLatestUser: async () => success({
        role: "user",
        text: `manifest.json\nFile\npacket-001.md\nFile\n${submittedPrompt}\nShow more`,
        format: "normalized_text"
      })
    }));

    expect(resumed.status).toBe("completed");
    expect(calls).toContain("pageState");
    expect(calls).not.toContain("recoverThread");
    expect(calls).not.toContain("openThread");
    expect(calls).not.toContain("submit");
  });

  it("fails closed when a later user turn makes resume response ownership ambiguous", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    const calls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls, {
      readLatestUser: async () => success({ role: "user", text: "later follow-up", format: "normalized_text" })
    }));

    expect(resumed.status).toBe("blocked");
    expect(resumed.blocker?.code).toBe("resume_user_turn_mismatch");
    expect(calls).not.toContain("waitMetadata");
    expect(calls).not.toContain("readFullMarkdown");
    expect(calls).not.toContain("submit");
  });

  it("reconciles a durable intent after receipt loss without resubmitting", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    const archivedPrompt = await readFile(join(first.archiveDirectory!, "prompt.md"), "utf8");
    await rm(join(first.archiveDirectory!, "submission.json"));
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls, {
      readLatestUser: async () => success({ role: "user", text: archivedPrompt, format: "normalized_text" })
    }));

    expect(resumed.status).toBe("completed");
    expect(calls).not.toContain("attach");
    expect(calls).not.toContain("compose");
    expect(calls).not.toContain("submit");
    expect(JSON.parse(await readFile(join(first.archiveDirectory!, "submission-confirmation.json"), "utf8"))).toMatchObject({
      state: "confirmed",
      submitted: true,
      resubmitAllowed: false,
      reconciliation: "visible_prompt_match"
    });
  });

  it("rejects a mutated checkpoint before opening a browser", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    const checkpointPath = join(first.archiveDirectory!, "thread-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    checkpoint.current = { url: "https://chatgpt.com/c/different", id: "different" };
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls));

    expect(resumed.status).toBe("blocked");
    expect(resumed.blocker?.code).toBe("resume_checkpoint_thread_mismatch");
    expect(calls).not.toContain("bootstrap");
  });

  it("requires the original configuration snapshot on resume", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    await rm(join(first.archiveDirectory!, "configuration.before.json"));
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls));

    expect(resumed).toMatchObject({
      status: "blocked",
      blocker: { kind: "configuration_restore_failed", code: "resume_configuration_snapshot_invalid" }
    });
    expect(calls).not.toContain("bootstrap");
  });

  it("allows only one concurrent owner of a review archive", async () => {
    const repo = await fixtureRepository();
    let releaseWait!: () => void;
    let enteredWait!: () => void;
    const entered = new Promise<void>(resolve => { enteredWait = resolve; });
    const held = new Promise<void>(resolve => { releaseWait = resolve; });
    const firstPromise = runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => {
        enteredWait();
        await held;
        return failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" });
      }
    }));
    await entered;
    const archiveRoot = join(repo, ".codex", "pro-reviews");
    const [archiveName] = await readdir(archiveRoot);
    const archiveDirectory = join(archiveRoot, archiveName!);
    const secondCalls: string[] = [];

    const second = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory }
    }, makePort(secondCalls));

    expect(second).toMatchObject({
      status: "blocked",
      blocker: { code: "review_archive_locked", resumable: true }
    });
    expect(secondCalls).not.toContain("bootstrap");
    releaseWait();
    const first = await firstPromise;
    expect(first.status).toBe("in_progress");
    await expect(readFile(join(archiveDirectory, ".workflow.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for an exiting lease owner before resuming the same submitted thread", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([]));
    const archiveDirectory = first.archiveDirectory!;
    const prompt = await readFile(join(archiveDirectory, "prompt.md"), "utf8");
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 750)"], { stdio: "ignore" });
    if (owner.pid === undefined) throw new Error("Unable to start the transitional lease-owner fixture.");
    await writeFile(join(archiveDirectory, ".workflow.lock"), JSON.stringify({
      schemaVersion: 1,
      pid: owner.pid,
      acquiredAt: "2026-08-11T12:00:00.000Z"
    }));
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory }
    }, makePort(calls, {
      readLatestUser: async () => success({ role: "user", text: prompt, format: "normalized_text" })
    }));

    expect(resumed.status).toBe("completed");
    expect(calls).toContain("bootstrap");
    await expect(readFile(join(archiveDirectory, ".workflow.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    if (owner.exitCode === null) owner.kill();
  });

  it("reclaims an expired lease whose PID has been reused by a live process", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([]));
    const archiveDirectory = first.archiveDirectory!;
    const prompt = await readFile(join(archiveDirectory, "prompt.md"), "utf8");
    const reusedOwner = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10000)"], { stdio: "ignore" });
    if (reusedOwner.pid === undefined) throw new Error("Unable to start the reused-PID fixture.");
    await writeFile(join(archiveDirectory, ".workflow.lock"), JSON.stringify({
      schemaVersion: 1,
      pid: reusedOwner.pid,
      acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString()
    }));
    const calls: string[] = [];

    try {
      const resumed = await runCodeReviewWithPort({
        repositoryRoot: repo,
        baseRef: "HEAD",
        resume: { archiveDirectory }
      }, makePort(calls, {
        readLatestUser: async () => success({ role: "user", text: prompt, format: "normalized_text" })
      }));

      expect(resumed.status).toBe("completed");
      expect(calls).toContain("bootstrap");
      await expect(readFile(join(archiveDirectory, ".workflow.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (reusedOwner.exitCode === null) reusedOwner.kill();
    }
  });

  it("reclaims an old empty lease left by an interrupted writer", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([]));
    const archiveDirectory = first.archiveDirectory!;
    const prompt = await readFile(join(archiveDirectory, "prompt.md"), "utf8");
    const leasePath = join(archiveDirectory, ".workflow.lock");
    await writeFile(leasePath, "");
    const staleTime = new Date(Date.now() - 10 * 60_000);
    await utimes(leasePath, staleTime, staleTime);
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory }
    }, makePort(calls, {
      readLatestUser: async () => success({ role: "user", text: prompt, format: "normalized_text" })
    }));

    expect(resumed.status).toBe("completed");
    expect(calls).toContain("bootstrap");
    await expect(readFile(leasePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function makePort(calls: string[], overrides: Partial<ReviewWorkflowPort> = {}): ReviewWorkflowPort {
  let tick = 0;
  let latestUserText = "";
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
    openThread: record("openThread", async target => success({
      url: target.url ?? `https://chatgpt.com/c/${target.conversationId}`,
      conversationId: target.conversationId ?? "review-thread"
    })),
    recoverThread: record("recoverThread", async () => success({ url: "https://chatgpt.com/c/review-thread", conversationId: "review-thread" })),
    snapshotConfiguration: record("snapshotConfiguration", async () => success(snapshot)),
    applyPro: record("applyPro", async () => success({ requested: { intelligence: "Pro" }, selected: [{ axis: "intelligence", requested: "Pro", selected: "Pro" }], before: beforeInspection, after: proInspection, verified: true })),
    inspectConfiguration: record("inspectConfiguration", async () => success(proInspection)),
    restoreConfiguration: record("restoreConfiguration", async () => success({ snapshot, restored: true, after: beforeInspection })),
    pageState: record("pageState", async () => ({ url: "https://chatgpt.com/c/review-thread", conversationId: "review-thread", title: "Review", visibleText: "New chat Search chats", signedIn: true })),
    artifactBaseline: record("artifactBaseline", async () => success(baseline)),
    artifactDelta: record("artifactDelta", async () => success({ baseline, current: baseline, added: [] })),
    attach: record("attach", async () => success({ attached: true })),
    messageStatus: record("messageStatus", async () => success({ turnCount: 0, assistantTurnCount: 0, completionState: "unknown", generationActive: false, generationSignals: [] })),
    compose: record("compose", async (text: string) => {
      latestUserText = text;
      return success({});
    }),
    submit: record("submit", async () => ({ ...success({ submitted: true, userTurnText: latestUserText, turnCount: 1, submissionState: "submitted" }), context: context("https://chatgpt.com/c/review-thread") })),
    waitMetadata: record("waitMetadata", async () => success({ complete: true, assistantTurnCount: 1, elapsedMs: 10, responseChars: markdown.length, responseSha256: "abc", responseContent: "metadata" })),
    readFullMarkdown: record("readFullMarkdown", async () => success({ role: "assistant", text: markdown, markdown, format: "markdown" })),
    readLatestUser: record("readLatestUser", async () => success({ role: "user", text: latestUserText, format: "normalized_text" })),
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
