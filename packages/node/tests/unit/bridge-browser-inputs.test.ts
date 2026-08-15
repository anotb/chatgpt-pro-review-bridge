import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  attachFiles,
  selectTool,
  validateLocalFiles,
  verifyVisibleTools,
  type BrowserInputLocator,
  type BrowserInputPage
} from "../../src/bridge/browser-inputs.js";

let fixtureDir: string;
let firstFile: string;
let secondFile: string;
let emptyFile: string;
let directoryPath: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "bridge-browser-inputs-"));
  firstFile = join(fixtureDir, "context notes.md");
  secondFile = join(fixtureDir, "data.csv");
  emptyFile = join(fixtureDir, "empty.txt");
  directoryPath = join(fixtureDir, "folder");
  await Promise.all([
    writeFile(firstFile, "context"),
    writeFile(secondFile, "a,b\n1,2\n"),
    writeFile(emptyFile, ""),
    mkdir(directoryPath)
  ]);
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe("validateLocalFiles", () => {
  it("checks only absolute, readable, regular local files", async () => {
    await expect(validateLocalFiles([firstFile])).resolves.toEqual([{
      path: firstFile,
      name: "context notes.md",
      bytes: 7
    }]);
    await expect(validateLocalFiles(["relative.txt"]))
      .rejects.toMatchObject({ code: "file_path_not_absolute", uncertain: false });
    await expect(validateLocalFiles([join(fixtureDir, "missing.txt")]))
      .rejects.toMatchObject({ code: "file_not_readable", uncertain: false });
    await expect(validateLocalFiles([directoryPath]))
      .rejects.toMatchObject({ code: "file_not_regular", uncertain: false });
    await expect(validateLocalFiles([emptyFile])).resolves.toEqual([{
      path: emptyFile,
      name: "empty.txt",
      bytes: 0
    }]);
  });
});

