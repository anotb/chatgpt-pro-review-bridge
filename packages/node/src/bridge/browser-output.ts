import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const GENERATED_IMAGE_CONTAINER_SELECTOR = [
  '[data-testid*="generated-image"]',
  '[data-testid*="image-generation"]',
  '[data-testid="image-paragen-multigen"]'
].join(",");

export type StructuralPage = {
  evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result>;
  locator?: (selector: string) => ArtifactLocator;
  waitForEvent?: (event: string, options?: unknown) => Promise<unknown>;
  waitForTimeout?: (ms: number) => Promise<void>;
  capabilities?: { get?: (id: string) => Promise<unknown> | unknown };
};

export type ArtifactLocator = {
  count?: () => Promise<number>;
  nth?: (index: number) => ArtifactLocator;
  getByRole?: (role: string, options?: Record<string, unknown>) => ArtifactLocator;
  locator?: (selector: string) => ArtifactLocator;
  isVisible?: () => Promise<boolean>;
  click?: (options?: unknown) => Promise<void>;
  evaluate?: <T>(fn: (element: Element) => T) => Promise<T>;
};

export type TextClipboard = {
  readText(): Promise<string | undefined>;
  waitForChange?(before: string | undefined, timeoutMs: number): Promise<string | undefined>;
  /** Optional temporary write used only when a lossless snapshot can be restored. */
  writeText?(text: string): Promise<void>;
  /** Optional lossless host clipboard preservation. Both methods are required to use it. */
  snapshot?(): Promise<unknown>;
  restore?(snapshot: unknown): Promise<void>;
};

export type VisibleGeneration = {
  state: "generating" | "completed" | "uncertain";
  stopVisible: boolean;
  responseActionsVisible: boolean;
};

export type VisibleArtifactCandidate = {
  assistantIndex: number;
  assistantTurnId: string | null;
  kind: "file" | "image";
  name: string | null;
  occurrence: number;
  controlLabel?: string;
  controlRole?: "button" | "link";
};

export type VisibleChatSnapshot = {
  userCount: number;
  assistantCount: number;
  userText?: string;
  userTurnId?: string | null;
  assistantText?: string;
  assistantTurnId?: string | null;
  generation: VisibleGeneration;
  artifactCandidates: VisibleArtifactCandidate[];
};

type RawVisibleChatSnapshot = Omit<VisibleChatSnapshot, "generation"> & {
  pageStopVisible: boolean;
  responseActionsVisible: boolean;
  artifactResponseVisible: boolean;
};

type ReadVisibleChatRequest = ReadVisibleChatOptions & {
  generatedImageContainerSelector: string;
};

export type ReadVisibleChatOptions = {
  userIndex?: number;
  assistantIndex?: number;
  includeAssistantText?: boolean;
  includeArtifacts?: boolean;
};

