import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  BridgeJournalError,
  createOperationRecord,
  readOperationRecord,
  updateOperationRecord
} from "./journal.js";
import { collectBridgeOutput } from "./output.js";
import type { BridgeObservation, BridgePort } from "./port.js";
import { selectTargets } from "./targets.js";
import type {
  BridgeHandle,
  BridgeOperationRecord,
  BridgePhase,
  BridgeResult,
  BridgeRunInput,
  BridgeResumeOptions,
  BridgeWaitOptions,
  ChatGPTBridge
} from "./types.js";

export type CreateBridgeOptions = {
  port: BridgePort;
  stateDir?: string;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
};

export function createBridge(options: CreateBridgeOptions): ChatGPTBridge {
  const stateDir = resolve(options.stateDir ?? ".codex/chatgpt-bridge/operations");
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? delay;
  let portTail = Promise.resolve();

  async function withPort<T>(work: () => Promise<T>): Promise<T> {
    const previous = portTail;
    let release!: () => void;
    portTail = new Promise<void>(resolveQueue => { release = resolveQueue; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async function submit(input: BridgeRunInput): Promise<BridgeResult> {
    assertPrompt(input.prompt);
    const operationId = input.operationId;
    assertOperationId(operationId);
    const statePath = resolve(stateDir, `${operationId}.json`);
    const requestSha256 = requestHash(input);
    const existing = await readIfExists(statePath);
    if (existing !== undefined) {
      verifySameRequest(existing, requestSha256);
      return resultFromRecord(existing);
    }

    return withPort(async () => {
      const queuedExisting = await readIfExists(statePath);
      if (queuedExisting !== undefined) {
        verifySameRequest(queuedExisting, requestSha256);
        return resultFromRecord(queuedExisting);
      }

      if ((input.files?.length ?? 0) > 0) {
        await options.port.preflightFiles(input.files!);
      }
      const createdAt = now().toISOString();
      const binding = await options.port.bindThread(input.thread ?? "new");
      const requestedSelection = input.selection ?? {};
      if (Object.keys(requestedSelection).length > 0) {
        await selectTargets(options.port, requestedSelection);
      }
      await options.port.composePrompt(input.prompt);
      for (const tool of input.tools ?? []) await options.port.selectTool(tool);
      const hasFiles = (input.files?.length ?? 0) > 0;
      const preHandoffPresentation = await options.port.submissionPresentationSha256s(input.prompt);

      const handle: BridgeHandle = {
        version: 1,
        operationId,
        promptSha256: sha256(input.prompt),
        ...(!hasFiles
          ? {}
          : { attachmentCount: input.files!.length }),
        ...(!hasFiles
          ? { promptPresentationSha256s: [...preHandoffPresentation] }
          : {}),
        createdAt,
        statePath,
        ...(binding.threadUrl === undefined ? {} : { threadUrl: binding.threadUrl }),
        ...(binding.conversationId === undefined ? {} : { conversationId: binding.conversationId }),
        ...(binding.tabId === undefined ? {} : { tabId: binding.tabId }),
        userTurnBefore: binding.userTurnCount,
        assistantTurnBefore: binding.assistantTurnCount
      };

      try {
        await createOperationRecord({
          statePath,
          handle,
          requestSha256,
          selection: requestedSelection,
          now
        });
      } catch (error) {
        if (!(error instanceof BridgeJournalError) || error.code !== "operation_exists") throw error;
        const winner = await readOperationRecord(statePath);
        verifySameRequest(winner, requestSha256);
        return resultFromRecord(winner);
      }

      try {
        if (hasFiles) {
          await options.port.attachFiles(input.files!);
          const presentationSha256s = await options.port.submissionPresentationSha256s(input.prompt);
          await updateOperationRecord({
            statePath,
            expectedPhase: "prepared",
            phase: "prepared",
            handlePatch: { promptPresentationSha256s: [...presentationSha256s] },
            now
          });
        }
      } catch (error) {
        const uncertain = await updateOperationRecord({
          statePath,
          expectedPhase: "prepared",
          phase: "uncertain",
          uncertainty: preparationUncertainty(error),
          now
        });
        return resultFromRecord(uncertain);
      }

      let submission: Awaited<ReturnType<BridgePort["submitPrompt"]>>;
      try {
        submission = await options.port.submitPrompt({
          prompt: input.prompt,
          promptSha256: handle.promptSha256,
          userTurnBefore: binding.userTurnCount,
          assistantTurnBefore: binding.assistantTurnCount,
          ...(binding.lastUserTurnId === undefined
            ? {}
            : { lastUserTurnId: binding.lastUserTurnId }),
          ...(binding.lastAssistantTurnId === undefined
            ? {}
            : { lastAssistantTurnId: binding.lastAssistantTurnId }),
          ...(requestedSelection.power === undefined ? {} : { power: requestedSelection.power })
        });
      } catch {
        const uncertain = await updateOperationRecord({
          statePath,
          expectedPhase: "prepared",
          phase: "uncertain",
          uncertainty: "Send outcome could not be reconciled after at most one activation.",
          now
        });
        return resultFromRecord(uncertain);
      }

      const handlePatch = {
        ...(submission.threadUrl === undefined ? {} : { threadUrl: submission.threadUrl }),
        ...(submission.conversationId === undefined ? {} : { conversationId: submission.conversationId }),
        ...(submission.tabId === undefined ? {} : { tabId: submission.tabId }),
        ...(submission.renderedPromptSha256 === undefined
          ? {}
          : { renderedPromptSha256: submission.renderedPromptSha256 }),
        ...(submission.userTurnId === undefined ? {} : { userTurnId: submission.userTurnId })
      };
      const record = submission.confirmed
        ? await updateOperationRecord({
            statePath,
            expectedPhase: "prepared",
            phase: "submitted",
            handlePatch,
            now
          })
        : await updateOperationRecord({
            statePath,
            expectedPhase: "prepared",
            phase: "uncertain",
            handlePatch,
            uncertainty: "Send was attempted once but the visible user turn could not be confirmed.",
            now
          });
      return resultFromRecord(record);
    });
  }

  async function refresh(
    handle: BridgeHandle,
    capture?: Pick<BridgeResumeOptions, "downloadDir">
  ): Promise<BridgeResult> {
    return withPort(async () => {
      const record = await boundRecord(handle);
      if (record.phase === "completed") {
        if (capture === undefined) return resultFromRecord(record);
        await options.port.bindHandle(record.handle);
        const output = await collectBridgeOutput(options.port, capture);
        return { ...resultFromRecord(record), output };
      }
      if (record.phase === "uncertain"
        && preparationBlockerCode(record.uncertainty) !== undefined) {
        return resultFromRecord(record);
      }

      let binding: Awaited<ReturnType<BridgePort["bindHandle"]>>;
      let observation: BridgeObservation;
      try {
        binding = await options.port.bindHandle(record.handle);
        observation = await options.port.observe(record.handle);
      } catch {
        if (record.phase === "uncertain") return resultFromRecord(record);
        const uncertain = await updateOperationRecord({
          statePath: requireStatePath(record.handle),
          expectedPhase: record.phase,
          phase: "uncertain",
          uncertainty: "Visible handle could not be reconciled.",
          now
        });
        return resultFromRecord(uncertain);
      }

      const phase = trustedObservedPhase(observation);
      const handlePatch = changedBindingPatch(record.handle, binding, observation);
      if (phase === record.phase && Object.keys(handlePatch).length === 0) {
        return resultFromRecord(record);
      }
      const next = await updateOperationRecord({
        statePath: requireStatePath(record.handle),
        expectedPhase: record.phase,
        phase,
        handlePatch,
        ...(phase === "uncertain"
          ? { uncertainty: observation.uncertainty ?? "Visible turn ownership could not be verified." }
          : {}),
        now
      });
      const result = resultFromRecord(next);
      if (next.phase !== "completed" || capture === undefined) return result;
      // Keep final ownership verification and the first full transfer in this
      // same serialized browser window so a bridge follow-up cannot interleave.
      await options.port.bindHandle(next.handle);
      const output = await collectBridgeOutput(options.port, capture);
      return { ...result, output };
    });
  }

  async function collect(
    handle: BridgeHandle,
    resumeOptions: BridgeResumeOptions = {}
  ): Promise<BridgeResult> {
    const capture = {
      ...(resumeOptions.downloadDir === undefined ? {} : { downloadDir: resumeOptions.downloadDir })
    };
    let current = await refresh(handle, capture);
    const wait = normalizeWait(resumeOptions.wait);
    if (wait !== undefined) {
      const started = now().getTime();
      while (isRunning(current.phase) && now().getTime() - started < wait.timeoutMs) {
        const remaining = wait.timeoutMs - (now().getTime() - started);
        await sleep(Math.min(wait.pollMs, remaining));
        current = await refresh(current.handle, capture);
      }
    }
    // Polling transfers metadata only. The full response is captured once, after
    // visible completion, so long answers do not cross the host bridge per poll.
    return current;
  }

  async function run(input: BridgeRunInput): Promise<BridgeResult> {
    const submitted = await submit(input);
    if (submitted.phase === "uncertain" || input.wait === false) return submitted;
    return collect(submitted.handle, {
      wait: input.wait ?? true,
      ...(input.downloadDir === undefined ? {} : { downloadDir: input.downloadDir })
    });
  }

  async function boundRecord(handle: BridgeHandle): Promise<BridgeOperationRecord> {
    const record = await readOperationRecord(requireStatePath(handle));
    if (record.handle.operationId !== handle.operationId
      || record.handle.promptSha256 !== handle.promptSha256
      || record.handle.createdAt !== handle.createdAt) {
      throw new Error("Bridge handle does not match its durable operation record.");
    }
    return record;
  }

  return {
    inspectTargets: () => withPort(() => options.port.inspectTargets()),
    submit,
    collect,
    run
  };
}

function trustedObservedPhase(observation: BridgeObservation): BridgeObservation["phase"] {
  return observation.phase === "completed" && !observation.responseOwned
    ? "uncertain"
    : observation.phase;
}

function resultFromRecord(record: BridgeOperationRecord): BridgeResult {
  const result: BridgeResult = { phase: record.phase, handle: record.handle };
  if (record.phase !== "uncertain" && Object.keys(record.selection).length > 0) {
    result.selection = {
      requested: record.selection,
      active: record.selection,
      verified: true
    };
  }
  if (record.phase === "uncertain") {
    const preparationCode = preparationBlockerCode(record.uncertainty);
    result.blocker = preparationCode === undefined
      ? {
          code: "operation_uncertain",
          message: record.uncertainty ?? "Visible submission ownership is uncertain.",
          resumable: true
        }
      : {
          code: preparationCode,
          message: "Visible preparation could not be completed safely.",
          resumable: false
        };
  }
  return result;
}

function normalizeWait(
  wait: BridgeResumeOptions["wait"]
): Required<BridgeWaitOptions> | undefined {
  if (wait === false || wait === undefined) return undefined;
  if (wait === true) return { timeoutMs: 120_000, pollMs: 1_000 };
  return {
    timeoutMs: positive(wait.timeoutMs, 120_000),
    pollMs: positive(wait.pollMs, 1_000)
  };
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0
    ? Math.max(1, Math.floor(value!))
    : fallback;
}

function isRunning(phase: BridgePhase): boolean {
  return phase === "prepared" || phase === "submitted" || phase === "generating";
}

function requireStatePath(handle: BridgeHandle): string {
  if (handle.statePath === undefined) throw new Error("Bridge handle has no durable state path.");
  return handle.statePath;
}

function assertPrompt(prompt: string): void {
  if (prompt.trim().length === 0) throw new Error("Bridge prompt must contain visible text.");
}

function assertOperationId(operationId: string): void {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
    throw new Error("Bridge operation ID must be a path-safe opaque identifier.");
  }
}

function changedBindingPatch(
  handle: BridgeHandle,
  binding: Awaited<ReturnType<BridgePort["bindHandle"]>>,
  observation: BridgeObservation
): Pick<BridgeHandle, "threadUrl" | "conversationId" | "tabId" | "userTurnId" | "assistantTurnId"> {
  const patch: Pick<
    BridgeHandle,
    "threadUrl" | "conversationId" | "tabId" | "userTurnId" | "assistantTurnId"
  > = {};
  if (binding.threadUrl !== undefined && binding.threadUrl !== handle.threadUrl) patch.threadUrl = binding.threadUrl;
  if (binding.conversationId !== undefined && binding.conversationId !== handle.conversationId) patch.conversationId = binding.conversationId;
  if (binding.tabId !== undefined && binding.tabId !== handle.tabId) patch.tabId = binding.tabId;
  if (observation.userTurnId !== undefined && observation.userTurnId !== handle.userTurnId) {
    patch.userTurnId = observation.userTurnId;
  }
  // ChatGPT can expose a transient request-placeholder ID while a response is
  // still materializing. Bind the durable assistant identity only after the
  // owned response is visibly complete.
  if (observation.phase === "completed"
    && observation.assistantTurnId !== undefined
    && observation.assistantTurnId !== handle.assistantTurnId) {
    patch.assistantTurnId = observation.assistantTurnId;
  }
  return patch;
}

function requestHash(input: BridgeRunInput): string {
  const sortedSelection = Object.fromEntries(
    Object.entries(input.selection ?? {}).sort(([left], [right]) => left.localeCompare(right))
  );
  return sha256(JSON.stringify({
    promptSha256: sha256(input.prompt),
    thread: input.thread ?? "new",
    selection: sortedSelection,
    tools: input.tools ?? [],
    files: input.files ?? []
  }));
}

async function readIfExists(statePath: string): Promise<BridgeOperationRecord | undefined> {
  try {
    return await readOperationRecord(statePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function verifySameRequest(record: BridgeOperationRecord, requestSha256: string): void {
  if (record.requestSha256 !== requestSha256) {
    throw new Error("Bridge operation ID is already bound to a different request.");
  }
}

function preparationUncertainty(error: unknown): string {
  const code = typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && SAFE_PREPARATION_CODES.has(error.code)
      ? error.code
      : undefined;
  return code ?? "preparation_uncertain";
}

function preparationBlockerCode(uncertainty: string | undefined): string | undefined {
  return uncertainty !== undefined && SAFE_PREPARATION_CODES.has(uncertainty)
    ? uncertainty
    : undefined;
}

const SAFE_PREPARATION_CODES = new Set([
  "preparation_uncertain",
  "file_path_not_absolute",
  "file_not_readable",
  "file_not_regular",
  "composer_unavailable",
  "input_ambiguous",
  "upload_path_unavailable",
  "file_handoff_uncertain",
  "upload_readiness_uncertain",
  "tool_label_invalid",
  "tool_unavailable",
  "tool_uncertain",
  "tool_unverified"
]);

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
