import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type {
  BridgeHandle,
  BridgeOperationRecord,
  BridgePhase,
  BridgeSelection
} from "./types.js";

const ARTIFACT_KEY = /^[a-f0-9]{64}$/;
const STALE_LOCK_MS = 30_000;

export class BridgeJournalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BridgeJournalError";
  }
}

export type CreateOperationRecordInput = {
  statePath: string;
  handle: BridgeHandle;
  requestSha256: string;
  selection: BridgeSelection;
  now?: () => Date;
};

export type UpdateOperationRecordInput = {
  statePath: string;
  expectedPhase: BridgePhase;
  phase: BridgePhase;
  handlePatch?: Pick<
    BridgeHandle,
    "threadUrl" | "conversationId" | "tabId" | "promptPresentationSha256s" | "renderedPromptSha256" | "userTurnId" | "assistantTurnId"
  >;
  uncertainty?: string;
  now?: () => Date;
};

export async function createOperationRecord(
  input: CreateOperationRecordInput
): Promise<BridgeOperationRecord> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const handle = { ...input.handle, statePath: input.statePath };
  const record: BridgeOperationRecord = {
    schemaVersion: 1,
    handle,
    requestSha256: input.requestSha256,
    phase: "prepared",
    selection: { ...input.selection },
    updatedAt: now
  };
  validateRecord(record, input.statePath);
  await mkdir(dirname(input.statePath), { recursive: true });
  try {
    await writeFile(input.statePath, serialize(record), { flag: "wx" });
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new BridgeJournalError(
        "operation_exists",
        `Bridge operation already exists: ${basename(input.statePath)}`
      );
    }
    throw error;
  }
  return record;
}

export async function readOperationRecord(
  statePath: string
): Promise<BridgeOperationRecord> {
  const raw = await readFile(statePath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BridgeJournalError("invalid_record", "Bridge operation record is not valid JSON.");
  }
  validateRecord(value, statePath);
  return value;
}