/** Read the visible Chat surface once without transferring HTML. */
export async function readVisibleChatSnapshot(
  page: StructuralPage,
  options: ReadVisibleChatOptions = {}
): Promise<VisibleChatSnapshot> {
  const raw = await page.evaluate<RawVisibleChatSnapshot, ReadVisibleChatRequest>(requested => {
    const main = document.querySelector("main");
    if (main === null) {
      return {
        userCount: 0,
        assistantCount: 0,
        pageStopVisible: false,
        responseActionsVisible: false,
        artifactResponseVisible: false,
        artifactCandidates: []
      };
    }

    const visible = (element: Element): boolean => {
      if (element.closest("[hidden], [aria-hidden='true']") !== null) return false;
      const html = element as HTMLElement;
      const style = window.getComputedStyle(html);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0"
        && html.getClientRects().length > 0;
    };
    const renderedText = (element: Element): string => {
      const innerText = (element as HTMLElement).innerText;
      return typeof innerText === "string" ? innerText : element.textContent ?? "";
    };
    const promptText = (element: Element): string => {
      const skipped = "[data-inline-selection-pill], [data-inline-selection-pill-cursor-target]";
      const read = (parent: Element): string => {
        let text = "";
        let followsPill = false;
        for (const child of Array.from(parent.childNodes)) {
          if (child.nodeType === Node.ELEMENT_NODE) {
            const nested = child as Element;
            if (nested.matches(skipped)) {
              followsPill ||= nested.matches("[data-inline-selection-pill]");
              continue;
            }
            if (nested.tagName === "BR") {
              text += "\n";
              followsPill = false;
              continue;
            }
            let value = read(nested);
            if (followsPill && value.startsWith(" ")) value = value.slice(1);
            text += value;
            followsPill = false;
            continue;
          }
          if (child.nodeType !== Node.TEXT_NODE) continue;
          let value = child.textContent ?? "";
          if (followsPill && value.startsWith(" ")) value = value.slice(1);
          text += value;
          followsPill = false;
        }
        return text;
      };
      return read(element);
    };
    const turnContainer = (message: Element): Element =>
      message.closest('[data-testid^="conversation-turn-"]')
        ?? message.closest("article")
        ?? message.closest("[data-message-id]")
        ?? message.parentElement
        ?? message;
    const turnId = (message: Element): string | null => {
      const container = turnContainer(message);
      const testId = container.getAttribute("data-testid");
      return message.getAttribute("data-message-id")
        ?? container.getAttribute("data-message-id")
        ?? (/^conversation-turn-\d+$/.test(testId ?? "") ? testId : null)
        ?? null;
    };
    const fileName = (value: string, trustedFileControl: boolean): string | null => {
      const normalized = value.replace(/\s+/g, " ").trim()
        .replace(/^download\s+/i, "");
      if (!/^[^\\/\r\n]{1,255}$/.test(normalized)
        || normalized === "."
        || normalized === "..") return null;
      return trustedFileControl
        || /\.[a-z0-9][a-z0-9._-]*$/i.test(normalized)
        ? normalized
        : null;
    };
    const generatedImages = (assistant: Element): HTMLImageElement[] =>
      Array.from(assistant.querySelectorAll("img")).filter(image => {
        if (!visible(image)) return false;
        return image.closest(requested.generatedImageContainerSelector) !== null;
      });
    const responseCopyControls = (assistant: Element): HTMLButtonElement[] => {
      const container = turnContainer(assistant);
      const exact = Array.from(container.querySelectorAll<HTMLButtonElement>(
        'button[data-testid="copy-turn-action-button"]'
      )).filter(visible);
      if (exact.length > 0) return exact;
      return Array.from(container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Copy response"], button[aria-label="Copy"]'
      )).filter(button => visible(button)
        && button.closest("pre, code, [data-testid*='code']") === null);
    };

    const users = Array.from(main.querySelectorAll('[data-message-author-role="user"]')).filter(visible);
    const turnSelector = '[data-testid^="conversation-turn-"]';
    const turns = Array.from(main.querySelectorAll(turnSelector)).filter(visible);
    const assistants = turns.flatMap(turn => {
      const roleTurns = Array.from(
        turn.querySelectorAll('[data-message-author-role="assistant"]')
      ).filter(visible);
      if (roleTurns.length > 0) return roleTurns;
      return generatedImages(turn).length > 0 ? [turn] : [];
    });
    const looseAssistants = Array.from(
      main.querySelectorAll('[data-message-author-role="assistant"]')
    ).filter(assistant => visible(assistant) && assistant.closest(turnSelector) === null);
    assistants.push(...looseAssistants);
    const user = requested.userIndex === undefined ? undefined : users[requested.userIndex];
    const requestedAssistant = requested.assistantIndex === undefined
      ? undefined
      : assistants[requested.assistantIndex];
    const promptBubbles = user === undefined
      ? []
      : Array.from(user.querySelectorAll(
          ".user-message-bubble-color .whitespace-pre-wrap"
        )).filter(visible);
    const userText = user === undefined
      ? undefined
      : promptBubbles.length === 1
        ? promptText(promptBubbles[0]!)
        : renderedText(user);
    const userTurnId = user === undefined ? undefined : turnId(user);
    const assistantText = requested.includeAssistantText === true && requestedAssistant !== undefined
      ? renderedText(requestedAssistant)
      : undefined;
    const assistantTurnId = requestedAssistant === undefined ? undefined : turnId(requestedAssistant);

    const pageStopVisible = Array.from(main.querySelectorAll([
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop generating"]'
    ].join(","))).some(visible);
    const actionAssistant = requestedAssistant ?? assistants.at(-1);
    const responseActionsVisible = actionAssistant !== undefined
      && responseCopyControls(actionAssistant).length === 1;
    const artifactResponseVisible = requestedAssistant !== undefined
      && generatedImages(requestedAssistant).length > 0;

    const artifactCandidates: VisibleArtifactCandidate[] = [];
    const artifactAssistants = requested.includeArtifacts !== true
      ? []
      : requested.assistantIndex === undefined
        ? assistants.map((assistant, assistantIndex) => ({ assistant, assistantIndex }))
        : requestedAssistant === undefined
          ? []
          : [{ assistant: requestedAssistant, assistantIndex: requested.assistantIndex }];
    artifactAssistants.forEach(({ assistant, assistantIndex }) => {
      const candidateTurnId = turnId(assistant);
      const controls = Array.from(assistant.querySelectorAll([
        "button[aria-label]",
        "a[download]",
        "a[href*='/files/']",
        "a[href*='/mnt/data/']",
        "a[href*='/backend-api/files/']"
      ].join(","))).filter(visible);
      controls.forEach((control, controlIndex) => {
        const href = control.getAttribute("href") ?? "";
        const trustedFileControl = control.hasAttribute("download")
          || href.includes("/files/")
          || href.includes("/mnt/data/")
          || href.includes("/backend-api/files/")
          || control.closest('[data-testid*="file" i], [data-testid*="artifact" i]') !== null;
        const controlLabel = (control.getAttribute("aria-label") ?? control.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const name = fileName(controlLabel, trustedFileControl);
        const textName = fileName(control.textContent ?? "", trustedFileControl);
        if (name === null || textName !== name) return;
        const role = control.tagName.toLowerCase() === "a" ? "link" : "button";
        artifactCandidates.push({
          assistantIndex,
          assistantTurnId: candidateTurnId,
          kind: "file",
          name,
          occurrence: controlIndex,
          controlLabel,
          controlRole: role
        });
      });

      generatedImages(assistant).forEach((image, occurrence) => {
        artifactCandidates.push({
          assistantIndex,
          assistantTurnId: candidateTurnId,
          kind: "image",
          name: image.getAttribute("alt"),
          occurrence
        });
      });
    });

    return {
      userCount: users.length,
      assistantCount: assistants.length,
      ...(userText === undefined ? {} : { userText }),
      ...(userTurnId === undefined ? {} : { userTurnId }),
      ...(assistantText === undefined ? {} : { assistantText }),
      ...(assistantTurnId === undefined ? {} : { assistantTurnId }),
      pageStopVisible,
      responseActionsVisible,
      artifactResponseVisible,
      artifactCandidates
    };
  }, { ...options, generatedImageContainerSelector: GENERATED_IMAGE_CONTAINER_SELECTOR });

  const stopVisible = raw.pageStopVisible && stopBelongsToRequestedTurn(
    options,
    raw.userCount,
    raw.assistantCount
  );
  return {
    userCount: raw.userCount,
    assistantCount: raw.assistantCount,
    ...(raw.userText === undefined ? {} : { userText: raw.userText }),
    ...(raw.userTurnId === undefined ? {} : { userTurnId: raw.userTurnId }),
    ...(raw.assistantText === undefined ? {} : { assistantText: raw.assistantText }),
    ...(raw.assistantTurnId === undefined ? {} : { assistantTurnId: raw.assistantTurnId }),
    generation: {
      state: stopVisible
        ? "generating"
        : raw.responseActionsVisible || raw.artifactResponseVisible
          ? "completed"
          : "uncertain",
      stopVisible,
      responseActionsVisible: raw.responseActionsVisible
    },
    artifactCandidates: raw.artifactCandidates
  };
}

