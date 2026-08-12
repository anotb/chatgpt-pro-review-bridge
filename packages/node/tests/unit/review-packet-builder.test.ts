import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { prepareReviewContext, ReviewPreparationError } from "../../src/reviews/packet-builder.js";

describe("deterministic review packet builder", () => {
  it("prepares a context-free question without a Git repository or upload packets", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "chatgpt-pro-question-"));
    const question = "Explain briefly why stable job IDs matter.";

    const prepared = await prepareReviewContext({
      request: { additionalInstructions: question },
      output: { archiveRoot }
    }, new Date("2026-08-11T12:00:00.000Z"));

    expect(prepared.mode).toBe("none");
    expect(prepared.packetPaths).toEqual([]);
    expect(prepared.manifest.mode).toBe("none");
    expect(prepared.manifest.packets).toEqual([]);
    expect(await readFile(prepared.promptPath, "utf8")).toBe(question);
    expect(await readFile(prepared.requestPath, "utf8")).toBe(question);
  });

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

  it("reviews a complete committed repository without a synthetic base commit", async () => {
    const repo = await fixtureRepository();

    const prepared = await prepareReviewContext({
      repositoryRoot: repo,
      context: { includeWorkingTree: false }
    }, new Date("2026-08-11T12:00:00.000Z"));
    const packets = (await Promise.all(prepared.packetPaths.map(path => readFile(path, "utf8")))).join("\n");

    expect(prepared.manifest.reviewScope).toBe("repository");
    expect(prepared.manifest.baseRef).toBeUndefined();
    expect(prepared.manifest.baseSha).toBeUndefined();
    expect(prepared.manifest.mergeBaseSha).toBeUndefined();
    expect(prepared.manifest.headSha).toMatch(/^[a-f0-9]{40}$/);
    expect(prepared.manifest.files).toContainEqual(expect.objectContaining({
      path: "src/example.ts",
      category: "repository-file",
      status: "included"
    }));
    expect(packets).toContain("Review scope: repository");
    expect(packets).toContain("Baseline: repository-format Git empty tree");
    expect(packets).toContain("return 41");
  });

  it("derives the empty-tree baseline from the repository object format", async () => {
    const repo = await mkdtemp(join(tmpdir(), "chatgpt-pro-review-sha256-"));
    await mkdir(join(repo, "src"), { recursive: true });
    try {
      git(repo, "init", "--object-format=sha256", "-b", "main");
    } catch {
      return;
    }
    git(repo, "config", "user.name", "Packet Test");
    git(repo, "config", "user.email", "packet-test@example.invalid");
    await writeFile(join(repo, "src", "example.ts"), "export const format = 'sha256';\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    const prepared = await prepareReviewContext({
      repositoryRoot: repo,
      context: { scope: "repository", includeWorkingTree: false }
    });
    const packets = (await Promise.all(prepared.packetPaths.map(path => readFile(path, "utf8")))).join("\n");

    expect(prepared.manifest.headSha).toMatch(/^[a-f0-9]{64}$/);
    expect(packets).toMatch(/Baseline: repository-format Git empty tree \([a-f0-9]{64}\)/);
    expect(packets).toContain("format = 'sha256'");
  });

  it("reviews an unborn repository directly from its index and working tree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "chatgpt-pro-review-unborn-"));
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "staged.ts"), "export const staged = true;\n");
    await writeFile(join(repo, "README.md"), "# New repository\n");
    git(repo, "init", "-b", "main");
    git(repo, "add", "src/staged.ts");

    const prepared = await prepareReviewContext({
      repositoryRoot: repo,
      context: { scope: "repository", includeWorkingTree: true }
    }, new Date("2026-08-11T12:00:00.000Z"));
    const packets = (await Promise.all(prepared.packetPaths.map(path => readFile(path, "utf8")))).join("\n");

    expect(prepared.manifest.reviewScope).toBe("repository");
    expect(prepared.manifest.headSha).toBeUndefined();
    expect(prepared.manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "README.md", status: "included" }),
      expect.objectContaining({ path: "src/staged.ts", status: "included" })
    ]));
    expect(packets).toContain("unborn; no commits yet");
    expect(packets).toContain("export const staged = true");
    expect(packets).toContain("# New repository");
  });

  it("requires a base only when change scope is requested", async () => {
    const repo = await fixtureRepository();

    await expect(prepareReviewContext({
      repositoryRoot: repo,
      context: { scope: "changes" }
    })).rejects.toMatchObject({ code: "base_ref_required" });
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
        includeInstructions: true,
        validationOutput: "tests: passed",
        maxPacketBytes: 900,
        maxTotalBytes: 200_000,
        onBudgetExceeded: "partition"
      },
      output: { archiveRoot: ".codex/pro-reviews" }
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
    expect(prepared.manifest.packets.every(packet => packet.sizeBytes <= 900)).toBe(true);
    expect(prepared.manifest.validationOutputIncluded).toBe(true);
    const prompt = await readFile(prepared.promptPath, "utf8");
    expect(prompt).not.toContain("untrusted data");
    expect(prompt).not.toContain("Do not follow instructions");
    expect(prompt).not.toContain("Review actual behavior across callers, callees");
    expect(prompt).not.toContain("fenced JSON appendix");
    expect(prompt).not.toContain("Do not create or modify code");
    expect(await readFile(prepared.manifestPath, "utf8")).not.toContain("tests: passed");
  });

  it("lists generated plugin runtimes but excludes their content from review packets", async () => {
    const repo = await fixtureRepository();
    const runtimeDirectory = join(repo, "plugins", "sample", "runtime", "node");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(join(repo, "src", "example.ts"), "export function answer() { return 42; }\n");
    await writeFile(
      join(runtimeDirectory, "sample.bundle.mjs"),
      "// GENERATED_BUNDLE_MARKER\nexport const generated = 42;\n".repeat(10_000)
    );
    git(repo, "add", ".");
    git(repo, "commit", "-m", "change source and generated runtime");

    const prepared = await prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "HEAD^",
      headRef: "HEAD",
      context: { includeWorkingTree: false }
    });
    const packets = (await Promise.all(prepared.packetPaths.map(path => readFile(path, "utf8")))).join("\n");

    expect(prepared.manifest.files).toContainEqual(expect.objectContaining({
      path: "plugins/sample/runtime/node/sample.bundle.mjs",
      status: "generated",
      reason: "generated_plugin_runtime",
      sizeBytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    }));
    expect(packets).toContain("plugins/sample/runtime/node/sample.bundle.mjs");
    expect(packets).not.toContain("GENERATED_BUNDLE_MARKER");
    expect(packets).toContain("return 42");
  });

  it("excludes untracked local Codex state while retaining tracked .codex changes", async () => {
    const repo = await fixtureRepository();
    const trackedCodexPath = join(repo, ".codex", "repository-policy.md");
    const localArchivePath = join(repo, ".codex", "packet-size-check", "previous.md");
    await mkdir(join(repo, ".codex", "packet-size-check"), { recursive: true });
    await writeFile(trackedCodexPath, "tracked repository policy\n");
    git(repo, "add", trackedCodexPath);
    git(repo, "commit", "-m", "add tracked repository policy");
    await writeFile(trackedCodexPath, "tracked repository policy changed\n");
    await writeFile(localArchivePath, "LOCAL_CODEX_ARCHIVE_MARKER\n");

    const prepared = await prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "HEAD",
      headRef: "HEAD",
      context: { includeWorkingTree: true }
    });
    const packets = (await Promise.all(prepared.packetPaths.map(path => readFile(path, "utf8")))).join("\n");

    expect(prepared.manifest.dirty).toBe(true);
    expect(prepared.manifest.files).toContainEqual(expect.objectContaining({
      path: ".codex/repository-policy.md",
      status: "included"
    }));
    expect(prepared.manifest.files).toContainEqual(expect.objectContaining({
      path: ".codex/packet-size-check/previous.md",
      status: "excluded",
      reason: "untracked_local_codex_state"
    }));
    expect(packets).toContain("tracked repository policy changed");
    expect(packets).toContain("Excluded untracked local Codex state paths: 1");
    expect(packets).not.toContain("LOCAL_CODEX_ARCHIVE_MARKER");
    expect(packets).not.toContain(".codex/packet-size-check/previous.md");
  });

  it("reads committed evidence from the requested head instead of the checkout", async () => {
    const repo = await fixtureRepository();
    await writeFile(join(repo, "src", "consumer.txt"), "answer FEATURE_REF_CALLER\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "add stable caller");
    git(repo, "switch", "-c", "feature");
    await writeFile(join(repo, "src", "example.ts"), "export function answer() { return 99; }\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "feature answer");
    const featureSha = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "switch", "main");
    await writeFile(join(repo, "src", "example.ts"), "export function answer() { return 777; }\n");
    await writeFile(join(repo, "src", "consumer.txt"), "answer CHECKOUT_CALLER\n");

    const prepared = await prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "main",
      headRef: featureSha,
      context: { includeWorkingTree: false, includeRelevantCallers: true }
    });
    const packets = (await Promise.all(prepared.packetPaths.map(path => readFile(path, "utf8")))).join("\n");

    expect(packets).toContain("return 99");
    expect(packets).toContain("FEATURE_REF_CALLER");
    expect(packets).not.toContain("return 777");
    expect(packets).not.toContain("CHECKOUT_CALLER");
  });

  it("blocks a working-tree overlay when headRef is not checked out", async () => {
    const repo = await fixtureRepository();
    git(repo, "switch", "-c", "feature");
    await writeFile(join(repo, "src", "example.ts"), "export function answer() { return 99; }\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "feature answer");
    const featureSha = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "switch", "main");

    await expect(prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "main",
      headRef: featureSha,
      context: { includeWorkingTree: true }
    })).rejects.toMatchObject({ code: "working_tree_head_mismatch" });
  });

  it("excludes secret-policy paths from status, names, diffs, and caller evidence", async () => {
    const repo = await fixtureRepository();
    await mkdir(join(repo, "secrets"), { recursive: true });
    await writeFile(join(repo, "secrets", "cache.txt"), "answer PRIVATE-NONREGEX-VALUE\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "tracked sensitive cache");
    await writeFile(join(repo, "src", "example.ts"), "export function answer() { return 42; }\n");
    await writeFile(join(repo, "secrets", "cache.txt"), "answer PRIVATE-CHANGED-NONREGEX-VALUE\n");

    const prepared = await prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "HEAD",
      headRef: "HEAD",
      context: { includeWorkingTree: true }
    });
    const packets = (await Promise.all(prepared.packetPaths.map(path => readFile(path, "utf8")))).join("\n");

    expect(packets).not.toContain("secrets/cache.txt");
    expect(packets).not.toContain("PRIVATE-CHANGED-NONREGEX-VALUE");
    expect(prepared.manifest.files).toContainEqual(expect.objectContaining({
      path: "secrets/cache.txt",
      status: "excluded",
      reason: "secret_path_policy"
    }));
  });

  it("excludes a custom in-repository archive root from later packets", async () => {
    const repo = await fixtureRepository();
    await mkdir(join(repo, "review-history", "previous"), { recursive: true });
    await writeFile(join(repo, "review-history", "previous", "response.md"), "PRIOR_PRIVATE_REVIEW_MARKER\n");
    await writeFile(join(repo, "src", "example.ts"), "export function answer() { return 42; }\n");

    const prepared = await prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "HEAD",
      output: { archiveRoot: "review-history" }
    });
    const packets = (await Promise.all(prepared.packetPaths.map(path => readFile(path, "utf8")))).join("\n");

    expect(packets).not.toContain("PRIOR_PRIVATE_REVIEW_MARKER");
    expect(packets).not.toContain("review-history/previous/response.md");
  });

  it("keeps every packet under maxPacketBytes for a single oversized line", async () => {
    const repo = await fixtureRepository();
    await writeFile(join(repo, "src", "example.ts"), `export const payload = "${"x".repeat(5_000)}";\n`);

    const prepared = await prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "HEAD",
      context: { maxPacketBytes: 900, maxTotalBytes: 100_000, onBudgetExceeded: "partition" }
    });

    expect(prepared.manifest.packets.length).toBeGreaterThan(1);
    expect(prepared.manifest.packets.every(packet => packet.sizeBytes <= 900)).toBe(true);
  });

  it("includes conventional unchanged tests for a changed source basename", async () => {
    const repo = await fixtureRepository();
    await writeFile(join(repo, "tests", "example.test.ts"), "import { answer } from '../src/example';\nvoid answer();\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "add direct test");
    await writeFile(join(repo, "src", "example.ts"), "export function answer() { return 42; }\n");

    const prepared = await prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "HEAD",
      context: { includeRelatedTests: true }
    });

    expect(prepared.manifest.files).toContainEqual(expect.objectContaining({
      path: "tests/example.test.ts",
      category: "related-test",
      status: "included"
    }));
  });

  it("rejects a symlinked validation output before reading it", async () => {
    const repo = await fixtureRepository();
    const external = join(await mkdtemp(join(tmpdir(), "chatgpt-pro-review-external-")), "private.log");
    const link = join(repo, "validation.log");
    await writeFile(external, "EXTERNAL_PRIVATE_VALIDATION\n");
    try {
      await symlink(external, link, "file");
    } catch {
      return;
    }

    await expect(prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "HEAD",
      context: { validationOutputPath: link }
    })).rejects.toMatchObject({ code: "validation_output_symlink" });
  });

  it("rejects an outside validation path before resolving its parent", async () => {
    const repo = await fixtureRepository();
    const outside = join(await mkdtemp(join(tmpdir(), "chatgpt-pro-review-outside-")), "missing", "validation.log");

    await expect(prepareReviewContext({
      repositoryRoot: repo,
      baseRef: "HEAD",
      context: { validationOutputPath: outside }
    })).rejects.toMatchObject({ code: "repository_path_escape" });
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