describe("attachFiles", () => {
  it("returns immediately for no files", async () => {
    const page = new FakePage();
    await expect(attachFiles(page, [])).resolves.toEqual([]);
    expect(page.cdpCalls).toBe(0);
  });

  it("hands files directly to the exact composer input without clicking", async () => {
    const page = new FakePage();

    await expect(attachFiles(page, [firstFile])).resolves.toEqual([{
      path: firstFile,
      name: basename(firstFile),
      bytes: 7
    }]);

    expect(page.cdpCalls).toBe(1);
    expect(page.cdpTimeouts).toEqual([30_000]);
    expect(page.cdpExpressions[0]).toContain("new DataTransfer()");
    expect(page.cdpExpressions[0]).not.toContain(".click(");
    expect(page.handoffNames).toEqual([basename(firstFile)]);
    expect(page.composerLocatorQueries).toEqual(["#upload-files"]);
  });

  it("fails before action when background handoff is unavailable", async () => {
    const page = new FakePage();
    page.cdpSupported = false;

    await expect(attachFiles(page, [firstFile])).rejects.toMatchObject({
      code: "upload_path_unavailable",
      uncertain: false
    });
    expect(page.cdpCalls).toBe(0);
  });

  it("fails before action when the exact composer input is absent or ambiguous", async () => {
    for (const count of [0, 2]) {
      const page = new FakePage();
      page.uploadInputCount = count;
      await expect(attachFiles(page, [firstFile])).rejects.toMatchObject({
        code: "upload_path_unavailable",
        uncertain: false
      });
      expect(page.cdpCalls).toBe(0);
    }
  });

  it("requires a file input with enough multiplicity before action", async () => {
    const wrongType = new FakePage();
    wrongType.uploadInputType = "text";
    await expect(attachFiles(wrongType, [firstFile])).rejects.toMatchObject({
      code: "upload_path_unavailable",
      uncertain: false
    });

    const single = new FakePage();
    single.uploadInputMultiple = false;
    await expect(attachFiles(single, [firstFile, secondFile])).rejects.toMatchObject({
      code: "upload_path_unavailable",
      uncertain: false
    });
    expect(wrongType.cdpCalls + single.cdpCalls).toBe(0);
  });

  it("hands multiple files over in one ordered background action", async () => {
    const page = new FakePage();

    await expect(attachFiles(page, [firstFile, secondFile])).resolves.toHaveLength(2);

    expect(page.cdpCalls).toBe(1);
    expect(page.handoffNames).toEqual([basename(firstFile), basename(secondFile)]);
  });

  it("keeps an errored background handoff uncertain without retrying", async () => {
    const page = new FakePage();
    page.cdpError = new Error("background handoff acknowledgement lost");

    await expect(attachFiles(page, [firstFile])).rejects.toMatchObject({
      code: "file_handoff_uncertain",
      uncertain: true
    });
    expect(page.cdpCalls).toBe(1);
  });

  it("requires the exact ordered handoff postcondition", async () => {
    const page = new FakePage();
    page.cdpResultNames = [];

    await expect(attachFiles(page, [firstFile])).rejects.toMatchObject({
      code: "file_handoff_uncertain",
      uncertain: true
    });
    expect(page.cdpCalls).toBe(1);
  });

  it("waits for ChatGPT's displayed attachment names to stabilize", async () => {
    const page = new FakePage();
    page.readyNameOverrides.set(basename(firstFile), "context notes(2).md");

    await expect(attachFiles(page, [firstFile], { timeoutMs: 100, pollMs: 1 }))
      .resolves.toEqual([{
        path: firstFile,
        name: "context notes(2).md",
        bytes: 7
      }]);
    expect(page.attachmentWaits).toBeGreaterThanOrEqual(4);
  });

  it("waits until every new attachment card hides its upload spinner", async () => {
    const page = new FakePage();
    page.attachmentPending = true;
    page.clearAttachmentPendingAfterWait = 2;

    await expect(attachFiles(page, [firstFile], { timeoutMs: 100, pollMs: 1 }))
      .resolves.toHaveLength(1);
    expect(page.attachmentPending).toBe(false);
  });

  it("requires readiness for every file in the handoff", async () => {
    const page = new FakePage();
    page.omitReadyFilename = basename(secondFile);

    await expect(attachFiles(
      page,
      [firstFile, secondFile],
      { timeoutMs: 5, pollMs: 1 }
    )).rejects.toMatchObject({
      code: "upload_readiness_uncertain",
      uncertain: true
    });
    expect(page.cdpCalls).toBe(1);
  });

  it("rejects preexisting composer attachments before file handoff", async () => {
    const page = new FakePage();
    page.visibleFilenameCounts.set("manual.txt", 1);

    await expect(attachFiles(page, [firstFile])).rejects.toMatchObject({
      code: "input_ambiguous",
      uncertain: false
    });
    expect(page.cdpCalls).toBe(0);
  });

  it("rejects an extra attachment that appears during file handoff", async () => {
    const page = new FakePage();
    page.extraReadyFilenameOnHandoff = "manual.txt";

    await expect(attachFiles(page, [firstFile], { timeoutMs: 5, pollMs: 1 }))
      .rejects.toMatchObject({ code: "upload_readiness_uncertain", uncertain: true });
    expect(page.cdpCalls).toBe(1);
  });

  it("requires visible attachment processing to finish", async () => {
    const page = new FakePage();
    page.processingTextOnHandoff = "Processing attachment";

    await expect(attachFiles(page, [firstFile], { timeoutMs: 5, pollMs: 1 }))
      .rejects.toMatchObject({ code: "upload_readiness_uncertain", uncertain: true });
    expect(page.cdpCalls).toBe(1);
  });
});