export function stopBelongsToRequestedTurn(
  requested: Pick<ReadVisibleChatOptions, "userIndex" | "assistantIndex">,
  userCount: number,
  assistantCount: number
): boolean {
  return requested.userIndex === undefined
    || requested.assistantIndex === undefined
    || (requested.userIndex === userCount - 1
      && (requested.assistantIndex === assistantCount
        || requested.assistantIndex === assistantCount - 1));
}

export type AssistantCopyTarget = {
  assistantIndex: number;
  assistantTurnId?: string;
};

export type AssistantCopyResult =
  | { status: "copied"; markdown: string }
  | { status: "unavailable"; reason: "assistant_missing" | "turn_mismatch" | "copy_action_missing" | "copy_action_ambiguous" | "clipboard_unavailable" };

/** Copy one owned assistant turn with one bounded transient retry and lossless restore when supported. */
export async function copyAssistantMarkdown(
  page: StructuralPage,
  clipboard: TextClipboard,
  target: AssistantCopyTarget
): Promise<AssistantCopyResult> {
  let control = await exactOwnedCopyControl(page, target);
  if (!control.ok) return { status: "unavailable", reason: control.reason };
  if (clipboard.snapshot === undefined || clipboard.restore === undefined) {
    return { status: "unavailable", reason: "clipboard_unavailable" };
  }

  const clipboardSnapshot = await clipboard.snapshot();

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const markdown = await attemptClipboardCopy(control.locator, clipboard);
      if (markdown !== undefined) return { status: "copied", markdown };
      if (attempt === 1) break;

      // Copy is reversible, but revalidate exact ownership and uniqueness
      // before the one bounded second click. Structural failures never retry.
      control = await exactOwnedCopyControl(page, target);
      if (!control.ok) return { status: "unavailable", reason: control.reason };
    }
    return { status: "unavailable", reason: "clipboard_unavailable" };
  } finally {
    await clipboard.restore(clipboardSnapshot);
  }
}

