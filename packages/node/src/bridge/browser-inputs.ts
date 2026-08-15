import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";

export const COMPOSER_FORM_SELECTOR = "main form:has(#prompt-textarea), form:has(#prompt-textarea)";
export const ATTACHMENT_NAME_SELECTOR = ".truncate.font-semibold";
const UPLOAD_INPUT_SELECTOR = "#upload-files";
const ADD_FILES_LABEL = "Add files and more";
const PROCESSING_TEXT = /\b(uploading|processing|attaching|preparing|reading|scanning|analyzing)\b/i;
const ATTACHMENT_STABLE_OBSERVATIONS = 4;
const ATTACHMENT_STABLE_POLL_MS = 500;

export type BrowserInputLocator = {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  click(): Promise<void>;
  innerText?(): Promise<string>;
  evaluate?<T>(fn: (element: Element) => T): Promise<T>;
  nth?(index: number): BrowserInputLocator;
  locator?(selector: string): BrowserInputLocator;
  getByText?(text: string, options: { exact: true }): BrowserInputLocator;
  getByRole?(
    role: "button",
    options: { name: string; exact: true }
  ): BrowserInputLocator;
};

type BrowserInputCdpCapability = {
  send(
    method: "Runtime.evaluate",
    params: {
      expression: string;
      userGesture: true;
      awaitPromise: true;
      returnByValue: true;
    },
    options?: { timeoutMs?: number }
  ): Promise<unknown>;
};

export type BrowserInputPage = {
  locator(selector: string): BrowserInputLocator;
  getByRole(
    role: "button",
    options: { name: string; exact: true }
  ): BrowserInputLocator;
  getByText(text: string, options: { exact: true }): BrowserInputLocator;
  waitForTimeout?(ms: number): Promise<void>;
  capabilities?: {
    get(id: "cdp"): Promise<unknown> | unknown;
  };
};

export type ValidatedLocalFile = {
  path: string;
  name: string;
  bytes: number;
};

type AttachmentSnapshot = {
  lines: string[];
  cards: Array<{ name: string; pending: boolean }>;
};

type UploadUncertaintyCode =
  | "file_handoff_uncertain"
  | "upload_readiness_uncertain";

export type BrowserInputErrorCode =
  | "file_path_not_absolute"
  | "file_not_readable"
  | "file_not_regular"
  | "composer_unavailable"
  | "input_ambiguous"
  | "upload_path_unavailable"
  | UploadUncertaintyCode
  | "tool_label_invalid"
  | "tool_unavailable"
  | "tool_uncertain"
  | "tool_unverified";

export class BrowserInputError extends Error {
  readonly code: BrowserInputErrorCode;
  readonly uncertain: boolean;

  constructor(
    code: BrowserInputErrorCode,
    message: string,
    uncertain = false,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserInputError";
    this.code = code;
    this.uncertain = uncertain;
  }
}

export type AttachFilesOptions = {
  timeoutMs?: number;
  pollMs?: number;
};

/** Validate only what the visible browser handoff requires. */
export async function validateLocalFiles(
  paths: readonly string[]
): Promise<ValidatedLocalFile[]> {
  const validated: ValidatedLocalFile[] = [];
  for (const input of paths) {
    if (!isAbsolute(input)) {
      throw new BrowserInputError(
        "file_path_not_absolute",
        `File path must be absolute on the browser host: ${input}`
      );
    }
    const path = resolve(input);
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      [metadata] = await Promise.all([
        stat(path),
        access(path, constants.R_OK)
      ]);
    } catch (cause) {
      throw new BrowserInputError(
        "file_not_readable",
        `File must exist and be readable on the browser host: ${path}`,
        false,
        cause
      );
    }
    if (!metadata.isFile()) {
      throw new BrowserInputError(
        "file_not_regular",
        `File path is not a regular file: ${path}`
      );
    }
    validated.push({ path, name: basename(path), bytes: metadata.size });
  }
  return validated;
}