describe("selectTool", () => {
  it("selects an arbitrary exact primary label and verifies composer echo", async () => {
    const page = new FakePage();
    page.toolLabels.set("Future Research Mode", { count: 1, echo: true });

    await selectTool(page, "Future Research Mode");

    expect(page.openerClicks).toBe(1);
    expect(page.toolClicks).toEqual(["Future Research Mode"]);
    expect(page.exactTextQueries).toContainEqual({
      text: "Future Research Mode",
      exact: true
    });
    expect(page.composerEchoQueries).toContain("Future Research Mode");
  });

  it("returns without toggling an already active exact tool", async () => {
    const page = new FakePage();
    page.activeToolEchoCounts.set("Already Active", 1);

    await selectTool(page, "Already Active");

    expect(page.openerClicks).toBe(0);
    expect(page.toolClicks).toEqual([]);
  });

  it("fails before opening the menu when active tool state is ambiguous", async () => {
    const page = new FakePage();
    page.activeToolEchoCounts.set("Duplicate Active", 2);

    await expect(selectTool(page, "Duplicate Active")).rejects.toMatchObject({
      code: "input_ambiguous",
      uncertain: false
    });
    expect(page.openerClicks).toBe(0);
  });

  it("accepts an exact inline composer pill as the selected tool signal", async () => {
    const page = new FakePage();
    page.toolLabels.set("Create image", { count: 1, echo: false, inline: true });

    await selectTool(page, "Create image");

    expect(page.toolClicks).toEqual(["Create image"]);
    expect(page.inlineToolLabels).toEqual(["Create image"]);
  });

  it("rejects an ambiguous exact tool label", async () => {
    const page = new FakePage();
    page.toolLabels.set("Duplicate Tool", { count: 2, echo: false });

    await expect(selectTool(page, "Duplicate Tool")).rejects.toMatchObject({
      code: "input_ambiguous",
      uncertain: false
    });
    expect(page.toolClicks).toEqual([]);
  });

  it("fails uncertain when the clicked tool lacks an exact composer echo", async () => {
    const page = new FakePage();
    page.toolLabels.set("No Echo Tool", { count: 1, echo: false });

    await expect(selectTool(page, "No Echo Tool")).rejects.toMatchObject({
      code: "tool_unverified",
      uncertain: true
    });
  });

  it("verifies that every requested tool echo still coexists", async () => {
    const page = new FakePage();
    page.activeToolEchoCounts.set("First", 1);

    await expect(verifyVisibleTools(page, ["First", "Second"]))
      .rejects.toMatchObject({ code: "tool_unverified", uncertain: true });
  });
});

type ToolState = { count: number; echo: boolean; inline?: boolean };

class FakePage implements BrowserInputPage {
  cdpSupported = true;
  cdpCalls = 0;
  cdpTimeouts: number[] = [];
  cdpExpressions: string[] = [];
  cdpError: Error | undefined;
  cdpResultNames: string[] | undefined;
  handoffNames: string[] = [];
  uploadInputCount = 1;
  uploadInputType = "file";
  uploadInputMultiple = true;
  omitReadyFilename: string | undefined;
  extraReadyFilenameOnHandoff: string | undefined;
  processingText = "";
  processingTextOnHandoff = "";
  openerClicks = 0;
  composerLocatorQueries: string[] = [];
  exactTextQueries: Array<{ text: string; exact: boolean }> = [];
  composerEchoQueries: string[] = [];
  toolClicks: string[] = [];
  toolLabels = new Map<string, ToolState>();
  activeToolEchoCounts = new Map<string, number>();
  inlineToolLabels: string[] = [];
  visibleFilenameCounts = new Map<string, number>();
  readyNameOverrides = new Map<string, string>();
  attachmentWaits = 0;
  attachmentPending = false;
  clearAttachmentPendingAfterWait = 0;

  capabilities = {
    get: async (id: "cdp") => {
      expect(id).toBe("cdp");
      if (!this.cdpSupported) return undefined;
      return {
        send: async (
          method: "Runtime.evaluate",
          params: {
            expression: string;
            userGesture: true;
            awaitPromise: true;
            returnByValue: true;
          },
          options?: { timeoutMs?: number }
        ) => {
          expect(method).toBe("Runtime.evaluate");
          expect(params).toMatchObject({
            userGesture: true,
            awaitPromise: true,
            returnByValue: true
          });
          expect(options).toEqual({ timeoutMs: expect.any(Number) });
          this.cdpCalls += 1;
          this.cdpTimeouts.push(options!.timeoutMs!);
          this.cdpExpressions.push(params.expression);
          if (this.cdpError !== undefined) throw this.cdpError;

          const marker = "for (const file of ";
          const start = params.expression.indexOf(marker) + marker.length;
          const end = params.expression.indexOf(") {", start);
          const payload = JSON.parse(params.expression.slice(start, end)) as Array<{ name: string }>;
          this.handoffNames = payload.map(file => file.name);
          this.processingText = this.processingTextOnHandoff;
          for (const name of this.handoffNames) {
            if (name === this.omitReadyFilename) continue;
            this.visibleFilenameCounts.set(name, (this.visibleFilenameCounts.get(name) ?? 0) + 1);
          }
          if (this.extraReadyFilenameOnHandoff !== undefined) {
            const name = this.extraReadyFilenameOnHandoff;
            this.visibleFilenameCounts.set(name, (this.visibleFilenameCounts.get(name) ?? 0) + 1);
          }
          const names = this.cdpResultNames ?? this.handoffNames;
          return { result: { value: { count: names.length, names } } };
        }
      };
    }
  };

