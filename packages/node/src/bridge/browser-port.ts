import { createHash } from "node:crypto";

import {
  ATTACHMENT_NAME_SELECTOR,
  COMPOSER_FORM_SELECTOR,
  attachFiles as attachVisibleFiles,
  selectTool as selectVisibleTool,
  validateLocalFiles,
  verifyVisibleTools
} from "./browser-inputs.js";
import type { BrowserInputPage } from "./browser-inputs.js";
import {
  copyAssistantMarkdown,
  downloadHandleArtifact,
  inventoryHandleArtifacts,
  readOwnedAssistantText,
  readVisibleChatSnapshot,
  type HandleArtifact,
  type StructuralPage,
  type TextClipboard,
  type VisibleChatSnapshot
} from "./browser-output.js";
import {
  acquireChatGPTPage,
  BrowserRuntimeError,
  CHATGPT_HOME,
  CHATGPT_ORIGIN,
  exactChatGPTUrl,
  exactTabId,
  type BrowserClipboard,
  type BrowserEnv,
  type BrowserLocator,
  type BrowserPage
} from "./browser-runtime.js";
import { ChatGPTPowerTargetPort } from "./browser-targets.js";
import type { BridgeObservedArtifact } from "./output.js";
import type {
  BridgeBinding,
  BridgeObservation,
  BridgePort,
  BridgeSubmission
} from "./port.js";
import type {
  BridgeArtifact,
  BridgeHandle,
  BridgeTargetSnapshot,
  BridgeThread
} from "./types.js";

const COMPOSER_SELECTOR = "#prompt-textarea";
const SEND_SELECTOR = "button[data-testid='send-button']";
const POWER_CONTROL_SELECTOR = "[role='menuitem'][aria-label='Power']";
const POWER_OPENER_SELECTOR = "form:has(#prompt-textarea) button[aria-haspopup='menu']";
const NEW_PAGE_READY_TIMEOUT_MS = 10_000;