/** Attach once to the exact composer input without opening a native picker. */
export async function attachFiles(
  page: BrowserInputPage,
  paths: readonly string[],
  options: AttachFilesOptions = {}
): Promise<ValidatedLocalFile[]> {
  if (paths.length === 0) return [];
  const files = await validateLocalFiles(paths);
  const composer = await uniqueVisible(
    page.locator(COMPOSER_FORM_SELECTOR),
    "composer_unavailable",
    "Visible Chat composer was not uniquely available."
  );
  const baseline = await attachmentSnapshot(composer);
  if (baseline.cards.length > 0) {
    throw new BrowserInputError(
      "input_ambiguous",
      "Visible Chat composer already contains attachments."
    );
  }
  const timeoutMs = positive(options.timeoutMs, 30_000);
  const pollMs = positive(options.pollMs, 100);
  const capability = await page.capabilities?.get("cdp");
  if (!isCdpCapability(capability)) {
    throw new BrowserInputError(
      "upload_path_unavailable",
      "The selected browser does not expose background file handoff."
    );
  }
  const input = composer.locator?.(UPLOAD_INPUT_SELECTOR);
  if (input === undefined || await input.count() !== 1 || input.evaluate === undefined) {
    throw new BrowserInputError(
      "upload_path_unavailable",
      `Composer ${JSON.stringify(UPLOAD_INPUT_SELECTOR)} was not uniquely available.`
    );
  }
  const inputShape = await input.evaluate(element => ({
    type: (element as HTMLInputElement).type,
    multiple: (element as HTMLInputElement).multiple
  }));
  if (inputShape.type !== "file" || (files.length > 1 && !inputShape.multiple)) {
    throw new BrowserInputError(
      "upload_path_unavailable",
      "The exact composer file input cannot accept the requested handoff."
    );
  }

  const payload = await Promise.all(files.map(async file => ({
    name: file.name,
    base64: (await readFile(file.path)).toString("base64")
  })));
  try {
    const result = await capability.send("Runtime.evaluate", {
      expression: directUploadExpression(payload),
      userGesture: true,
      awaitPromise: true,
      returnByValue: true
    }, { timeoutMs });
    if (!isExactUploadResult(result, files.map(file => file.name))) {
      throw new Error("Background file handoff lacked its exact postcondition.");
    }
  } catch (cause) {
    throw uncertain(
      "file_handoff_uncertain",
      "Background file handoff had an uncertain outcome.",
      cause
    );
  }

  try {
    const names = await waitForReadyFilenames(
      page,
      composer,
      files,
      baseline,
      timeoutMs,
      pollMs
    );
    return files.map((file, index) => ({ ...file, name: names[index]! }));
  } catch (cause) {
    throw uncertain(
      "upload_readiness_uncertain",
      "Attachment filename readiness could not be confirmed.",
      cause
    );
  }
}

function directUploadExpression(
  files: readonly { name: string; base64: string }[]
): string {
  return `(async () => {
  const composers = document.querySelectorAll(${JSON.stringify(COMPOSER_FORM_SELECTOR)});
  if (composers.length !== 1) throw new Error("Chat composer is not unique.");
  const inputs = composers[0].querySelectorAll(${JSON.stringify(UPLOAD_INPUT_SELECTOR)});
  if (inputs.length !== 1) throw new Error("Upload input is not unique.");
  const input = inputs[0];
  const transfer = new DataTransfer();
  for (const file of ${JSON.stringify(files)}) {
    const raw = atob(file.base64);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    transfer.items.add(new File([bytes], file.name));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  return { count: input.files.length, names: Array.from(input.files, file => file.name) };
})()`;
}

function isExactUploadResult(value: unknown, names: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || !("result" in value)) return false;
  const result = value.result;
  if (typeof result !== "object" || result === null || !("value" in result)) return false;
  const uploaded = result.value;
  if (typeof uploaded !== "object" || uploaded === null) return false;
  const count = "count" in uploaded ? uploaded.count : undefined;
  const actual = "names" in uploaded ? uploaded.names : undefined;
  return count === names.length
    && Array.isArray(actual)
    && actual.length === names.length
    && actual.every((name, index) => name === names[index]);
}

