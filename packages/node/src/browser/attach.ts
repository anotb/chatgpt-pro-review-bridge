import { BrowserBridgeUnavailableError, ChatGPTControlError, LoginRequiredError } from "../errors.js";
import type { BootstrapArgs, BrowserLike, BrowserUserTabInfo, ExistingTabDiagnostics, ExistingTabPolicy, ExistingTabTarget, PageLike, RuntimeEnv } from "../types.js";
import { parseConversationId, readPageState, type PageState } from "./page-state.js";

const CHATGPT_HOME = "https://chatgpt.com/";
const CHATGPT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com"]);
const MAX_EXISTING_TAB_DIAGNOSTIC_CANDIDATES = 10;
const MAX_EXISTING_TAB_DIAGNOSTIC_FIELD_LENGTH = 240;
const EXACT_TARGET_TIMEOUT_MS = 12_000;

type ExistingTabSelectionOutcome = {
  page?: PageLike;
  diagnostics?: ExistingTabDiagnostics;
};

export type AttachedBrowser = {
  browser: BrowserLike;
  page: PageLike;
  browserName: string;
  tabId?: string;
};

type AttachedBrowserState = AttachedBrowser & {
  state: PageState;
};

type ControlledTab = PageLike | {
  id: string;
  providerTabId?: string;
  tabId?: string;
  title?: string;
  url?: string;
};

type BridgeTabs = Omit<NonNullable<BrowserLike["tabs"]>, "list" | "finalize"> & {
  list?: () => Promise<ControlledTab[]> | ControlledTab[];
  finalize?: (options: { keep?: Array<{ status: "handoff" | "deliverable"; tab: unknown }> }) => Promise<void>;
};

class ExactTargetTimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`Timed out while ${operation}.`);
    this.name = "ExactTargetTimeoutError";
  }
}

export async function attachChatGPTBrowser(
  env: RuntimeEnv,
  args: BootstrapArgs = {}
): Promise<AttachedBrowser> {
  const browser = await getBrowser(env);
  const exactTimeoutMs = exactTargetTimeoutMs(args);
  const page = await getOrCreateChatGPTPage(browser, env, args, exactTimeoutMs);
  let state: PageState;
  try {
    if (exactTimeoutMs === undefined) {
      state = await readPageState(page);
    } else {
      const guarded = exactStatePage(page, exactTimeoutMs);
      state = await readPageState(guarded.page);
      if (guarded.stopped()) throw new ExactTargetTimeoutError("reading the requested ChatGPT tab");
    }
  } catch (error) {
    if (error instanceof ExactTargetTimeoutError) throw existingTabUnresponsiveError(error.operation);
    throw error;
  }

  if (state.blocker?.kind === "login_required") {
    throw new LoginRequiredError(state.blocker.visibleText);
  }

  const attached: AttachedBrowserState = {
    browser,
    page,
    browserName: browser.name ?? "chrome",
    state
  };

  const tabId = tabIdFromPage(page);
  if (tabId !== undefined) {
    attached.tabId = tabId;
  }

  return attached;
}

async function getBrowser(env: RuntimeEnv): Promise<BrowserLike> {
  if (env.browser !== undefined) {
    return env.browser;
  }

  const anyEnv = env as Record<string, unknown>;
  const agent = env.agent ?? anyEnv.agent ?? (globalThis as Record<string, unknown>).agent;
  const browsers = (agent as { browsers?: unknown } | undefined)?.browsers;

  if (browsers !== undefined && typeof browsers === "object") {
    const maybeBrowser = await tryBrowserGetPreferredListed(browsers)
      ?? await tryBrowserGet(browsers, "extension")
      ?? await tryBrowserGet(browsers, "chrome");

    if (maybeBrowser !== undefined) {
      return maybeBrowser;
    }
  }

  throw new BrowserBridgeUnavailableError();
}

async function tryBrowserGet(browsers: unknown, name: string): Promise<BrowserLike | undefined> {
  const get = (browsers as { get?: (browserName: string) => Promise<unknown> | unknown }).get;
  if (typeof get !== "function") {
    return undefined;
  }

  try {
    const browser = await get.call(browsers, name);
    return normalizeBrowser(browser);
  } catch {
    return undefined;
  }
}

async function tryBrowserGetFirst(browsers: unknown): Promise<BrowserLike | undefined> {
  const list = (browsers as { list?: () => Promise<unknown[]> | unknown[] }).list;
  const get = (browsers as { get?: (browserName: string) => Promise<unknown> | unknown }).get;

  if (typeof list !== "function" || typeof get !== "function") {
    return undefined;
  }

  try {
    const names = await list.call(browsers);
    const first = names.find(name => typeof name === "string") as string | undefined;
    if (first === undefined) {
      return undefined;
    }
    const browser = await get.call(browsers, first);
    return normalizeBrowser(browser);
  } catch {
    return undefined;
  }
}