async function attemptClipboardCopy(
  control: ArtifactLocator,
  clipboard: TextClipboard
): Promise<string | undefined> {
  let before: string | undefined;
  try {
    before = await clipboard.readText();
    if (clipboard.writeText !== undefined) {
      before = `codex-bridge-copy-${randomUUID()}`;
      await clipboard.writeText(before);
    }
  } catch {
    return undefined;
  }

  // A transport error can arrive after the clipboard changed, so reconcile
  // by reading and never repeat this particular activation.
  await control.click!().catch(() => undefined);
  try {
    const changed = clipboard.waitForChange === undefined
      ? await clipboard.readText()
      : await clipboard.waitForChange(before, 3_000);
    return changed === undefined || changed === before ? undefined : changed;
  } catch {
    return undefined;
  }
}

type OwnedCopyControl =
  | { ok: true; locator: ArtifactLocator }
  | { ok: false; reason: "assistant_missing" | "turn_mismatch" | "copy_action_missing" | "copy_action_ambiguous" };

async function exactOwnedCopyControl(
  page: StructuralPage,
  target: AssistantCopyTarget
): Promise<OwnedCopyControl> {
  const assistants = await visibleLocators(
    page.locator?.('main [data-message-author-role="assistant"]')
  );
  const assistant = assistants[target.assistantIndex];
  if (assistant === undefined) return { ok: false, reason: "assistant_missing" };

  if (target.assistantTurnId !== undefined) {
    if (assistant.evaluate === undefined) return { ok: false, reason: "turn_mismatch" };
    const actualTurnId = await assistant.evaluate(element => {
      const container = element.closest('[data-testid^="conversation-turn-"]')
        ?? element.closest("article")
        ?? element.closest("[data-message-id]")
        ?? element.parentElement
        ?? element;
      return element.getAttribute("data-message-id")
        ?? container.getAttribute("data-message-id")
        ?? null;
    });
    if (actualTurnId !== target.assistantTurnId) return { ok: false, reason: "turn_mismatch" };
  }

  const container = await exactAssistantContainer(assistant);
  if (container === undefined) return { ok: false, reason: "copy_action_missing" };
  const exact = await visibleLocators(
    container.locator?.('button[data-testid="copy-turn-action-button"]')
  );
  let copies = exact;
  if (copies.length === 0) {
    const fallback = await visibleLocators(container.locator?.(
      'button[aria-label="Copy response"], button[aria-label="Copy"]'
    ));
    copies = [];
    for (const candidate of fallback) {
      if (candidate.evaluate === undefined) {
        return { ok: false, reason: "copy_action_ambiguous" };
      }
      const insideCode = await candidate.evaluate(element =>
        element.closest("pre, code, [data-testid*='code']") !== null
      );
      if (!insideCode) copies.push(candidate);
    }
  }
  if (copies.length === 0) return { ok: false, reason: "copy_action_missing" };
  if (copies.length !== 1 || copies[0]?.click === undefined) {
    return { ok: false, reason: "copy_action_ambiguous" };
  }
  return { ok: true, locator: copies[0] };
}

async function exactAssistantContainer(
  assistant: ArtifactLocator
): Promise<ArtifactLocator | undefined> {
  if (assistant.locator === undefined) return undefined;
  for (const selector of [
    "xpath=ancestor-or-self::*[starts-with(@data-testid, 'conversation-turn-')][1]",
    "xpath=ancestor-or-self::article[1]",
    "xpath=ancestor-or-self::*[@data-message-id][1]",
    "xpath=.."
  ]) {
    const candidate = assistant.locator(selector);
    if (await locatorCount(candidate) === 1) return candidate;
  }
  return undefined;
}