/** Select an arbitrary exact English-visible tool label with no registry. */
export async function selectTool(
  page: BrowserInputPage,
  label: string
): Promise<void> {
  if (label.trim().length === 0) {
    throw new BrowserInputError("tool_label_invalid", "Tool label must be nonempty.");
  }
  const composer = await uniqueVisible(
    page.locator(COMPOSER_FORM_SELECTOR),
    "composer_unavailable",
    "Visible Chat composer was not uniquely available."
  );
  if (await hasExactComposerTool(composer, label)) return;

  const opener = await uniqueVisible(
    page.getByRole("button", { name: ADD_FILES_LABEL, exact: true }),
    "tool_unavailable",
    `Visible ${JSON.stringify(ADD_FILES_LABEL)} button was not uniquely available.`
  );
  try {
    await opener.click();
  } catch (cause) {
    throw new BrowserInputError(
      "tool_uncertain",
      "Opening the visible tool menu had an uncertain outcome.",
      true,
      cause
    );
  }

  const row = await waitForUniqueVisible(
    page,
    page.getByText(label, { exact: true }),
    "input_ambiguous",
    `Exact primary tool label ${JSON.stringify(label)} was unavailable or ambiguous.`,
    3_000,
    100
  );
  try {
    await row.click();
  } catch (cause) {
    throw new BrowserInputError(
      "tool_uncertain",
      `Selecting exact tool ${JSON.stringify(label)} had an uncertain outcome.`,
      true,
      cause
    );
  }

  await verifyComposerTools(composer, [label]);
}

export async function verifyVisibleTools(
  page: BrowserInputPage,
  labels: readonly string[]
): Promise<void> {
  const composer = await uniqueVisible(
    page.locator(COMPOSER_FORM_SELECTOR),
    "composer_unavailable",
    "Visible Chat composer was not uniquely available."
  );
  await verifyComposerTools(composer, labels);
}

async function verifyComposerTools(
  composer: BrowserInputLocator,
  labels: readonly string[]
): Promise<void> {
  for (const label of labels) {
    if (!await hasExactComposerTool(composer, label)) {
      throw new BrowserInputError(
        "tool_unverified",
        `Tool ${JSON.stringify(label)} lacks an exact visible composer echo.`,
        true
      );
    }
  }
}

async function hasExactComposerTool(
  composer: BrowserInputLocator,
  label: string
): Promise<boolean> {
  const button = composer.getByRole?.("button", { name: label, exact: true });
  const buttonCount = button === undefined ? 0 : await button.count();
  if (buttonCount > 1) {
    throw new BrowserInputError(
      "input_ambiguous",
      `Exact active tool label ${JSON.stringify(label)} was ambiguous.`
    );
  }
  const buttonActive = buttonCount === 1 && await button!.isVisible();
  if (composer.evaluate === undefined) return buttonActive;
  const inline = await composer.evaluate(element =>
    Array.from(element.querySelectorAll("[data-inline-selection-pill][data-keyword]"))
      .map(pill => pill.getAttribute("data-keyword") ?? "")
      .filter(Boolean)
  );
  const inlineCount = inline.filter(value => value === label).length;
  if (inlineCount > 1) {
    throw new BrowserInputError(
      "input_ambiguous",
      `Exact inline tool label ${JSON.stringify(label)} was ambiguous.`
    );
  }
  return buttonActive || inlineCount === 1;
}