  locator(selector: string): BrowserInputLocator {
    if (selector.includes("#prompt-textarea")) return this.composer();
    return locator({ count: 0 });
  }

  getByRole(
    role: "button",
    options: { name: string; exact: true }
  ): BrowserInputLocator {
    expect(role).toBe("button");
    expect(options).toEqual({ name: "Add files and more", exact: true });
    return locator({
      count: 1,
      click: async () => { this.openerClicks += 1; }
    });
  }

  getByText(text: string, options: { exact: true }): BrowserInputLocator {
    this.exactTextQueries.push({ text, exact: options.exact });
    const tool = this.toolLabels.get(text);
    return locator({
      count: tool?.count ?? 0,
      click: async () => {
          this.toolClicks.push(text);
          if (tool?.echo === true) this.activeToolEchoCounts.set(text, 1);
          if (tool?.inline === true) this.inlineToolLabels.push(text);
      }
    });
  }

  waitForTimeout = async () => {
    this.attachmentWaits += 1;
    if (this.attachmentWaits === 1) {
      for (const [before, after] of this.readyNameOverrides) {
        const count = this.visibleFilenameCounts.get(before) ?? 0;
        if (count === 0) continue;
        this.visibleFilenameCounts.delete(before);
        this.visibleFilenameCounts.set(after, count);
      }
    }
    if (this.clearAttachmentPendingAfterWait > 0
      && this.attachmentWaits >= this.clearAttachmentPendingAfterWait) {
      this.attachmentPending = false;
    }
  };

  private composer(): BrowserInputLocator {
    return locator({
      count: 1,
      evaluate: async <T>(fn: (element: Element) => T) =>
        String(fn).includes("data-inline-selection-pill")
          ? ([...this.inlineToolLabels] as T)
          : ({
              lines: [
                ...Array.from(this.visibleFilenameCounts.entries()).flatMap(([name, count]) =>
                  Array.from({ length: count }, () => name)
                ),
                this.processingText
              ].filter(Boolean),
              cards: Array.from(this.visibleFilenameCounts.entries()).flatMap(([name, count]) =>
                Array.from({ length: count }, () => ({ name, pending: this.attachmentPending }))
              )
            } as T),
      locator: selector => {
        this.composerLocatorQueries.push(selector);
        return locator({
          count: this.uploadInputCount,
          evaluate: async <T>() => ({
            type: this.uploadInputType,
            multiple: this.uploadInputMultiple
          }) as T
        });
      },
      getByRole: (_role, options) => {
        this.composerEchoQueries.push(options.name);
        return locator({ count: this.activeToolEchoCounts.get(options.name) ?? 0 });
      }
    });
  }
}

type LocatorOptions = {
  count?: number | (() => number);
  visible?: boolean;
  click?: () => Promise<void>;
  evaluate?: <T>(fn: (element: Element) => T) => Promise<T>;
  locator?: (selector: string) => BrowserInputLocator;
  getByRole?: (
    role: "button",
    options: { name: string; exact: true }
  ) => BrowserInputLocator;
};

function locator(options: LocatorOptions): BrowserInputLocator {
  const count = () => typeof options.count === "function"
    ? options.count()
    : (options.count ?? 1);
  const result: BrowserInputLocator = {
    count: async () => count(),
    isVisible: async () => (options.visible ?? true) && count() > 0,
    click: options.click ?? (async () => undefined),
    nth: () => locator({ count: 1, visible: options.visible ?? true })
  };
  if (options.evaluate !== undefined) result.evaluate = options.evaluate;
  if (options.locator !== undefined) result.locator = options.locator;
  if (options.getByRole !== undefined) result.getByRole = options.getByRole;
  return result;
}