export function readOwnedAssistantText(
  snapshot: VisibleChatSnapshot,
  target: AssistantCopyTarget
): string | undefined {
  if (target.assistantTurnId !== undefined
    && snapshot.assistantTurnId !== target.assistantTurnId) {
    return undefined;
  }
  return snapshot.assistantText;
}

export type ArtifactHandleScope = {
  operationId: string;
  conversationId?: string;
  assistantTurnBefore: number;
};

export type HandleArtifact = {
  key: string;
  kind: "file" | "image";
  name?: string;
  assistantIndex: number;
  assistantTurnId?: string;
  occurrence: number;
  controlLabel?: string;
  controlRole?: "button" | "link";
};

/** Return artifacts only from the assistant turn created after this handle's baseline. */
export function inventoryHandleArtifacts(
  snapshot: VisibleChatSnapshot,
  scope: ArtifactHandleScope
): HandleArtifact[] {
  return snapshot.artifactCandidates
    .filter(candidate => candidate.assistantIndex === scope.assistantTurnBefore)
    .map(candidate => {
      const turn = candidate.assistantTurnId ?? `assistant-index:${candidate.assistantIndex}`;
      const key = createHash("sha256")
        .update(JSON.stringify([
          scope.operationId,
          scope.conversationId ?? null,
          turn,
          candidate.kind,
          candidate.kind === "file" ? candidate.name : null,
          candidate.controlLabel ?? null,
          candidate.occurrence
        ]))
        .digest("hex");
      return {
        key,
        kind: candidate.kind,
        assistantIndex: candidate.assistantIndex,
        ...(candidate.assistantTurnId === null ? {} : { assistantTurnId: candidate.assistantTurnId }),
        ...(candidate.name === null ? {} : { name: candidate.name }),
        occurrence: candidate.occurrence,
        ...(candidate.controlLabel === undefined ? {} : { controlLabel: candidate.controlLabel }),
        ...(candidate.controlRole === undefined ? {} : { controlRole: candidate.controlRole })
      };
    });
}

export type DownloadedHandleArtifact = {
  path: string;
  name: string;
  bytes: number;
  sha256?: string;
};

/** Download one exact owned artifact; no page-wide/latest fallback is allowed. */
export async function downloadHandleArtifact(
  page: StructuralPage,
  artifact: HandleArtifact,
  downloadDir: string,
  timeoutMs = 120_000
): Promise<DownloadedHandleArtifact> {
  return artifact.kind === "image"
    ? downloadOwnedImage(page, artifact, downloadDir, boundedTimeout(timeoutMs))
    : downloadOwnedFile(page, artifact, downloadDir, boundedTimeout(timeoutMs));
}

