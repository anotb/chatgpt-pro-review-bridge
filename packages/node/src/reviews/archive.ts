import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ReviewArtifact } from "./types.js";

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function sha256Text(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function createReviewArchive(
  repositoryRoot: string,
  archiveRoot: string,
  headSha: string | undefined,
  now = new Date()
): Promise<string> {
  const root = isAbsolute(archiveRoot) ? resolve(archiveRoot) : resolve(repositoryRoot, archiveRoot);
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const revision = headSha?.slice(0, 12) ?? "unborn";
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const path = join(root, `${timestamp}-${revision}-${randomBytes(6).toString("hex")}`);
    try {
      await mkdir(path, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    await mkdir(join(path, "context"), { recursive: false, mode: 0o700 });
    await mkdir(join(path, "artifacts"), { recursive: false, mode: 0o700 });
    await Promise.all([path, join(path, "context"), join(path, "artifacts")].map(directory => chmod(directory, 0o700)));
    return path;
  }
  throw new Error("Unable to allocate an exclusive review archive directory.");
}

export async function writeImmutableFile(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const expected = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temporary, expected, { flag: "wx", mode: 0o600 });
  try {
    // Hard-linking a complete same-directory temporary file publishes it
    // atomically without POSIX rename's destination-overwrite behavior.
    await link(temporary, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EPERM", "ENOSYS", "EXDEV", "EOPNOTSUPP"].includes(code ?? "")) {
      try {
        await copyFile(temporary, path, constants.COPYFILE_EXCL);
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") throw copyError;
      }
    } else if (code !== "EEXIST") {
      throw error;
    }
    const existing = await readFile(path);
    if (!existing.equals(expected)) {
      throw new Error(`Refusing to replace immutable archive file with different content: ${path}`);
    }
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeImmutableJson(path: string, data: unknown): Promise<void> {
  await writeImmutableFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function sanitizeArtifactFilename(name: string, fallback = "artifact"): string {
  const leaf = basename(name.replace(/\\/g, "/"));
  const cleaned = leaf
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  const usable = cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
  return usable.slice(0, 180);
}

export function collisionSafeFilename(name: string, used: Set<string>): string {
  const safe = sanitizeArtifactFilename(name);
  const key = safe.toLocaleLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return safe;
  }
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    const candidateKey = candidate.toLocaleLowerCase();
    if (!used.has(candidateKey)) {
      used.add(candidateKey);
      return candidate;
    }
  }
  throw new Error(`Unable to allocate a collision-safe artifact filename for ${JSON.stringify(name)}.`);
}

export async function preserveDownloadedArtifact(
  downloadedPath: string,
  archiveDirectory: string,
  desiredName: string,
  used: Set<string>,
  metadata: { kind?: string; sourceLabel?: string; sourceReference?: string; inventoryKey?: string } = {}
): Promise<ReviewArtifact> {
  const name = collisionSafeFilename(desiredName, used);
  const artifactsRoot = resolve(archiveDirectory, "artifacts");
  const target = resolve(artifactsRoot, name);
  assertPathInside(artifactsRoot, target);
  await mkdir(artifactsRoot, { recursive: true });
  if (resolve(downloadedPath) !== target) {
    try {
      await copyFile(downloadedPath, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const [existingHash, downloadedHash] = await Promise.all([
        sha256File(target),
        sha256File(downloadedPath)
      ]);
      if (existingHash !== downloadedHash) {
        throw new Error(`Refusing to replace an archived artifact with different content: ${target}`);
      }
    }
  }
  await chmod(target, 0o600);
  const saved = await stat(target);
  const artifact: ReviewArtifact = {
    name,
    path: target,
    sizeBytes: saved.size,
    sha256: await sha256File(target)
  };
  if (metadata.kind !== undefined) artifact.kind = metadata.kind;
  if (metadata.sourceLabel !== undefined) artifact.sourceLabel = metadata.sourceLabel;
  if (metadata.sourceReference !== undefined) artifact.sourceReference = metadata.sourceReference;
  if (metadata.inventoryKey !== undefined) artifact.inventoryKey = metadata.inventoryKey;
  return artifact;
}

export function assertPathInside(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(`Refusing path outside archive root: ${target}`);
}

export function markdownSectionIndex(markdown: string): Array<{ heading: string; level: number; offset: number }> {
  const entries: Array<{ heading: string; level: number; offset: number }> = [];
  const pattern = /^(#{1,6})\s+(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    entries.push({ heading: match[2] ?? "", level: match[1]?.length ?? 1, offset: match.index });
  }
  return entries;
}
