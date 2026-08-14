import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultReviewWorkflowPort,
  runCodeReviewWithPort,
  type ReviewWorkflowPort
} from "../../src/reviews/code-review.js";
import { removeLeaseIfOwnerExitedOrExpired } from "../../src/reviews/review-lease.js";
import type {
  ArtifactInventoryData,
  CommandResult,
  ConfigurationInspectionData,
  ConfigurationSnapshotData,
  BrowserLike,
  DownloadedFile,
  PageLike,
  RuntimeEnv
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
  it("exact-claims the archived tab among duplicate conversation tabs without navigating", async () => {
    const claimed: string[] = [];
    const navigated: string[] = [];
    const probe = mutableChatPage("probe", "https://chatgpt.com/", {}, navigated);
    const preferred = mutableChatPage("preferred", "https://chatgpt.com/c/candidate", {
      conversations: { candidate: "Exact candidate prompt" }
    }, navigated);
    const duplicate = mutableChatPage("duplicate", "https://chatgpt.com/c/candidate", {
      conversations: { candidate: "Exact candidate prompt" }
    }, navigated);
    const pages = new Map([["probe", probe], ["preferred", preferred], ["duplicate", duplicate]]);
    const browser: BrowserLike = {
      user: {
        openTabs: async () => [...pages].map(([id, page]) => ({ id, url: page.url!() as string, title: id })),
        claimTab: async tab => {
          const id = typeof tab === "string" ? tab : tab.id;
          claimed.push(id);
          return pages.get(id)!;
        }
      }
    };
    const env: RuntimeEnv = { browser, page: probe, expectedTabId: "probe" };

    const result = await defaultReviewWorkflowPort(env).recoverThread(
      "Candidate",
      "Exact candidate prompt",
      { url: "https://chatgpt.com/c/candidate", conversationId: "candidate", tabId: "preferred" }
    );

    expect(result).toMatchObject({ ok: true, data: { conversationId: "candidate" }, context: { tabId: "preferred" } });
    expect(claimed).toEqual(["preferred", "probe", "preferred"]);
    expect(navigated).toEqual([]);
  });

  it("blocks a claimed recovery candidate that resolves to a different conversation", async () => {
    const probe = mutableChatPage("probe", "https://chatgpt.com/", {
      home: '<a href="/c/candidate"><div>Candidate</div></a>'
    });
    const raced = mutableChatPage("candidate-tab", "https://chatgpt.com/c/other", {});
    const browser: BrowserLike = {
      user: {
        openTabs: async () => [
          { id: "probe", url: "https://chatgpt.com/", title: "Probe" },
          { id: "candidate-tab", url: "https://chatgpt.com/c/candidate", title: "Candidate" }
        ],
        claimTab: async tab => (typeof tab === "string" ? tab : tab.id) === "probe" ? probe : raced
      }
    };
    const env: RuntimeEnv = { browser, page: probe, expectedTabId: "probe" };

    const result = await defaultReviewWorkflowPort(env).recoverThread("Candidate", "Exact candidate prompt");

    expect(result).toMatchObject({ ok: false, blocker: { code: "review_thread_recovery_candidate_drift", resumable: true } });
  });

  it("does not restore or inspect after a recovery candidate hands off browser ownership", async () => {
    let handedOff = false;
    const operations: string[] = [];
    const probe: PageLike = {
      id: "probe",
      url: () => {
        operations.push(handedOff ? "url-after-handoff" : "url");
        return "https://chatgpt.com/";
      },
      content: async () => {
        operations.push(handedOff ? "content-after-handoff" : "content");
        return '<main>New chat Search chats Chat with ChatGPT<a href="/c/candidate"><div>Candidate</div></a></main>';
      },
      locator: () => ({ count: async () => 0 }),
      waitForTimeout: async () => undefined,
      waitForEvent: async () => ({})
    };
    const controlled = { id: "candidate-provider", url: "https://chatgpt.com/c/candidate", title: "Candidate" };
    const browser = {
      name: "chrome",
      tabs: {
        list: async () => {
          operations.push(handedOff ? "list-after-handoff" : "list");
          return [controlled];
        },
        finalize: async () => {
          operations.push("finalize");
          handedOff = true;
        }
      }
    } as unknown as BrowserLike;

    const result = await defaultReviewWorkflowPort({ browser, page: probe, expectedTabId: "probe" }).recoverThread(
      "Candidate",
      "Exact candidate prompt",
      { url: "https://chatgpt.com/c/candidate", conversationId: "candidate", tabId: "candidate-provider" }
    );

    expect(result).toMatchObject({
      ok: false,
      blocker: { code: "existing_tab_handoff_completed", resumable: true }
    });
    expect(operations).toContain("finalize");
    expect(operations.filter(operation => operation.endsWith("after-handoff"))).toEqual([]);
  });

  it("recovers through one alternate duplicate tab for a canonical conversation without opening another", async () => {
    const claimed: string[] = [];
    const created: string[] = [];
    const navigated: string[] = [];
    const probe = mutableChatPage("probe", "https://chatgpt.com/", {
      home: '<a href="/c/candidate"><div>Candidate</div></a>'
    }, navigated);
    const one = mutableChatPage("one", "https://chatgpt.com/c/candidate", {
      conversations: { candidate: "Exact candidate prompt" }
    }, navigated);
    const two = mutableChatPage("two", "https://chatgpt.com/c/candidate", {
      conversations: { candidate: "Exact candidate prompt" }
    }, navigated);
    const pages = new Map([["probe", probe], ["one", one], ["two", two]]);
    const browser: BrowserLike = {
      user: {
        openTabs: async () => [...pages].map(([id, page]) => ({ id, url: page.url!() as string, title: id })),
        claimTab: async tab => {
          const id = typeof tab === "string" ? tab : tab.id;
          claimed.push(id);
          if (id === "one") throw new Error("Tab is already part of browser session stale-owner");
          return pages.get(id)!;
        }
      },
      tabs: {
        create: async url => {
          created.push(url);
          return mutableChatPage("fresh", url, {});
        }
      }
    };
    const env: RuntimeEnv = { browser, page: probe, expectedTabId: "probe" };
    const result = await defaultReviewWorkflowPort(env).recoverThread("Candidate", "Exact candidate prompt");

    expect(result).toMatchObject({ ok: true, data: { conversationId: "candidate" }, context: { tabId: "two" } });
    expect(claimed).toEqual(["one", "two", "probe", "two"]);
    expect(created).toEqual([]);
    expect(navigated).toEqual([]);
  });

  it("restores its probe after ambiguous recovery and remains ambiguous on retry", async () => {
    const prompt = "Exact archived prompt for recovery";
    const original = "https://chatgpt.com/";
    const page = mutableChatPage("probe", original, {
      home: [
        '<a href="/c/one"><div>Recovery Query one</div></a>',
        '<a href="/c/two"><div>Recovery Query two</div></a>'
      ].join(""),
      conversations: { one: prompt, two: prompt }
    });
    const browser: BrowserLike = {
      user: {
        openTabs: async () => [{ id: "probe", url: await page.url!(), title: "Probe" }],
        claimTab: async () => page
      }
    };
    const env: RuntimeEnv = { browser, page, expectedTabId: "probe" };

    const first = await defaultReviewWorkflowPort(env).recoverThread("Recovery Query", prompt);
    expect(first).toMatchObject({ ok: false, blocker: { code: "review_thread_recovery_ambiguous" } });
    expect(await page.url!()).toBe(original);
    const second = await defaultReviewWorkflowPort(env).recoverThread("Recovery Query", prompt);
    expect(second).toMatchObject({ ok: false, blocker: { code: "review_thread_recovery_ambiguous" } });
    expect(await page.url!()).toBe(original);
  });

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

  it("keeps legacy workflow ports on the ordinary bootstrap surface", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "chatgpt-pro-legacy-bootstrap-"));
    const calls: string[] = [];
    const port = makePort(calls);
    delete (port as Partial<ReviewWorkflowPort>).bootstrapRecovery;
    const result = await runCodeReviewWithPort({
      request: { additionalInstructions: "Legacy bootstrap compatibility" },
      output: { archiveRoot }
    }, port);

    expect(result.status).toBe("completed");
    expect(calls).toContain("bootstrap");
    expect(calls).not.toContain("bootstrapRecovery");
  });

  it("blocks canonical drift before packet attachment, composition, or submission", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    let pageReads = 0;
    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort(calls, {
      pageState: async () => {
        pageReads += 1;
        const conversationId = pageReads < 3 ? "review-thread" : "different-thread";
        return {
          url: `https://chatgpt.com/c/${conversationId}`,
          conversationId,
          visibleText: "Chat history",
          signedIn: true
        };
      }
    }));

    expect(result).toMatchObject({
      status: "blocked",
      submitted: false,
      blocker: { code: "conversation_binding_lost", resumable: false }
    });
    expect(calls).not.toContain("attach");
    expect(calls).not.toContain("compose");
    expect(calls).not.toContain("submit");
  });

  it("blocks poll context drift without rebinding the archived checkpoint or reading the response", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    const checkpointBefore = JSON.parse(await readFile(join(first.archiveDirectory!, "thread-checkpoint.json"), "utf8"));
    const prompt = await readFile(join(first.archiveDirectory!, "prompt.md"), "utf8");
    const calls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls, {
      readLatestUser: async () => success({ role: "user", text: prompt, format: "normalized_text" }),
      waitMetadata: async () => ({
        ...success({ complete: true, assistantTurnCount: 1, elapsedMs: 10, responseContent: "metadata" }),
        context: { ...context("https://chatgpt.com/c/different-thread"), conversationId: "different-thread" }
      })
    }));

    expect(resumed).toMatchObject({ status: "blocked", blocker: { code: "conversation_binding_lost", resumable: true } });
    expect(calls).not.toContain("readFullMarkdown");
    const checkpointAfter = JSON.parse(await readFile(join(first.archiveDirectory!, "thread-checkpoint.json"), "utf8"));
    expect(checkpointAfter.current).toEqual(checkpointBefore.current);
  });

  it("uses a matching archived tab binding before canonical conversation selection", async () => {
    const repo = await fixtureRepository();
    const url = "https://chatgpt.com/c/review-thread";
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      newThread: async () => ({
        ...success({ url, conversationId: "review-thread" }),
        context: { ...context(url), conversationId: "review-thread", tabId: "stored-tab" }
      }),
      pageState: async () => ({
        url,
        conversationId: "review-thread",
        tabId: "stored-tab",
        visibleText: "Chat history",
        signedIn: true
      }),
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    const prompt = await readFile(join(first.archiveDirectory!, "prompt.md"), "utf8");
    const targets: unknown[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort([], {
      bootstrapRecovery: async target => {
        targets.push(target);
        return {
          ...success({}),
          context: { ...context(url), conversationId: "review-thread", tabId: "stored-tab" }
        };
      },
      pageState: async () => ({
        url,
        conversationId: "review-thread",
        tabId: "stored-tab",
        visibleText: "Chat history",
        signedIn: true
      }),
      readLatestUser: async () => success({ role: "user", text: prompt, format: "normalized_text" })
    }));

    expect(resumed.status).toBe("completed");
    expect(targets).toEqual([{ tabId: "stored-tab" }]);
  });

  it("prefers a validated canonical checkpoint URL and tab over the older submission route", async () => {
    const repo = await fixtureRepository();
    const receiptUrl = "https://chatgpt.com/c/review-thread";
    const checkpointUrl = "https://chatgpt.com/c/review-thread?model=pro";
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      newThread: async () => ({
        ...success({ url: receiptUrl, conversationId: "review-thread" }),
        context: { ...context(receiptUrl), conversationId: "review-thread", tabId: "receipt-tab" }
      }),
      pageState: async () => ({
        url: receiptUrl,
        conversationId: "review-thread",
        tabId: "receipt-tab",
        visibleText: "Chat history",
        signedIn: true
      }),
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    const checkpointPath = join(first.archiveDirectory!, "thread-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    checkpoint.current = { url: checkpointUrl, id: "review-thread", tabId: "checkpoint-tab" };
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const prompt = await readFile(join(first.archiveDirectory!, "prompt.md"), "utf8");
    const bootstrapTargets: unknown[] = [];
    const openTargets: unknown[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort([], {
      bootstrapRecovery: async target => {
        bootstrapTargets.push(target);
        return {
          ...success({}),
          context: { ...context(checkpointUrl), conversationId: "review-thread", tabId: "checkpoint-tab" }
        };
      },
      openThread: async target => {
        openTargets.push(target);
        return {
          ...success({ url: target.url!, conversationId: "review-thread" }),
          context: { ...context(target.url), conversationId: "review-thread", tabId: "checkpoint-tab" }
        };
      },
      pageState: async () => ({
        url: checkpointUrl,
        conversationId: "review-thread",
        tabId: "checkpoint-tab",
        visibleText: "Chat history",
        signedIn: true
      }),
      readLatestUser: async () => success({ role: "user", text: prompt, format: "normalized_text" })
    }));

    expect(resumed.status).toBe("completed");
    expect(bootstrapTargets).toEqual([{ tabId: "checkpoint-tab" }]);
    expect(openTargets).toEqual([{ url: checkpointUrl, conversationId: "review-thread" }]);
  });

  it.each(["existing_tab_unresponsive"] as const)(
    "keeps %s resumable without opening, falling back, or resubmitting",
    async code => {
      const repo = await fixtureRepository();
      const url = "https://chatgpt.com/c/review-thread";
      const first = await runCodeReviewWithPort({
        repositoryRoot: repo,
        baseRef: "HEAD",
        polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
      }, makePort([], {
        newThread: async () => ({
          ...success({ url, conversationId: "review-thread" }),
          context: { ...context(url), conversationId: "review-thread", tabId: "archived-tab" }
        }),
        pageState: async () => ({
          url,
          conversationId: "review-thread",
          tabId: "archived-tab",
          visibleText: "Chat history",
          signedIn: true
        }),
        waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
      }));
      const calls: string[] = [];
      const resumed = await runCodeReviewWithPort({
        repositoryRoot: repo,
        baseRef: "HEAD",
        resume: { archiveDirectory: first.archiveDirectory! },
        safeguards: { restorePreviousConfiguration: true }
      }, makePort(calls, {
        bootstrapRecovery: async () => ({
          ok: false,
          status: "blocked",
          warnings: [],
          blocker: { kind: "selector_drift", code, message: "Exact tab ownership must be recovered.", resumable: false },
          context: context(url)
        })
      }));

      expect(resumed).toMatchObject({ status: "blocked", submitted: true, blocker: { code, resumable: true } });
      expect(calls).toEqual(["bootstrapRecovery"]);
      expect(calls).not.toContain("restoreConfiguration");
    }
  );

  it("resumes a fresh explicit-thread handoff from its pre-submit checkpoint and submits once", async () => {
    const repo = await fixtureRepository();
    const url = "https://chatgpt.com/c/review-thread";
    const firstCalls: string[] = [];
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      thread: { url, id: "review-thread" }
    }, makePort(firstCalls, {
      bootstrap: async () => ({
        ok: false,
        status: "blocked",
        warnings: [],
        blocker: { kind: "not_found", code: "existing_tab_handoff_completed", message: "Continue from a fresh browser host.", resumable: true },
        context: context(url)
      })
    }));

    expect(first).toMatchObject({ status: "in_progress", submitted: false, resubmitAllowed: false, nextAction: "poll_same_thread" });
    expect(firstCalls).toEqual(["bootstrap"]);
    expect(JSON.parse(await readFile(join(first.archiveDirectory!, "pre-submit-checkpoint.json"), "utf8"))).toMatchObject({
      phase: "preflight_browser_handoff",
      target: { mode: "existing", url, id: "review-thread" }
    });
    await expect(readdir(join(first.archiveDirectory!, ".workflow.lock"))).rejects.toMatchObject({ code: "ENOENT" });

    const resumeCalls: string[] = [];
    const bootstrapTargets: unknown[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(resumeCalls, {
      bootstrap: async target => {
        bootstrapTargets.push(target);
        return success({});
      }
    }));

    expect(resumed.status).toBe("completed");
    expect(bootstrapTargets).toEqual([{ url, conversationId: "review-thread" }]);
    expect(resumeCalls.filter(call => call === "submit")).toHaveLength(1);
    await expect(readFile(join(first.archiveDirectory!, "pre-submit-checkpoint.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(first.archiveDirectory!, "submission.json"), "utf8"))).toMatchObject({ submitted: true, resubmitAllowed: false });
    await expect(readdir(join(first.archiveDirectory!, ".workflow.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes a pre-submit checkpoint after a non-handoff bootstrap failure", async () => {
    const repo = await fixtureRepository();
    const result = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      thread: { url: "https://chatgpt.com/c/review-thread", id: "review-thread" }
    }, makePort([], {
      bootstrap: async () => ({
        ok: false,
        status: "blocked",
        warnings: [],
        blocker: { kind: "login_required", code: "login_required", message: "Sign in to continue." },
        context: context()
      })
    }));

    expect(result).toMatchObject({ status: "blocked", blocker: { code: "login_required" } });
    await expect(readFile(join(result.archiveDirectory!, "pre-submit-checkpoint.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an external initial thread URL before preparing context or opening a browser", async () => {
    const calls: string[] = [];
    const result = await runCodeReviewWithPort({
      request: { additionalInstructions: "Review this existing thread." },
      thread: { url: "https://example.invalid/c/review-thread", id: "review-thread" }
    }, makePort(calls));

    expect(result).toMatchObject({ status: "blocked", blocker: { code: "thread_target_invalid" } });
    expect(result.archiveDirectory).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("rejects an external existing-thread URL persisted in a pre-submit handoff", async () => {
    const repo = await fixtureRepository();
    const url = "https://chatgpt.com/c/review-thread";
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      thread: { url, id: "review-thread" }
    }, makePort([], {
      bootstrap: async () => ({
        ok: false,
        status: "blocked",
        warnings: [],
        blocker: { kind: "not_found", code: "existing_tab_handoff_completed", message: "Continue from a fresh browser host.", resumable: true },
        context: context(url)
      })
    }));
    const checkpointPath = join(first.archiveDirectory!, "pre-submit-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    checkpoint.target.url = "https://example.invalid/c/review-thread";
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls));

    expect(resumed).toMatchObject({ status: "blocked", blocker: { code: "resume_pre_submit_checkpoint_invalid" } });
    expect(calls).toEqual([]);
  });

  it("rejects an external caller resume URL before reading its archive", async () => {
    const archiveDirectory = await mkdtemp(join(tmpdir(), "chatgpt-pro-external-resume-"));
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      resume: {
        archiveDirectory,
        threadUrl: "https://example.invalid/c/review-thread",
        conversationId: "review-thread"
      }
    }, makePort(calls));

    expect(resumed).toMatchObject({ status: "blocked", blocker: { code: "resume_thread_mismatch" } });
    expect(calls).toEqual([]);
    await rm(archiveDirectory, { recursive: true, force: true });
  });

  it("continues an intent-only WEB handoff on the canonical same tab without resubmitting", async () => {
    const repo = await fixtureRepository();
    const provisionalUrl = "https://chatgpt.com/c/WEB:handoff-live-sequence";
    const canonicalUrl = "https://chatgpt.com/c/canonical-live-sequence";
    let submittedPrompt = "";
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      bootstrap: async () => ({ ...success({}), context: { ...context(), tabId: "live-tab" } }),
      newThread: async () => ({ ...success({ url: provisionalUrl, conversationId: "WEB:handoff-live-sequence" }), context: { ...context(provisionalUrl), conversationId: "WEB:handoff-live-sequence", tabId: "live-tab" } }),
      submit: async prompt => {
        submittedPrompt = prompt;
        return { ...success({ submitted: true, userTurnText: prompt, turnCount: 1, submissionState: "submitted_generating" as const }), context: { ...context(provisionalUrl), conversationId: "WEB:handoff-live-sequence", tabId: "live-tab" } };
      },
      readLatestUser: async () => success({ role: "user", text: submittedPrompt, format: "normalized_text" }),
      pageState: async () => ({ url: provisionalUrl, conversationId: "WEB:handoff-live-sequence", tabId: "live-tab", visibleText: "Stop generating", signedIn: true }),
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    await rm(join(first.archiveDirectory!, "submission.json"));
    const intentPath = join(first.archiveDirectory!, "submission-intent.json");
    const intentBefore = await readFile(intentPath, "utf8");

    const handoffCalls: string[] = [];
    const handedOff = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(handoffCalls, {
      bootstrapRecovery: async () => ({
        ok: false,
        status: "blocked",
        warnings: [],
        blocker: { kind: "not_found", code: "existing_tab_handoff_completed", message: "Continue from a fresh browser host.", resumable: true },
        context: { ...context(provisionalUrl), tabId: "live-tab" }
      })
    }));
    expect(handedOff).toMatchObject({ status: "in_progress", submitted: false, nextAction: "poll_same_thread" });
    expect(handoffCalls).toEqual(["bootstrapRecovery"]);
    expect(await readFile(intentPath, "utf8")).toBe(intentBefore);
    await expect(readdir(join(first.archiveDirectory!, ".workflow.lock"))).rejects.toMatchObject({ code: "ENOENT" });

    const prompt = await readFile(join(first.archiveDirectory!, "prompt.md"), "utf8");
    const resumeCalls: string[] = [];
    const completed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(resumeCalls, {
      bootstrapRecovery: async target => {
        expect(target).toEqual({ tabId: "live-tab" });
        return { ...success({}), context: { ...context(canonicalUrl), conversationId: "canonical-live-sequence", tabId: "live-tab" } };
      },
      pageState: async () => ({ url: canonicalUrl, conversationId: "canonical-live-sequence", tabId: "live-tab", visibleText: "Chat history", signedIn: true }),
      readLatestUser: async () => ({ ...success({ role: "user" as const, text: prompt, format: "normalized_text" as const }), context: { ...context(canonicalUrl), conversationId: "canonical-live-sequence", tabId: "live-tab" } }),
      messageStatus: async () => ({ ...success({ turnCount: 1, assistantTurnCount: 1, completionState: "complete" as const, generationActive: false, generationSignals: [] }), context: { ...context(canonicalUrl), conversationId: "canonical-live-sequence", tabId: "live-tab" } }),
      waitMetadata: async () => ({ ...success({ complete: true, assistantTurnCount: 1, elapsedMs: 1, responseContent: "metadata" as const }), context: { ...context(canonicalUrl), conversationId: "canonical-live-sequence", tabId: "live-tab" } }),
      readFullMarkdown: async () => ({ ...success({ role: "assistant" as const, text: "# Complete live review", markdown: "# Complete live review", format: "markdown" as const }), context: { ...context(canonicalUrl), conversationId: "canonical-live-sequence", tabId: "live-tab" } })
    }));

    expect(completed).toMatchObject({ status: "completed_with_warnings", thread: { url: canonicalUrl, id: "canonical-live-sequence" } });
    expect(resumeCalls).not.toContain("attach");
    expect(resumeCalls).not.toContain("compose");
    expect(resumeCalls).not.toContain("submit");
    expect(await readFile(join(first.archiveDirectory!, "response.md"), "utf8")).toBe("# Complete live review");
    expect(JSON.parse(await readFile(join(first.archiveDirectory!, "submission-confirmation.json"), "utf8"))).toMatchObject({ state: "confirmed", thread: { url: canonicalUrl, id: "canonical-live-sequence", tabId: "live-tab" } });
    expect(JSON.parse(await readFile(join(first.archiveDirectory!, "thread-checkpoint.json"), "utf8"))).toMatchObject({ current: { url: canonicalUrl, id: "canonical-live-sequence", tabId: "live-tab" } });
    await expect(readdir(join(first.archiveDirectory!, ".workflow.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not repurpose a reused archived tab that now shows another conversation", async () => {
    const repo = await fixtureRepository();
    const url = "https://chatgpt.com/c/review-thread";
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      newThread: async () => ({
        ...success({ url, conversationId: "review-thread" }),
        context: { ...context(url), conversationId: "review-thread", tabId: "stored-tab" }
      }),
      pageState: async () => ({
        url,
        conversationId: "review-thread",
        tabId: "stored-tab",
        visibleText: "Chat history",
        signedIn: true
      }),
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    const prompt = await readFile(join(first.archiveDirectory!, "prompt.md"), "utf8");
    const targets: unknown[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort([], {
      bootstrapRecovery: async target => {
        targets.push(target);
        return {
          ...success({}),
          context: {
            ...context("https://chatgpt.com/c/reused"),
            conversationId: "reused",
            tabId: "stored-tab"
          }
        };
      },
      bootstrap: async target => {
        targets.push(target);
        return {
          ...success({}),
          context: { ...context(url), conversationId: "review-thread", tabId: "canonical-tab" }
        };
      },
      pageState: async () => ({
        url,
        conversationId: "review-thread",
        tabId: "canonical-tab",
        visibleText: "Chat history",
        signedIn: true
      }),
      readLatestUser: async () => success({ role: "user", text: prompt, format: "normalized_text" })
    }));

    expect(resumed.status).toBe("completed");
    expect(targets).toEqual([
      { tabId: "stored-tab" },
      { url, conversationId: "review-thread" }
    ]);
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
      }),
      submit: async (prompt: string) => ({
        ...success({ submitted: true, userTurnText: prompt, turnCount: 1, submissionState: "submitted" }),
        context: { ...context(`https://chatgpt.com/c/${conversationId}`), conversationId }
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

  it("records a post-click submit-context drift without rebinding an explicit canonical thread", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "chatgpt-pro-follow-up-drift-"));
    const calls: string[] = [];
    const conversationId = "existing-pro-thread";
    const result = await runCodeReviewWithPort({
      thread: { url: `https://chatgpt.com/c/${conversationId}`, id: conversationId },
      request: { additionalInstructions: "Continue exactly once." },
      output: { archiveRoot }
    }, makePort(calls, {
      pageState: async () => ({
        url: `https://chatgpt.com/c/${conversationId}`,
        conversationId,
        visibleText: "Chat history",
        signedIn: true
      }),
      submit: async (prompt: string) => ({
        ...success({ submitted: true, userTurnText: prompt, turnCount: 2, submissionState: "submitted_generating" }),
        context: { ...context("https://chatgpt.com/c/different-thread"), conversationId: "different-thread" }
      }),
      readLatestUser: async () => success({ role: "user", text: "Continue exactly once.", format: "normalized_text" })
    }));

    expect(result).toMatchObject({
      status: "blocked",
      submitted: true,
      blocker: { code: "conversation_binding_lost", resumable: true },
      thread: { id: conversationId }
    });
    expect(JSON.parse(await readFile(join(result.archiveDirectory!, "submission.json"), "utf8"))).toMatchObject({
      state: "ambiguous",
      thread: { id: conversationId }
    });
    expect(calls.filter(call => call === "submit")).toHaveLength(1);
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

  it("keeps strict verification invariant when legacy callers pass false safety flags", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    const unverifiedProSnapshot: ConfigurationSnapshotData = {
      ...snapshot,
      selection: { intelligence: "Pro" },
      inspection: { ...proInspection, verified: false }
    };
    const result = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      target: { strict: false },
      safeguards: {
        submitOnce: false,
        verifyTargetBeforeSubmit: false,
        verifyTargetAfterCompletion: false,
        failOnFallback: false
      }
    }, makePort(calls, {
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

  it("returns in_progress when a bounded poll captures partial text while Pro is still thinking", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    const result = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort(calls, {
      waitMetadata: async () => failure("partial", {
        complete: false,
        assistantTurnCount: 1,
        elapsedMs: 10,
        responseChars: 217,
        responseSha256: "abc",
        responseContent: "metadata",
        completionState: "generating",
        generationActive: true,
        generationSignals: ["stop_control"]
      })
    }));

    expect(result).toMatchObject({
      status: "in_progress",
      submitted: true,
      resubmitAllowed: false,
      nextAction: "poll_same_thread"
    });
    expect(calls.filter(call => call === "submit")).toHaveLength(1);
    expect(calls.filter(call => call === "waitMetadata")).toHaveLength(1);
    expect(calls).not.toContain("readFullMarkdown");
  });

  it("does not resume an explicitly stopped partial response as though Pro were still thinking", async () => {
    const repo = await fixtureRepository();
    const result = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD"
    }, makePort([], {
      waitMetadata: async () => failure("partial", {
        complete: false,
        assistantTurnCount: 1,
        elapsedMs: 10,
        responseChars: 217,
        responseContent: "metadata",
        completionState: "stopped",
        generationActive: false,
        generationSignals: ["stopped_assistant"]
      })
    }));

    expect(result.status).toBe("failed");
    expect(result.nextAction).toBeUndefined();
  });

  it("preserves successful command warnings in step evidence, the result, and the receipt", async () => {
    const repo = await fixtureRepository();
    const fidelityWarning = "Markdown was reconstructed from visible semantic content.";
    const result = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD"
    }, makePort([], {
      readFullMarkdown: async () => ({
        ...success({ role: "assistant" as const, text: "# Review", markdown: "# Review", format: "markdown" as const }),
        warnings: [fidelityWarning]
      })
    }));

    expect(result.status).toBe("completed_with_warnings");
    expect(result.warnings).toContain(fidelityWarning);
    expect(result.rawSteps).toContainEqual(expect.objectContaining({
      state: "READ_FULL_MARKDOWN_ONCE",
      warnings: [fidelityWarning]
    }));
    expect(JSON.parse(await readFile(join(result.archiveDirectory!, "receipt.json"), "utf8"))).toMatchObject({
      warnings: expect.arrayContaining([fidelityWarning])
    });
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

    const terminal = JSON.parse(await readFile(join(result.archiveDirectory!, "terminal-outcome.json"), "utf8"));
    expect(terminal).toMatchObject({
      schemaVersion: 1,
      status: "blocked",
      submitted: true,
      blocker: { kind: "model_fallback", code: "pro_postcondition_unverified", resumable: false },
      response: { sha256: result.provenance.responseSha256 }
    });
    const resumeCalls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: result.archiveDirectory! }
    }, makePort(resumeCalls));
    expect(resumed).toMatchObject({
      status: "blocked",
      submitted: true,
      blocker: { kind: "model_fallback", code: "pro_postcondition_unverified", resumable: false }
    });
    expect(resumeCalls).toEqual([]);
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
    expect(JSON.parse(await readFile(join(first.archiveDirectory!, "submission.json"), "utf8"))).toMatchObject({
      schemaVersion: 3,
      promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      uploadManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      configurationSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifactBaselineSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      packetBindings: expect.any(Array)
    });
  });

  it("rejects a mutated upload manifest before opening a browser on resume", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    await writeFile(join(first.archiveDirectory!, "terminal-outcome.json"), `${JSON.stringify({
      schemaVersion: 1,
      finalizedAt: "2026-08-11T12:00:00.000Z",
      status: "blocked",
      ok: false,
      submitted: true,
      resubmitAllowed: false,
      blocker: { kind: "unknown", code: "synthetic_terminal", message: "synthetic", resumable: false },
      warnings: [],
      thread: { url: "https://chatgpt.com/c/review-thread", id: "review-thread" }
    }, null, 2)}\n`);
    await writeFile(join(first.archiveDirectory!, "context", "manifest.upload.json"), "{}\n");
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls));

    expect(resumed.status).toBe("blocked");
    expect(resumed.blocker?.code).toBe("resume_submission_integrity_mismatch");
    expect(calls).not.toContain("bootstrap");
  });

  it("rejects an external archived submission thread URL before browser resume", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    const submissionPath = join(first.archiveDirectory!, "submission.json");
    const submission = JSON.parse(await readFile(submissionPath, "utf8"));
    submission.thread.url = "https://example.invalid/c/review-thread";
    await writeFile(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls));

    expect(resumed).toMatchObject({ status: "blocked", blocker: { code: "resume_submission_unverified" } });
    expect(calls).toEqual([]);
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
    expect(result.blocker).toMatchObject({ code: "resume_thread_mismatch", resumable: true });
    expect(result).toMatchObject({ submitted: true, thread: { id: "review-thread" } });
    expect(calls).not.toContain("bootstrap");
    expect(calls).not.toContain("submit");
    await expect(readFile(join(first.archiveDirectory!, "terminal-outcome.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const archivedPrompt = await readFile(join(first.archiveDirectory!, "prompt.md"), "utf8");
    const retryCalls: string[] = [];
    const retried = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(retryCalls, {
      readLatestUser: async () => success({ role: "user", text: archivedPrompt, format: "normalized_text" })
    }));
    expect(retried.status).toBe("completed");
    expect(retryCalls).not.toContain("submit");
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

  it("records ambiguous post-click conversation drift without rebinding or polling", async () => {
    const repo = await fixtureRepository();
    const calls: string[] = [];
    let statusCalls = 0;
    let clicked = false;
    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort(calls, {
      newThread: async () => success({ url: "https://chatgpt.com/c/WEB:provisional", conversationId: "WEB:provisional" }),
      submit: async () => {
        clicked = true;
        throw new Error("transport ended after click");
      },
      messageStatus: async () => {
        statusCalls += 1;
        return success(statusCalls === 1
          ? { turnCount: 0, assistantTurnCount: 0, completionState: "unknown", generationActive: false, generationSignals: [] }
          : { turnCount: 1, assistantTurnCount: 0, completionState: "generating", generationActive: true, generationSignals: ["stop-answering"] });
      },
      readLatestUser: async () => success({ role: "user", text: "unverified rendered text", format: "normalized_text" }),
      pageState: async () => clicked
        ? { url: "https://chatgpt.com/c/canonical-thread", conversationId: "canonical-thread", visibleText: "Stop generating", signedIn: true }
        : { url: "https://chatgpt.com/c/WEB:provisional", conversationId: "WEB:provisional", visibleText: "New chat Search chats", signedIn: true }
    }));

    expect(result).toMatchObject({
      status: "blocked",
      submitted: true,
      resubmitAllowed: false,
      blocker: { code: "conversation_binding_lost", resumable: true }
    });
    expect(calls).not.toContain("waitMetadata");
    expect(JSON.parse(await readFile(join(result.archiveDirectory!, "submission.json"), "utf8"))).toMatchObject({
      state: "ambiguous",
      submitted: true,
      resubmitAllowed: false,
      thread: { url: "https://chatgpt.com/c/WEB:provisional", id: "WEB:provisional" }
    });
  });

  it("confirms a same-tab provisional to canonical transition when submit context still carries the WEB route", async () => {
    const repo = await fixtureRepository();
    const provisionalUrl = "https://chatgpt.com/c/WEB:submit-route";
    const canonicalUrl = "https://chatgpt.com/c/canonical-after-submit";
    let submittedPrompt = "";
    let clicked = false;
    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([], {
      bootstrap: async () => ({ ...success({}), context: { ...context(), tabId: "bound-tab" } }),
      newThread: async () => ({
        ...success({ url: provisionalUrl, conversationId: "WEB:submit-route" }),
        context: { ...context(provisionalUrl), conversationId: "WEB:submit-route", tabId: "bound-tab" }
      }),
      submit: async (prompt: string) => {
        submittedPrompt = prompt;
        clicked = true;
        return {
          ...success({ submitted: true, userTurnText: prompt, turnCount: 2, submissionState: "submitted_generating" }),
          context: { ...context(provisionalUrl), conversationId: "WEB:submit-route", tabId: "bound-tab" }
        };
      },
      messageStatus: async () => success(clicked
        ? { turnCount: 1, assistantTurnCount: 0, completionState: "generating", generationActive: true, generationSignals: ["stop-answering"] }
        : { turnCount: 0, assistantTurnCount: 0, completionState: "unknown", generationActive: false, generationSignals: [] }),
      readLatestUser: async () => success({ role: "user", text: submittedPrompt, format: "normalized_text" }),
      pageState: async () => clicked
        ? { url: canonicalUrl, conversationId: "canonical-after-submit", tabId: "bound-tab", visibleText: "Stop generating", signedIn: true }
        : { url: provisionalUrl, conversationId: "WEB:submit-route", tabId: "bound-tab", visibleText: "Chat history", signedIn: true }
    }));

    expect(result.status).toBe("completed");
    expect(result.thread).toEqual({ url: canonicalUrl, id: "canonical-after-submit" });
    expect(JSON.parse(await readFile(join(result.archiveDirectory!, "submission.json"), "utf8"))).toMatchObject({
      state: "confirmed",
      thread: { url: canonicalUrl, id: "canonical-after-submit", tabId: "bound-tab" }
    });
  });

  it("does not let a provisional submit-context exception hide a conflicting browser tab", async () => {
    const repo = await fixtureRepository();
    const provisionalUrl = "https://chatgpt.com/c/WEB:submit-tab-route";
    const canonicalUrl = "https://chatgpt.com/c/canonical-submit-tab-route";
    let submittedPrompt = "";
    let clicked = false;
    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([], {
      bootstrap: async () => ({ ...success({}), context: { ...context(), tabId: "bound-tab" } }),
      newThread: async () => ({
        ...success({ url: provisionalUrl, conversationId: "WEB:submit-tab-route" }),
        context: { ...context(provisionalUrl), conversationId: "WEB:submit-tab-route", tabId: "bound-tab" }
      }),
      submit: async (prompt: string) => {
        submittedPrompt = prompt;
        clicked = true;
        return {
          ...success({ submitted: true, userTurnText: prompt, turnCount: 1, submissionState: "submitted" }),
          context: { ...context(provisionalUrl), conversationId: "WEB:submit-tab-route", tabId: "other-tab" }
        };
      },
      messageStatus: async () => success(clicked
        ? { turnCount: 1, assistantTurnCount: 0, completionState: "generating", generationActive: true, generationSignals: ["stop-answering"] }
        : { turnCount: 0, assistantTurnCount: 0, completionState: "unknown", generationActive: false, generationSignals: [] }),
      readLatestUser: async () => success({ role: "user", text: submittedPrompt, format: "normalized_text" }),
      pageState: async () => clicked
        ? { url: canonicalUrl, conversationId: "canonical-submit-tab-route", tabId: "bound-tab", visibleText: "Chat history", signedIn: true }
        : { url: provisionalUrl, conversationId: "WEB:submit-tab-route", tabId: "bound-tab", visibleText: "Chat history", signedIn: true }
    }));

    expect(result).toMatchObject({
      status: "blocked",
      submitted: true,
      blocker: { code: "conversation_tab_affinity_lost", resumable: true }
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

  it("resumes across attachment-envelope and Show more presentation changes", async () => {
    const repo = await fixtureRepository();
    let submittedPrompt = "";
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      submit: async (prompt: string) => {
        submittedPrompt = prompt;
        return success({ submitted: true, userTurnText: prompt, turnCount: 2, submissionState: "submitted_generating" });
      },
      readLatestUser: async () => success({
        role: "user",
        text: `manifest.upload.json\nFile\npacket-001.md\nFile\n${submittedPrompt}\nShow more`,
        format: "normalized_text"
      }),
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    expect(first.status).toBe("in_progress");

    const calls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls, {
      readLatestUser: async () => success({
        role: "user",
        text: `manifest.upload.json File packet-001.md File   ${submittedPrompt.replace(/\s+/g, " ")}`,
        format: "normalized_text"
      })
    }));

    expect(resumed.status).toBe("completed");
    expect(calls).not.toContain("attach");
    expect(calls).not.toContain("submit");
  });

  it("recovers the unique prompt-identical thread for a provisional ambiguous receipt", async () => {
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
      bootstrapRecovery: async target => {
        expect(target).toBeUndefined();
        return success({});
      },
      recoverThread: async () => ({
        ...success({
          url: "https://chatgpt.com/c/canonical-thread",
          conversationId: "canonical-thread"
        }),
        warnings: ["Recovered the archived review from a uniquely prompt-identical conversation in visible Chat history."]
      }),
      pageState: async () => ({
        url: "https://chatgpt.com/c/canonical-thread",
        conversationId: "canonical-thread",
        visibleText: "Chat history",
        signedIn: true
      }),
      readLatestUser: async () => success({
        role: "user",
        text: `manifest.json\nFile\npacket-001.md\nFile\n${submittedPrompt}\nShow more`,
        format: "normalized_text"
      })
    }));

    expect(resumed.status).toBe("completed_with_warnings");
    expect(resumed.warnings).toContain("Recovered the archived review from a uniquely prompt-identical conversation in visible Chat history.");
    expect(calls).toContain("pageState");
    expect(calls).toContain("recoverThread");
    expect(calls).not.toContain("openThread");
    expect(calls).not.toContain("submit");
  });

  it("does not canonically confirm a provisional recovery with a later identical turn", async () => {
    const repo = await fixtureRepository();
    let submittedPrompt = "";
    const provisionalUrl = "https://chatgpt.com/c/WEB:later-identical";
    const canonicalUrl = "https://chatgpt.com/c/canonical-later-identical";
    const first = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([], {
      newThread: async () => success({ url: provisionalUrl, conversationId: "WEB:later-identical" }),
      submit: async prompt => {
        submittedPrompt = prompt;
        return success({ submitted: true, userTurnText: "render pending", turnCount: 1, submissionState: "submitted_generating" });
      },
      readLatestUser: async () => success({ role: "user", text: "render pending", format: "normalized_text" }),
      pageState: async () => ({ url: provisionalUrl, conversationId: "WEB:later-identical", visibleText: "Stop generating", signedIn: true })
    }));
    const checkpointPath = join(first.archiveDirectory!, "thread-checkpoint.json");
    const checkpointBefore = JSON.parse(await readFile(checkpointPath, "utf8"));

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort([], {
      recoverThread: async () => success({ url: canonicalUrl, conversationId: "canonical-later-identical" }),
      pageState: async () => ({ url: canonicalUrl, conversationId: "canonical-later-identical", visibleText: "Chat history", signedIn: true }),
      readLatestUser: async () => success({ role: "user", text: submittedPrompt, format: "normalized_text" }),
      messageStatus: async () => success({ turnCount: 3, assistantTurnCount: 2, completionState: "complete", generationActive: false, generationSignals: [] })
    }));

    expect(resumed).toMatchObject({ blocker: { code: "resume_conversation_turn_ambiguous", resumable: true } });
    await expect(readFile(join(first.archiveDirectory!, "submission-confirmation.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(checkpointPath, "utf8")).current).toEqual(checkpointBefore.current);
  });

  it("does not confirm provisional recovery evidence from a drifting status context", async () => {
    const repo = await fixtureRepository();
    let submittedPrompt = "";
    let messageStatusCalls = 0;
    const provisionalUrl = "https://chatgpt.com/c/WEB:status-drift";
    const canonicalUrl = "https://chatgpt.com/c/canonical-status-drift";
    const first = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([], {
      newThread: async () => success({ url: provisionalUrl, conversationId: "WEB:status-drift" }),
      submit: async prompt => {
        submittedPrompt = prompt;
        return success({ submitted: true, userTurnText: "render pending", turnCount: 1, submissionState: "submitted_generating" });
      },
      readLatestUser: async () => success({ role: "user", text: "render pending", format: "normalized_text" }),
      pageState: async () => ({ url: provisionalUrl, conversationId: "WEB:status-drift", visibleText: "Stop generating", signedIn: true })
    }));
    const checkpointPath = join(first.archiveDirectory!, "thread-checkpoint.json");
    const checkpointBefore = JSON.parse(await readFile(checkpointPath, "utf8"));

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort([], {
      recoverThread: async () => success({ url: canonicalUrl, conversationId: "canonical-status-drift" }),
      pageState: async () => ({ url: canonicalUrl, conversationId: "canonical-status-drift", visibleText: "Chat history", signedIn: true }),
      readLatestUser: async () => ({
        ...success({ role: "user" as const, text: submittedPrompt, format: "normalized_text" as const }),
        context: { ...context(canonicalUrl), conversationId: "canonical-status-drift" }
      }),
      messageStatus: async () => {
        messageStatusCalls += 1;
        return {
          ...success({ turnCount: 1, assistantTurnCount: 0, completionState: "generating" as const, generationActive: true, generationSignals: ["stop-answering"] }),
          context: { ...context("https://chatgpt.com/c/other"), conversationId: "other" }
        };
      }
    }));

    expect(resumed).toMatchObject({ blocker: { code: "conversation_binding_lost", resumable: true } });
    expect(messageStatusCalls).toBe(1);
    await expect(readFile(join(first.archiveDirectory!, "submission-confirmation.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(checkpointPath, "utf8")).current).toEqual(checkpointBefore.current);
  });

  it("canonicalizes a confirmed provisional receipt on resume without resubmitting", async () => {
    const repo = await fixtureRepository();
    const provisionalUrl = "https://chatgpt.com/c/WEB:confirmed-fixture";
    const canonicalUrl = "https://chatgpt.com/c/canonical-fixture";
    let submittedPrompt = "";
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      newThread: async () => success({
        url: provisionalUrl,
        conversationId: "WEB:confirmed-fixture"
      }),
      submit: async (prompt: string) => {
        submittedPrompt = prompt;
        return {
          ...success({
            submitted: true,
            userTurnText: prompt,
            turnCount: 2,
            submissionState: "submitted_generating"
          }),
          context: context(provisionalUrl)
        };
      },
      readLatestUser: async () => success({
        role: "user",
        text: submittedPrompt,
        format: "normalized_text"
      }),
      pageState: async () => ({
        url: provisionalUrl,
        conversationId: "WEB:confirmed-fixture",
        visibleText: "Stop generating",
        signedIn: true
      }),
      waitMetadata: async () => failure("timeout", {
        complete: false,
        assistantTurnCount: 0,
        elapsedMs: 10,
        responseContent: "metadata"
      })
    }));
    expect(first.status).toBe("in_progress");
    expect(JSON.parse(await readFile(join(first.archiveDirectory!, "submission.json"), "utf8"))).toMatchObject({
      state: "confirmed",
      thread: { url: provisionalUrl, id: "WEB:confirmed-fixture" }
    });

    const archivedPrompt = await readFile(join(first.archiveDirectory!, "prompt.md"), "utf8");
    const mismatchedCalls: string[] = [];
    const mismatched = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(mismatchedCalls, {
      pageState: async () => ({
        url: canonicalUrl,
        conversationId: "canonical-fixture",
        visibleText: "Chat history",
        signedIn: true
      }),
      recoverThread: async () => success({
        url: canonicalUrl,
        conversationId: "canonical-fixture"
      }),
      readLatestUser: async () => ({
        ...success({
          role: "user" as const,
          text: "A different visible prompt",
          format: "normalized_text" as const
        }),
        context: { ...context(canonicalUrl), conversationId: "canonical-fixture" }
      })
    }));

    expect(mismatched.status).toBe("blocked");
    expect(mismatched.blocker).toMatchObject({ code: "resume_recovered_thread_prompt_mismatch", resumable: true });
    expect(mismatchedCalls).not.toContain("submit");
    expect(JSON.parse(await readFile(join(first.archiveDirectory!, "thread-checkpoint.json"), "utf8"))).toMatchObject({
      current: { url: provisionalUrl, id: "WEB:confirmed-fixture" }
    });

    const calls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls, {
      bootstrapRecovery: async target => {
        expect(target).toBeUndefined();
        return success({});
      },
      recoverThread: async () => success({
        url: canonicalUrl,
        conversationId: "canonical-fixture"
      }),
      pageState: async () => ({
        url: canonicalUrl,
        conversationId: "canonical-fixture",
        title: "Canonical fixture",
        visibleText: "Chat history",
        signedIn: true
      }),
      readLatestUser: async () => success({
        role: "user",
        text: archivedPrompt,
        format: "normalized_text"
      })
    }));

    expect(resumed.status).toBe("completed");
    expect(resumed.thread).toEqual({ url: canonicalUrl, id: "canonical-fixture" });
    expect(calls).toContain("pageState");
    expect(calls).toContain("recoverThread");
    expect(calls).not.toContain("openThread");
    expect(calls).not.toContain("submit");
    expect(JSON.parse(await readFile(join(first.archiveDirectory!, "thread-checkpoint.json"), "utf8"))).toMatchObject({
      current: { url: canonicalUrl, id: "canonical-fixture" }
    });

    const checkpointPath = join(first.archiveDirectory!, "thread-checkpoint.json");
    const staleCheckpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    staleCheckpoint.current = { url: provisionalUrl, id: "WEB:confirmed-fixture" };
    await writeFile(checkpointPath, `${JSON.stringify(staleCheckpoint, null, 2)}\n`);
    const crashRetryCalls: string[] = [];
    const crashRetried = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(crashRetryCalls, {
      pageState: async () => ({
        url: canonicalUrl,
        conversationId: "canonical-fixture",
        title: "Canonical fixture",
        visibleText: "Chat history",
        signedIn: true
      }),
      readLatestUser: async () => success({ role: "user", text: archivedPrompt, format: "normalized_text" })
    }));
    expect(crashRetried.status).toBe("completed");
    expect(crashRetryCalls).not.toContain("submit");
    expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toMatchObject({
      current: { url: canonicalUrl, id: "canonical-fixture" }
    });
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

  it("rejects a later identical user turn using archived turn-count ownership", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    const archivedPrompt = await readFile(join(first.archiveDirectory!, "prompt.md"), "utf8");
    const calls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls, {
      readLatestUser: async () => success({ role: "user", text: archivedPrompt, format: "normalized_text" }),
      messageStatus: async () => success({
        turnCount: 3,
        assistantTurnCount: 2,
        completionState: "complete",
        generationActive: false,
        generationSignals: []
      })
    }));

    expect(resumed).toMatchObject({
      status: "blocked",
      blocker: { code: "resume_conversation_turn_ambiguous", resumable: true }
    });
    expect(calls).not.toContain("waitMetadata");
    expect(calls).not.toContain("readFullMarkdown");
    expect(calls).not.toContain("submit");
  });

  it("rechecks ownership after polling before accepting a later identical response", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    const archivedPrompt = await readFile(join(first.archiveDirectory!, "prompt.md"), "utf8");
    let statusCalls = 0;
    const calls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls, {
      readLatestUser: async () => success({ role: "user", text: archivedPrompt, format: "normalized_text" }),
      messageStatus: async () => {
        statusCalls += 1;
        return success(statusCalls === 1
          ? { turnCount: 1, assistantTurnCount: 0, completionState: "generating", generationActive: true, generationSignals: ["stop-answering"] }
          : { turnCount: 3, assistantTurnCount: 2, completionState: "complete", generationActive: false, generationSignals: [] });
      }
    }));

    expect(resumed).toMatchObject({
      status: "blocked",
      blocker: { code: "resume_conversation_turn_ambiguous", resumable: true }
    });
    expect(calls).toContain("waitMetadata");
    expect(calls).not.toContain("readFullMarkdown");
  });

  it("fences a repeated identical turn during the first invocation too", async () => {
    const repo = await fixtureRepository();
    let statusCalls = 0;
    const calls: string[] = [];
    const result = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort(calls, {
      messageStatus: async () => {
        statusCalls += 1;
        if (statusCalls === 1) {
          return success({ turnCount: 0, assistantTurnCount: 0, completionState: "unknown", generationActive: false, generationSignals: [] });
        }
        if (statusCalls === 2) {
          return success({ turnCount: 1, assistantTurnCount: 0, completionState: "generating", generationActive: true, generationSignals: ["stop-answering"] });
        }
        return success({ turnCount: 3, assistantTurnCount: 2, completionState: "complete", generationActive: false, generationSignals: [] });
      }
    }));

    expect(result).toMatchObject({
      status: "blocked",
      submitted: true,
      blocker: { code: "resume_conversation_turn_ambiguous", resumable: true }
    });
    expect(calls).toContain("waitMetadata");
    expect(calls).not.toContain("readFullMarkdown");
    await expect(readFile(join(result.archiveDirectory!, "response.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

  it("does not use ordinary bootstrap when an archived provisional tab is no longer open", async () => {
    const repo = await fixtureRepository();
    const provisionalUrl = "https://chatgpt.com/c/WEB:missing-archived-tab";
    let submittedPrompt = "";
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      bootstrap: async () => ({ ...success({}), context: { ...context(), tabId: "missing-tab" } }),
      newThread: async () => ({
        ...success({ url: provisionalUrl, conversationId: "WEB:missing-archived-tab" }),
        context: { ...context(provisionalUrl), conversationId: "WEB:missing-archived-tab", tabId: "missing-tab" }
      }),
      submit: async prompt => {
        submittedPrompt = prompt;
        return {
          ...success({ submitted: true, userTurnText: prompt, turnCount: 1, submissionState: "submitted_generating" }),
          context: { ...context(provisionalUrl), conversationId: "WEB:missing-archived-tab", tabId: "missing-tab" }
        };
      },
      readLatestUser: async () => success({ role: "user", text: submittedPrompt, format: "normalized_text" }),
      pageState: async () => ({
        url: provisionalUrl,
        conversationId: "WEB:missing-archived-tab",
        tabId: "missing-tab",
        visibleText: "Stop generating",
        signedIn: true
      }),
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    await rm(join(first.archiveDirectory!, "submission.json"));
    const intentPath = join(first.archiveDirectory!, "submission-intent.json");
    const intentBefore = await readFile(intentPath, "utf8");
    const recoveryTargets: unknown[] = [];
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls, {
      bootstrapRecovery: async target => {
        recoveryTargets.push(target);
        return {
          ok: false,
          status: "blocked",
          warnings: [],
          blocker: {
            kind: "not_found",
            code: "existing_tab_not_found",
            message: "No already-open ChatGPT tab matched the recovery target.",
            resumable: false
          },
          context: context()
        };
      }
    }));

    expect(resumed).toMatchObject({
      status: "blocked",
      submitted: false,
      resubmitAllowed: false,
      blocker: { code: "existing_tab_not_found", resumable: true }
    });
    expect(recoveryTargets).toEqual([{ tabId: "missing-tab" }, undefined]);
    expect(calls).toEqual(["bootstrapRecovery", "bootstrapRecovery"]);
    expect(calls).not.toContain("bootstrap");
    expect(calls).not.toContain("openChat");
    expect(calls).not.toContain("newThread");
    expect(calls).not.toContain("recoverThread");
    expect(calls).not.toContain("submit");
    expect(await readFile(intentPath, "utf8")).toBe(intentBefore);
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

  it("rejects an external checkpoint URL even when its declared conversation ID matches", async () => {
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
    checkpoint.current = { url: "https://example.invalid/c/review-thread", id: "review-thread", tabId: "stored-tab" };
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls));

    expect(resumed).toMatchObject({ status: "blocked", blocker: { code: "resume_checkpoint_invalid" } });
    expect(calls).not.toContain("bootstrap");
    expect(calls).not.toContain("bootstrapRecovery");
  });

  it("rejects a malformed archived recovery tab id before opening a browser", async () => {
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
    checkpoint.current.tabId = { unexpected: true };
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls));

    expect(resumed).toMatchObject({ status: "blocked", blocker: { code: "resume_checkpoint_invalid" } });
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

  it("publishes terminal outcome only after provenance and makes a late archive commit failure authoritative", async () => {
    const repo = await fixtureRepository();
    let sabotagedArchive: string | undefined;
    const result = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD"
    }, makePort([], {
      inspectConfiguration: async () => {
        const archiveRoot = join(repo, ".codex", "pro-reviews");
        const archives = await readdir(archiveRoot);
        sabotagedArchive = join(archiveRoot, archives[0]!);
        await mkdir(join(sabotagedArchive, "receipt.json"));
        return success(beforeInspection);
      }
    }));

    expect(result).toMatchObject({
      status: "failed",
      submitted: true,
      blocker: { code: "archive_terminal_commit_failed", resumable: false }
    });
    await expect(readFile(join(sabotagedArchive!, "terminal-outcome.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(sabotagedArchive!, "archive-commit-failure.json"), "utf8"))).toMatchObject({
      status: "failed",
      submitted: true,
      blocker: { code: "archive_terminal_commit_failed", resumable: false }
    });

    const calls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: sabotagedArchive! }
    }, makePort(calls));
    expect(resumed).toMatchObject({ status: "failed", blocker: { code: "archive_terminal_commit_failed", resumable: false } });
    expect(calls).toEqual([]);
  });

  it("replays an authoritative pre-submit terminal outcome after archive integrity checks", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([], {
      applyPro: async () => success({
        requested: { intelligence: "Pro" },
        selected: [{ axis: "intelligence", requested: "Pro", selected: "Instant" }],
        before: beforeInspection,
        after: beforeInspection,
        verified: false
      })
    }));
    expect(first).toMatchObject({
      status: "blocked",
      submitted: false,
      blocker: { code: "pro_precondition_unverified", resumable: false }
    });
    await expect(readFile(join(first.archiveDirectory!, "submission.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const calls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      safeguards: { restorePreviousConfiguration: true },
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls));
    expect(resumed).toMatchObject({
      status: "blocked",
      submitted: false,
      blocker: { code: "pro_precondition_unverified", resumable: false }
    });
    expect(calls).toEqual([]);
  });

  it("replays a pre-snapshot terminal marker without requiring configuration.before.json", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([], {
      newThread: async () => ({
        ok: false,
        status: "blocked",
        warnings: [],
        blocker: { kind: "selector_drift", code: "pre_snapshot_open_failed", message: "Open failed before snapshot.", resumable: false },
        context: context()
      })
    }));
    expect(first).toMatchObject({ submitted: false, blocker: { code: "pre_snapshot_open_failed", resumable: false } });
    await expect(readFile(join(first.archiveDirectory!, "configuration.before.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const calls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls));
    expect(resumed).toMatchObject({ submitted: false, blocker: { code: "pre_snapshot_open_failed", resumable: false } });
    expect(calls).toEqual([]);
  });

  it("reports a corrupt terminal marker structurally without opening a browser", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    await writeFile(join(first.archiveDirectory!, "terminal-outcome.json"), "{not-json\n");
    const calls: string[] = [];

    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls));
    expect(resumed).toMatchObject({
      status: "blocked",
      submitted: true,
      blocker: { code: "resume_terminal_outcome_invalid", resumable: false }
    });
    expect(calls).toEqual([]);
  });

  it("rejects a resumable terminal marker as non-authoritative", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      polling: { callTimeoutMs: 10, totalTimeoutMs: 10, stableMs: 1, pollMs: 1 }
    }, makePort([], {
      waitMetadata: async () => failure("timeout", { complete: false, assistantTurnCount: 0, elapsedMs: 10, responseContent: "metadata" })
    }));
    await writeFile(join(first.archiveDirectory!, "terminal-outcome.json"), `${JSON.stringify({
      schemaVersion: 1,
      finalizedAt: "2026-08-11T12:00:00.000Z",
      status: "blocked",
      ok: false,
      submitted: true,
      resubmitAllowed: false,
      blocker: { kind: "unknown", code: "synthetic_resumable", message: "retry", resumable: true },
      warnings: [],
      thread: { url: "https://chatgpt.com/c/review-thread", id: "review-thread" }
    }, null, 2)}\n`);
    const calls: string[] = [];
    const resumed = await runCodeReviewWithPort({
      repositoryRoot: repo,
      baseRef: "HEAD",
      resume: { archiveDirectory: first.archiveDirectory! }
    }, makePort(calls));
    expect(resumed).toMatchObject({ blocker: { code: "resume_terminal_outcome_invalid", resumable: false } });
    expect(calls).toEqual([]);
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

  it("reclaims a fresh lease after its browser-host owner has exited", async () => {
    const repo = await fixtureRepository();
    const first = await runCodeReviewWithPort({ repositoryRoot: repo, baseRef: "HEAD" }, makePort([]));
    const archiveDirectory = first.archiveDirectory!;
    const prompt = await readFile(join(archiveDirectory, "prompt.md"), "utf8");
    const owner = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    if (owner.pid === undefined) throw new Error("Unable to start the exited lease-owner fixture.");
    const ownerPid = owner.pid;
    await new Promise<void>((resolve, reject) => {
      if (owner.exitCode !== null) {
        resolve();
        return;
      }
      owner.once("exit", () => resolve());
      owner.once("error", reject);
    });
    await writeFile(join(archiveDirectory, ".workflow.lock"), JSON.stringify({
      schemaVersion: 1,
      pid: ownerPid,
      acquiredAt: new Date().toISOString(),
      renewedAt: new Date().toISOString()
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
  });

  it("does not delete a successor lease installed while dead-owner liveness is being checked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-pro-lease-replacement-"));
    const leasePath = join(directory, ".workflow.lock");
    const originalId = "11111111-1111-4111-8111-111111111111";
    const successorId = "22222222-2222-4222-8222-222222222222";
    const original = JSON.stringify({
      schemaVersion: 1,
      leaseId: originalId,
      pid: 4242,
      acquiredAt: "2026-08-11T12:00:00.000Z"
    });
    const successor = JSON.stringify({
      schemaVersion: 1,
      leaseId: successorId,
      pid: process.pid,
      acquiredAt: "2026-08-13T18:30:00.000Z"
    });
    await mkdir(leasePath);
    await writeFile(join(leasePath, `${originalId}.json`), original);
    let finishProbe!: () => void;
    let probeStarted!: () => void;
    const started = new Promise<void>(resolve => { probeStarted = resolve; });
    const finish = new Promise<void>(resolve => { finishProbe = resolve; });
    const removal = removeLeaseIfOwnerExitedOrExpired(leasePath, async () => {
      probeStarted();
      await finish;
      return "dead";
    });

    await started;
    await rm(join(leasePath, `${originalId}.json`));
    await rmdir(leasePath);
    await mkdir(leasePath);
    await writeFile(join(leasePath, `${successorId}.json`), successor);
    finishProbe();

    await expect(removal).resolves.toBe(false);
    await expect(readFile(join(leasePath, `${successorId}.json`), "utf8")).resolves.toBe(successor);
    await rm(directory, { recursive: true, force: true });
  });

  it("reclaims a stale corrupt directory marker left by interrupted initialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-pro-corrupt-directory-lease-"));
    const leasePath = join(directory, ".workflow.lock");
    const ownerPath = join(leasePath, "33333333-3333-4333-8333-333333333333.json");
    await mkdir(leasePath);
    await writeFile(ownerPath, "");
    const staleTime = new Date(Date.now() - 10 * 60_000);
    await utimes(ownerPath, staleTime, staleTime);

    await expect(removeLeaseIfOwnerExitedOrExpired(leasePath)).resolves.toBe(true);
    await expect(readFile(ownerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });

  it("does not evict a live lease owner merely because its timestamp is old", async () => {
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

      expect(resumed).toMatchObject({
        status: "blocked",
        blocker: { code: "review_archive_locked", resumable: true }
      });
      expect(calls).not.toContain("bootstrap");
      await expect(readFile(join(archiveDirectory, ".workflow.lock"), "utf8")).resolves.toContain(String(reusedOwner.pid));
    } finally {
      if (reusedOwner.exitCode === null) reusedOwner.kill();
      await rm(join(archiveDirectory, ".workflow.lock"), { force: true });
    }
  }, 15_000);

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
    bootstrapRecovery: record("bootstrapRecovery", async () => success({})),
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

function mutableChatPage(
  id: string,
  initialUrl: string,
  fixture: { home?: string; conversations?: Record<string, string> },
  navigated: string[] = []
): PageLike {
  let currentUrl = initialUrl;
  return {
    id,
    tabId: id,
    url: () => currentUrl,
    goto: async url => {
      currentUrl = url;
      navigated.push(url);
    },
    title: async () => currentUrl === "https://chatgpt.com/" ? "ChatGPT" : "Recovery candidate",
    content: async () => {
      const conversationId = /\/c\/([^/?#]+)/.exec(currentUrl)?.[1];
      const prompt = conversationId === undefined ? undefined : fixture.conversations?.[conversationId];
      if (prompt !== undefined) {
        return `<main>New chat Search chats Chat with ChatGPT<div data-message-author-role="user">${prompt}</div><div data-message-author-role="assistant">response</div></main>`;
      }
      return `<main>New chat Search chats Chat with ChatGPT${fixture.home ?? ""}</main>`;
    },
    locator: () => ({ count: async () => 0 }),
    waitForTimeout: async () => undefined,
    waitForEvent: async () => ({})
  };
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
