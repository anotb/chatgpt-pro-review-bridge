import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { acquireReviewLease, removeLeaseIfOwnerExitedOrExpired } from "../../src/reviews/review-lease.js";

const staleTime = (): Date => new Date(Date.now() - 10 * 60_000);

function leaseRecord(leaseId?: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    ...(leaseId === undefined ? {} : { leaseId }),
    pid: 4242,
    acquiredAt: "2026-08-13T12:00:00.000Z"
  });
}

async function writeSubmittedReceipt(
  archiveDirectory: string,
  filename: "submission-confirmation.json" | "submission.json" = "submission.json"
): Promise<void> {
  await writeFile(join(archiveDirectory, filename), JSON.stringify({
    schemaVersion: 3,
    state: "confirmed",
    submitted: true,
    resubmitAllowed: false,
    promptSha256: "a".repeat(64),
    thread: { url: "https://chatgpt.com/c/review-thread", id: "review-thread" },
    artifactBaseline: { items: [] }
  }));
}

describe("review archive lease recovery", () => {
  it("keeps a fresh lease locked when owner liveness is unknown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-pro-fresh-unknown-lease-"));
    const leasePath = join(directory, ".workflow.lock");
    const leaseId = "11111111-1111-4111-8111-111111111111";
    const ownerPath = join(leasePath, `${leaseId}.json`);
    await mkdir(leasePath);
    await writeFile(ownerPath, leaseRecord(leaseId));

    await expect(removeLeaseIfOwnerExitedOrExpired(leasePath, async () => "unknown")).resolves.toBe(false);
    await expect(readFile(ownerPath, "utf8")).resolves.toContain(leaseId);
    await rm(directory, { recursive: true, force: true });
  });

  it("reclaims a stale legacy lease when owner liveness is unknown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-pro-stale-legacy-lease-"));
    const leasePath = join(directory, ".workflow.lock");
    await writeSubmittedReceipt(directory);
    await writeFile(leasePath, leaseRecord());
    await utimes(leasePath, staleTime(), staleTime());

    await expect(removeLeaseIfOwnerExitedOrExpired(leasePath, async () => "unknown")).resolves.toBe(true);
    await expect(readFile(leasePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });

  it("reclaims a stale directory lease when owner liveness is unknown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-pro-stale-directory-lease-"));
    const leasePath = join(directory, ".workflow.lock");
    const leaseId = "22222222-2222-4222-8222-222222222222";
    const ownerPath = join(leasePath, `${leaseId}.json`);
    await writeSubmittedReceipt(directory, "submission-confirmation.json");
    await mkdir(leasePath);
    await writeFile(ownerPath, leaseRecord(leaseId));
    await utimes(ownerPath, staleTime(), staleTime());

    await expect(removeLeaseIfOwnerExitedOrExpired(leasePath, async () => "unknown")).resolves.toBe(true);
    await expect(readFile(ownerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps a stale unknown-owner lease locked when only submission intent exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-pro-stale-intent-lease-"));
    const leasePath = join(directory, ".workflow.lock");
    const leaseId = "88888888-8888-4888-8888-888888888888";
    const ownerPath = join(leasePath, `${leaseId}.json`);
    await writeFile(join(directory, "submission-intent.json"), JSON.stringify({
      schemaVersion: 3,
      state: "intent",
      resubmitAllowed: false,
      promptSha256: "a".repeat(64),
      thread: { url: "https://chatgpt.com/c/review-thread", id: "review-thread" },
      artifactBaseline: { items: [] }
    }));
    await mkdir(leasePath);
    await writeFile(ownerPath, leaseRecord(leaseId));
    await utimes(ownerPath, staleTime(), staleTime());

    await expect(removeLeaseIfOwnerExitedOrExpired(leasePath, async () => "unknown")).resolves.toBe(false);
    await expect(readFile(ownerPath, "utf8")).resolves.toContain(leaseId);
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps a stale lease locked when the owner is demonstrably live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-pro-stale-live-lease-"));
    const leasePath = join(directory, ".workflow.lock");
    const leaseId = "33333333-3333-4333-8333-333333333333";
    const ownerPath = join(leasePath, `${leaseId}.json`);
    await mkdir(leasePath);
    await writeFile(ownerPath, leaseRecord(leaseId));
    await utimes(ownerPath, staleTime(), staleTime());

    await expect(removeLeaseIfOwnerExitedOrExpired(leasePath, async () => "live")).resolves.toBe(false);
    await expect(readFile(ownerPath, "utf8")).resolves.toContain(leaseId);
    await rm(directory, { recursive: true, force: true });
  });

  it("immediately reclaims a fresh lease when the owner is demonstrably dead", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-pro-fresh-dead-lease-"));
    const leasePath = join(directory, ".workflow.lock");
    const leaseId = "66666666-6666-4666-8666-666666666666";
    const ownerPath = join(leasePath, `${leaseId}.json`);
    await mkdir(leasePath);
    await writeFile(ownerPath, leaseRecord(leaseId));

    await expect(removeLeaseIfOwnerExitedOrExpired(leasePath, async () => "dead")).resolves.toBe(true);
    await expect(readFile(ownerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps an unknown-owner lease that renews while liveness is being checked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-pro-renewed-unknown-lease-"));
    const leasePath = join(directory, ".workflow.lock");
    const leaseId = "77777777-7777-4777-8777-777777777777";
    const ownerPath = join(leasePath, `${leaseId}.json`);
    await writeSubmittedReceipt(directory);
    await mkdir(leasePath);
    await writeFile(ownerPath, leaseRecord(leaseId));
    await utimes(ownerPath, staleTime(), staleTime());
    let finishProbe!: () => void;
    let probeStarted!: () => void;
    const started = new Promise<void>(resolve => { probeStarted = resolve; });
    const finish = new Promise<void>(resolve => { finishProbe = resolve; });
    const removal = removeLeaseIfOwnerExitedOrExpired(leasePath, async () => {
      probeStarted();
      await finish;
      return "unknown";
    });

    await started;
    const renewed = new Date();
    await utimes(ownerPath, renewed, renewed);
    finishProbe();

    await expect(removal).resolves.toBe(false);
    await expect(readFile(ownerPath, "utf8")).resolves.toContain(leaseId);
    await rm(directory, { recursive: true, force: true });
  });

  it("does not delete a successor installed while unknown-owner liveness is checked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-pro-unknown-lease-replacement-"));
    const leasePath = join(directory, ".workflow.lock");
    const originalId = "44444444-4444-4444-8444-444444444444";
    const successorId = "55555555-5555-4555-8555-555555555555";
    const originalPath = join(leasePath, `${originalId}.json`);
    const successorPath = join(leasePath, `${successorId}.json`);
    const successor = leaseRecord(successorId);
    await writeSubmittedReceipt(directory);
    await mkdir(leasePath);
    await writeFile(originalPath, leaseRecord(originalId));
    await utimes(originalPath, staleTime(), staleTime());
    let finishProbe!: () => void;
    let probeStarted!: () => void;
    const started = new Promise<void>(resolve => { probeStarted = resolve; });
    const finish = new Promise<void>(resolve => { finishProbe = resolve; });
    const removal = removeLeaseIfOwnerExitedOrExpired(leasePath, async () => {
      probeStarted();
      await finish;
      return "unknown";
    });

    await started;
    await unlink(originalPath);
    await rmdir(leasePath);
    await mkdir(leasePath);
    await writeFile(successorPath, successor);
    await utimes(successorPath, staleTime(), staleTime());
    finishProbe();

    await expect(removal).resolves.toBe(false);
    await expect(readFile(successorPath, "utf8")).resolves.toBe(successor);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects an initializer that wakes after its empty lease directory was replaced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-pro-lease-init-turnover-"));
    const leasePath = join(directory, ".workflow.lock");
    let resumeInitialization!: () => void;
    let initializationPaused!: () => void;
    const paused = new Promise<void>(resolve => { initializationPaused = resolve; });
    const resume = new Promise<void>(resolve => { resumeInitialization = resolve; });
    const first = acquireReviewLease(directory, {
      afterDirectoryCreated: async () => {
        initializationPaused();
        await resume;
      }
    });

    await paused;
    await utimes(leasePath, staleTime(), staleTime());
    await expect(removeLeaseIfOwnerExitedOrExpired(leasePath)).resolves.toBe(true);
    const releaseSuccessor = await acquireReviewLease(directory);
    const successorEntries = await readdir(leasePath);
    expect(successorEntries).toHaveLength(1);
    const firstRejected = expect(first).rejects.toMatchObject({ code: "review_archive_locked" });
    resumeInitialization();

    await firstRejected;
    await expect(readdir(leasePath)).resolves.toEqual(successorEntries);
    await releaseSuccessor();
    await expect(readFile(leasePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });
});
