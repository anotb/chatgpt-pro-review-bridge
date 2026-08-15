import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  copyAssistantMarkdown,
  downloadHandleArtifact,
  inventoryHandleArtifacts,
  readOwnedAssistantText,
  readVisibleChatSnapshot,
  type TextClipboard,
  type ArtifactLocator,
  type StructuralPage,
  type VisibleChatSnapshot
} from "../../src/bridge/browser-output.js";
import { collectBridgeOutput } from "../../src/bridge/output.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

function pageWith<Result>(result: Result): StructuralPage {
  return {
    evaluate: async () => result as never,
    capabilities: {
      get: async id => id === "cdp"
        ? { send: async () => ({ result: { value: result } }) }
        : undefined
    }
  };
}

function copyPage(
  assistantIndex: number,
  turnId: string | undefined | (() => string | undefined),
  onClick: () => void = () => undefined
): { page: StructuralPage; pageEvaluate: ReturnType<typeof vi.fn>; click: ReturnType<typeof vi.fn> } {
  const click = vi.fn(async () => { onClick(); });
  const copy: ArtifactLocator = {
    count: async () => 1,
    isVisible: async () => true,
    click
  };
  const container: ArtifactLocator = {
    count: async () => 1,
    locator: selector => selector === 'button[data-testid="copy-turn-action-button"]'
      ? copy
      : { count: async () => 0 }
  };
  const assistant = (index: number): ArtifactLocator => ({
    isVisible: async () => true,
    evaluate: async <T>() => (index === assistantIndex
      ? typeof turnId === "function" ? turnId() : turnId
      : `turn-${index}`) as T,
    locator: () => container
  });
  const only = assistant(0);
  const assistants: ArtifactLocator = {
    count: async () => assistantIndex + 1,
    nth: index => assistant(index),
    isVisible: only.isVisible!,
    evaluate: only.evaluate!,
    locator: only.locator!
  };
  const pageEvaluate = vi.fn(async () => {
    throw new Error("Copy must not mutate through page.evaluate().");
  });
  return {
    page: {
      evaluate: pageEvaluate,
      locator: selector => selector === 'main [data-message-author-role="assistant"]'
        ? assistants
        : { count: async () => 0 }
    },
    pageEvaluate,
    click
  };
}

function fallbackCopyPage(codeFlags: readonly boolean[]): {
  page: StructuralPage;
  clicks: Array<ReturnType<typeof vi.fn>>;
} {
  const clicks = codeFlags.map(() => vi.fn(async () => undefined));
  const controls = codeFlags.map((insideCode, index): ArtifactLocator => ({
    isVisible: async () => true,
    evaluate: async <T>() => insideCode as T,
    click: clicks[index]!
  }));
  const fallback: ArtifactLocator = {
    count: async () => controls.length,
    nth: index => controls[index]!
  };
  const container: ArtifactLocator = {
    count: async () => 1,
    locator: selector => selector === 'button[data-testid="copy-turn-action-button"]'
      ? { count: async () => 0 }
      : fallback
  };
  const assistant: ArtifactLocator = {
    count: async () => 1,
    isVisible: async () => true,
    locator: () => container
  };
  return {
    page: {
      evaluate: async () => undefined as never,
      locator: selector => selector === 'main [data-message-author-role="assistant"]'
        ? assistant
        : { count: async () => 0 }
    },
    clicks
  };
}

function snapshot(overrides: Partial<VisibleChatSnapshot> = {}): VisibleChatSnapshot {
  return {
    userCount: 0,
    assistantCount: 0,
    generation: { state: "uncertain", stopVisible: false, responseActionsVisible: false },
    artifactCandidates: [],
    ...overrides
  };
}