type BrowserCdpCapability = {
  send?: (
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<unknown>;
};

export type BrowserBridgePortOptions = {
  acknowledgementTimeoutMs?: number;
  attachmentTimeoutMs?: number;
  artifactTimeoutMs?: number;
  pollMs?: number;
};

type BoundOwner = {
  handle: BridgeHandle;
};

/**
 * Direct visible ChatGPT adapter. It owns the UI mechanics but no workflow,
 * model registry, locale layer, backend protocol, or retrying submission path.
 */
export class ChatGPTBrowserPort implements BridgePort {
  readonly #env: BrowserEnv;
  readonly #acknowledgementTimeoutMs: number;
  readonly #attachmentTimeoutMs: number;
  readonly #artifactTimeoutMs: number;
  readonly #pollMs: number;
  #acquired = false;
  #owner: BoundOwner | undefined;
  #boundUrl: string | undefined;
  #boundConversationId: string | undefined;
  #boundTabId: string | undefined;
  #artifactSources = new Map<string, HandleArtifact>();
  #powerTargets: ChatGPTPowerTargetPort | undefined;
  #selectedPower: string | undefined;
  #selectedTools = new Set<string>();
  #attachedFileNames: string[] = [];
  #pristinePreflightTabId: string | undefined;

  constructor(env: BrowserEnv, options: BrowserBridgePortOptions = {}) {
    this.#env = env;
    this.#acknowledgementTimeoutMs = positive(options.acknowledgementTimeoutMs, 5_000);
    this.#attachmentTimeoutMs = positive(options.attachmentTimeoutMs, 30_000);
    this.#artifactTimeoutMs = positive(options.artifactTimeoutMs, 120_000);
    this.#pollMs = positive(options.pollMs, 100);
  }

  async preflightFiles(paths: readonly string[]): Promise<void> {
    await validateLocalFiles(paths);
  }

  async bindThread(thread: BridgeThread): Promise<BridgeBinding> {
    const preflightTabId = thread === "new" ? this.#pristinePreflightTabId : undefined;
    const preflightPowerTargets = preflightTabId === undefined ? undefined : this.#powerTargets;
    this.#pristinePreflightTabId = undefined;
    this.#resetBinding();
    let acquired = preflightTabId === undefined
      ? undefined
      : await this.#reclaimPristinePreflight(preflightTabId);
    if (acquired !== undefined && preflightPowerTargets !== undefined) {
      this.#powerTargets = preflightPowerTargets;
    }
    if (preflightTabId !== undefined && acquired === undefined && this.#env.browser === undefined) {
      throw new Error("The inspected ChatGPT tab is no longer a zero-turn home page and no fresh tab can be created.");
    }
    acquired ??= await acquireChatGPTPage(this.#env, {
      createIfMissing: true,
      fresh: thread === "new"
    });
    this.#acquired = true;
    const page = acquired.page;

    if (thread === "new") {
      const current = await exactChatLocation(page);
      if (current.url !== CHATGPT_HOME) {
        await navigate(page, CHATGPT_HOME);
      }
      const after = await exactChatLocation(page);
      if (after.url !== CHATGPT_HOME) {
        throw new Error(`New Chat binding was not verified at ${CHATGPT_HOME}.`);
      }
      const readiness = await waitForPristineNewPage(
        page,
        NEW_PAGE_READY_TIMEOUT_MS,
        this.#pollMs
      );
      if (!readiness.ready) {
        throw new Error(`New Chat binding is not ready: ${readiness.reason}`);
      }
    } else if (thread !== "current") {
      const target = exactThreadTarget(thread);
      const current = await exactChatLocation(page);
      if (current.conversationId !== target.conversationId) {
        await navigate(page, target.url);
      }
      const after = await exactChatLocation(page);
      if (after.conversationId !== target.conversationId) {
        throw new Error(
          `ChatGPT did not bind conversation ${JSON.stringify(target.conversationId)}.`
        );
      }
    }

    const binding = await this.#binding(page, thread !== "new");
    this.#boundUrl = binding.threadUrl;
    this.#boundConversationId = binding.conversationId;
    this.#boundTabId = binding.tabId;
    return binding;
  }

  async bindHandle(handle: BridgeHandle): Promise<BridgeBinding> {
    validateHandle(handle);
    this.#pristinePreflightTabId = undefined;
    this.#owner = undefined;
    this.#powerTargets = undefined;
    this.#artifactSources.clear();
    this.#selectedTools.clear();
    const target = handleTarget(handle);
    let acquired;
    try {
      acquired = await acquireChatGPTPage(this.#env, {
        createIfMissing: false,
        ...(handle.tabId === undefined ? {} : { expectedTabId: handle.tabId })
      });
    } catch (error) {
      if (!(error instanceof BrowserRuntimeError)
        || error.code !== "tab_id_unavailable"
        || target === "current") {
        throw error;
      }
      acquired = await acquireChatGPTPage(this.#env, {
        createIfMissing: true,
        fresh: true
      });
    }
    this.#acquired = true;
    const page = acquired.page;
    let navigated = false;
    if (target !== "current") {
      const exact = exactThreadTarget(target);
      const current = await exactChatLocation(page);
      if (current.conversationId !== exact.conversationId) {
        await navigate(page, exact.url);
        navigated = true;
      }
    }

    const location = await exactChatLocation(page);
    const binding: BridgeBinding = {
      tabId: exactTabId(page),
      threadUrl: location.url,
      userTurnCount: handle.userTurnBefore!,
      assistantTurnCount: handle.assistantTurnBefore!,
      ...(location.conversationId === undefined ? {} : { conversationId: location.conversationId })
    };
    if (binding.conversationId === undefined) {
      throw new Error("A submitted bridge handle requires an exact ChatGPT conversation.");
    }
    if (handle.conversationId !== undefined
      && binding.conversationId !== handle.conversationId) {
      throw new Error("Bridge handle conversation does not match the visible thread.");
    }
    if (navigated) {
      await waitForHandleUserTurn(page, handle, NEW_PAGE_READY_TIMEOUT_MS, this.#pollMs);
    }

    this.#boundConversationId = binding.conversationId;
    this.#boundUrl = binding.threadUrl;
    this.#boundTabId = binding.tabId;
    this.#owner = { handle: { ...handle } };
    return binding;
  }

  async inspectTargets(): Promise<BridgeTargetSnapshot> {
    const preflight = this.#boundTabId === undefined && this.#owner === undefined;
    const page = preflight ? await this.#pristinePreflightPage() : await this.#page();
    try {
      await openPowerMenu(page);
      this.#powerTargets ??= new ChatGPTPowerTargetPort(page);
      return await this.#powerTargets.inspectTargets();
    } finally {
      try {
        await closePowerMenu(page);
      } finally {
        if (preflight) {
          const readiness = await waitForPristineNewPage(
            page,
            NEW_PAGE_READY_TIMEOUT_MS,
            this.#pollMs
          );
          this.#pristinePreflightTabId = readiness.ready ? exactTabId(page) : undefined;
        }
      }
    }
  }

  async selectTarget(axis: string, label: string): Promise<void> {
    const page = await this.#page();
    await openPowerMenu(page);
    try {
      this.#powerTargets ??= new ChatGPTPowerTargetPort(page);
      await this.#powerTargets.selectTarget(axis, label);
    } finally {
      await closePowerMenu(page);
    }
    if (await readComposerPowerLabel(page) !== label) {
      throw new Error(`Chat target ${JSON.stringify(label)} lacks an exact composer echo.`);
    }
    this.#selectedPower = label;
    await this.#assertBoundLocation();
  }

  async selectTool(label: string): Promise<void> {
    const page = await this.#page();
    if (this.#selectedTools.has(label)) {
      await verifyVisibleTools(page as BrowserInputPage, [...this.#selectedTools]);
      return;
    }
    await selectVisibleTool(page as BrowserInputPage, label);
    this.#selectedTools.add(label);
    if (this.#selectedTools.size > 1) {
      await verifyVisibleTools(page as BrowserInputPage, [...this.#selectedTools]);
    }
    await this.#assertBoundLocation();
  }

  async attachFiles(paths: readonly string[]): Promise<void> {
    const page = await this.#page();
    const files = await attachVisibleFiles(page as BrowserInputPage, paths, {
      timeoutMs: this.#attachmentTimeoutMs,
      pollMs: this.#pollMs
    });
    this.#attachedFileNames.push(...files.map(file => file.name));
    await this.#assertBoundLocation();
  }

  async composePrompt(prompt: string): Promise<void> {
    requirePrompt(prompt);
    const page = await this.#page();
    const form = await uniqueVisible(page, COMPOSER_FORM_SELECTOR, "ChatGPT composer form");
    if (form.evaluate === undefined) {
      throw new Error("ChatGPT composer attachment state cannot be read.");
    }
    const staged = await form.evaluate(element => ({
      attachmentNames: Array.from(element.querySelectorAll(".truncate.font-semibold"))
        .map(name => (name.textContent ?? "").trim())
        .filter(Boolean),
      toolLabels: Array.from(element.querySelectorAll(
        "[data-inline-selection-pill][data-keyword]"
      )).map(pill => pill.getAttribute("data-keyword") ?? "").filter(Boolean)
    }));
    const stagedAttachmentNames = staged.attachmentNames;
    if (stagedAttachmentNames.length !== this.#attachedFileNames.length
      || stagedAttachmentNames.some((name, index) => name !== this.#attachedFileNames[index])) {
      throw new Error("ChatGPT composer contains an unrequested staged attachment.");
    }
    const stagedToolLabels = [...new Set(staged.toolLabels)].sort();
    const selectedToolLabels = [...this.#selectedTools].sort();
    if (stagedToolLabels.length !== selectedToolLabels.length
      || stagedToolLabels.some((label, index) => label !== selectedToolLabels[index])) {
      throw new Error("ChatGPT composer contains an unrequested active tool.");
    }
    const composer = await uniqueVisible(page, COMPOSER_SELECTOR, "ChatGPT composer");
    if (composer.fill === undefined || composer.evaluate === undefined) {
      throw new Error("ChatGPT composer lacks exact fill and readback operations.");
    }
    const existing = await readEditableText(composer);
    if (existing !== "" && existing !== prompt) {
      throw new Error("ChatGPT composer contains a different draft; it was not overwritten.");
    }
    if (existing !== prompt) await composer.fill(prompt);
    if (await readEditableText(composer) !== prompt) {
      throw new Error("ChatGPT composer readback did not exactly match the prompt.");
    }
    if (this.#selectedTools.size > 0) {
      await verifyVisibleTools(page as BrowserInputPage, [...this.#selectedTools]);
    }
    await this.#assertBoundLocation();
  }

  async submissionPresentationSha256s(prompt: string): Promise<readonly string[]> {
    requirePrompt(prompt);
    const page = await this.#page();
    const expectedUrl = this.#boundUrl;
    if (expectedUrl === undefined) throw new Error("Submission requires an exact bound ChatGPT route.");
    await verifyComposerEnvelope(page, {
      url: expectedUrl,
      prompt,
      attachmentNames: this.#attachedFileNames,
      toolLabels: [...this.#selectedTools],
      ...(this.#selectedPower === undefined ? {} : { power: this.#selectedPower })
    });
    return promptPresentationSha256s(prompt);
  }

  async submitPrompt(input: {
    prompt: string;
    promptSha256: string;
    userTurnBefore: number;
    assistantTurnBefore: number;
    lastUserTurnId?: string;
    lastAssistantTurnId?: string;
    power?: string;
  }): Promise<BridgeSubmission> {
    requirePrompt(input.prompt);
    if (sha256(input.prompt) !== input.promptSha256) {
      throw new Error("Submission prompt hash does not match the exact prompt.");
    }
    if (!isCount(input.userTurnBefore)) {
      throw new Error("Submission requires a user-turn baseline.");
    }
    if (!isCount(input.assistantTurnBefore)) {
      throw new Error("Submission requires an assistant-turn baseline.");
    }

    const page = await this.#page();
    await this.#assertBoundLocation();
    const expectedUrl = this.#boundUrl;
    if (expectedUrl === undefined) throw new Error("Submission requires an exact bound ChatGPT route.");

    // One irreversible action. Errors are reconciled by reads; never by another activation.
    try {
      await activateSend(page, {
        url: expectedUrl,
        prompt: input.prompt,
        attachmentNames: this.#attachedFileNames,
        toolLabels: [...this.#selectedTools],
        ...(input.power === undefined ? {} : { power: input.power }),
        userTurnBefore: input.userTurnBefore,
        assistantTurnBefore: input.assistantTurnBefore,
        ...(input.lastUserTurnId === undefined ? {} : { lastUserTurnId: input.lastUserTurnId }),
        ...(input.lastAssistantTurnId === undefined
          ? {}
          : { lastAssistantTurnId: input.lastAssistantTurnId })
      });
    } catch {
      // The browser can deliver the click and then report a transport error.
    }

    const deadline = Date.now() + this.#acknowledgementTimeoutMs;
    while (Date.now() < deadline) {
      const snapshot = await readVisibleChatSnapshot(structural(page), {
        userIndex: input.userTurnBefore
      }).catch(() => undefined);
      if (snapshot !== undefined) {
        if (snapshot.userCount > input.userTurnBefore + 1) {
          return this.#submissionReceipt(page, false);
        }
        if (snapshot.userCount === input.userTurnBefore + 1) {
          const location = await exactChatLocation(page).catch(() => undefined);
          const conversationMatches = location?.conversationId !== undefined
            && (this.#boundConversationId === undefined
              || location.conversationId === this.#boundConversationId);
          const rendered = snapshot.userText;
          if (conversationMatches
            && rendered !== undefined
            && renderedPromptMatches(input.prompt, rendered)) {
            return this.#submissionReceipt(
              page,
              true,
              sha256(rendered),
              snapshot.userTurnId ?? undefined
            );
          }
        }
      }
      await pause(page, this.#pollMs);
    }
    return this.#submissionReceipt(page, false);
  }

  async observe(handle: BridgeHandle): Promise<BridgeObservation> {
    if (this.#owner?.handle.operationId !== handle.operationId) {
      throw new Error("Observation requires the exact bound bridge handle.");
    }
    const owned = await this.#ownedSnapshot(handle);
    if (!owned.promptOwned) {
      return {
        phase: "uncertain",
        responseOwned: false,
        uncertainty: owned.reason ?? "Submitted prompt ownership could not be verified."
      };
    }
    if (!owned.assistantOwned && owned.assistantDelta > 0) {
      return {
        phase: "uncertain",
        responseOwned: false,
        uncertainty: owned.reason ?? "Owned assistant turn identity could not be verified."
      };
    }
    const identities = {
      ...(owned.snapshot.userTurnId === null || owned.snapshot.userTurnId === undefined
        ? {}
        : { userTurnId: owned.snapshot.userTurnId }),
      ...(!owned.assistantOwned
        || owned.snapshot.assistantTurnId === null
        || owned.snapshot.assistantTurnId === undefined
        ? {}
        : { assistantTurnId: owned.snapshot.assistantTurnId })
    };
    if (owned.snapshot.generation.state === "generating") {
      return { phase: "generating", responseOwned: owned.assistantOwned, ...identities };
    }
    if (owned.assistantDelta === 0) {
      return { phase: "submitted", responseOwned: false, ...identities };
    }
    return owned.snapshot.generation.state === "completed"
      ? { phase: "completed", responseOwned: true, ...identities }
      : {
          phase: "generating",
          responseOwned: true,
          ...identities,
          uncertainty: "Owned response exists but completion controls are not visible yet."
        };
  }

  async copyResponseMarkdown(): Promise<string | undefined> {
    const owned = await this.#ownedResponse();
    const target = copyTarget(owned.handle, owned.snapshot);
    const copied = await copyAssistantMarkdown(
      structural(owned.page),
      this.#clipboard(owned.page),
      target
    );
    return copied.status === "copied" ? copied.markdown : undefined;
  }

  async readResponseSnapshot(): Promise<{ text?: string; partial?: boolean }> {
    const owned = await this.#ownedResponse({ includeAssistantText: true });
    const text = readOwnedAssistantText(owned.snapshot, copyTarget(owned.handle, owned.snapshot));
    if (text === undefined) throw new Error("Owned assistant response text is unavailable.");
    return {
      text,
      partial: owned.snapshot.generation.state !== "completed"
    };
  }

  async listArtifacts(): Promise<readonly BridgeObservedArtifact[]> {
    if (this.#owner === undefined) return [];
    const owned = await this.#ownedResponse({ includeArtifacts: true });
    const artifacts = inventoryHandleArtifacts(owned.snapshot, {
      operationId: owned.handle.operationId,
      ...(owned.handle.conversationId === undefined
        ? {}
        : { conversationId: owned.handle.conversationId }),
      assistantTurnBefore: owned.handle.assistantTurnBefore!
    });
    this.#artifactSources.clear();
    for (const artifact of artifacts) this.#artifactSources.set(artifact.key, artifact);
    return artifacts.map(artifact => ({
      key: artifact.key,
      kind: artifact.kind,
      ...(artifact.name === undefined ? {} : { name: artifact.name })
    }));
  }

  async downloadArtifact(
    artifact: BridgeObservedArtifact,
    downloadDir: string
  ): Promise<BridgeArtifact> {
    const owned = await this.#ownedResponse();
    const source = this.#artifactSources.get(artifact.key);
    if (source === undefined || source.kind !== artifact.kind) {
      throw new Error("Artifact is not part of the latest handle-owned inventory.");
    }
    const downloaded = await downloadHandleArtifact(
      structural(owned.page),
      source,
      downloadDir,
      this.#artifactTimeoutMs
    );
    await this.#assertBoundLocation();
    return {
      kind: source.kind,
      name: downloaded.name,
      path: downloaded.path,
      bytes: downloaded.bytes,
      ...(downloaded.sha256 === undefined ? {} : { sha256: downloaded.sha256 })
    };
  }

  async #page(): Promise<BrowserPage> {
    if (!this.#acquired || this.#env.page === undefined) {
      const acquired = await acquireChatGPTPage(this.#env, { createIfMissing: true });
      this.#acquired = true;
      return acquired.page;
    }
    await exactChatLocation(this.#env.page);
    return this.#env.page;
  }

  async #freshPristinePreflight(): Promise<BrowserPage> {
    this.#pristinePreflightTabId = undefined;
    this.#powerTargets = undefined;
    this.#selectedPower = undefined;
    const acquired = await acquireChatGPTPage(this.#env, {
      createIfMissing: true,
      fresh: true
    });
    this.#acquired = true;
    const readiness = await waitForPristineNewPage(
      acquired.page,
      NEW_PAGE_READY_TIMEOUT_MS,
      this.#pollMs
    );
    if (!readiness.ready) {
      throw new Error(`Target inspection page is not ready: ${readiness.reason}`);
    }
    this.#pristinePreflightTabId = exactTabId(acquired.page);
    return acquired.page;
  }

  async #pristinePreflightPage(): Promise<BrowserPage> {
    if (this.#pristinePreflightTabId !== undefined) {
      const reclaimed = await this.#reclaimPristinePreflight(this.#pristinePreflightTabId);
      if (reclaimed !== undefined) return reclaimed.page;
      if (this.#env.browser === undefined) {
        throw new Error("The inspected ChatGPT tab is no longer a zero-turn home page and no fresh tab can be created.");
      }
    }
    return this.#freshPristinePreflight();
  }

  async #reclaimPristinePreflight(
    tabId: string
  ): Promise<Awaited<ReturnType<typeof acquireChatGPTPage>> | undefined> {
    try {
      const acquired = await acquireChatGPTPage(this.#env, {
        createIfMissing: false,
        expectedTabId: tabId
      });
      const readiness = await waitForPristineNewPage(
        acquired.page,
        NEW_PAGE_READY_TIMEOUT_MS,
        this.#pollMs
      );
      return readiness.ready ? acquired : undefined;
    } catch {
      return undefined;
    }
  }

  async #binding(page: BrowserPage, requireStable = false): Promise<BridgeBinding> {
    const { location, snapshot } = requireStable
      ? await waitForStableThread(page, NEW_PAGE_READY_TIMEOUT_MS, this.#pollMs)
      : {
          location: await exactChatLocation(page),
          snapshot: await readVisibleChatSnapshot(structural(page))
        };
    return {
      tabId: exactTabId(page),
      threadUrl: location.url,
      userTurnCount: snapshot.userCount,
      assistantTurnCount: snapshot.assistantCount,
      ...(snapshot.userTurnId == null ? {} : { lastUserTurnId: snapshot.userTurnId }),
      ...(snapshot.assistantTurnId == null
        ? {}
        : { lastAssistantTurnId: snapshot.assistantTurnId }),
      ...(location.conversationId === undefined ? {} : { conversationId: location.conversationId })
    };
  }

  async #submissionReceipt(
    page: BrowserPage,
    confirmed: boolean,
    renderedPromptSha256?: string,
    userTurnId?: string
  ): Promise<BridgeSubmission> {
    const location = await exactChatLocation(page).catch(() => undefined);
    const tabId = exactTabId(page);
    if (confirmed && location?.conversationId !== undefined) {
      this.#boundConversationId = location.conversationId;
      this.#boundUrl = location.url;
      this.#boundTabId = tabId;
    }
    return {
      confirmed,
      tabId,
      ...(location === undefined ? {} : { threadUrl: location.url }),
      ...(location?.conversationId === undefined ? {} : { conversationId: location.conversationId }),
      ...(renderedPromptSha256 === undefined ? {} : { renderedPromptSha256 }),
      ...(userTurnId === undefined ? {} : { userTurnId })
    };
  }

  async #assertBoundLocation(boundPage?: BrowserPage): Promise<void> {
    const page = boundPage ?? await this.#page();
    const location = await exactChatLocation(page);
    if (this.#boundConversationId !== undefined
      && location.conversationId !== this.#boundConversationId) {
      throw new Error("Controlled ChatGPT page left the handle-bound conversation.");
    }
    if (this.#boundTabId !== undefined && exactTabId(page) !== this.#boundTabId) {
      throw new Error("Controlled ChatGPT page left the handle-bound tab.");
    }
  }

  async #ownedSnapshot(
    handle: BridgeHandle,
    options: { includeAssistantText?: boolean; includeArtifacts?: boolean } = {}
  ): Promise<{
    page: BrowserPage;
    promptOwned: boolean;
    assistantOwned: boolean;
    assistantDelta: number;
    snapshot: VisibleChatSnapshot;
    reason?: string;
  }> {
    const page = await this.#page();
    await this.#assertBoundLocation(page);
    const snapshot = await readVisibleChatSnapshot(structural(page), {
      userIndex: handle.userTurnBefore!,
      assistantIndex: handle.assistantTurnBefore!,
      ...options
    });
    const expectedUsers = handle.userTurnBefore! + 1;
    const assistantDelta = snapshot.assistantCount - handle.assistantTurnBefore!;
    if (snapshot.userCount < expectedUsers) {
      return {
        promptOwned: false,
        assistantOwned: false,
        page,
        assistantDelta,
        snapshot,
        reason: "Visible user-turn count moved behind this handle's baseline."
      };
    }
    const rendered = snapshot.userText;
    const exactUserIdentity = handle.userTurnId !== undefined;
    if ((exactUserIdentity && snapshot.userTurnId !== handle.userTurnId)
      || (!exactUserIdentity && !renderedPromptOwned(
        handle,
        rendered
      ))) {
      return {
        promptOwned: false,
        assistantOwned: false,
        page,
        assistantDelta,
        snapshot,
        reason: exactUserIdentity
          ? "Visible submitted user-turn identity does not match this handle."
          : "Visible submitted prompt hash does not match this handle."
      };
    }
    if (!exactUserIdentity && snapshot.userCount > expectedUsers && snapshot.userTurnId == null) {
      return {
        promptOwned: false,
        assistantOwned: false,
        page,
        assistantDelta,
        snapshot,
        reason: "Later user turns exist and the owned user turn lacks a stable identity."
      };
    }
    if (assistantDelta < 0) {
      return {
        promptOwned: false,
        assistantOwned: false,
        page,
        assistantDelta,
        snapshot,
        reason: "Visible assistant-turn count moved behind this handle's baseline."
      };
    }
    const assistantOwned = assistantDelta > 0
      && (handle.assistantTurnId === undefined
        ? snapshot.assistantTurnId != null || assistantDelta === 1
        : snapshot.assistantTurnId === handle.assistantTurnId);
    if (!assistantOwned && assistantDelta > 0) {
      return {
        page,
        promptOwned: true,
        assistantOwned: false,
        assistantDelta,
        snapshot,
        reason: handle.assistantTurnId === undefined
          ? "Later assistant turns exist and the owned assistant turn lacks a stable identity."
          : "Visible assistant-turn identity does not match this handle."
      };
    }
    return { page, promptOwned: true, assistantOwned, assistantDelta, snapshot };
  }

  async #ownedResponse(
    options: { includeAssistantText?: boolean; includeArtifacts?: boolean } = {}
  ): Promise<{
    page: BrowserPage;
    handle: BridgeHandle;
    snapshot: VisibleChatSnapshot;
  }> {
    const owner = this.#owner;
    if (owner === undefined) {
      throw new Error("Response access requires an exact bound bridge handle.");
    }
    const owned = await this.#ownedSnapshot(owner.handle, options);
    if (!owned.promptOwned || !owned.assistantOwned) {
      throw new Error(owned.reason ?? "No uniquely owned assistant response is available.");
    }
    return { page: owned.page, handle: owner.handle, snapshot: owned.snapshot };
  }

  #clipboard(page: BrowserPage): TextClipboard {
    const configured = this.#env.clipboard;
    if (configured !== undefined) {
      return {
        readText: () => configured.read(),
        waitForChange: (before, timeoutMs) => configured.waitForChange(before, timeoutMs),
        ...(configured.snapshot === undefined
          ? {}
          : { snapshot: () => configured.snapshot!() }),
        ...(configured.restore === undefined
          ? {}
          : { restore: snapshot => configured.restore!(snapshot) }),
        ...(configured.writeText === undefined
          ? {}
          : { writeText: text => configured.writeText!(text) })
      };
    }

    const virtual = page.clipboard;
    if (virtual !== undefined
      && (virtual.readText !== undefined || virtual.read !== undefined)) {
      return {
        readText: () => readBrowserClipboardText(virtual),
        waitForChange: (before, timeoutMs) =>
          waitForBrowserClipboardChange(page, virtual, before, timeoutMs),
        ...(virtual.read === undefined || virtual.write === undefined
          ? {}
          : {
              snapshot: () => Promise.resolve(virtual.read!()),
              restore: snapshot => Promise.resolve(virtual.write!(snapshot))
            }),
        ...(virtual.writeText === undefined
          ? {}
          : { writeText: text => Promise.resolve(virtual.writeText!(text)) })
      };
    }

    return {
      readText: async () => undefined
    };
  }

  #resetBinding(): void {
    this.#owner = undefined;
    this.#powerTargets = undefined;
    this.#artifactSources.clear();
    this.#selectedTools.clear();
    this.#attachedFileNames = [];
    this.#boundUrl = undefined;
    this.#boundConversationId = undefined;
    this.#boundTabId = undefined;
  }
}

export function createBrowserBridgePort(
  env: BrowserEnv,
  options: BrowserBridgePortOptions = {}
): BridgePort {
  return new ChatGPTBrowserPort(env, options);
}

function structural(page: BrowserPage): StructuralPage {
  if (page.evaluate === undefined) {
    throw new Error("Visible ChatGPT ownership requires page.evaluate().");
  }
  return page as StructuralPage;
}

function copyTarget(handle: BridgeHandle, snapshot: VisibleChatSnapshot): {
  assistantIndex: number;
  assistantTurnId?: string;
} {
  const assistantIndex = handle.assistantTurnBefore!;
  const turnId = handle.assistantTurnId ?? snapshot.assistantTurnId;
  return {
    assistantIndex,
    ...(turnId === null || turnId === undefined ? {} : { assistantTurnId: turnId })
  };
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function requirePrompt(prompt: string): void {
  if (prompt.trim().length === 0) throw new Error("Prompt must be nonempty.");
}

export function renderedPromptMatches(
  composed: string,
  rendered: string
): boolean {
  const allowed = new Set(promptPresentationSha256s(composed));
  return renderedPresentationSha256s(rendered)
    .some(hash => allowed.has(hash));
}

/** Exact, bounded, hash-only evidence for the presentations this adapter accepts. */
export function promptPresentationSha256s(
  composed: string
): string[] {
  const hashes = new Set<string>([presentationHash("exact", comparablePrompt(composed))]);
  const prompt = flattenedPrompt(composed);
  if (hasVisibleLineBreak(composed)) hashes.add(presentationHash("flat", prompt));
  hashes.add(presentationHash("show-more", prompt));
  return [...hashes];
}

function renderedPresentationSha256s(rendered: string): string[] {
  const hashes = [
    presentationHash("exact", comparablePrompt(rendered)),
    presentationHash("flat", flattenedPrompt(rendered))
  ];
  const showMoreContent = promptOnlyShowMoreContent(rendered);
  if (showMoreContent !== undefined) {
    hashes.push(presentationHash("show-more", flattenedPrompt(showMoreContent)));
  }
  return hashes;
}

function renderedPromptOwned(
  handle: BridgeHandle,
  rendered: string | undefined
): boolean {
  if (rendered === undefined) return false;
  if (handle.renderedPromptSha256 !== undefined) {
    return sha256(rendered) === handle.renderedPromptSha256;
  }
  if (handle.promptPresentationSha256s !== undefined) {
    const expected = new Set(handle.promptPresentationSha256s);
    return renderedPresentationSha256s(rendered).some(hash => expected.has(hash));
  }
  return sha256(rendered) === handle.promptSha256;
}

function comparablePrompt(value: string): string {
  return value
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .trimEnd();
}

function flattenedPrompt(value: string): string {
  return comparablePrompt(value).trim().replace(/\s+/g, " ");
}

function promptOnlyShowMoreContent(rendered: string): string | undefined {
  const match = /^(.*\S)(?: *\n)+ *Show more$/s.exec(comparablePrompt(rendered));
  return match?.[1]?.trimEnd();
}

function hasVisibleLineBreak(value: string): boolean {
  return /[\r\n\u2028\u2029]/.test(value);
}

function presentationHash(
  kind: "exact" | "flat" | "show-more",
  value: string
): string {
  return sha256(`${kind}\0${value}`);
}

function isCount(value: number | undefined): value is number {
  return Number.isInteger(value) && (value ?? -1) >= 0;
}

function validateHandle(handle: BridgeHandle): void {
  if (!isCount(handle.userTurnBefore) || !isCount(handle.assistantTurnBefore)) {
    throw new Error("Bridge handle requires user and assistant turn baselines.");
  }
  if (!/^[a-f0-9]{64}$/i.test(handle.promptSha256)
    || (handle.attachmentCount !== undefined
      && (!Number.isInteger(handle.attachmentCount) || handle.attachmentCount < 1))
    || (handle.promptPresentationSha256s !== undefined
      && (handle.promptPresentationSha256s.length < 1
        || handle.promptPresentationSha256s.length > 4
        || new Set(handle.promptPresentationSha256s).size !== handle.promptPresentationSha256s.length
        || !handle.promptPresentationSha256s.every(hash => /^[a-f0-9]{64}$/i.test(hash))))
    || (handle.renderedPromptSha256 !== undefined
      && !/^[a-f0-9]{64}$/i.test(handle.renderedPromptSha256))) {
    throw new Error("Bridge handle prompt hash is invalid.");
  }
}

function handleTarget(handle: BridgeHandle): Exclude<BridgeThread, "new"> {
  if (handle.threadUrl !== undefined && handle.conversationId !== undefined) {
    const parsed = exactThreadTarget({ url: handle.threadUrl });
    if (parsed.conversationId !== handle.conversationId) {
      throw new Error("Bridge handle URL and conversation refer to different threads.");
    }
  }
  if (handle.threadUrl !== undefined) {
    const parsed = exactChatGPTUrl(handle.threadUrl);
    if (conversationId(parsed) !== undefined) return { url: handle.threadUrl };
    if (parsed.pathname === "/" && parsed.search === "" && parsed.hash === "") return "current";
    throw new Error("Bridge handle URL is not ChatGPT home or an exact conversation.");
  }
  if (handle.conversationId !== undefined) return { conversationId: handle.conversationId };
  return "current";
}

function exactThreadTarget(thread: Exclude<BridgeThread, "new" | "current">): {
  url: string;
  conversationId: string;
} {
  if ("conversationId" in thread) {
    validateConversationId(thread.conversationId);
    return {
      url: `${CHATGPT_ORIGIN}/c/${encodeURIComponent(thread.conversationId)}`,
      conversationId: thread.conversationId
    };
  }
  const parsed = exactChatGPTUrl(thread.url);
  const id = conversationId(parsed);
  if (id === undefined || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Exact thread URLs must use https://chatgpt.com/c/<conversationId>.");
  }
  return { url: parsed.toString(), conversationId: id };
}

function conversationId(url: URL): string | undefined {
  const match = /^\/c\/([^/]+)\/?$/.exec(url.pathname);
  if (match?.[1] === undefined) return undefined;
  const id = decodeURIComponent(match[1]);
  validateConversationId(id);
  return id;
}

function validateConversationId(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Conversation ID contains unsupported characters.");
  }
}

type NewPageReadiness =
  | { ready: true }
  | { ready: false; retry: boolean; reason: string };
type NewPageWaitResult = { ready: true } | { ready: false; reason: string };

async function waitForPristineNewPage(
  page: BrowserPage,
  timeoutMs: number,
  pollMs: number
): Promise<NewPageWaitResult> {
  const deadline = Date.now() + timeoutMs;
  let state = await readNewPageReadiness(page);
  while (!state.ready && state.retry && Date.now() < deadline) {
    await pause(page, Math.min(pollMs, Math.max(1, deadline - Date.now())));
    state = await readNewPageReadiness(page);
  }
  return state.ready
    ? state
      : { ready: false, reason: state.reason };
}

async function waitForStableThread(
  page: BrowserPage,
  timeoutMs: number,
  pollMs: number
): Promise<{
  location: Awaited<ReturnType<typeof exactChatLocation>>;
  snapshot: VisibleChatSnapshot;
}> {
  const deadline = Date.now() + timeoutMs;
  let previousKey: string | undefined;
  let stableObservations = 0;
  while (Date.now() < deadline) {
    const state = await readStableThreadState(page).catch(() => undefined);
    if (state !== undefined) {
      const key = JSON.stringify([
        state.location.url,
        state.snapshot.userCount,
        state.snapshot.assistantCount,
        state.snapshot.userTurnId ?? null,
        state.snapshot.assistantTurnId ?? null
      ]);
      if (key === previousKey) {
        stableObservations += 1;
      } else {
        previousKey = key;
        stableObservations = 1;
      }
      if (stableObservations >= 3) return state;
    } else {
      previousKey = undefined;
      stableObservations = 0;
    }
    await pause(page, Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error("ChatGPT thread did not expose a stable non-generating turn baseline before timeout.");
}

async function readStableThreadState(page: BrowserPage): Promise<{
  location: Awaited<ReturnType<typeof exactChatLocation>>;
  snapshot: VisibleChatSnapshot;
} | undefined> {
  const location = await exactChatLocation(page);
  if (!await hasVisibleMain(page)) return undefined;
  const composer = page.locator?.(COMPOSER_SELECTOR);
  if (composer?.count === undefined
    || await composer.count() !== 1
    || (composer.isVisible !== undefined && !await composer.isVisible())) return undefined;

  const counts = await readVisibleChatSnapshot(structural(page));
  if (counts.generation.state === "generating") return undefined;
  if (location.conversationId !== undefined && counts.userCount === 0) return undefined;
  if (location.conversationId !== undefined
    && counts.assistantCount < counts.userCount) return undefined;
  const snapshot = await readVisibleChatSnapshot(structural(page), {
    ...(counts.userCount === 0 ? {} : { userIndex: counts.userCount - 1 }),
    ...(counts.assistantCount === 0 ? {} : { assistantIndex: counts.assistantCount - 1 })
  });
  return snapshot.userCount === counts.userCount && snapshot.assistantCount === counts.assistantCount
    ? { location, snapshot }
    : undefined;
}

async function readNewPageReadiness(page: BrowserPage): Promise<NewPageReadiness> {
  try {
    const location = await exactChatLocation(page);
    if (location.url !== CHATGPT_HOME) {
      return { ready: false, retry: false, reason: "page is not exact ChatGPT home" };
    }
    if (!await hasVisibleMain(page)) {
      return { ready: false, retry: true, reason: "visible ChatGPT main is not ready" };
    }
    const snapshot = await readVisibleChatSnapshot(structural(page));
    if (snapshot.userCount !== 0 || snapshot.assistantCount !== 0) {
      return { ready: false, retry: false, reason: "visible conversation turns are present" };
    }
    const found = page.locator?.(COMPOSER_SELECTOR);
    const composer = found?.filter?.({ visible: true }) ?? found;
    if (composer?.count === undefined || composer.evaluate === undefined) {
      return { ready: false, retry: false, reason: "composer cannot be verified" };
    }
    if (await composer.count() !== 1
      || (composer.isVisible !== undefined && !await composer.isVisible())) {
      return { ready: false, retry: true, reason: "one visible composer is not ready" };
    }
    if (await readEditableText(composer) !== "") {
      return { ready: false, retry: false, reason: "composer contains a draft" };
    }
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      retry: true,
      reason: error instanceof Error ? error.message : "page readiness could not be read"
    };
  }
}

async function hasVisibleMain(page: BrowserPage): Promise<boolean> {
  const main = page.locator?.("main");
  if (main?.count === undefined) return false;
  const count = await main.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = count === 1 ? main : main.nth?.(index);
    if (candidate !== undefined
      && (candidate.isVisible === undefined || await candidate.isVisible())) return true;
  }
  return false;
}

async function exactChatLocation(page: BrowserPage): Promise<{
  url: string;
  conversationId?: string;
}> {
  const raw = await page.url?.();
  if (typeof raw !== "string") throw new Error("Controlled page URL cannot be verified.");
  const parsed = exactChatGPTUrl(raw);
  const id = conversationId(parsed);
  if ((parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") && id === undefined) {
    throw new Error("Bridge supports only ChatGPT home and exact conversation routes.");
  }
  return { url: parsed.toString(), ...(id === undefined ? {} : { conversationId: id }) };
}

async function navigate(page: BrowserPage, url: string): Promise<void> {
  if (page.goto === undefined) throw new Error("Controlled page cannot navigate.");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
}

async function waitForHandleUserTurn(
  page: BrowserPage,
  handle: BridgeHandle,
  timeoutMs: number,
  pollMs: number
): Promise<void> {
  const expected = handle.userTurnBefore! + 1;
  const deadline = Date.now() + timeoutMs;
  do {
    const snapshot = await readVisibleChatSnapshot(structural(page)).catch(() => undefined);
    if (snapshot !== undefined && snapshot.userCount >= expected) return;
    await pause(page, Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error("Submitted ChatGPT conversation did not hydrate its owned user turn.");
}

async function openPowerMenu(page: BrowserPage): Promise<void> {
  const opener = await uniqueVisible(page, POWER_OPENER_SELECTOR, "ChatGPT Power opener");
  if (await powerMenuExpanded(opener)
    && await visibleCount(page.locator?.(POWER_CONTROL_SELECTOR)) === 1) return;
  let clickError: unknown;
  try {
    await activateExactPointerControl(page, opener, "ChatGPT Power opener");
  } catch (error) {
    clickError = error;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await powerMenuExpanded(opener)
      && await visibleCount(page.locator?.(POWER_CONTROL_SELECTOR)) === 1) return;
    await pause(page, 50);
  }
  if (clickError !== undefined) throw clickError;
  throw new Error("Power menu did not become expanded with one visible control.");
}

async function closePowerMenu(page: BrowserPage): Promise<void> {
  const opener = await uniqueVisible(page, POWER_OPENER_SELECTOR, "ChatGPT Power opener");
  if (!await powerMenuExpanded(opener)) return;
  let closeError: unknown;
  try {
    await activateExactPointerControl(page, opener, "ChatGPT Power opener");
  } catch (error) {
    closeError = error;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!await powerMenuExpanded(opener)) return;
    await pause(page, 50);
  }
  if (closeError !== undefined) throw closeError;
  throw new Error("Power menu remained expanded after toggling its exact composer control.");
}

async function activateExactPointerControl(
  page: BrowserPage,
  control: BrowserLocator,
  label: string
): Promise<void> {
  const rawCdp = await page.capabilities?.get?.("cdp");
  const cdp = rawCdp as BrowserCdpCapability | undefined;
  if (cdp?.send !== undefined) {
    await bringPageToFront(cdp);
    if (control.evaluate === undefined) {
      throw new Error(`${label} position cannot be read.`);
    }
    const rect = await control.evaluate(element => {
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    });
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`${label} has no usable visible position.`);
    }
    const point = {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2
    };
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", ...point, button: "none", buttons: 0 },
      { timeoutMs: 10_000 }
    );
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 },
      { timeoutMs: 10_000 }
    );
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 },
      { timeoutMs: 10_000 }
    );
    return;
  }
  if (control.click === undefined) throw new Error(`${label} is not clickable.`);
  await control.click();
}