async function waitForReadyFilenames(
  page: BrowserInputPage,
  composer: BrowserInputLocator,
  files: readonly ValidatedLocalFile[],
  baseline: AttachmentSnapshot,
  timeoutMs: number,
  pollMs: number
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let stableKey: string | undefined;
  let stableObservations = 0;
  while (Date.now() < deadline) {
    const current = await attachmentSnapshot(composer);
    const matched = matchAttachmentCards(current.cards, files);
    const status = lineDelta(current.lines, baseline.lines);
    if (matched !== undefined
      && !matched.pending
      && !PROCESSING_TEXT.test(withoutMatchedNames(status, matched.names).join("\n"))) {
      const key = JSON.stringify(matched.names);
      if (key === stableKey) {
        stableObservations += 1;
      } else {
        stableKey = key;
        stableObservations = 1;
      }
      if (stableObservations >= ATTACHMENT_STABLE_OBSERVATIONS) return matched.names;
    } else {
      stableKey = undefined;
      stableObservations = 0;
    }
    const delay = stableKey === undefined ? pollMs : ATTACHMENT_STABLE_POLL_MS;
    await pause(page, Math.min(delay, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Visible attachment names did not remain ready and stable before timeout.");
}

async function attachmentSnapshot(composer: BrowserInputLocator): Promise<AttachmentSnapshot> {
  if (typeof composer.evaluate !== "function") {
    throw new Error("Visible composer attachment state is unavailable.");
  }
  return composer.evaluate(element => ({
    lines: ((element as HTMLElement).innerText ?? element.textContent ?? "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean),
    cards: Array.from(element.querySelectorAll(".truncate.font-semibold"))
      .map(name => {
        const container = name.parentElement?.parentElement;
        const spinner = container?.querySelector("svg[class*='animate-spin']");
        const bounds = spinner?.getBoundingClientRect();
        return {
          name: (name.textContent ?? "").trim(),
          pending: bounds !== undefined && bounds.width > 0 && bounds.height > 0
        };
      })
      .filter(card => card.name.length > 0)
  }));
}

function lineDelta(current: readonly string[], baseline: readonly string[]): string[] {
  const before = occurrences(baseline);
  return current.filter(line => {
    const count = before.get(line) ?? 0;
    if (count === 0) return true;
    before.set(line, count - 1);
    return false;
  });
}

function matchAttachmentCards(
  cards: readonly { name: string; pending: boolean }[],
  files: readonly ValidatedLocalFile[]
): { names: string[]; pending: boolean } | undefined {
  const unmatched = [...cards];
  const names: string[] = [];
  let pending = false;
  for (const file of files) {
    const index = unmatched.findIndex(card => displayedFileNameMatches(file.name, card.name));
    if (index < 0) return undefined;
    names.push(unmatched[index]!.name);
    pending ||= unmatched[index]!.pending;
    unmatched.splice(index, 1);
  }
  if (unmatched.length > 0) return undefined;
  return { names, pending };
}

function withoutMatchedNames(lines: readonly string[], names: readonly string[]): string[] {
  const matched = occurrences(names);
  return lines.filter(line => {
    const count = matched.get(line) ?? 0;
    if (count === 0) return true;
    matched.set(line, count - 1);
    return false;
  });
}

function displayedFileNameMatches(requested: string, displayed: string): boolean {
  if (displayed === requested) return true;
  const extension = extname(requested);
  const stem = extension.length === 0 ? requested : requested.slice(0, -extension.length);
  return new RegExp(`^${escapeRegex(stem)} ?\\([1-9]\\d*\\)${escapeRegex(extension)}$`)
    .test(displayed);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function uniqueVisible(
  locator: BrowserInputLocator,
  code: BrowserInputErrorCode,
  message: string
): Promise<BrowserInputLocator> {
  if (!await isUniqueVisible(locator)) throw new BrowserInputError(code, message);
  return locator;
}

async function waitForUniqueVisible(
  page: BrowserInputPage,
  locator: BrowserInputLocator,
  code: BrowserInputErrorCode,
  message: string,
  timeoutMs: number,
  pollMs: number
): Promise<BrowserInputLocator> {
  const deadline = Date.now() + timeoutMs;
  do {
    const count = await locator.count();
    if (count > 1) throw new BrowserInputError(code, message);
    if (count === 1 && await locator.isVisible()) return locator;
    await pause(page, Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new BrowserInputError(code, message);
}

async function isUniqueVisible(locator: BrowserInputLocator): Promise<boolean> {
  return await locator.count() === 1 && await locator.isVisible();
}

function uncertain(
  code: UploadUncertaintyCode,
  message: string,
  cause?: unknown
): BrowserInputError {
  return new BrowserInputError(code, message, true, cause);
}

function isCdpCapability(value: unknown): value is BrowserInputCdpCapability {
  return typeof value === "object"
    && value !== null
    && typeof (value as BrowserInputCdpCapability).send === "function";
}

function occurrences(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

async function pause(page: BrowserInputPage, ms: number): Promise<void> {
  if (page.waitForTimeout !== undefined) {
    await page.waitForTimeout(ms);
    return;
  }
  await new Promise(resolve => setTimeout(resolve, ms));
}