async function downloadOwnedImage(
  page: StructuralPage,
  artifact: HandleArtifact,
  downloadDir: string,
  timeoutMs: number
): Promise<DownloadedHandleArtifact> {
  const requested = {
    assistantIndex: artifact.assistantIndex,
    ...(artifact.assistantTurnId === undefined ? {} : { assistantTurnId: artifact.assistantTurnId }),
    occurrence: artifact.occurrence,
    timeoutMs,
    generatedImageContainerSelector: GENERATED_IMAGE_CONTAINER_SELECTOR
  };
  const rawCdp = await page.capabilities?.get?.("cdp");
  if (!isImageCdpCapability(rawCdp)) {
    throw artifactTransferError(
      "artifact_download_unavailable",
      "Visible browser does not expose bounded generated-image transfer."
    );
  }
  const result = await rawCdp.send("Runtime.evaluate", {
    expression: `(async () => {
    const requested = ${JSON.stringify(requested)};
    const visible = element => {
      if (element.closest("[hidden], [aria-hidden='true']") !== null) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden"
        && style.opacity !== "0" && element.getClientRects().length > 0;
    };
    const main = document.querySelector("main");
    if (main === null) return undefined;
    const turnSelector = '[data-testid^="conversation-turn-"]';
    const generated = element =>
      Array.from(element.querySelectorAll("img")).filter(image =>
        visible(image)
        && image.closest(requested.generatedImageContainerSelector) !== null
      );
    const turns = Array.from(main.querySelectorAll(turnSelector)).filter(visible);
    const assistants = turns.flatMap(turn => {
      const roleTurns = Array.from(
        turn.querySelectorAll('[data-message-author-role="assistant"]')
      ).filter(visible);
      if (roleTurns.length > 0) return roleTurns;
      return generated(turn).length > 0 ? [turn] : [];
    });
    assistants.push(...Array.from(
      main.querySelectorAll('[data-message-author-role="assistant"]')
    ).filter(assistant => visible(assistant) && assistant.closest(turnSelector) === null));
    const assistant = assistants[requested.assistantIndex];
    if (assistant === null) return undefined;
    if (assistant === undefined) return undefined;
    const container = assistant.closest('[data-testid^="conversation-turn-"]')
      ?? assistant.closest("article")
      ?? assistant.closest("[data-message-id]")
      ?? assistant.parentElement
      ?? assistant;
    const testId = container.getAttribute("data-testid");
    const turnId = assistant.getAttribute("data-message-id")
      ?? container.getAttribute("data-message-id")
      ?? (/^conversation-turn-\\d+$/.test(testId ?? "") ? testId : undefined)
      ?? undefined;
    if (requested.assistantTurnId !== undefined && turnId !== requested.assistantTurnId) {
      return undefined;
    }
    const images = generated(assistant);
    const image = images[requested.occurrence];
    if (image === undefined) return undefined;
    const src = image.currentSrc || image.src;
    const controller = new AbortController();
    let reader;
    const timer = setTimeout(() => {
      controller.abort();
      reader?.abort();
    }, requested.timeoutMs);
    return fetch(src, { signal: controller.signal }).then(async response => {
      if (!response.ok) return undefined;
      const blob = await response.blob();
      const dataUrl = await new Promise((resolveData, rejectData) => {
        reader = new FileReader();
        reader.onload = () => resolveData(String(reader.result));
        reader.onerror = () => rejectData(reader.error ?? new Error("Image read failed."));
        reader.onabort = () => rejectData(new Error("Image read timed out."));
        reader.readAsDataURL(blob);
      });
      return { dataUrl, mimeType: blob.type || "image/png" };
    }).finally(() => clearTimeout(timer));
  })()`,
    userGesture: false,
    awaitPromise: true,
    returnByValue: true
  }, { timeoutMs });
  const source = cdpValue(result);
  if (source === undefined) {
    throw artifactTransferError(
      "artifact_download_unavailable",
      "Exact owned image source is unavailable."
    );
  }
  if (!isImageSource(source)) {
    throw artifactTransferError(
      "artifact_download_unavailable",
      "Owned image transfer returned an unsupported shape."
    );
  }
  const encoded = /^data:([^;,]+);base64,(.+)$/s.exec(source.dataUrl);
  if (encoded?.[2] === undefined) throw new Error("Owned image did not produce base64 data.");
  const bytes = Buffer.from(encoded[2], "base64");
  if (bytes.length === 0) throw new Error("Owned image data is empty.");
  const extension = imageExtension(source.mimeType);
  const name = `generated-image-${artifact.key.slice(0, 12)}.${extension}`;
  const saved = await persistBuffer(downloadDir, name, artifact.key, bytes);
  return {
    ...saved,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

type ImageCdpCapability = {
  send(
    method: "Runtime.evaluate",
    params: {
      expression: string;
      userGesture: false;
      awaitPromise: true;
      returnByValue: true;
    },
    options: { timeoutMs: number }
  ): Promise<unknown>;
};

function isImageCdpCapability(value: unknown): value is ImageCdpCapability {
  return typeof value === "object" && value !== null
    && typeof (value as { send?: unknown }).send === "function";
}

function cdpValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("result" in value)) return undefined;
  const result = value.result;
  return typeof result === "object" && result !== null && "value" in result
    ? result.value
    : undefined;
}

function isImageSource(value: unknown): value is { dataUrl: string; mimeType: string } {
  return typeof value === "object" && value !== null
    && "dataUrl" in value && typeof value.dataUrl === "string"
    && "mimeType" in value && typeof value.mimeType === "string";
}