async function tryBrowserGetPreferredListed(browsers: unknown): Promise<BrowserLike | undefined> {
  const list = (browsers as { list?: () => Promise<Array<Record<string, unknown>>> | Array<Record<string, unknown>> }).list;
  const get = (browsers as { get?: (browserName: string) => Promise<unknown> | unknown }).get;

  if (typeof list !== "function" || typeof get !== "function") {
    return undefined;
  }

  try {
    const available = await list.call(browsers);
    const preferred = available.find(browser => browser.type === "extension")
      ?? available.find(browser => typeof browser.name === "string" && /chrome/i.test(browser.name))
      ?? available[0];
    const id = preferred?.id;
    if (typeof id !== "string") {
      return undefined;
    }
    const browser = await get.call(browsers, id);
    return normalizeBrowser(browser);
  } catch {
    return undefined;
  }
}

async function getOrCreateChatGPTPage(
  browser: BrowserLike,
  env: RuntimeEnv,
  args: BootstrapArgs,
  exactTimeoutMs: number | undefined
): Promise<PageLike> {
  const targetUrl = args.url ?? CHATGPT_HOME;
  const explicitExistingPolicy = normalizeExplicitExistingTabPolicy(args);

  if (env.page !== undefined) {
    const cached = normalizePage(env.page);
    if (await cachedPageMatchesBootstrapArgs(cached, args, explicitExistingPolicy, exactTimeoutMs)) {
      return cached;
    }
  }

  if (explicitExistingPolicy !== undefined) {
    const existing = await selectExistingTab(browser, explicitExistingPolicy, exactTimeoutMs);
    if (existing.page !== undefined) {
      return existing.page;
    }

    const ifMissing = explicitExistingPolicy.ifMissing ?? "block";
    if (ifMissing === "block") {
      throw new ExistingTabSelectionError(
        "No already-open ChatGPT tab matched the requested existing-tab target.",
        "existing_tab_not_found",
        existing.diagnostics?.candidateTabs,
        existing.diagnostics
      );
    }
    const missingUrl = ifMissing === "open"
      ? urlFromExistingTarget(explicitExistingPolicy.target) ?? targetUrl
      : targetUrl;
    const created = await createTab(browser, missingUrl);
    if (created !== undefined) {
      return created;
    }
    throw new BrowserBridgeUnavailableError("Codex can access a browser object, but no tab creation API was found.");
  }

  if (args.preferExistingTab !== false) {
    const existing = await findExistingChatGPTTab(browser);
    if (existing !== undefined) {
      return existing;
    }
  }

  const created = await createTab(browser, targetUrl);
  if (created !== undefined) {
    return created;
  }

  throw new BrowserBridgeUnavailableError("Codex can access a browser object, but no tab creation API was found.");
}

async function cachedPageMatchesBootstrapArgs(
  page: PageLike,
  args: BootstrapArgs,
  explicitExistingPolicy: ExistingTabPolicy | undefined,
  exactTimeoutMs?: number
): Promise<boolean> {
  if (explicitExistingPolicy !== undefined) {
    return pageMatchesExistingTarget(page, explicitExistingPolicy, exactTimeoutMs);
  }

  if (args.url !== undefined) {
    const currentUrl = await Promise.resolve(page.url?.()).catch(() => undefined);
    return urlMatches(currentUrl, args.url);
  }

  return true;
}

function normalizeExplicitExistingTabPolicy(args: BootstrapArgs): ExistingTabPolicy | undefined {
  if (args.existingTab === undefined) {
    return undefined;
  }
  if (args.existingTab === true) {
    return {
      target: { type: "selected", host: "chatgpt" },
      ifMissing: "create",
      ifMultiple: "first",
      requireChatGPT: true
    };
  }
  if (args.existingTab === false) {
    return undefined;
  }
  return {
    requireChatGPT: true,
    ifMissing: "block",
    ifMultiple: args.existingTab.target?.type === "selected" ? "first" : "block",
    ...args.existingTab
  };
}

function exactTargetTimeoutMs(args: BootstrapArgs): number | undefined {
  const target = typeof args.existingTab === "object" ? args.existingTab.target : undefined;
  if (target === undefined || !isDeterministicMetadataTarget(target)) return undefined;
  if (typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)) {
    return Math.max(1, Math.floor(args.timeoutMs));
  }
  return EXACT_TARGET_TIMEOUT_MS;
}

function isDeterministicMetadataTarget(
  target: ExistingTabTarget
): target is Extract<ExistingTabTarget, { type: "tabId" | "conversationId" | "conversation_id" | "url" }> {
  return target.type === "tabId"
    || target.type === "conversationId"
    || target.type === "conversation_id"
    || target.type === "url";
}