type ComposerEnvelopeExpectation = {
  url: string;
  prompt: string;
  attachmentNames: readonly string[];
  toolLabels: readonly string[];
  power?: string;
};

type AtomicSendExpectation = ComposerEnvelopeExpectation & {
  userTurnBefore: number;
  assistantTurnBefore: number;
  lastUserTurnId?: string;
  lastAssistantTurnId?: string;
};

async function activateSend(page: BrowserPage, expected: AtomicSendExpectation): Promise<void> {
  await evaluateComposerEnvelope(page, { ...expected, activate: true });
}

async function verifyComposerEnvelope(
  page: BrowserPage,
  expected: ComposerEnvelopeExpectation
): Promise<void> {
  await evaluateComposerEnvelope(page, { ...expected, activate: false });
}

async function evaluateComposerEnvelope(
  page: BrowserPage,
  expected: ComposerEnvelopeExpectation & {
    activate: boolean;
    userTurnBefore?: number;
    assistantTurnBefore?: number;
    lastUserTurnId?: string;
    lastAssistantTurnId?: string;
  }
): Promise<void> {
  const rawCdp = await page.capabilities?.get?.("cdp");
  const cdp = rawCdp as BrowserCdpCapability | undefined;
  if (cdp?.send === undefined) {
    throw new Error("Exact ChatGPT composer ownership requires the bound tab's CDP capability.");
  }
  const result = await cdp.send("Runtime.evaluate", {
    expression: composerEnvelopeExpression(expected),
    userGesture: true,
    awaitPromise: true,
    returnByValue: true
  }, { timeoutMs: 10_000 });
  if (!cdpBooleanResult(result)) {
    throw new Error(expected.activate
      ? "ChatGPT Send activation lacked its exact atomic postcondition."
      : "ChatGPT composer envelope did not match the exact request.");
  }
}