async function downloadOwnedFile(
  page: StructuralPage,
  artifact: HandleArtifact,
  downloadDir: string,
  timeoutMs: number
): Promise<DownloadedHandleArtifact> {
  if (artifact.name === undefined
    || artifact.controlLabel === undefined
    || artifact.controlRole === undefined
    || page.locator === undefined) {
    throw new Error("Exact owned file control is unavailable.");
  }
  const assistants = page.locator('main [data-message-author-role="assistant"]');
  const assistant = await exactOccurrence(assistants, artifact.assistantIndex, "assistant turn");
  if (artifact.assistantTurnId !== undefined) {
    if (assistant.evaluate === undefined) throw new Error("Assistant turn identity cannot be verified.");
    const turnId = await assistant.evaluate(element => {
      const container = element.closest('[data-testid^="conversation-turn-"]')
        ?? element.closest("article")
        ?? element.closest("[data-message-id]")
        ?? element.parentElement
        ?? element;
      return element.getAttribute("data-message-id")
        ?? container.getAttribute("data-message-id")
        ?? null;
    });
    if (turnId !== artifact.assistantTurnId) throw new Error("Owned file turn identity changed.");
  }
  const exactControls = assistant.getByRole?.(artifact.controlRole, {
    name: artifact.controlLabel,
    exact: true
  });
  const visibleControls = await visibleLocators(exactControls);
  if (visibleControls.length !== 1) {
    throw new Error("Owned file control is unavailable or ambiguous.");
  }
  const control = visibleControls[0]!;
  await verifyFileControl(control, artifact);

  if (artifact.controlRole === "link") {
    return downloadFromOneClick(page, control, downloadDir, artifact, timeoutMs);
  }

  if (control.click === undefined) throw new Error("Owned file preview control is not clickable.");
  await control.click();
  const exactDownload = await waitForExactPreviewDownload(page, artifact.name, timeoutMs);
  return downloadFromOneClick(page, exactDownload, downloadDir, artifact, timeoutMs);
}

async function waitForExactPreviewDownload(
  page: StructuralPage,
  name: string,
  timeoutMs: number
): Promise<ArtifactLocator> {
  const preview = page.locator?.(`section[aria-label="${cssString(name)}"]`);
  const limitMs = Math.min(timeoutMs, 15_000);
  let waitedMs = 0;

  while (true) {
    const previews = await visibleLocators(preview);
    if (previews.length === 1) {
      const downloads = await visibleLocators(
        previews[0]!.getByRole?.("button", { name: "Download", exact: true })
      );
      if (downloads.length === 1 && downloads[0]!.click !== undefined) return downloads[0]!;
    }
    if (waitedMs >= limitMs) break;
    const delayMs = Math.min(100, limitMs - waitedMs);
    await waitForPage(page, delayMs);
    waitedMs += delayMs;
  }

  throw artifactTransferError(
    "artifact_preview_timeout",
    `Exact preview Download control for ${JSON.stringify(name)} was unavailable before timeout.`
  );
}