export async function updateOperationRecord(
  input: UpdateOperationRecordInput
): Promise<BridgeOperationRecord> {
  const lockPath = `${input.statePath}.lock`;
  const lock = await acquireLock(lockPath);

  try {
    const current = await readOperationRecord(input.statePath);
    if (current.phase !== input.expectedPhase) {
      throw new BridgeJournalError(
        "phase_conflict",
        `Expected bridge phase ${input.expectedPhase}, found ${current.phase}.`
      );
    }
    assertTransition(current.phase, input.phase);
    const uncertainty = input.uncertainty?.trim();
    if (input.phase === "uncertain" && !uncertainty) {
      throw new BridgeJournalError("uncertainty_required", "Uncertain operations require a reason.");
    }
    if (input.phase !== "uncertain" && input.uncertainty !== undefined) {
      throw new BridgeJournalError("unexpected_uncertainty", "Only uncertain operations may store a reason.");
    }

    const timestamp = (input.now ?? (() => new Date()))().toISOString();
    const handle = mergeHandle(current.handle, input.handlePatch);
    const next: BridgeOperationRecord = {
      ...current,
      handle,
      phase: input.phase,
      updatedAt: timestamp
    };
    if (input.phase === "uncertain") next.uncertainty = uncertainty!;
    else delete next.uncertainty;

    validateRecord(next, input.statePath);
    const tempPath = join(dirname(input.statePath), `.${basename(input.statePath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, serialize(next), { flag: "wx" });
      await rename(tempPath, input.statePath);
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
    return next;
  } finally {
    await releaseLock(lock);
  }
}

type OwnedLock = {
  path: string;
  owner: string;
};

async function acquireLock(lockPath: string): Promise<OwnedLock> {
  return acquireLease(lockPath);
}

async function acquireLease(lockPath: string): Promise<OwnedLock> {
  const owner = randomUUID();
  try {
    await writeFile(lockPath, owner, { flag: "wx" });
    return { path: lockPath, owner };
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }

  let observed: string;
  try {
    observed = await readFile(lockPath, "utf8");
    if (!await isStale(lockPath)) throw operationBusy();
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    return createContendedLock(lockPath, owner);
  }

  const claim = await acquireClaim(lockPath, observed);
  try {
    let current: string;
    try {
      current = await readFile(lockPath, "utf8");
      if (current !== observed || !await isStale(lockPath)) throw operationBusy();
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      return createContendedLock(lockPath, owner);
    }

    await unlink(lockPath);
    return createContendedLock(lockPath, owner);
  } finally {
    await unlinkIfOwned(claim);
  }
}

async function createContendedLock(lockPath: string, owner: string): Promise<OwnedLock> {
  try {
    await writeFile(lockPath, owner, { flag: "wx" });
    return { path: lockPath, owner };
  } catch (error) {
    if (isNodeError(error, "EEXIST")) throw operationBusy();
    throw error;
  }
}

async function acquireClaim(lockPath: string, observedOwner: string): Promise<OwnedLock> {
  const identity = createHash("sha256").update(observedOwner).digest("hex");
  return acquireLease(`${lockPath}.${identity}.claim`);
}

async function releaseLock(lock: OwnedLock): Promise<void> {
  let claim: OwnedLock;
  try {
    claim = await acquireClaim(lock.path, lock.owner);
  } catch (error) {
    if (error instanceof BridgeJournalError && error.code === "operation_busy") return;
    throw error;
  }

  try {
    await unlinkIfOwned(lock);
  } finally {
    await unlinkIfOwned(claim);
  }
}

async function unlinkIfOwned(lock: OwnedLock): Promise<void> {
  try {
    if (await readFile(lock.path, "utf8") === lock.owner) await unlink(lock.path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function isStale(lockPath: string): Promise<boolean> {
  return Date.now() - (await stat(lockPath)).mtimeMs > STALE_LOCK_MS;
}

function operationBusy(): BridgeJournalError {
  return new BridgeJournalError("operation_busy", "Bridge operation is being updated.");
}

function assertTransition(from: BridgePhase, to: BridgePhase): void {
  if (from === to) return;
  const allowed: Record<BridgePhase, BridgePhase[]> = {
    prepared: ["submitted", "generating", "completed", "uncertain"],
    submitted: ["generating", "completed", "uncertain"],
    generating: ["completed", "uncertain"],
    completed: [],
    uncertain: ["submitted", "generating", "completed"]
  };
  if (!allowed[from].includes(to)) {
    throw new BridgeJournalError("invalid_transition", `Bridge phase cannot move from ${from} to ${to}.`);
  }
}

function mergeHandle(
  current: BridgeHandle,
  patch: UpdateOperationRecordInput["handlePatch"]
): BridgeHandle {
  if (patch === undefined) return current;
  for (const key of ["userTurnId", "assistantTurnId"] as const) {
    if (current[key] !== undefined && patch[key] !== undefined && current[key] !== patch[key]) {
      throw new BridgeJournalError(
        "turn_binding_mismatch",
        `Bridge ${key} cannot change after it is recorded.`
      );
    }
  }
  if (current.promptPresentationSha256s !== undefined
    && patch.promptPresentationSha256s !== undefined
    && !sameStrings(current.promptPresentationSha256s, patch.promptPresentationSha256s)) {
    throw new BridgeJournalError(
      "presentation_binding_mismatch",
      "Bridge prompt presentation evidence cannot change after it is recorded."
    );
  }
  return { ...current, ...definedEntries(patch) };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined)
  ) as Partial<T>;
}

function validateRecord(value: unknown, statePath: string): asserts value is BridgeOperationRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.handle)) {
    throw new BridgeJournalError("invalid_record", "Bridge operation record has an invalid schema.");
  }
  const handle = value.handle;
  if (
    handle.version !== 1 ||
    typeof handle.operationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(handle.operationId) ||
    typeof handle.promptSha256 !== "string" ||
    !ARTIFACT_KEY.test(handle.promptSha256) ||
    (handle.attachmentCount !== undefined
      && (typeof handle.attachmentCount !== "number"
        || !Number.isInteger(handle.attachmentCount)
        || handle.attachmentCount < 1)) ||
    !isOptionalPresentationHashes(handle.promptPresentationSha256s) ||
    (handle.renderedPromptSha256 !== undefined
      && (typeof handle.renderedPromptSha256 !== "string"
        || !ARTIFACT_KEY.test(handle.renderedPromptSha256))) ||
    !isOptionalTurnId(handle.userTurnId) ||
    !isOptionalTurnId(handle.assistantTurnId)
  ) {
    throw new BridgeJournalError("invalid_record", "Bridge operation handle is invalid.");
  }
  if (handle.statePath !== statePath) {
    throw new BridgeJournalError("record_binding_mismatch", "Bridge operation record path does not match its handle.");
  }
  if (!isPhase(value.phase)
    || typeof value.requestSha256 !== "string"
    || !ARTIFACT_KEY.test(value.requestSha256)) {
    throw new BridgeJournalError("invalid_record", "Bridge operation request hash or phase is invalid.");
  }
  if (
    !isRecord(value.selection) ||
    !Object.values(value.selection).every((entry) => typeof entry === "string") ||
    typeof value.updatedAt !== "string"
  ) {
    throw new BridgeJournalError("invalid_record", "Bridge operation metadata is invalid.");
  }
}

function isOptionalPresentationHashes(value: unknown): value is string[] | undefined {
  return value === undefined
    || (Array.isArray(value)
      && value.length >= 1
      && value.length <= 4
      && new Set(value).size === value.length
      && value.every(entry => typeof entry === "string" && ARTIFACT_KEY.test(entry)));
}

function isOptionalTurnId(value: unknown): value is string | undefined {
  return value === undefined
    || (typeof value === "string" && /^[^\u0000-\u001f]{1,512}$/.test(value));
}

function isPhase(value: unknown): value is BridgePhase {
  return value === "prepared" || value === "submitted" || value === "generating" || value === "completed" || value === "uncertain";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

function serialize(record: BridgeOperationRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