function composerEnvelopeExpression(
  expected: ComposerEnvelopeExpectation & {
    activate: boolean;
    userTurnBefore?: number;
    assistantTurnBefore?: number;
    lastUserTurnId?: string;
    lastAssistantTurnId?: string;
  }
): string {
  return `(() => {
  const expected = ${JSON.stringify(expected)};
  if (location.origin !== ${JSON.stringify(CHATGPT_ORIGIN)} || location.href !== expected.url) {
    throw new Error("Controlled ChatGPT route changed before Send.");
  }
  const visible = element => {
    if (element.closest("[hidden], [aria-hidden='true']") !== null) return false;
    const style = getComputedStyle(element);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0"
      && element.getClientRects().length > 0;
  };
  const normalizedLabel = element => {
    const value = element.getAttribute("aria-label")
      || element.innerText
      || element.textContent
      || "";
    return value.replace(/\\s+/g, " ").trim();
  };
  const sameOrdered = (left, right) => {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  };
  const sameMultiset = (left, right) => {
    if (left.length !== right.length) return false;
    const orderedLeft = [...left].sort();
    const orderedRight = [...right].sort();
    return orderedLeft.every((value, index) => value === orderedRight[index]);
  };

  const composers = Array.from(document.querySelectorAll(${JSON.stringify(COMPOSER_FORM_SELECTOR)}))
    .filter(visible);
  if (composers.length !== 1) throw new Error("Chat composer is not unique.");
  const form = composers[0];
  const editors = Array.from(form.querySelectorAll(${JSON.stringify(COMPOSER_SELECTOR)})).filter(visible);
  if (editors.length !== 1) throw new Error("Chat prompt editor is not unique.");
  const editor = editors[0];
  const tag = editor.tagName.toLowerCase();
  const promptEditor = editor.cloneNode(true);
  for (const pill of Array.from(promptEditor.querySelectorAll(
    "[data-inline-selection-pill][data-keyword]"
  ))) {
    const next = pill.nextSibling;
    if (next && next.nodeType === Node.TEXT_NODE && next.textContent?.startsWith(" ")) {
      next.textContent = next.textContent.slice(1);
    }
    pill.previousElementSibling?.matches("[data-inline-selection-pill-cursor-target]")
      && pill.previousElementSibling.remove();
    pill.remove();
  }
  promptEditor.querySelectorAll("[data-inline-selection-pill-cursor-target]")
    .forEach(cursor => cursor.remove());
  const prompt = (tag === "textarea" || tag === "input") && typeof editor.value === "string"
    ? editor.value
    : promptEditor.innerText || promptEditor.textContent || "";
  if (prompt !== expected.prompt) throw new Error("Exact prompt changed before Send.");

  const attachmentCards = Array.from(form.querySelectorAll(${JSON.stringify(ATTACHMENT_NAME_SELECTOR)}));
  const attachmentNames = attachmentCards
    .map(element => (element.textContent || "").trim())
    .filter(Boolean);
  const attachmentPending = attachmentCards.some(name => {
    const container = name.parentElement && name.parentElement.parentElement;
    const spinner = container && container.querySelector("svg[class*='animate-spin']");
    const bounds = spinner && spinner.getBoundingClientRect();
    return bounds && bounds.width > 0 && bounds.height > 0;
  });
  if (attachmentPending || !sameOrdered(attachmentNames, expected.attachmentNames)) {
    throw new Error("Exact ready attachment set changed before Send.");
  }

  const buttons = Array.from(form.querySelectorAll("button")).filter(visible);
  const activeToolSelector = [
    "button[aria-pressed='true']",
    "button[data-state='active']",
    "button[data-state='on']",
    "button[data-selected='true']",
    "button[data-testid*='tool' i]",
    "button[data-testid*='composer-chip' i]",
    "button[data-testid*='composer-pill' i]"
  ].join(",");
  const activeToolControls = Array.from(form.querySelectorAll(activeToolSelector))
    .filter(visible)
    .filter(button => button.getAttribute("aria-haspopup") !== "menu")
    .filter(button => !button.matches(${JSON.stringify(SEND_SELECTOR)}))
    .filter(button => button.id !== "composer-plus-btn")
    .map(normalizedLabel)
    .filter(Boolean);
  const inlineToolLabels = Array.from(editor.querySelectorAll(
    "[data-inline-selection-pill][data-keyword]"
  )).map(pill => pill.getAttribute("data-keyword") || "").filter(Boolean);
  const activeToolLabels = [...new Set([...activeToolControls, ...inlineToolLabels])];
  if (!sameMultiset(activeToolLabels, expected.toolLabels)) {
    throw new Error("Exact enumerable active tool set changed before Send.");
  }

  if (expected.power !== undefined) {
    const powers = Array.from(form.querySelectorAll(${JSON.stringify(POWER_OPENER_SELECTOR)}))
      .filter(visible);
    const power = powers.length === 1
      ? (powers[0].innerText || powers[0].textContent || "").replace(/\\s+/g, " ").trim()
      : undefined;
    if (power !== expected.power) {
      throw new Error("Requested Power echo changed before Send.");
    }
  }

  if (expected.userTurnBefore !== undefined || expected.assistantTurnBefore !== undefined) {
    const mains = Array.from(document.querySelectorAll("main")).filter(visible);
    if (mains.length !== 1) throw new Error("Visible Chat main is not unique.");
    const users = Array.from(mains[0].querySelectorAll('[data-message-author-role="user"]')).filter(visible);
    const assistants = Array.from(mains[0].querySelectorAll('[data-message-author-role="assistant"]')).filter(visible);
    if (users.length !== expected.userTurnBefore
      || assistants.length !== expected.assistantTurnBefore) {
      throw new Error("Visible turn baselines changed before Send.");
    }
    const turnId = message => {
      const container = message.closest('[data-testid^="conversation-turn-"]')
        || message.closest("article")
        || message.closest("[data-message-id]")
        || message.parentElement
        || message;
      return message.getAttribute("data-message-id")
        || container.getAttribute("data-message-id")
        || null;
    };
    if (expected.lastUserTurnId !== undefined
      && turnId(users[users.length - 1]) !== expected.lastUserTurnId) {
      throw new Error("Visible user-turn tail changed before Send.");
    }
    if (expected.lastAssistantTurnId !== undefined
      && turnId(assistants[assistants.length - 1]) !== expected.lastAssistantTurnId) {
      throw new Error("Visible assistant-turn tail changed before Send.");
    }
  }

  if (!expected.activate) return true;

  const sends = Array.from(form.querySelectorAll(${JSON.stringify(SEND_SELECTOR)})).filter(visible);
  if (sends.length !== 1) throw new Error("ChatGPT Send control is not unique.");
  const send = sends[0];
  if (send.disabled || send.getAttribute("aria-disabled") === "true" || send.getAttribute("aria-busy") === "true") {
    throw new Error("ChatGPT Send control is not ready.");
  }
  form.requestSubmit(send);
  return true;
})()`;
}

function cdpBooleanResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("result" in value)) return false;
  const result = value.result;
  return typeof result === "object"
    && result !== null
    && "value" in result
    && result.value === true;
}

async function bringPageToFront(cdp: BrowserCdpCapability): Promise<void> {
  try {
    await cdp.send!("Page.bringToFront", {}, { timeoutMs: 10_000 });
  } catch {
    // This reversible hint can be unsupported or acknowledged late; the exact
    // control postcondition still decides whether the following action worked.
  }
}

async function powerMenuExpanded(opener: BrowserLocator): Promise<boolean> {
  if (opener.evaluate === undefined) {
    throw new Error("ChatGPT Power opener state cannot be read.");
  }
  return opener.evaluate(element => element.getAttribute("aria-expanded") === "true");
}

async function readComposerPowerLabel(page: BrowserPage): Promise<string> {
  const opener = await uniqueVisible(page, POWER_OPENER_SELECTOR, "ChatGPT Power opener");
  if (opener.evaluate === undefined) throw new Error("Power selection cannot be read.");
  return opener.evaluate(element =>
    ((element as HTMLElement).innerText ?? element.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

async function uniqueVisible(
  page: BrowserPage,
  selector: string,
  label: string,
  timeoutMs = 10_000
): Promise<BrowserLocator> {
  const found = page.locator?.(selector);
  const locator = found?.filter?.({ visible: true }) ?? found;
  if (locator?.count === undefined) throw new Error(`${label} is unavailable.`);
  const deadline = Date.now() + timeoutMs;
  do {
    if (await locator.count() === 1
      && (locator.isVisible === undefined || await locator.isVisible())) return locator;
    await pause(page, Math.min(100, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`${label} is not uniquely visible.`);
}

async function readEditableText(locator: BrowserLocator): Promise<string> {
  if (locator.evaluate === undefined) throw new Error("Editable control cannot be read.");
  return locator.evaluate(element => {
    const editable = element as HTMLElement & { value?: unknown };
    const tag = element.tagName.toLowerCase();
    if ((tag === "textarea" || tag === "input") && typeof editable.value === "string") {
      return editable.value;
    }
    return editable.innerText ?? element.textContent ?? "";
  });
}

async function visibleCount(locator: BrowserLocator | undefined): Promise<number> {
  if (locator?.count === undefined) return 0;
  const filtered = locator.filter?.({ visible: true }) ?? locator;
  if (filtered.count === undefined) return 0;
  const count = await filtered.count();
  if (count === 1 && filtered.isVisible !== undefined && !await filtered.isVisible()) return 0;
  return count;
}

async function readBrowserClipboardText(
  clipboard: BrowserClipboard
): Promise<string | undefined> {
  if (clipboard.readText !== undefined) {
    const value = await clipboard.readText();
    return typeof value === "string" ? value : undefined;
  }
  if (clipboard.read === undefined) return undefined;
  return clipboardText(await clipboard.read());
}

async function clipboardText(value: unknown): Promise<string | undefined> {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = await clipboardText(item);
      if (text !== undefined) return text;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["text/plain", "text", "data", "value"]) {
    if (typeof record[key] === "string") return record[key];
  }
  if (typeof record.getType === "function") {
    try {
      const blob = await Reflect.apply(record.getType, value, ["text/plain"]);
      if (blob !== null && typeof blob === "object"
        && typeof (blob as { text?: unknown }).text === "function") {
        const text = await Reflect.apply((blob as { text: () => unknown }).text, blob, []);
        return typeof text === "string" ? text : undefined;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function waitForBrowserClipboardChange(
  page: BrowserPage,
  clipboard: BrowserClipboard,
  before: string | undefined,
  timeoutMs: number
): Promise<string | undefined> {
  const deadline = Date.now() + Math.max(1, Math.floor(timeoutMs));
  let current = await readBrowserClipboardText(clipboard);
  while (current === before && Date.now() < deadline) {
    await pause(page, Math.min(25, Math.max(1, deadline - Date.now())));
    current = await readBrowserClipboardText(clipboard);
  }
  return current;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function pause(page: BrowserPage, ms: number): Promise<void> {
  if (page.waitForTimeout !== undefined) await page.waitForTimeout(ms);
  else await new Promise(resolve => setTimeout(resolve, ms));
}