async function exactTargetOperation<T>(
  timeoutMs: number,
  operation: string,
  run: () => Promise<T>
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new ExactTargetTimeoutError(operation)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function exactStatePage(page: PageLike, timeoutMs: number): { page: PageLike; stopped: () => boolean } {
  const deadline = Date.now() + timeoutMs;
  let stopped = false;
  const wrap = (value: object): object => new Proxy(value, {
    get(target, property, receiver) {
      if (property === "title") return undefined;
      const member = Reflect.get(target, property, receiver) as unknown;
      if (property === "playwright" && member !== null && typeof member === "object") return wrap(member);
      if (typeof member !== "function") return member;
      return async (...args: unknown[]) => {
        const remaining = deadline - Date.now();
        if (stopped || remaining <= 0) {
          stopped = true;
          throw new ExactTargetTimeoutError("reading the requested ChatGPT tab");
        }
        try {
          // Beat readPageState's ordinary fallback timer so a stalled exact
          // probe cannot fall through and start a second browser operation.
          const operationTimeout = property === "evaluate" || property === "content"
            ? Math.min(remaining, 900)
            : remaining;
          return await exactTargetOperation(
            operationTimeout,
            "reading the requested ChatGPT tab",
            () => Promise.resolve(member.apply(target, args))
          );
        } catch (error) {
          if (error instanceof ExactTargetTimeoutError) stopped = true;
          throw error;
        }
      };
    }
  });
  return { page: wrap(page as object) as PageLike, stopped: () => stopped };
}

function existingTabUnresponsiveError(operation: string): ExistingTabSelectionError {
  return new ExistingTabSelectionError(
    `The browser stopped responding while ${operation}. Preserve the review archive and resume after the browser host is responsive.`,
    "existing_tab_unresponsive",
    [],
    undefined,
    true
  );
}

function stableUserTabId(tab: BrowserUserTabInfo): string {
  return tab.providerTabId ?? tab.id;
}

function controlledTabInfo(tab: ControlledTab): BrowserUserTabInfo {
  const value = tab as Record<string, unknown>;
  const legacyId = typeof value.tabId === "string"
    ? value.tabId
    : typeof value.id === "string"
      ? value.id
      : "unknown";
  const providerTabId = typeof value.providerTabId === "string" ? value.providerTabId : undefined;
  const info: BrowserUserTabInfo = { id: providerTabId ?? legacyId };
  if (providerTabId !== undefined) info.providerTabId = providerTabId;
  if (typeof value.url === "string") info.url = value.url;
  if (typeof value.title === "string") info.title = value.title;
  return info;
}

function metadataMatchesTarget(tab: ControlledTab, policy: ExistingTabPolicy): boolean {
  const target = policy.target;
  if (target === undefined || !isDeterministicMetadataTarget(target)) return false;
  const info = controlledTabInfo(tab);
  if (target.type === "tabId") {
    if (stableUserTabId(info) !== target.tabId) return false;
    return !(policy.requireChatGPT ?? true) || info.url === undefined || isChatGPTUrl(info.url);
  }
  if (info.url === undefined) return false;
  return userTabMatchesTarget(info, policy);
}

function isControllablePage(value: unknown): value is PageLike {
  if (value === undefined || value === null || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return page.playwright !== undefined
    || page.page !== undefined
    || typeof page.url === "function"
    || typeof page.goto === "function"
    || typeof page.evaluate === "function"
    || typeof page.content === "function"
    || typeof page.locator === "function";
}

function pageWithStableTabId(page: PageLike, stableId: string): PageLike {
  return new Proxy(page as object, {
    get(target, property, receiver) {
      if (property === "providerTabId" || property === "tabId") return stableId;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as PageLike;
}

async function handoffControlledTabs(
  tabs: BridgeTabs,
  controlled: ControlledTab[],
  match: ControlledTab,
  timeoutMs: number
): Promise<void> {
  if (typeof tabs.finalize !== "function") {
    throw new ExistingTabSelectionError(
      "The requested ChatGPT tab is still owned by this browser session. Resume after the current browser-host invocation exits; no duplicate tab was opened.",
      "existing_tab_temporarily_claimed",
      [controlledTabInfo(match)],
      undefined,
      true
    );
  }
  try {
    await exactTargetOperation(timeoutMs, "handing off controlled browser tabs", () => Promise.resolve(tabs.finalize!({
      keep: controlled.map(tab => ({ tab, status: "handoff" as const }))
    })));
  } catch (error) {
    if (error instanceof ExactTargetTimeoutError) throw existingTabUnresponsiveError(error.operation);
    throw new ExistingTabSelectionError(
      "The browser could not release the requested ChatGPT tab. Resume after the current browser-host invocation exits; no duplicate tab was opened.",
      "existing_tab_temporarily_claimed",
      [controlledTabInfo(match)],
      undefined,
      true
    );
  }
}

async function selectExistingTab(
  browser: BrowserLike,
  policy: ExistingTabPolicy,
  exactTimeoutMs: number | undefined
): Promise<ExistingTabSelectionOutcome> {
  const target = policy.target ?? { type: "selected", host: "chatgpt" };
  const tabs = browser.tabs as BridgeTabs | undefined;
  let exactUserMatch: ExistingTabSelectionOutcome | undefined;
  let exactUserClaimConflict: ExistingTabSelectionError | undefined;

  if (target.type === "selected" && typeof tabs?.selected === "function") {
    const selected = await Promise.resolve(tabs.selected.call(tabs)).catch(() => undefined);
    if (selected !== undefined && isControllablePage(selected)) {
      const normalized = normalizePage(selected);
      if (await pageMatchesExistingTarget(normalized, policy, exactTimeoutMs)) return { page: normalized };
    }
  }

  // A fresh host may expose a handed-off tab through both APIs. Prefer the
  // stable user-tab identity so stale controlled metadata cannot hand it off
  // repeatedly or block the claim by stalling.
  if (isDeterministicMetadataTarget(target)) {
    try {
      exactUserMatch = await selectExistingUserTab(
        browser,
        policy,
        shouldCollectExistingTabDiagnostics(policy),
        exactTimeoutMs,
        true
      );
      if (exactUserMatch.page !== undefined) return exactUserMatch;
    } catch (error) {
      if (!(error instanceof ExistingTabSelectionError)
        || error.blockerDetails.code !== "existing_tab_temporarily_claimed") {
        throw error;
      }
      exactUserClaimConflict = error;
    }
  }

  let controlledListed = false;
  if (typeof tabs?.list === "function") {
    let controlled: ControlledTab[] | undefined;
    try {
      controlled = exactTimeoutMs === undefined
        ? await Promise.resolve(tabs.list.call(tabs))
        : await exactTargetOperation(exactTimeoutMs, "listing controlled browser tabs", () => Promise.resolve(tabs.list!.call(tabs)));
      controlledListed = true;
    } catch (error) {
      if (error instanceof ExactTargetTimeoutError) throw existingTabUnresponsiveError(error.operation);
      // Compatibility fallback for browser adapters without controlled-tab listing.
    }

    if (controlled !== undefined) {
      const matches: Array<{ tab: ControlledTab; page?: PageLike }> = [];
      for (const candidate of controlled) {
        if (target.type === "tabId"
          && stableUserTabId(controlledTabInfo(candidate)) !== target.tabId) continue;
        if (isControllablePage(candidate)) {
          const page = normalizePage(candidate);
          if (await pageMatchesExistingTarget(page, policy, exactTimeoutMs)) matches.push({ tab: candidate, page });
        } else if (isDeterministicMetadataTarget(target) && metadataMatchesTarget(candidate, policy)) {
          matches.push({ tab: candidate });
        }
      }

      if (matches.length > 1 && (policy.ifMultiple ?? "block") !== "first") {
        throw new ExistingTabSelectionError(
          "Multiple already-controlled ChatGPT tabs matched the requested existing-tab target.",
          "existing_tab_ambiguous",
          matches.map(match => controlledTabInfo(match.tab))
        );
      }
      if (matches.length > 0) {
        const match = matches[0]!;
        if (match.page !== undefined) return { page: match.page };
        await handoffControlledTabs(tabs, controlled, match.tab, exactTimeoutMs ?? EXACT_TARGET_TIMEOUT_MS);
        throw new ExistingTabSelectionError(
          "The matching ChatGPT tab was released from stale browser-session control and kept open. Resume the same operation to claim it without opening a duplicate.",
          "existing_tab_handoff_completed",
          [controlledTabInfo(match.tab)],
          undefined,
          true
        );
      }
    }
  }

  // A successful list is authoritative for controlled tabs. Only legacy
  // adapters that cannot list may need the direct exact-tab lookup.
  if (target.type === "tabId" && !controlledListed && typeof tabs?.get === "function") {
    try {
      const tab = await exactTargetOperation(
        exactTimeoutMs ?? EXACT_TARGET_TIMEOUT_MS,
        "getting the requested controlled browser tab",
        () => Promise.resolve(tabs.get!.call(tabs, target.tabId))
      );
      if (isControllablePage(tab)) {
        const page = normalizePage(tab);
        if (await pageMatchesExistingTarget(page, policy, exactTimeoutMs)) return { page };
      }
    } catch (error) {
      if (error instanceof ExactTargetTimeoutError) throw existingTabUnresponsiveError(error.operation);
    }
  }

  if (exactUserClaimConflict !== undefined) throw exactUserClaimConflict;

  const userMatch = exactUserMatch ?? await selectExistingUserTab(
    browser,
    policy,
    shouldCollectExistingTabDiagnostics(policy),
    exactTimeoutMs
  );
  if (userMatch.page !== undefined) {
    return userMatch;
  }

  return userMatch.diagnostics === undefined
    ? { diagnostics: diagnosticsForUnavailableUserTabs(policy) }
    : userMatch;
}

async function selectExistingUserTab(
  browser: BrowserLike,
  policy: ExistingTabPolicy,
  collectDiagnostics: boolean,
  exactTimeoutMs?: number,
  strictOpenTabsErrors = false
): Promise<ExistingTabSelectionOutcome> {
  const openTabs = browser.user?.openTabs;
  const claimTab = browser.user?.claimTab;
  if (typeof openTabs !== "function" || typeof claimTab !== "function") {
    return {};
  }

  let tabs: BrowserUserTabInfo[] | undefined;
  try {
    tabs = exactTimeoutMs === undefined
      ? await Promise.resolve(openTabs.call(browser.user))
      : await exactTargetOperation(exactTimeoutMs, "listing open browser tabs", () => Promise.resolve(openTabs.call(browser.user)));
  } catch (error) {
    if (error instanceof ExactTargetTimeoutError) throw existingTabUnresponsiveError(error.operation);
    if (strictOpenTabsErrors) {
      throw new ExistingTabSelectionError(
        "The browser could not enumerate open tabs for the requested exact target.",
        "existing_tab_unresponsive",
        [],
        diagnosticsForUnavailableUserTabs(policy, "user_open_tabs_unavailable"),
        true
      );
    }
  }
  if (tabs === undefined) {
    return collectDiagnostics
      ? { diagnostics: diagnosticsForUnavailableUserTabs(policy, "user_open_tabs_unavailable") }
      : {};
  }
  const matches = matchingUserTabs(tabs, policy);
  const diagnostics = collectDiagnostics ? diagnosticsForUserTabs(policy, tabs, matches) : undefined;

  if (matches.length === 0) {
    return diagnostics === undefined ? {} : { diagnostics };
  }

  if (matches.length > 1 && (policy.ifMultiple ?? "block") !== "first") {
    throw new ExistingTabSelectionError(
      "Multiple already-open ChatGPT tabs matched the requested existing-tab target.",
      "existing_tab_ambiguous",
      matches,
      diagnostics
    );
  }

  const target = policy.target;
  const claimCandidates = target?.type === "conversationId"
    && policy.ifMissing === "block"
    && policy.ifMultiple === "first"
    && policy.requireChatGPT === true
    ? matches.slice(0, 2)
    : [matches[0]!];
  for (const [index, selected] of claimCandidates.entries()) {
    let page: PageLike;
    try {
      const claimed = exactTimeoutMs === undefined
        ? await Promise.resolve(claimTab.call(browser.user, selected))
        : await exactTargetOperation(exactTimeoutMs, "claiming the requested browser tab", () => Promise.resolve(claimTab.call(browser.user, selected)));
      page = normalizePage(claimed);
    } catch (error) {
      if (error instanceof ExactTargetTimeoutError) throw existingTabUnresponsiveError(error.operation);
      if (isExistingTabClaimConflict(error)) {
        if (index + 1 < claimCandidates.length) continue;
        throw new ExistingTabSelectionError(
          "A matching ChatGPT tab is still claimed by another browser-host invocation. Resume after that invocation exits; no duplicate tab was opened.",
          "existing_tab_temporarily_claimed",
          [selected],
          diagnostics,
          true
        );
      }
      throw error;
    }
    const stableId = stableUserTabId(selected);
    if (stableId !== undefined) page = pageWithStableTabId(page, stableId);
    return diagnostics === undefined ? { page } : { page, diagnostics };
  }
  throw new Error("Existing-tab claim candidates were unexpectedly exhausted.");
}

function matchingUserTabs(
  tabs: BrowserUserTabInfo[],
  policy: ExistingTabPolicy
): BrowserUserTabInfo[] {
  const target = policy.target ?? { type: "selected", host: "chatgpt" };
  if (target.type !== "tabId") return tabs.filter(tab => userTabMatchesTarget(tab, policy));

  const requireChatGPT = policy.requireChatGPT ?? targetRequiresChatGPT(target);
  const eligible = requireChatGPT ? tabs.filter(tab => isChatGPTUrl(tab.url)) : tabs;
  const providerMatches = tabs.filter(tab => tab.providerTabId === target.tabId);
  return providerMatches.length > 0
    ? providerMatches.filter(tab => !requireChatGPT || isChatGPTUrl(tab.url))
    : eligible.filter(tab => tab.id === target.tabId);
}

function isExistingTabClaimConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\balready\b.{0,80}\b(?:browser session|browser use session|claimed|controlled)\b|\bclaimed\b.{0,80}\b(?:browser session|browser use session|another session)\b/i.test(message);
}

function userTabMatchesTarget(tab: BrowserUserTabInfo, policy: ExistingTabPolicy): boolean {
  const target = policy.target ?? { type: "selected", host: "chatgpt" };
  const requireChatGPT = policy.requireChatGPT ?? targetRequiresChatGPT(target);
  if (requireChatGPT && !isChatGPTUrl(tab.url)) {
    return false;
  }

  switch (target.type) {
    case "selected":
      return target.host === undefined || target.host === "chatgpt" ? isChatGPTUrl(tab.url) : true;
    case "tabId":
      return stableUserTabId(tab) === target.tabId;
    case "conversationId":
    case "conversation_id":
      return parseConversationId(tab.url ?? "") === target.conversationId;
    case "url":
      return urlMatches(tab.url, target.url);
    case "title":
      return titleMatches(tab.title, target.title, target.exact ?? true);
  }
}

function diagnosticsForUserTabs(
  policy: ExistingTabPolicy,
  tabs: BrowserUserTabInfo[],
  matches: BrowserUserTabInfo[]
): ExistingTabDiagnostics {
  const chatgptTabs = tabs.filter(tab => isChatGPTUrl(tab.url));
  const candidateTabs = matches.length > 1 ? matches : chatgptTabs;
  const cappedTabs = candidateTabs.slice(0, MAX_EXISTING_TAB_DIAGNOSTIC_CANDIDATES);
  const diagnostics: ExistingTabDiagnostics = {
    requestedTarget: diagnosticTarget(policy.target ?? { type: "selected", host: "chatgpt" }),
    userOpenTabsAvailable: true,
    chatgptTabCount: chatgptTabs.length,
    mismatchReason: matches.length > 1 ? "multiple_candidates" : mismatchReasonForNoMatches(policy, tabs, chatgptTabs),
    candidateTabs: cappedTabs.map(diagnosticCandidate)
  };
  const omittedCandidateCount = candidateTabs.length - cappedTabs.length;
  if (omittedCandidateCount > 0) diagnostics.omittedCandidateCount = omittedCandidateCount;
  return diagnostics;
}

function shouldCollectExistingTabDiagnostics(policy: ExistingTabPolicy): boolean {
  return (policy.ifMissing ?? "block") === "block" || (policy.ifMultiple ?? "block") !== "first";
}

function diagnosticsForUnavailableUserTabs(
  policy: ExistingTabPolicy,
  mismatchReason: ExistingTabDiagnostics["mismatchReason"] | undefined = undefined
): ExistingTabDiagnostics {
  const target = policy.target ?? { type: "selected", host: "chatgpt" };
  return {
    requestedTarget: diagnosticTarget(target),
    userOpenTabsAvailable: false,
    chatgptTabCount: 0,
    mismatchReason: mismatchReason ?? (target.type === "tabId" ? "explicit_tab_id_not_open" : "selected_tab_unavailable"),
    candidateTabs: []
  };
}

function diagnosticTarget(target: ExistingTabTarget): ExistingTabDiagnostics["requestedTarget"] {
  switch (target.type) {
    case "selected": {
      const value: ExistingTabDiagnostics["requestedTarget"] = { type: target.type };
      if (target.host !== undefined) value.host = target.host;
      return value;
    }
    case "tabId":
      return { type: target.type, tabId: target.tabId };
    case "conversationId":
    case "conversation_id":
      return { type: target.type, conversationId: target.conversationId };
    case "url":
      return { type: target.type, url: target.url };
    case "title": {
      const value: ExistingTabDiagnostics["requestedTarget"] = { type: target.type, title: target.title };
      if (target.exact !== undefined) value.exact = target.exact;
      return value;
    }
  }
}

function diagnosticCandidate(tab: BrowserUserTabInfo): ExistingTabDiagnostics["candidateTabs"][number] {
  const candidate: ExistingTabDiagnostics["candidateTabs"][number] = {
    id: truncateDiagnosticField(stableUserTabId(tab))
  };
  if (tab.url !== undefined) {
    candidate.url = truncateDiagnosticField(tab.url);
    const conversationId = parseConversationId(tab.url);
    if (conversationId !== undefined) candidate.conversationId = conversationId;
  }
  if (tab.title !== undefined) candidate.title = truncateDiagnosticField(tab.title);
  if (tab.lastOpened !== undefined) candidate.lastOpened = truncateDiagnosticField(tab.lastOpened);
  if (tab.tabGroup !== undefined) candidate.tabGroup = truncateDiagnosticField(tab.tabGroup);
  return candidate;
}

function truncateDiagnosticField(value: string): string {
  return value.length <= MAX_EXISTING_TAB_DIAGNOSTIC_FIELD_LENGTH
    ? value
    : `${value.slice(0, MAX_EXISTING_TAB_DIAGNOSTIC_FIELD_LENGTH - 1)}…`;
}

function mismatchReasonForNoMatches(
  policy: ExistingTabPolicy,
  tabs: BrowserUserTabInfo[],
  chatgptTabs: BrowserUserTabInfo[]
): ExistingTabDiagnostics["mismatchReason"] {
  const target = policy.target ?? { type: "selected", host: "chatgpt" };
  if (tabs.length === 0) return "no_candidate";
  if (chatgptTabs.length === 0 && (policy.requireChatGPT ?? targetRequiresChatGPT(target))) {
    return "non_chatgpt_tab";
  }
  switch (target.type) {
    case "tabId":
      return tabs.some(tab => stableUserTabId(tab) === target.tabId) ? "non_chatgpt_tab" : "explicit_tab_id_not_open";
    case "conversationId":
    case "conversation_id":
      return "conversation_id_mismatch";
    case "url":
      return "url_mismatch";
    case "title":
      return "title_mismatch";
    case "selected":
      return "selected_tab_unavailable";
  }
}

async function pageMatchesExistingTarget(
  page: PageLike,
  policy: ExistingTabPolicy,
  exactTimeoutMs?: number
): Promise<boolean> {
  let url: string | undefined;
  try {
    url = exactTimeoutMs === undefined
      ? await Promise.resolve(page.url?.()).catch(() => undefined)
      : await exactTargetOperation(exactTimeoutMs, "reading the requested browser tab URL", () => Promise.resolve(page.url?.()));
  } catch (error) {
    if (error instanceof ExactTargetTimeoutError) throw existingTabUnresponsiveError(error.operation);
  }
  const tab: BrowserUserTabInfo = { id: tabIdFromPage(page) ?? "" };
  if (url !== undefined) tab.url = url;
  if (policy.target?.type === "title") {
    const title = await Promise.resolve(page.title?.()).catch(() => undefined);
    if (title !== undefined) tab.title = title;
  }
  return userTabMatchesTarget(tab, policy);
}

async function findExistingChatGPTTab(browser: BrowserLike): Promise<PageLike | undefined> {
  // Reuse a tab already controlled by this browser session before attempting
  // to claim an external user tab. Claiming a tab that is still associated
  // with an interrupted host call can otherwise wait on a stale control lock
  // until the next bounded browser call is killed.
  const selected = browser.tabs?.selected;
  if (typeof selected === "function") {
    try {
      const current = await selected.call(browser.tabs);
      if (current !== undefined) {
        const normalized = normalizePage(current);
        try {
          if (isChatGPTUrl(await normalized.url?.())) {
            return normalized;
          }
        } catch {
          // Continue to full tab list.
        }
      }
    } catch {
      // No selected tab is a normal fresh-browser state.
    }
  }

  const list = browser.tabs?.list;
  if (typeof list === "function") {
    const tabs = await list.call(browser.tabs);
    for (const candidate of tabs) {
      // Current bridges return metadata here. Generic discovery must never
      // hydrate that metadata through get(), which can wait on stale control.
      if (!isControllablePage(candidate)) continue;
      const tab = normalizePage(candidate);
      try {
        if (isChatGPTUrl(await tab.url?.())) {
          return tab;
        }
      } catch {
        // Keep looking.
      }
    }
  }

  let userTab: ExistingTabSelectionOutcome;
  try {
    userTab = await selectExistingUserTab(browser, {
      target: { type: "selected", host: "chatgpt" },
      ifMultiple: "first",
      requireChatGPT: true
    }, false);
  } catch (error) {
    if (!(error instanceof ExistingTabSelectionError)
      || error.blockerDetails.code !== "existing_tab_temporarily_claimed") {
      throw error;
    }
    // Generic reuse is only a preference. A tab claimed by another live
    // invocation must not prevent an unrelated new workflow from opening its
    // own ChatGPT home tab. Exact existing-tab targets take the explicit path
    // above and remain fail-closed so resumes never open duplicates.
    userTab = {};
  }
  if (userTab.page !== undefined) {
    return userTab.page;
  }
  return undefined;
}

class ExistingTabSelectionError extends ChatGPTControlError {
  constructor(
    message: string,
    code: string,
    candidates: BrowserUserTabInfo[] = [],
    diagnostics?: ExistingTabDiagnostics,
    resumable = false
  ) {
    const details: ConstructorParameters<typeof ChatGPTControlError>[4] = {
      code,
      candidates: candidates.map(tab => ({ label: userTabCandidateLabel(tab) })),
      remediation: [
        {
          label: "Choose an exact tab",
          instruction: "Use the selected tab, a ChatGPT conversation URL, conversation ID, or the stable tab ID shown in diagnostics or the current context.",
          userActionRequired: false
        },
        {
          label: "Allow opening",
          instruction: "Rerun with open-if-missing only if it is acceptable to open or create a ChatGPT tab instead of reusing an already-open one.",
          userActionRequired: false
        }
      ]
    };
    if (diagnostics !== undefined) details.diagnostics = { existingTab: diagnostics };
    if (resumable) details.resumable = true;
    super(message, "not_found", true, undefined, details);
  }
}

function targetRequiresChatGPT(target: ExistingTabTarget): boolean {
  switch (target.type) {
    case "selected":
      return target.host === "chatgpt";
    case "tabId":
    case "title":
      return true;
    case "conversationId":
    case "conversation_id":
    case "url":
      return true;
  }
}

export function isChatGPTUrl(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  try {
    return CHATGPT_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function urlMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) {
    return false;
  }
  const actualConversationId = parseConversationId(actual);
  const expectedConversationId = parseConversationId(expected);
  if (actualConversationId !== undefined || expectedConversationId !== undefined) {
    return actualConversationId !== undefined && actualConversationId === expectedConversationId;
  }
  return normalizeUrl(actual) === normalizeUrl(expected);
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function titleMatches(actual: string | undefined, expected: string, exact: boolean): boolean {
  if (actual === undefined) {
    return false;
  }
  const normalizedActual = normalizeText(actual);
  const normalizedExpected = normalizeText(expected);
  return exact ? normalizedActual === normalizedExpected : normalizedActual.includes(normalizedExpected);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function urlFromExistingTarget(target: ExistingTabTarget | undefined): string | undefined {
  if (target === undefined) {
    return undefined;
  }
  switch (target.type) {
    case "url":
      return target.url;
    case "conversationId":
    case "conversation_id":
      return new URL(`/c/${target.conversationId}`, CHATGPT_HOME).toString();
    case "selected":
    case "tabId":
    case "title":
      return undefined;
  }
}

function userTabCandidateLabel(tab: BrowserUserTabInfo): string {
  return `tab ${stableUserTabId(tab)} - ${tab.title ?? "Untitled"} - ${tab.url ?? "unknown URL"}`;
}

async function createTab(browser: BrowserLike, url: string): Promise<PageLike | undefined> {
  if (typeof browser.tabs?.create === "function") {
    const tab = await browser.tabs.create(url);
    const page = await hydrateTab(browser, tab);
    await ensurePageAt(page, url);
    return page;
  }

  if (typeof browser.tabs?.new === "function") {
    const tab = await browser.tabs.new(url);
    const page = await hydrateTab(browser, tab);
    await ensurePageAt(page, url);
    return page;
  }

  if (typeof browser.newPage === "function") {
    const page = normalizePage(await browser.newPage());
    if (typeof page.goto === "function") {
      await page.goto(url);
    }
    return page;
  }

  return undefined;
}

async function ensurePageAt(page: PageLike, url: string): Promise<void> {
  const currentUrl = await Promise.resolve(page.url?.()).catch(() => "");
  if (isChatGPTUrl(currentUrl)) {
    return;
  }
  if (typeof page.goto === "function") {
    await page.goto(url);
    const navigatedUrl = await Promise.resolve(page.url?.()).catch(() => "");
    if (!isChatGPTUrl(navigatedUrl)) {
      throw new ChatGPTControlError(
        "The browser did not remain on a supported ChatGPT origin after navigation.",
        "selector_drift",
        false,
        undefined,
        { code: "unsafe_chatgpt_origin" }
      );
    }
  }
}

function normalizeBrowser(browser: unknown): BrowserLike | undefined {
  if (browser === undefined || browser === null || typeof browser !== "object") {
    return undefined;
  }

  return browser as BrowserLike;
}

async function hydrateTab(browser: BrowserLike, pageOrTab: unknown): Promise<PageLike> {
  const maybe = pageOrTab as Record<string, unknown>;
  if (maybe.playwright === undefined && typeof maybe.id === "string" && typeof browser.tabs?.get === "function") {
    try {
      return normalizePage(await browser.tabs.get(maybe.id));
    } catch {
      return normalizePage(pageOrTab);
    }
  }
  return normalizePage(pageOrTab);
}

function normalizePage(pageOrTab: unknown): PageLike {
  const maybe = pageOrTab as Record<string, unknown>;
  const playwright = maybe.playwright ?? maybe.page;
  if (playwright !== undefined && typeof playwright === "object") {
    return new Proxy(playwright as Record<string, unknown>, {
      get(target, prop) {
        if (prop in target) {
          const value = target[prop as keyof typeof target];
          return typeof value === "function" ? value.bind(target) : value;
        }
        const value = maybe[prop as keyof typeof maybe];
        return typeof value === "function" ? value.bind(maybe) : value;
      }
    }) as PageLike;
  }

  if (typeof maybe.url === "string") {
    return {
      ...maybe,
      url: () => maybe.url as string,
      title: async () => typeof maybe.title === "string" ? maybe.title : ""
    } as PageLike;
  }

  return pageOrTab as PageLike;
}

export function tabIdFromPage(page: PageLike): string | undefined {
  const maybe = page as Record<string, unknown>;
  const id = maybe.providerTabId ?? maybe.tabId ?? maybe.id;
  return typeof id === "string" ? id : undefined;
}