async function verifyFileControl(
  control: ArtifactLocator,
  artifact: HandleArtifact
): Promise<void> {
  if (control.evaluate === undefined) {
    throw new Error("Owned file control identity cannot be verified.");
  }
  const identity = await control.evaluate(element => {
    const href = element.getAttribute("href") ?? "";
    return {
      role: element.tagName.toLowerCase() === "a" ? "link" : "button",
      label: (element.getAttribute("aria-label") ?? element.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
      trusted: element.hasAttribute("download")
        || href.includes("/files/")
        || href.includes("/mnt/data/")
        || href.includes("/backend-api/files/")
        || element.closest('[data-testid*="file" i], [data-testid*="artifact" i]') !== null
    };
  });
  const name = visibleFileName(identity.label, identity.trusted);
  const textName = visibleFileName(identity.text, identity.trusted);
  if (identity.role !== artifact.controlRole
    || identity.label !== artifact.controlLabel
    || name !== artifact.name
    || textName !== artifact.name) {
    throw new Error("Owned file control identity changed.");
  }
}

async function downloadFromOneClick(
  page: StructuralPage,
  control: ArtifactLocator,
  downloadDir: string,
  artifact: HandleArtifact,
  timeoutMs: number
): Promise<DownloadedHandleArtifact> {
  if (page.waitForEvent === undefined || control.click === undefined) {
    throw artifactTransferError(
      "artifact_download_unavailable",
      "Visible browser does not expose exact download events and clicks."
    );
  }
  const pending = page.waitForEvent("download", { timeoutMs });
  let clickError: unknown;
  try {
    await control.click();
  } catch (error) {
    clickError = error;
  }
  let raw: unknown;
  try {
    raw = await pending;
  } catch (error) {
    throw clickError ?? error;
  }
  if (!isDownload(raw)) {
    throw artifactTransferError(
      "artifact_download_unavailable",
      "Visible download event had an unsupported shape."
    );
  }
  const name = deterministicName(artifact.key, artifact.name ?? "artifact.bin");
  const directory = resolve(downloadDir);
  await mkdir(directory, { recursive: true });
  const target = join(directory, name);
  const temporary = `${target}.${randomUUID()}.partial`;
  try {
    const source = await raw.path({ timeoutMs });
    if (source === null) {
      throw artifactTransferError(
        "artifact_download_unavailable",
        "Download does not expose a completed local path."
      );
    }
    await copyFile(source, temporary);
    return await commitTemporaryArtifact(temporary, target, name);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function persistBuffer(
  downloadDir: string,
  suggestedName: string,
  key: string,
  bytes: Buffer
): Promise<DownloadedHandleArtifact> {
  const directory = resolve(downloadDir);
  await mkdir(directory, { recursive: true });
  const name = deterministicName(key, suggestedName);
  const target = join(directory, name);
  const temporary = `${target}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    return await commitTemporaryArtifact(temporary, target, name);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function commitTemporaryArtifact(
  temporary: string,
  target: string,
  name: string
): Promise<DownloadedHandleArtifact> {
  try {
    await copyFile(temporary, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    if (!await sameFile(temporary, target)) {
      throw new Error(`Artifact destination collision: ${target}`);
    }
  }
  return fileResult(target, name);
}

async function fileResult(path: string, name: string): Promise<DownloadedHandleArtifact> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Downloaded artifact is not a regular file: ${path}`);
  return {
    path,
    name,
    bytes: metadata.size,
    sha256: await fileSha256(path)
  };
}

async function exactOccurrence(
  locator: ArtifactLocator | undefined,
  occurrence: number,
  label: string
): Promise<ArtifactLocator> {
  if (locator === undefined || occurrence < 0) {
    throw new Error(`${label} occurrence ${occurrence} is unavailable.`);
  }
  const visible = await visibleLocators(locator);
  const selected = visible[occurrence];
  if (selected === undefined) throw new Error(`${label} occurrence ${occurrence} is unavailable.`);
  return selected;
}

async function visibleLocators(
  locator: ArtifactLocator | undefined
): Promise<ArtifactLocator[]> {
  const count = await locatorCount(locator);
  if (locator === undefined) return [];
  const visible: ArtifactLocator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = count === 1 ? locator : locator.nth?.(index);
    if (candidate === undefined) {
      return [];
    }
    if (candidate.isVisible === undefined) {
      if (count > 1) return [];
      visible.push(candidate);
    } else if (await candidate.isVisible()) {
      visible.push(candidate);
    }
  }
  return visible;
}

async function locatorCount(locator: ArtifactLocator | undefined): Promise<number> {
  return locator?.count === undefined ? 0 : locator.count();
}

async function waitForPage(page: StructuralPage, timeoutMs: number): Promise<void> {
  if (page.waitForTimeout !== undefined) {
    await page.waitForTimeout(timeoutMs);
    return;
  }
  await new Promise(resolveWait => setTimeout(resolveWait, timeoutMs));
}

async function sameFile(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
  const [leftHash, rightHash] = await Promise.all([fileSha256(left), fileSha256(right)]);
  return leftHash === rightHash;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function visibleFileName(value: string, trustedFileControl: boolean): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim().replace(/^download\s+/i, "");
  if (!/^[^\\/\r\n]{1,255}$/.test(normalized)
    || normalized === "."
    || normalized === "..") return undefined;
  return trustedFileControl || /\.[a-z0-9][a-z0-9._-]*$/i.test(normalized)
    ? normalized
    : undefined;
}

function boundedTimeout(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 120_000;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function deterministicName(key: string, value: string): string {
  const safe = basename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 180) || "artifact.bin";
  return `${key.slice(0, 12)}-${safe}`;
}

function imageExtension(mimeType: string): string {
  if (/jpe?g/i.test(mimeType)) return "jpg";
  if (/webp/i.test(mimeType)) return "webp";
  if (/gif/i.test(mimeType)) return "gif";
  return "png";
}

function cssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ");
}

function isDownload(value: unknown): value is {
  path: (options?: { timeoutMs?: number }) => Promise<string | null>;
} {
  return typeof value === "object" && value !== null
    && typeof (value as { path?: unknown }).path === "function";
}

function artifactTransferError(
  code: "artifact_preview_timeout" | "artifact_download_unavailable",
  message: string
): Error & { code: typeof code } {
  return Object.assign(new Error(message), { code });
}
