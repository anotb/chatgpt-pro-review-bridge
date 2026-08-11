import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { prepareReviewContext, ReviewPreparationError } from "../../src/reviews/packet-builder.js";

describe("deterministic review packet builder", () => {
  it("fails closed when durable provenance archiving is explicitly disabled", async () => {
    await expect(prepareReviewContext({
      repositoryRoot: ".",
      baseRef: "HEAD",
      output: { archive: false }
    })).rejects.toMatchObject({
      name: "ReviewPreparationError",
      code: "archive_required"
    });
  });

  it("captures provenance, changed source, instructions, validation, partitions, and hashes", async () => {
    const repo = await fixtureRepository();
    await writeFile(join(repo, "AGENTS.md"), "# Repository rules\n");
    await writeFile(join(repo, "src", "example.ts"), "export function answer() {\n  return 42;\n}\n");
    await writeFile(join(repo, "tests", "example.test.ts"), "import { answer } from '../src/example';\nvoid answer();\n");

    const prepared = await prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "HEAD",
      headRef: "HEAD",
      context: {
        includeWorkingTree: true,
        validationOutput: "tests: passed",
        maxPacketBytes: 900,
        maxTotalBytes: 200_000,
        onBudgetExceeded: "partition"
      },
      output: { archiveRoot: ".codex/pro-reviews" },
      safeguards: { scanPacketsForSecrets: true }
    }, new Date("2026-08-11T12:00:00.000Z"));

    expect(prepared.manifest.dirty).toBe(true);
    expect(prepared.manifest.baseSha).toMatch(/^[a-f0-9]{40}$/);
    expect(prepared.manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "AGENTS.md", status: "included", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "src/example.ts", status: "included" }),
      expect.objectContaining({ path: "tests/example.test.ts", status: "included" })
    ]));
    expect(prepared.packetPaths.length).toBeGreaterThan(1);
    expect(prepared.manifest.packets.every(packet => /^[a-f0-9]{64}$/.test(packet.sha256))).toBe(true);
    expect(prepared.manifest.validationOutputIncluded).toBe(true);
    expect(await readFile(prepared.promptPath, "utf8")).toContain("untrusted data");
    expect(await readFile(prepared.manifestPath, "utf8")).not.toContain("tests: passed");
  });

  it("fails before submission evidence when a secret appears only in the diff", async () => {
    const repo = await fixtureRepository();
    await writeFile(join(repo, "src", "example.ts"), "export const leaked = 'AKIA1234567890ABCDEF';\n");

    await expect(prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "HEAD",
      context: { includeWorkingTree: true },
      safeguards: { scanPacketsForSecrets: true, secretPolicy: "block" }
    })).rejects.toMatchObject({
      name: "ReviewPreparationError",
      code: "packet_secret_detected",
      archiveDirectory: expect.any(String)
    });
  });

  it("redacts configured secret matches without preserving the value in packets", async () => {
    const repo = await fixtureRepository();
    const secret = "AKIA1234567890ABCDEF";
    await writeFile(join(repo, "src", "example.ts"), `export const value = '${secret}';\n`);

    const prepared = await prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "HEAD",
      safeguards: { scanPacketsForSecrets: true, secretPolicy: "redact" }
    });
    const packets = (await Promise.all(prepared.packetPaths.map(path => readFile(path, "utf8")))).join("\n");

    expect(packets).not.toContain(secret);
    expect(packets).toContain("[REDACTED:aws_access_key]");
    expect(prepared.manifest.secretFindings).toContainEqual(expect.objectContaining({ action: "redacted", kind: "aws_access_key" }));
  });
});

async function fixtureRepository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "chatgpt-pro-review-packets-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "src", "example.ts"), "export function answer() { return 41; }\n");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Packet Test");
  git(repo, "config", "user.email", "packet-test@example.invalid");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  return repo;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}
