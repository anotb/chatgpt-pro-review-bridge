import { lstat, mkdir, open, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ReviewPreparationError } from "./packet-builder.js";
import { probeProcessLiveness, type ProcessLiveness } from "./process-liveness.js";

const REVIEW_LEASE_MAX_AGE_MS = 5 * 60_000;
const REVIEW_LEASE_RENEW_MS = Math.floor(REVIEW_LEASE_MAX_AGE_MS / 3);

type ReviewLeaseSnapshot = {
  format: "directory" | "legacy";
  leaseText: string;
  ownerPath?: string;
  value: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function acquireReviewLease(
  archiveDirectory: string,
  hooks: { afterDirectoryCreated?: (leasePath: string) => Promise<void> } = {}
): Promise<() => Promise<void>> {
  const leasePath = join(archiveDirectory, ".workflow.lock");
  const leaseId = randomUUID();
  const acquiredAt = new Date();
  const leaseRecord = `${JSON.stringify({
    schemaVersion: 1,
    leaseId,
    pid: process.pid,
    acquiredAt: acquiredAt.toISOString()
  })}\n`;
  let ownerPath: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(leasePath, { mode: 0o700 });
      ownerPath = join(leasePath, `${leaseId}.json`);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" && attempt === 0 && await waitForLeaseTurnover(leasePath)) {
        continue;
      }
      if (code === "EEXIST") {
        throw new ReviewPreparationError(
          "Another process or task already holds the exclusive lease for this review archive.",
          "review_archive_locked",
          undefined,
          archiveDirectory
        );
      }
      throw error;
    }
  }
  if (ownerPath === undefined) throw new Error("Unable to acquire the review archive lease.");
  try {
    await hooks.afterDirectoryCreated?.(leasePath);
    handle = await open(ownerPath, "wx", 0o600);
    await handle.writeFile(leaseRecord);
    await handle.sync();
    const entries = await readdir(leasePath);
    if (entries.length !== 1 || entries[0] !== `${leaseId}.json`) {
      throw new ReviewPreparationError(
        "Another process or task replaced the review archive lease while it was being initialized.",
        "review_archive_locked",
        undefined,
        archiveDirectory
      );
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(ownerPath).catch(() => undefined);
    await rmdir(leasePath).catch(() => undefined);
    throw error;
  }
  if (handle === undefined) throw new Error("Unable to initialize the review archive lease.");
  const ownerHandle = handle;
  let released = false;
  const renewal = setInterval(() => {
    if (released) return;
    const renewedAt = new Date();
    // The owner record is immutable; renewing only its timestamps cannot
    // corrupt the generation identity used for safe cleanup.
    void ownerHandle.utimes(renewedAt, renewedAt).catch(() => undefined);
  }, REVIEW_LEASE_RENEW_MS);
  renewal.unref();
  return async () => {
    if (released) return;
    released = true;
    clearInterval(renewal);
    await ownerHandle.close().catch(() => undefined);
    await removeDirectoryLeaseOwner(leasePath, ownerPath);
  };
}

async function removeDirectoryLeaseOwner(
  leasePath: string,
  ownerPath: string,
  expectedMtimeMs?: number
): Promise<boolean> {
  try {
    if (expectedMtimeMs !== undefined) {
      const ownerStat = await lstat(ownerPath);
      if (!ownerStat.isFile() || ownerStat.mtimeMs !== expectedMtimeMs) return false;
    }
    await unlink(ownerPath);
  } catch {
    return false;
  }
  try {
    await rmdir(leasePath);
    return true;
  } catch {
    // A non-empty or replaced directory belongs to another owner. Never remove
    // recursively; the unique owner entry is the cleanup authority.
    return false;
  }
}

