import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  createOperationRecord,
  readOperationRecord,
  updateOperationRecord
} from "../../src/bridge/journal.js";
import type { BridgeHandle } from "../../src/bridge/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("bridge operation journal", () => {
  it("creates a small redacted prepared attempt record", async () => {
    const statePath = await operationPath();
    const record = await create(statePath, { selection: { power: "Pro" } });
    expect(record).toMatchObject({
      phase: "prepared",
      requestSha256: "a".repeat(64),
      selection: { power: "Pro" },
      handle: { statePath }
    });
    const persisted = await readFile(statePath, "utf8");
    expect(persisted).not.toContain("secret prompt");
    expect(persisted).not.toContain("report.pdf");
  });

  it("updates by expected phase and a narrow binding patch", async () => {
    const statePath = await operationPath();
    await create(statePath);
    const submitted = await updateOperationRecord({
      statePath,
      expectedPhase: "prepared",
      phase: "submitted",
      handlePatch: {
        threadUrl: "https://chatgpt.com/c/thread-1",
        conversationId: "thread-1",
        tabId: "tab-1",
        userTurnId: "user-message-1",
        assistantTurnId: "assistant-message-1",
        renderedPromptSha256: "c".repeat(64)
      },
      now: () => new Date("2026-08-14T12:01:00.000Z")
    });
    expect(submitted.updatedAt).toBe("2026-08-14T12:01:00.000Z");
    expect(submitted.handle).toMatchObject({
      tabId: "tab-1",
      conversationId: "thread-1",
      userTurnId: "user-message-1",
      assistantTurnId: "assistant-message-1",
      renderedPromptSha256: "c".repeat(64)
    });
    await expect(updateOperationRecord({
      statePath,
      expectedPhase: "submitted",
      phase: "generating",
      handlePatch: { assistantTurnId: "replacement-message" }
    })).rejects.toMatchObject({ code: "turn_binding_mismatch" });
  });

  it("persists only immutable hash evidence for pre-Send prompt presentations", async () => {
    const statePath = await operationPath();
    await create(statePath);
    const hashes = ["d".repeat(64), "e".repeat(64)];
    const prepared = await updateOperationRecord({
      statePath,
      expectedPhase: "prepared",
      phase: "prepared",
      handlePatch: { promptPresentationSha256s: hashes }
    });
    expect(prepared.handle.promptPresentationSha256s).toEqual(hashes);
    const persisted = await readFile(statePath, "utf8");
    expect(persisted).not.toContain("secret prompt");
    expect(persisted).not.toContain("report.pdf");

    await expect(updateOperationRecord({
      statePath,
      expectedPhase: "prepared",
      phase: "submitted",
      handlePatch: { promptPresentationSha256s: ["f".repeat(64)] }
    })).rejects.toMatchObject({ code: "presentation_binding_mismatch" });
  });

  it("fails closed for stale writers and backward terminal transitions", async () => {
    const statePath = await operationPath();
    await create(statePath);
    await updateOperationRecord({ statePath, expectedPhase: "prepared", phase: "completed" });
    await expect(updateOperationRecord({
      statePath,
      expectedPhase: "prepared",
      phase: "uncertain",
      uncertainty: "late caller"
    })).rejects.toMatchObject({ code: "phase_conflict" });
    await expect(updateOperationRecord({
      statePath,
      expectedPhase: "completed",
      phase: "generating"
    })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("reconciles uncertain observation without permitting another send", async () => {
    const statePath = await operationPath();
    await create(statePath);
    await updateOperationRecord({
      statePath,
      expectedPhase: "prepared",
      phase: "uncertain",
      uncertainty: "acknowledgement lost"
    });
    const recovered = await updateOperationRecord({
      statePath,
      expectedPhase: "uncertain",
      phase: "generating"
    });
    expect(recovered).toMatchObject({ phase: "generating" });
    expect(recovered.uncertainty).toBeUndefined();
  });

  it("rejects a live update lock but reclaims crash-stale residue", async () => {
    const statePath = await operationPath();
    await create(statePath);
    const lockPath = `${statePath}.lock`;
    await writeFile(lockPath, "");
    await expect(updateOperationRecord({
      statePath,
      expectedPhase: "prepared",
      phase: "submitted"
    })).rejects.toMatchObject({ code: "operation_busy" });

    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    await expect(updateOperationRecord({
      statePath,
      expectedPhase: "prepared",
      phase: "submitted"
    })).resolves.toMatchObject({ phase: "submitted" });
  });

  it("keeps a live owner claim but reclaims it after bounded staleness", async () => {
    const statePath = await operationPath();
    await create(statePath);
    const lockPath = `${statePath}.lock`;
    const crashedOwner = "crashed-owner";
    const claimPath = ownerClaimPath(lockPath, crashedOwner);
    await writeFile(lockPath, crashedOwner);
    await writeFile(claimPath, "live-claimant");
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);

    await expect(updateOperationRecord({
      statePath,
      expectedPhase: "prepared",
      phase: "submitted"
    })).rejects.toMatchObject({ code: "operation_busy" });
    expect(await readFile(claimPath, "utf8")).toBe("live-claimant");

    await utimes(claimPath, stale, stale);
    await expect(updateOperationRecord({
      statePath,
      expectedPhase: "prepared",
      phase: "submitted"
    })).resolves.toMatchObject({ phase: "submitted" });
  });

  it("allows only one contender to reclaim the same stale lock and claim", async () => {
    const statePath = await operationPath();
    await create(statePath);
    const lockPath = `${statePath}.lock`;
    const crashedOwner = "crashed-owner";
    const claimPath = ownerClaimPath(lockPath, crashedOwner);
    await writeFile(lockPath, crashedOwner);
    await writeFile(claimPath, "crashed-claimant");
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    await utimes(claimPath, stale, stale);

    const results = await Promise.allSettled([
      updateOperationRecord({ statePath, expectedPhase: "prepared", phase: "submitted" }),
      updateOperationRecord({ statePath, expectedPhase: "prepared", phase: "submitted" })
    ]);

    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({
      reason: { code: "operation_busy" }
    });
  });

  it("does not release a lock that was replaced by another owner", async () => {
    const statePath = await operationPath();
    await create(statePath);
    const lockPath = `${statePath}.lock`;

    await updateOperationRecord({
      statePath,
      expectedPhase: "prepared",
      phase: "submitted",
      now: () => {
        unlinkSync(lockPath);
        writeFileSync(lockPath, "replacement-owner");
        return new Date("2026-08-14T12:01:00.000Z");
      }
    });

    expect(await readFile(lockPath, "utf8")).toBe("replacement-owner");
  });

  it("rejects non-opaque request hashes", async () => {
    const statePath = await operationPath();
    await expect(createOperationRecord({
      statePath,
      handle: handle(),
      requestSha256: "C:/private/report.pdf",
      selection: {}
    })).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("rejects records copied away from their bound path", async () => {
    const statePath = await operationPath();
    await create(statePath);
    const otherPath = join(statePath, "..", "copied.json");
    await writeFile(otherPath, await readFile(statePath));
    await expect(readOperationRecord(otherPath)).rejects.toMatchObject({
      code: "record_binding_mismatch"
    });
  });
});

async function operationPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-bridge-journal-"));
  roots.push(root);
  return join(root, "operation.json");
}

async function create(
  statePath: string,
  overrides: { selection?: Record<string, string> } = {}
) {
  return createOperationRecord({
    statePath,
    handle: handle(),
    requestSha256: "a".repeat(64),
    selection: overrides.selection ?? {}
  });
}

function handle(): BridgeHandle {
  return {
    version: 1,
    operationId: "operation-1",
    promptSha256: "b".repeat(64),
    createdAt: "2026-08-14T12:00:00.000Z",
    userTurnBefore: 2,
    assistantTurnBefore: 1
  };
}

function ownerClaimPath(lockPath: string, owner: string): string {
  const identity = createHash("sha256").update(owner).digest("hex");
  return `${lockPath}.${identity}.claim`;
}