describe("visible Chat output helpers", () => {
  it("returns cheap counts and only explicitly requested text", async () => {
    const result = await readVisibleChatSnapshot(pageWith({
      userCount: 4,
      assistantCount: 3,
      userText: " owned prompt ",
      assistantText: "owned answer",
      assistantTurnId: "conversation-turn-7",
      pageStopVisible: true,
      responseActionsVisible: false,
      artifactCandidates: []
    }), { userIndex: 3, assistantIndex: 2, includeAssistantText: true });
    expect(result).toMatchObject({
      userCount: 4,
      assistantCount: 3,
      userText: " owned prompt ",
      assistantText: "owned answer",
      generation: { state: "generating" }
    });
  });

  it("treats response actions as completion only when Stop is absent", async () => {
    const completed = await readVisibleChatSnapshot(pageWith({
      userCount: 1,
      assistantCount: 1,
      pageStopVisible: false,
      responseActionsVisible: true,
      artifactCandidates: []
    }));
    expect(completed.generation.state).toBe("completed");
  });

  it("does not attribute a later page-global Stop control to an older owned response", async () => {
    const completed = await readVisibleChatSnapshot(pageWith({
      userCount: 2,
      assistantCount: 2,
      pageStopVisible: true,
      responseActionsVisible: true,
      artifactCandidates: []
    }), { userIndex: 0, assistantIndex: 0 });
    expect(completed.generation).toMatchObject({ state: "completed", stopVisible: false });
  });

  it("copies mapped raw Markdown and restores an opaque clipboard snapshot", async () => {
    const opaque = { formats: ["text/plain", "text/html"] };
    const clipboard: TextClipboard = {
      snapshot: vi.fn(async () => opaque),
      readText: vi.fn(async () => "before"),
      waitForChange: vi.fn(async () => "same raw markdown"),
      restore: vi.fn(async () => {})
    };
    const controlled = copyPage(2, "conversation-turn-6");
    await expect(copyAssistantMarkdown(controlled.page, clipboard, {
      assistantIndex: 2,
      assistantTurnId: "conversation-turn-6"
    })).resolves.toEqual({ status: "copied", markdown: "same raw markdown" });
    expect(controlled.click).toHaveBeenCalledTimes(1);
    expect(controlled.pageEvaluate).not.toHaveBeenCalled();
    expect(clipboard.restore).toHaveBeenCalledWith(opaque);
  });

  it("rejects unchanged clipboard content after Copy", async () => {
    const clipboard: TextClipboard = {
      readText: vi.fn(async () => "stale clipboard")
    };
    const controlled = copyPage(0, undefined);

    await expect(copyAssistantMarkdown(controlled.page, clipboard, {
      assistantIndex: 0
    })).resolves.toEqual({ status: "unavailable", reason: "clipboard_unavailable" });
    expect(controlled.click).not.toHaveBeenCalled();
  });

  it("uses a temporary sentinel when lossless restore makes repeated Markdown safe", async () => {
    const opaque = [{ type: "text/html", data: "<b>kept</b>" }];
    let current = "same response";
    const clipboard: TextClipboard = {
      snapshot: vi.fn(async () => opaque),
      restore: vi.fn(async () => undefined),
      readText: vi.fn(async () => current),
      writeText: vi.fn(async text => { current = text; })
    };
    const controlled = copyPage(0, "turn-1", () => { current = "same response"; });

    await expect(copyAssistantMarkdown(controlled.page, clipboard, {
      assistantIndex: 0,
      assistantTurnId: "turn-1"
    })).resolves.toEqual({ status: "copied", markdown: "same response" });
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/^codex-bridge-copy-/));
    expect(clipboard.restore).toHaveBeenCalledWith(opaque);
  });

  it("gives one transient exact Copy failure a bounded second chance", async () => {
    const opaque = [{ type: "text/html", data: "preserve me" }];
    const waitForChange = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("# Exact Markdown");
    const clipboard: TextClipboard = {
      snapshot: vi.fn(async () => opaque),
      restore: vi.fn(async () => undefined),
      readText: vi.fn(async () => "before"),
      writeText: vi.fn(async () => undefined),
      waitForChange
    };
    const controlled = copyPage(0, "turn-1");

    await expect(copyAssistantMarkdown(controlled.page, clipboard, {
      assistantIndex: 0,
      assistantTurnId: "turn-1"
    })).resolves.toEqual({ status: "copied", markdown: "# Exact Markdown" });
    expect(controlled.click).toHaveBeenCalledTimes(2);
    expect(waitForChange).toHaveBeenCalledTimes(2);
    expect(clipboard.restore).toHaveBeenCalledExactlyOnceWith(opaque);
  });

  it("revalidates turn identity before the bounded second Copy click", async () => {
    let turnId = "turn-1";
    const opaque = { formats: ["text/plain"] };
    const clipboard: TextClipboard = {
      snapshot: vi.fn(async () => opaque),
      restore: vi.fn(async () => undefined),
      readText: vi.fn(async () => "before"),
      waitForChange: vi.fn(async () => undefined)
    };
    const controlled = copyPage(0, () => turnId, () => { turnId = "replacement-turn"; });

    await expect(copyAssistantMarkdown(controlled.page, clipboard, {
      assistantIndex: 0,
      assistantTurnId: "turn-1"
    })).resolves.toEqual({ status: "unavailable", reason: "turn_mismatch" });
    expect(controlled.click).toHaveBeenCalledTimes(1);
  });

  it("does not retry an initial turn mismatch", async () => {
    const clipboard: TextClipboard = {
      readText: vi.fn(async () => "before")
    };
    const controlled = copyPage(0, "different-turn");

    await expect(copyAssistantMarkdown(controlled.page, clipboard, {
      assistantIndex: 0,
      assistantTurnId: "owned-turn"
    })).resolves.toEqual({ status: "unavailable", reason: "turn_mismatch" });
    expect(controlled.click).not.toHaveBeenCalled();
    expect(clipboard.readText).not.toHaveBeenCalled();
  });

  it("falls back to DOM after both bounded exact Copy attempts fail", async () => {
    const opaque = { formats: ["text/plain", "text/html"] };
    const clipboard: TextClipboard = {
      snapshot: vi.fn(async () => opaque),
      restore: vi.fn(async () => undefined),
      readText: vi.fn(async () => "before"),
      writeText: vi.fn(async () => undefined),
      waitForChange: vi.fn(async () => undefined)
    };
    const controlled = copyPage(0, "turn-1");
    const readResponseSnapshot = vi.fn(async () => ({ text: "DOM fallback", partial: false }));
    const output = await collectBridgeOutput({
      copyResponseMarkdown: async () => {
        const copied = await copyAssistantMarkdown(controlled.page, clipboard, {
          assistantIndex: 0,
          assistantTurnId: "turn-1"
        });
        return copied.status === "copied" ? copied.markdown : undefined;
      },
      readResponseSnapshot,
      listArtifacts: async () => []
    });

    expect(output).toEqual({
      text: "DOM fallback",
      fidelity: "dom_text",
      artifacts: [],
      partial: false
    });
    expect(controlled.click).toHaveBeenCalledTimes(2);
    expect(clipboard.restore).toHaveBeenCalledExactlyOnceWith(opaque);
    expect(readResponseSnapshot).toHaveBeenCalledTimes(1);
  });

  it("excludes code Copy controls and fails closed when response Copy remains ambiguous", async () => {
    const opaque = { formats: ["text/plain"] };
    const clipboard: TextClipboard = {
      snapshot: async () => opaque,
      restore: async () => undefined,
      readText: async () => "before",
      waitForChange: async () => "response Markdown"
    };
    const exact = fallbackCopyPage([true, false]);
    await expect(copyAssistantMarkdown(exact.page, clipboard, { assistantIndex: 0 }))
      .resolves.toEqual({ status: "copied", markdown: "response Markdown" });
    expect(exact.clicks[0]).not.toHaveBeenCalled();
    expect(exact.clicks[1]).toHaveBeenCalledTimes(1);

    const ambiguous = fallbackCopyPage([false, false]);
    await expect(copyAssistantMarkdown(ambiguous.page, clipboard, { assistantIndex: 0 }))
      .resolves.toEqual({ status: "unavailable", reason: "copy_action_ambiguous" });
    expect(ambiguous.clicks.every(click => click.mock.calls.length === 0)).toBe(true);
  });

  it("returns DOM text only for the owned assistant identity", () => {
    const turns = snapshot({
      assistantCount: 2,
      assistantText: "owned exact\ntext",
      assistantTurnId: "conversation-turn-4"
    });
    expect(readOwnedAssistantText(turns, {
      assistantIndex: 1,
      assistantTurnId: "conversation-turn-4"
    })).toBe("owned exact\ntext");
    expect(readOwnedAssistantText(turns, {
      assistantIndex: 1,
      assistantTurnId: "different"
    })).toBeUndefined();
  });

  it("inventories only the new assistant turn with stable opaque keys", () => {
    const turns = snapshot({
      assistantCount: 2,
      artifactCandidates: [
        { assistantIndex: 0, assistantTurnId: "turn-1", kind: "file", name: "old.csv", occurrence: 0 },
        {
          assistantIndex: 1,
          assistantTurnId: "turn-2",
          kind: "file",
          name: "report.csv",
          occurrence: 0,
          controlLabel: "report.csv",
          controlRole: "link"
        },
        { assistantIndex: 1, assistantTurnId: "turn-2", kind: "image", name: "description", occurrence: 0 }
      ]
    });
    const scope = {
      operationId: "operation-1",
      conversationId: "conversation-1",
      assistantTurnBefore: 1
    };
    const first = inventoryHandleArtifacts(turns, scope);
    const renamed = inventoryHandleArtifacts(snapshot({
      artifactCandidates: turns.artifactCandidates.map(item => item.kind === "image"
        ? { ...item, name: "changed alt" }
        : item)
    }), scope);
    const otherOperation = inventoryHandleArtifacts(turns, {
      ...scope,
      operationId: "operation-2"
    });
    expect(first).toHaveLength(2);
    expect(first.every(item => /^[a-f0-9]{64}$/.test(item.key))).toBe(true);
    expect(renamed[1]?.key).toBe(first[1]?.key);
    expect(otherOperation[0]?.key).not.toBe(first[0]?.key);
  });

  it("saves an exact owned visible image source deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-image-"));
    roots.push(root);
    const artifact = {
      key: "e".repeat(64),
      kind: "image" as const,
      assistantIndex: 1,
      assistantTurnId: "turn-2",
      occurrence: 0
    };
    const downloaded = await downloadHandleArtifact(pageWith({
      dataUrl: `data:image/png;base64,${Buffer.from("image bytes").toString("base64")}`,
      mimeType: "image/png"
    }), artifact, root);
    expect(downloaded).toMatchObject({ bytes: 11, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await readFile(downloaded.path, "utf8")).toBe("image bytes");
  });

  it("uses only structural generated-image evidence", async () => {
    const evaluate = vi.fn(async <T, A>(fn: (argument: A) => T | Promise<T>, argument: A) => {
      const source = String(fn);
      expect(source).toContain("generatedImageContainerSelector");
      expect(source).not.toContain("naturalWidth");
      expect(source).not.toContain("oaiusercontent");
      expect((argument as { generatedImageContainerSelector: string })
        .generatedImageContainerSelector).toContain("image-paragen-multigen");
      return snapshot({ userCount: 1, assistantCount: 1 }) as T;
    });
    await readVisibleChatSnapshot({ evaluate });
  });

  it("treats an owned structural image-only turn as completed output", async () => {
    const page: StructuralPage = {
      evaluate: async () => ({
        userCount: 1,
        assistantCount: 1,
        assistantTurnId: "conversation-turn-2",
        pageStopVisible: false,
        responseActionsVisible: false,
        artifactResponseVisible: true,
        artifactCandidates: []
      })
    };

    await expect(readVisibleChatSnapshot(page, {
      userIndex: 0,
      assistantIndex: 0
    })).resolves.toMatchObject({
      assistantTurnId: "conversation-turn-2",
      generation: { state: "completed" }
    });
  });

  it("waits for one exact preview and downloads through the IAB path object", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-preview-"));
    roots.push(root);
    const source = join(root, "iab-download.md");
    await writeFile(source, "# downloaded review\n");
    let waits = 0;
    const openerClick = vi.fn(async () => undefined);
    const downloadClick = vi.fn(async () => undefined);
    const opener: ArtifactLocator = {
      isVisible: async () => true,
      click: openerClick,
      evaluate: async <T>() => ({
        role: "button",
        label: "review.md",
        text: "review.md",
        trusted: true
      }) as T
    };
    const download: ArtifactLocator = {
      count: async () => 1,
      isVisible: async () => true,
      click: downloadClick
    };
    const preview: ArtifactLocator = {
      count: async () => waits >= 2 ? 1 : 0,
      nth: () => preview,
      isVisible: async () => waits >= 2,
      getByRole: () => download
    };
    const assistant: ArtifactLocator = {
      count: async () => 1,
      nth: () => assistant,
      isVisible: async () => true,
      getByRole: () => ({ count: async () => 1, nth: () => opener, ...opener })
    };
    const page: StructuralPage = {
      evaluate: async () => undefined as never,
      locator: selector => selector.startsWith("section[") ? preview : assistant,
      waitForTimeout: async () => { waits += 1; },
      waitForEvent: async () => ({
        path: async (options?: { timeoutMs?: number }) => {
          expect(options).toEqual({ timeoutMs: 500 });
          return source;
        }
      })
    };

    const downloaded = await downloadHandleArtifact(page, {
      key: "a".repeat(64),
      kind: "file",
      name: "review.md",
      assistantIndex: 0,
      occurrence: 0,
      controlLabel: "review.md",
      controlRole: "button"
    }, root, 500);

    expect(waits).toBe(2);
    expect(openerClick).toHaveBeenCalledOnce();
    expect(downloadClick).toHaveBeenCalledOnce();
    expect(downloaded).toMatchObject({
      bytes: 20,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(await readFile(downloaded.path, "utf8")).toBe("# downloaded review\n");
  });

  it("addresses file downloads by exact visible assistant role and label", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-file-"));
    roots.push(root);
    const source = join(root, "source-report.csv");
    await writeFile(source, "downloaded");
    const clicks: string[] = [];
    const control = (name: string, visible: boolean): ArtifactLocator => ({
      isVisible: async () => visible,
      click: async () => { clicks.push(name); },
      evaluate: async <T>() => ({
        role: "link",
        label: "report.csv",
        text: "report.csv",
        trusted: true
      }) as T
    });
    const controls = [control("hidden", false), control("visible", true)];
    const hiddenAssistant: ArtifactLocator = { isVisible: async () => false };
    const visibleAssistant: ArtifactLocator = {
      isVisible: async () => true,
      getByRole: () => ({
        count: async () => controls.length,
        nth: index => controls[index]!
      })
    };
    const assistants: ArtifactLocator = {
      count: async () => 2,
      nth: index => index === 0 ? hiddenAssistant : visibleAssistant
    };
    let downloadWaitOptions: unknown;
    const page: StructuralPage = {
      evaluate: async () => undefined as never,
      locator: () => assistants,
      waitForEvent: async (_event, options) => {
        downloadWaitOptions = options;
        return ({
          path: async (pathOptions?: { timeoutMs?: number }) => {
            expect(pathOptions).toEqual({ timeoutMs: 100 });
            return source;
          }
        });
      }
    };

    const downloaded = await downloadHandleArtifact(page, {
      key: "f".repeat(64),
      kind: "file",
      name: "report.csv",
      assistantIndex: 0,
      occurrence: 0,
      controlLabel: "report.csv",
      controlRole: "link"
    }, root, 100);

    expect(clicks).toEqual(["visible"]);
    expect(downloadWaitOptions).toEqual({ timeoutMs: 100 });
    expect(await readFile(downloaded.path, "utf8")).toBe("downloaded");
  });

  it("refuses to reuse a colliding artifact destination with different bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-file-collision-"));
    roots.push(root);
    const target = join(root, `${"f".repeat(12)}-report.csv`);
    const source = join(root, "source-report.csv");
    await writeFile(target, "stale");
    await writeFile(source, "fresh");
    const control: ArtifactLocator = {
      isVisible: async () => true,
      click: async () => undefined,
      evaluate: async <T>() => ({
        role: "link",
        label: "report.csv",
        text: "report.csv",
        trusted: true
      }) as T
    };
    const assistant: ArtifactLocator = {
      isVisible: async () => true,
      getByRole: () => ({ ...control, count: async () => 1, nth: () => control })
    };
    const page: StructuralPage = {
      evaluate: async () => undefined as never,
      locator: () => ({ ...assistant, count: async () => 1, nth: () => assistant }),
      waitForEvent: async () => ({ path: async () => source })
    };

    await expect(downloadHandleArtifact(page, {
      key: "f".repeat(64),
      kind: "file",
      name: "report.csv",
      assistantIndex: 0,
      occurrence: 0,
      controlLabel: "report.csv",
      controlRole: "link"
    }, root, 100)).rejects.toThrow("destination collision");
    expect(await readFile(target, "utf8")).toBe("stale");
  });

  it("passes a bounded timeout into owned image fetch and conversion", async () => {
    let seenTimeout: number | undefined;
    let seenExpression = "";
    const page: StructuralPage = {
      evaluate: async () => undefined as never,
      capabilities: {
        get: async () => ({
          send: async (_method: string, params: { expression: string }, options: { timeoutMs: number }) => {
            seenTimeout = options.timeoutMs;
            seenExpression = params.expression;
            return { result: { value: undefined } };
          }
        })
      }
    };
    await expect(downloadHandleArtifact(page, {
      key: "e".repeat(64),
      kind: "image",
      assistantIndex: 0,
      occurrence: 0
    }, "ignored", 37)).rejects.toThrow("image source is unavailable");
    expect(seenTimeout).toBe(37);
    expect(seenExpression).toContain('"timeoutMs":37');
    expect(seenExpression).toContain("new AbortController()");
  });
});