async function removeLegacyLeaseTextIfUnchanged(
  leasePath: string,
  expected: string,
  expectedMtimeMs?: number
): Promise<boolean> {
  try {
    if (await readFile(leasePath, "utf8") !== expected) return false;
    if (expectedMtimeMs !== undefined) {
      const leaseStat = await lstat(leasePath);
      if (!leaseStat.isFile() || leaseStat.mtimeMs !== expectedMtimeMs) return false;
    }
    // unlink cannot remove the directory used by v0.7.9+ successors, so a
    // delayed legacy-file reclaimer cannot delete a newly acquired lease.
    await unlink(leasePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function leaseGenerationHeartbeatIsStale(
  leasePath: string,
  snapshot: ReviewLeaseSnapshot
): Promise<number | undefined> {
  try {
    const heartbeatPath = snapshot.format === "directory" ? snapshot.ownerPath! : leasePath;
    const heartbeatStat = await lstat(heartbeatPath);
    if (!heartbeatStat.isFile()) return undefined;
    if (await readFile(heartbeatPath, "utf8") !== snapshot.leaseText) return undefined;
    return Date.now() - heartbeatStat.mtimeMs >= REVIEW_LEASE_MAX_AGE_MS
      ? heartbeatStat.mtimeMs
      : undefined;
  } catch {
    return undefined;
  }
}

async function archiveProvesSubmissionAlreadyOccurred(leasePath: string): Promise<boolean> {
  const archiveDirectory = dirname(leasePath);
  for (const filename of ["submission-confirmation.json", "submission.json"]) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(archiveDirectory, filename), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return false;
    }
    if (!isRecord(value)) return false;
    const validSchema = value.schemaVersion === 1 || value.schemaVersion === 2 || value.schemaVersion === 3;
    const validThread = isRecord(value.thread)
      && ((typeof value.thread.url === "string" && value.thread.url.length > 0)
        || (typeof value.thread.id === "string" && value.thread.id.length > 0));
    const validArtifactBaseline = isRecord(value.artifactBaseline) && Array.isArray(value.artifactBaseline.items);
    return validSchema
      && (value.state === "confirmed" || value.state === "ambiguous")
      && value.submitted === true
      && value.resubmitAllowed === false
      && typeof value.promptSha256 === "string"
      && /^[a-f0-9]{64}$/u.test(value.promptSha256)
      && validThread
      && validArtifactBaseline;
  }
  return false;
}

async function readReviewLeaseSnapshot(leasePath: string): Promise<ReviewLeaseSnapshot | undefined> {
  let leaseStat: Awaited<ReturnType<typeof lstat>>;
  try {
    leaseStat = await lstat(leasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!leaseStat.isDirectory()) {
    if (!leaseStat.isFile()) return undefined;
    const leaseText = await readFile(leasePath, "utf8");
    let value: unknown;
    try { value = JSON.parse(leaseText); } catch { value = undefined; }
    return { format: "legacy", leaseText, value };
  }
  const entries = (await readdir(leasePath)).filter(name => name.endsWith(".json"));
  if (entries.length !== 1) return undefined;
  const ownerPath = join(leasePath, entries[0]!);
  if (dirname(ownerPath) !== leasePath || !(await lstat(ownerPath)).isFile()) return undefined;
  const leaseText = await readFile(ownerPath, "utf8");
  let value: unknown;
  try { value = JSON.parse(leaseText); } catch { value = undefined; }
  return { format: "directory", leaseText, ownerPath, value };
}

export async function removeLeaseIfOwnerExitedOrExpired(
  leasePath: string,
  probeLiveness: (pid: number) => Promise<ProcessLiveness> = probeProcessLiveness
): Promise<boolean> {
  let snapshot: ReviewLeaseSnapshot | undefined;
  try {
    snapshot = await readReviewLeaseSnapshot(leasePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (snapshot === undefined) {
    try {
      const leaseStat = await lstat(leasePath);
      if (Date.now() - leaseStat.mtimeMs < REVIEW_LEASE_MAX_AGE_MS) return false;
      if (leaseStat.isDirectory()) {
        try {
          await rmdir(leasePath);
          return true;
        } catch {
          return false;
        }
      }
      if (!leaseStat.isFile()) return false;
      const leaseText = await readFile(leasePath, "utf8");
      return removeLegacyLeaseTextIfUnchanged(leasePath, leaseText);
    } catch {
      return false;
    }
  }
  const { value } = snapshot;
  if (snapshot.format === "directory" && !isRecord(value)) {
    try {
      const ownerStat = await lstat(snapshot.ownerPath!);
      if (!ownerStat.isFile() || Date.now() - ownerStat.mtimeMs < REVIEW_LEASE_MAX_AGE_MS) return false;
      return removeDirectoryLeaseOwner(leasePath, snapshot.ownerPath!);
    } catch {
      return false;
    }
  }
  if (snapshot.format === "legacy" && !isRecord(value)) {
    try {
      const leaseStat = await lstat(leasePath);
      if (!leaseStat.isFile() || Date.now() - leaseStat.mtimeMs < REVIEW_LEASE_MAX_AGE_MS) return false;
      return removeLegacyLeaseTextIfUnchanged(leasePath, snapshot.leaseText);
    } catch {
      return false;
    }
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isInteger(value.pid) || (value.pid as number) <= 0) return false;
  if (snapshot.format === "directory") {
    if (typeof value.leaseId !== "string" || snapshot.ownerPath !== join(leasePath, `${value.leaseId}.json`)) return false;
  }
  // Expiry is not authority to evict a demonstrably live owner. On Windows,
  // a sandbox can make every available process probe indeterminate, so a lease
  // with an unknown owner is reclaimable only after this exact generation's
  // heartbeat has gone stale. Directory leases use a unique owner entry, so
  // cleanup of one generation can never delete a successor's entry.
  const liveness = await probeLiveness(value.pid as number);
  if (liveness === "live") return false;
  if (liveness === "unknown" && !await archiveProvesSubmissionAlreadyOccurred(leasePath)) return false;
  const staleHeartbeatMtime = liveness === "unknown"
    ? await leaseGenerationHeartbeatIsStale(leasePath, snapshot)
    : undefined;
  if (liveness === "unknown" && staleHeartbeatMtime === undefined) return false;
  if (snapshot.format === "directory") {
    if (await readFile(snapshot.ownerPath!, "utf8").catch(() => undefined) !== snapshot.leaseText) return false;
    return removeDirectoryLeaseOwner(leasePath, snapshot.ownerPath!, staleHeartbeatMtime);
  }
  return removeLegacyLeaseTextIfUnchanged(leasePath, snapshot.leaseText, staleHeartbeatMtime);
}

async function waitForLeaseTurnover(leasePath: string, timeoutMs = 3_000): Promise<boolean> {
  if (await removeLeaseIfOwnerExitedOrExpired(leasePath)) return true;
  let ownerPid: number | undefined;
  try {
    const value = (await readReviewLeaseSnapshot(leasePath))?.value;
    if (isRecord(value) && value.schemaVersion === 1 && Number.isInteger(value.pid) && (value.pid as number) > 0) {
      ownerPid = value.pid as number;
    }
  } catch {
    return false;
  }
  // A concurrent call in this process is definitely live; preserve the fast
  // fail-closed path. A different process may be the browser evaluator that is
  // still exiting after its bounded host call timed out, so allow that brief
  // turnover to finish before declaring the archive locked.
  if (ownerPid === process.pid) return false;

  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await removeLeaseIfOwnerExitedOrExpired(leasePath)) return true;
    try {
      await lstat(leasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(100, remaining));
  }
}
