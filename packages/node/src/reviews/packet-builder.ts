import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { createReviewArchive, sha256File, sha256Text, writeImmutableFile, writeImmutableJson } from "./archive.js";
import type {
  PacketFileRecord,
  PreparedReviewContext,
  ProCodeReviewArgs,
  ReviewPacketManifest,
  ReviewScope
} from "./types.js";

const DEFAULT_PACKET_BYTES = 1_500_000;
const DEFAULT_TOTAL_BYTES = 12_000_000;
const DEFAULT_SOURCE_BYTES = 750_000;
const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:credentials?|secrets?|tokens?)(?:\.|\/|$)/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.azure\//i,
  /(^|\/)\.config\/gcloud\//i,
  /(^|\/)(?:id_rsa|id_ed25519|id_ecdsa)(?:\.|$)/i,
  /\.(?:pem|p12|pfx|key|keystore)$/i,
  /(^|\/)Cookies(?:-journal)?$/i,
  /(^|\/)Local Storage\//i
];
const GENERATED_DIRECTORY_PATTERN = /(^|\/)(?:node_modules|dist|build|coverage|vendor|target|\.next|\.cache)\//i;
const GENERATED_PLUGIN_RUNTIME_PATTERN = /^plugins\/[^/]+\/runtime\/node\/[^/]+\.mjs$/i;
const LOCAL_CODEX_STATE_PATTERN = /^\.codex\//i;
const GENERATED_DIFF_EXCLUDES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/target/**",
  "**/.next/**",
  "**/.cache/**",
  "plugins/*/runtime/node/*.mjs"
].map(pattern => `:(exclude,glob)${pattern}`);
const MANIFEST_PATTERN = /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|poetry\.lock|requirements[^/]*\.txt|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile(?:\.lock)?|composer\.json|Dockerfile|docker-compose[^/]*\.ya?ml|.*\.config\.[cm]?[jt]s|.*\.schema\.json)$/i;
const TEST_PATTERN = /(?:^|\/)(?:test|tests|__tests__)\/|(?:\.|_)(?:test|spec)\.[^.\/]+$/i;
export class ReviewPreparationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
    readonly archiveDirectory?: string
  ) {
    super(message);
    this.name = "ReviewPreparationError";
  }
}

type GitResult = { stdout: string; stderr: string; code: number };
type Section = { title: string; body: string; files: string[] };
type RepositoryRoots = { canonical: string; lexical: string };

export async function prepareReviewContext(args: ProCodeReviewArgs, now = new Date()): Promise<PreparedReviewContext> {
  if (args.output?.archive === false) {
    throw new ReviewPreparationError(
      "A Pro review requires a durable provenance archive; output.archive cannot be false.",
      "archive_required"
    );
  }
  if (usesContextFreeMode(args)) return prepareContextFreeQuestion(args, now);
  if (args.repositoryRoot === undefined) {
    throw new ReviewPreparationError(
      "repositoryRoot is required when repository context is requested.",
      "repository_context_incomplete"
    );
  }
  const repositoryRoots = await resolveRepositoryRoots(args.repositoryRoot);
  const repositoryRoot = repositoryRoots.canonical;
  const reviewScope: ReviewScope = args.context?.scope ?? (args.baseRef === undefined ? "repository" : "changes");
  if (reviewScope === "changes" && args.baseRef === undefined) {
    throw new ReviewPreparationError(
      "baseRef is required for a change review. Use context.scope = \"repository\" to review the complete repository.",
      "base_ref_required"
    );
  }
  const baseRef = reviewScope === "changes" ? requireNonEmpty(args.baseRef!, "baseRef") : undefined;
  const headRef = requireNonEmpty(args.headRef ?? "HEAD", "headRef");
  const includeWorkingTree = args.context?.includeWorkingTree ?? true;
  const checkedOutHeadSha = await gitCommit(repositoryRoot, "HEAD");
  const headSha = await gitCommit(repositoryRoot, headRef);
  const unbornHead = headSha === undefined && headRef === "HEAD" && checkedOutHeadSha === undefined;
  if (headSha === undefined && !(reviewScope === "repository" && includeWorkingTree && unbornHead)) {
    throw new ReviewPreparationError(
      reviewScope === "repository" && !includeWorkingTree && unbornHead
        ? "An unborn repository can only be reviewed with includeWorkingTree enabled."
        : `Git commit reference could not be resolved: ${headRef}`,
      reviewScope === "repository" && !includeWorkingTree && unbornHead ? "unborn_repository_worktree_required" : "head_ref_unresolved"
    );
  }
  const baseSha = reviewScope === "changes"
    ? await gitRequired(repositoryRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`], "base_ref_unresolved")
    : undefined;
  const mergeBaseSha = reviewScope === "changes"
    ? await gitRequired(repositoryRoot, ["merge-base", baseSha!, headSha!], "merge_base_unresolved")
    : undefined;
  const emptyTreeSha = reviewScope === "repository"
    ? await gitRequired(repositoryRoot, ["hash-object", "-t", "tree", "--stdin"], "empty_tree_unresolved")
    : undefined;
  if (includeWorkingTree && headSha !== checkedOutHeadSha) {
    throw new ReviewPreparationError(
      "Working-tree evidence can only overlay the checked-out HEAD. Set includeWorkingTree to false or check out the requested headRef.",
      "working_tree_head_mismatch",
      { headSha, checkedOutHeadSha }
    );
  }
  const archiveRoot = args.output?.archiveRoot ?? ".codex/pro-reviews";
  const archivePathPrefix = repositoryRelativeArchivePrefix(repositoryRoot, archiveRoot);
  const initialStatus = await gitChecked(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"], "git_status_failed");
  const archiveDirectory = await createReviewArchive(repositoryRoot, archiveRoot, headSha, now);

  try {
    const branch = (await gitChecked(repositoryRoot, ["branch", "--show-current"], "git_branch_failed")).stdout.trim() || undefined;
    const packetStatus = filterPacketStatus(initialStatus.stdout, archivePathPrefix);
    const dirty = packetStatus.visible.trim().length > 0;
    const availableFiles = await snapshotFiles(repositoryRoot, headSha, includeWorkingTree, archivePathPrefix);
    const changedAll = reviewScope === "repository"
      ? availableFiles
      : await changedFiles(repositoryRoot, mergeBaseSha!, headSha!, includeWorkingTree, archivePathPrefix);
    const excludedChanged = changedAll.filter(path => isPacketExcludedPath(path, archivePathPrefix));
    const changed = changedAll.filter(path => !isPacketExcludedPath(path, archivePathPrefix));
    const overlayPaths = includeWorkingTree
      ? await workingTreePaths(repositoryRoot, archivePathPrefix)
      : new Set<string>();
    let validation = await validationOutput(args, repositoryRoot, repositoryRoots.lexical);
    const fileRecords: PacketFileRecord[] = packetStatus.excluded.map(item => ({
      path: item.path,
      category: reviewScope === "repository" ? "repository-file" : "changed-file",
      status: "excluded" as const,
      reason: item.reason
    })).concat(excludedChanged.map(path => ({
      path,
      category: reviewScope === "repository" ? "repository-file" : "changed-file",
      status: "excluded" as const,
      reason: excludedPathReason(path, archivePathPrefix)
    })));
    const sourceSections: Section[] = [];
    const dependencies = new Map<string, Set<string>>();
    const maxSourceBytes = positiveInteger(args.context?.maxSourceFileBytes, DEFAULT_SOURCE_BYTES);

    const candidates = collectCandidateFiles(availableFiles, changed, args, reviewScope);
    for (const candidate of candidates) {
      const normalized = normalizeRepoPath(candidate.path);
      if (SECRET_PATH_PATTERNS.some(pattern => pattern.test(normalized))) {
        fileRecords.push({ path: normalized, category: candidate.category, status: "excluded", reason: "secret_path_policy" });
        continue;
      }
      const generatedReason = generatedPathReason(normalized);
      if (generatedReason !== undefined) {
        const generatedBytes = await readCandidateBytes(repositoryRoot, headSha, normalized, includeWorkingTree, overlayPaths).catch(() => undefined);
        fileRecords.push({
          path: normalized,
          category: candidate.category,
          status: "generated",
          reason: generatedReason,
          ...(generatedBytes === undefined ? {} : { sizeBytes: generatedBytes.length, sha256: hash(generatedBytes) })
        });
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await readCandidateBytes(repositoryRoot, headSha, normalized, includeWorkingTree, overlayPaths);
      } catch {
        fileRecords.push({ path: normalized, category: candidate.category, status: "excluded", reason: "not_present_at_head_or_worktree" });
        continue;
      }
      if (bytes.length > maxSourceBytes) {
        fileRecords.push({ path: normalized, category: candidate.category, status: "oversized", reason: "max_source_file_bytes", sizeBytes: bytes.length });
        continue;
      }
      if (isBinary(bytes)) {
        fileRecords.push({ path: normalized, category: candidate.category, status: "binary", sizeBytes: bytes.length, sha256: hash(bytes) });
        continue;
      }
      const text = bytes.toString("utf8");
      const numbered = lineNumber(text);
      sourceSections.push({
        title: `Source snapshot: ${normalized}`,
        body: `Path: ${normalized}\nCategory: ${candidate.category}\nSHA-256: ${hash(bytes)}\n\n\`\`\`text\n${numbered}\n\`\`\``,
        files: [normalized]
      });
      fileRecords.push({ path: normalized, category: candidate.category, status: "included", sizeBytes: bytes.length, sha256: hash(bytes) });
      for (const symbol of exportedSymbols(text)) {
        const paths = dependencies.get(symbol) ?? new Set<string>();
        paths.add(normalized);
        dependencies.set(symbol, paths);
      }
    }

    const comparisonBaseSha = reviewScope === "repository" ? emptyTreeSha! : mergeBaseSha!;
    const diff = await buildDiff(repositoryRoot, comparisonBaseSha, headSha, includeWorkingTree, excludedChanged, archivePathPrefix);

    const nameStatus = await buildNameStatus(repositoryRoot, comparisonBaseSha, headSha, includeWorkingTree, excludedChanged, archivePathPrefix);
    const callers = args.context?.includeRelevantCallers === true
      ? await callerEvidence(repositoryRoot, headSha, includeWorkingTree, dependencies, changed, archivePathPrefix)
      : "Caller/reference search not requested.";
    const instructions = candidates.filter(item => item.category === "instructions").map(item => item.path);
    const sections: Section[] = [
      {
        title: "Repository provenance",
        files: [],
        body: [
          `Repository root: ${repositoryRoot}`,
          `Review scope: ${reviewScope}`,
          ...(reviewScope === "changes"
            ? [`Base: ${baseRef} (${baseSha})`, `Head: ${headRef} (${headSha})`, `Merge base: ${mergeBaseSha}`]
            : [
                `Baseline: repository-format Git empty tree (${emptyTreeSha})`,
                `Head: ${headRef} (${headSha ?? "unborn; no commits yet"})`,
                "Merge base: not applicable to repository scope"
              ]),
          `Branch: ${branch ?? "(detached or unavailable)"}`,
          `Working tree included: ${includeWorkingTree}`,
          `Working tree dirty: ${dirty}`,
          "",
          "git status --porcelain:",
          "```text",
          packetStatus.visible.trimEnd(),
          "```",
          `Excluded untracked local Codex state paths: ${packetStatus.excluded.filter(item => item.reason === "untracked_local_codex_state").length}`,
          `Excluded archive or sensitive paths: ${packetStatus.excluded.filter(item => item.reason !== "untracked_local_codex_state").length}`
        ].join("\n")
      },
      {
        title: reviewScope === "repository" ? "Repository paths and status evidence" : "Changed paths and rename evidence",
        files: changed,
        body: `\`\`\`text\n${nameStatus.trimEnd()}\n\`\`\``
      },
      {
        title: reviewScope === "repository" ? "Tracked repository diff from the empty tree" : "Line-numbered unified diff",
        files: changed,
        body: `\`\`\`diff\n${diff.trimEnd()}\n\`\`\``
      },
      { title: "Deterministic caller/reference evidence", files: [], body: callers },
      { title: "Governing instruction files", files: instructions, body: instructions.length > 0 ? instructions.join("\n") : "No governing AGENTS.md files were present." },
      ...sourceSections
    ];
    if (validation !== undefined) sections.push({ title: "Caller-supplied validation output", files: [], body: `\`\`\`text\n${validation}\n\`\`\`` });

    const maxPacketBytes = positiveInteger(args.context?.maxPacketBytes, DEFAULT_PACKET_BYTES);
    const maxTotalBytes = positiveInteger(args.context?.maxTotalBytes, DEFAULT_TOTAL_BYTES);
    const headerReserve = Buffer.byteLength(packetHeader(999_999, 999_999));
    if (maxPacketBytes <= headerReserve + 64) {
      throw new ReviewPreparationError("maxPacketBytes is too small for packet framing.", "packet_budget_invalid", { maxPacketBytes }, archiveDirectory);
    }
    const partitioned = partitionSections(sections, maxPacketBytes - headerReserve);
    const serializedPackets = partitioned.map((packet, index) => ({
      ...packet,
      body: `${packetHeader(index + 1, partitioned.length)}${packet.body}`
    }));
    const totalBytes = serializedPackets.reduce((sum, packet) => sum + Buffer.byteLength(packet.body), 0);
    const oversizedPacket = serializedPackets.find(packet => Buffer.byteLength(packet.body) > maxPacketBytes);
    if (oversizedPacket !== undefined) {
      throw new ReviewPreparationError(
        "At least one serialized review packet exceeds maxPacketBytes. Nothing was silently truncated.",
        "packet_budget_exceeded",
        { packetBytes: Buffer.byteLength(oversizedPacket.body), maxPacketBytes },
        archiveDirectory
      );
    }
    if (totalBytes > maxTotalBytes || (serializedPackets.length > 1 && args.context?.onBudgetExceeded === "block")) {
      throw new ReviewPreparationError(
        `Review context requires ${totalBytes} bytes across ${serializedPackets.length} packets, exceeding configured behavior. No content was silently truncated.`,
        "packet_budget_exceeded",
        { totalBytes, maxTotalBytes, packetCount: serializedPackets.length },
        archiveDirectory
      );
    }

    const packetRecords: ReviewPacketManifest["packets"] = [];
    const partitions: ReviewPacketManifest["partitions"] = [];
    const packetPaths: string[] = [];
    for (const [index, packet] of serializedPackets.entries()) {
      const name = `packet-${String(index + 1).padStart(3, "0")}.md`;
      const path = join(archiveDirectory, "context", name);
      const body = packet.body;
      await writeImmutableFile(path, body);
      packetPaths.push(path);
      packetRecords.push({ path: name, sizeBytes: Buffer.byteLength(body), sha256: sha256Text(body), sections: packet.titles });
      partitions.push({ packet: name, files: [...new Set(packet.files)] });
      for (const record of fileRecords) {
        if (record.status === "included" && packet.files.includes(record.path)) record.packet = name;
      }
    }

    const manifest: ReviewPacketManifest = {
      schemaVersion: 1,
      mode: "review-packets",
      generatedAt: now.toISOString(),
      repositoryRoot,
      reviewScope,
      ...(baseRef === undefined ? {} : { baseRef }),
      headRef,
      ...(baseSha === undefined ? {} : { baseSha }),
      ...(headSha === undefined ? {} : { headSha }),
      ...(mergeBaseSha === undefined ? {} : { mergeBaseSha }),
      ...(branch === undefined ? {} : { branch }),
      dirty,
      includeWorkingTree,
      packets: packetRecords,
      files: fileRecords,
      exclusions: fileRecords.filter(item => item.status !== "included").map(item => `${item.path}: ${item.reason ?? item.status}`),
      partitions,
      crossPacketDependencies: [...dependencies.entries()]
        .filter(([, paths]) => paths.size > 1)
        .map(([symbol, paths]) => ({ symbol, paths: [...paths].sort() })),
      validationOutputIncluded: validation !== undefined
    };
    const manifestPath = join(archiveDirectory, "context", "manifest.json");
    await writeImmutableJson(manifestPath, manifest);
    const manifestSha256 = await sha256File(manifestPath);
    const request = requestMarkdown(args, manifest, packetPaths);
    const prompt = reviewPrompt(args, manifest, packetPaths);
    const requestPath = join(archiveDirectory, "request.md");
    const promptPath = join(archiveDirectory, "prompt.md");
    await writeImmutableFile(requestPath, request);
    await writeImmutableFile(promptPath, prompt);
    return { mode: "review-packets", archiveDirectory, requestPath, promptPath, packetPaths, manifestPath, manifest, manifestSha256, prompt };
  } catch (error) {
    if (error instanceof ReviewPreparationError) throw error;
    throw new ReviewPreparationError(
      error instanceof Error ? error.message : String(error),
      "packet_preparation_failed",
      undefined,
      archiveDirectory
    );
  }
}

function usesContextFreeMode(args: ProCodeReviewArgs): boolean {
  if (args.context?.mode === "none") return true;
  if (args.context?.mode === "review-packets") return false;
  const hasPacketOptions = args.context !== undefined && Object.keys(args.context).some(key => key !== "mode");
  return !hasPacketOptions && args.repositoryRoot === undefined && args.baseRef === undefined && args.headRef === undefined;
}

async function prepareContextFreeQuestion(args: ProCodeReviewArgs, now: Date): Promise<PreparedReviewContext> {
  const question = args.request?.additionalInstructions?.trim() ?? "";
  if (question.length === 0) {
    throw new ReviewPreparationError("A context-free AskPro call requires request.additionalInstructions.", "question_required");
  }
  const focus = args.request?.focus?.map(item => item.trim()).filter(Boolean) ?? [];
  const prompt = focus.length === 0
    ? question
    : `${question}\n\nRequested emphasis: ${focus.join(", ")}.`;
  const archiveRoot = args.output?.archiveRoot ?? ".codex/pro-reviews";
  const archiveDirectory = await createReviewArchive(process.cwd(), archiveRoot, undefined, now);
  try {
    const manifest: ReviewPacketManifest = {
      schemaVersion: 1,
      mode: "none",
      generatedAt: now.toISOString(),
      repositoryRoot: "",
      baseRef: "",
      headRef: "",
      dirty: false,
      includeWorkingTree: false,
      packets: [],
      files: [],
      exclusions: [],
      partitions: [],
      crossPacketDependencies: [],
      validationOutputIncluded: false
    };
    const manifestPath = join(archiveDirectory, "context", "manifest.json");
    await writeImmutableJson(manifestPath, manifest);
    const manifestSha256 = await sha256File(manifestPath);
    const requestPath = join(archiveDirectory, "request.md");
    const promptPath = join(archiveDirectory, "prompt.md");
    await writeImmutableFile(requestPath, prompt);
    await writeImmutableFile(promptPath, prompt);
    return {
      mode: "none",
      archiveDirectory,
      requestPath,
      promptPath,
      packetPaths: [],
      manifestPath,
      manifest,
      manifestSha256,
      prompt
    };
  } catch (error) {
    if (error instanceof ReviewPreparationError) throw error;
    throw new ReviewPreparationError(
      error instanceof Error ? error.message : String(error),
      "question_preparation_failed",
      undefined,
      archiveDirectory
    );
  }
}

async function resolveRepositoryRoots(input: string): Promise<RepositoryRoots> {
  const candidate = resolve(input);
  const root = (await gitChecked(candidate, ["rev-parse", "--show-toplevel"], "repository_not_found")).stdout.trim();
  if (root.length === 0) throw new ReviewPreparationError("repositoryRoot is not a Git worktree.", "repository_not_found");
  const prefix = (await gitChecked(candidate, ["rev-parse", "--show-prefix"], "repository_not_found")).stdout.trim();
  const lexical = prefix.length === 0
    ? candidate
    : resolve(candidate, ...prefix.split("/").filter(Boolean).map(() => ".."));
  return { canonical: await realpath(root), lexical };
}

async function changedFiles(
  root: string,
  mergeBase: string,
  headSha: string,
  includeWorkingTree: boolean,
  archivePathPrefix: string | undefined
): Promise<string[]> {
  const committed = parseNameStatus((await gitChecked(root, ["diff", "--name-status", "--find-renames", `${mergeBase}..${headSha}`], "git_diff_name_status_failed")).stdout);
  if (!includeWorkingTree) return [...new Set(committed)].sort();
  const unstaged = parseNameStatus((await gitChecked(root, ["diff", "--name-status", "--find-renames", "HEAD"], "git_worktree_diff_failed")).stdout);
  const untracked = (await gitChecked(root, ["ls-files", "--others", "--exclude-standard"], "git_untracked_list_failed")).stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizeRepoPath)
    .filter(path => !LOCAL_CODEX_STATE_PATTERN.test(path) && !isPacketExcludedPath(path, archivePathPrefix));
  return [...new Set([...committed, ...unstaged, ...untracked].map(normalizeRepoPath))].sort();
}

async function snapshotFiles(
  root: string,
  headSha: string | undefined,
  includeWorkingTree: boolean,
  archivePathPrefix: string | undefined
): Promise<string[]> {
  const committed = headSha === undefined
    ? []
    : (await gitChecked(root, ["ls-tree", "-r", "--name-only", headSha], "git_head_tree_failed")).stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map(normalizeRepoPath);
  if (!includeWorkingTree) return [...new Set(committed)].sort();
  const working = (await gitChecked(root, ["ls-files", "--cached", "--others", "--exclude-standard"], "git_worktree_list_failed")).stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizeRepoPath)
    .filter(path => !LOCAL_CODEX_STATE_PATTERN.test(path) && !isPacketExcludedPath(path, archivePathPrefix));
  return [...new Set([...committed, ...working])].sort();
}

function filterPacketStatus(value: string, archivePathPrefix: string | undefined): { visible: string; excluded: Array<{ path: string; reason: string }> } {
  const excluded: Array<{ path: string; reason: string }> = [];
  const visible = value.split(/\r?\n/).filter(line => {
    if (line.length < 4) return true;
    const paths = statusLinePaths(line);
    const blocked = paths.find(path => isPacketExcludedPath(path, archivePathPrefix)
      || (line.startsWith("?? ") && LOCAL_CODEX_STATE_PATTERN.test(path)));
    if (blocked === undefined) return true;
    excluded.push({
      path: blocked,
      reason: line.startsWith("?? ") && LOCAL_CODEX_STATE_PATTERN.test(blocked)
        ? "untracked_local_codex_state"
        : excludedPathReason(blocked, archivePathPrefix)
    });
    return false;
  }).join("\n");
  return { visible, excluded };
}

function parseNameStatus(value: string): string[] {
  return value.split(/\r?\n/).filter(Boolean).flatMap(line => {
    const parts = line.split("\t");
    if (/^[RC]/.test(parts[0] ?? "")) return parts.slice(1);
    return parts.slice(1, 2);
  }).filter(Boolean);
}

function statusLinePaths(line: string): string[] {
  const payload = line.slice(3).trim();
  const renamed = payload.split(" -> ");
  return renamed.map(path => normalizeRepoPath(path.replace(/^"|"$/g, ""))).filter(Boolean);
}

async function workingTreePaths(root: string, archivePathPrefix: string | undefined): Promise<Set<string>> {
  const status = await gitChecked(root, ["status", "--porcelain=v1", "--untracked-files=all"], "git_status_failed");
  return new Set(status.stdout.split(/\r?\n/).filter(Boolean)
    .flatMap(statusLinePaths)
    .filter(path => !isPacketExcludedPath(path, archivePathPrefix)));
}

async function readCandidateBytes(
  root: string,
  headSha: string | undefined,
  path: string,
  includeWorkingTree: boolean,
  overlayPaths: Set<string>
): Promise<Buffer> {
  if (includeWorkingTree && overlayPaths.has(path)) {
    const absolute = resolve(root, path);
    assertInside(root, absolute);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ReviewPreparationError(`Review candidate is not a regular file: ${path}`, "candidate_not_regular_file");
    }
    return await readFile(absolute);
  }
  if (headSha === undefined) {
    throw new ReviewPreparationError(`No committed Git blob is available for ${path}.`, "git_head_unavailable");
  }
  return await gitBlob(root, headSha, path);
}

function relatedFileStem(path: string): string {
  return basename(path)
    .toLocaleLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/(?:\.|_)(?:test|spec)$/, "");
}

function packetPathspec(excludedPaths: string[], archivePathPrefix: string | undefined): string[] {
  return ["--", ".", ...GENERATED_DIFF_EXCLUDES, ...packetExcludePathspec(excludedPaths, archivePathPrefix)];
}

function packetExcludePathspec(excludedPaths: string[], archivePathPrefix: string | undefined): string[] {
  const exact = excludedPaths.map(path => `:(exclude,literal)${path}`);
  const secretGlobs = [
    ":(exclude,glob)**/.env*",
    ":(exclude,glob)**/credentials*",
    ":(exclude,glob)**/secrets*",
    ":(exclude,glob)**/tokens*",
    ":(exclude,glob)**/.aws/**",
    ":(exclude,glob)**/.azure/**",
    ":(exclude,glob)**/.config/gcloud/**",
    ":(exclude,glob)**/*.pem",
    ":(exclude,glob)**/*.p12",
    ":(exclude,glob)**/*.pfx",
    ":(exclude,glob)**/*.key",
    ":(exclude,glob)**/*.keystore"
  ];
  const archive = archivePathPrefix === undefined
    ? []
    : [`:(exclude,literal)${archivePathPrefix}`, `:(exclude,glob)${archivePathPrefix}/**`];
  return [...exact, ...secretGlobs, ...archive];
}

function collectCandidateFiles(
  availableFiles: string[],
  changed: string[],
  args: ProCodeReviewArgs,
  reviewScope: ReviewScope
): Array<{ path: string; category: string }> {
  const records = new Map<string, string>();
  if (args.context?.includeChangedFiles !== false) {
    for (const path of changed) {
      records.set(path, reviewScope === "repository"
        ? (TEST_PATTERN.test(path) ? "repository-test" : "repository-file")
        : (TEST_PATTERN.test(path) ? "changed-test" : "changed-file"));
    }
  }
  if (args.context?.includeInstructions === true) {
    for (const path of governingInstructions(availableFiles, changed)) records.set(path, "instructions");
  }
  for (const path of availableFiles.filter(path => MANIFEST_PATTERN.test(path))) {
    if (changed.includes(path) || affectsChangedPath(path, changed)) records.set(path, "manifest-interface");
  }
  if (args.context?.includeRelatedTests === true) {
    const stems = new Set(changed.map(path => relatedFileStem(path)));
    for (const path of availableFiles.filter(path => TEST_PATTERN.test(path))) {
      if (changed.includes(path) || [...stems].some(stem => stem.length > 2 && relatedFileStem(path) === stem)) records.set(path, "related-test");
    }
  }
  return [...records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, category]) => ({ path, category }));
}

function governingInstructions(tracked: string[], changed: string[]): string[] {
  const instructions = tracked.filter(path => basename(path).toLocaleUpperCase() === "AGENTS.MD");
  return instructions.filter(instruction => changed.some(path => {
    const scope = dirname(instruction);
    return scope === "." || path === scope || path.startsWith(`${scope}/`);
  }));
}

function affectsChangedPath(path: string, changed: string[]): boolean {
  const dir = dirname(path);
  return changed.some(item => dir === "." || item.startsWith(`${dir}/`));
}

async function buildDiff(
  root: string,
  comparisonBase: string,
  headSha: string | undefined,
  includeWorkingTree: boolean,
  excludedPaths: string[],
  archivePathPrefix: string | undefined
): Promise<string> {
  const pathspec = packetPathspec(excludedPaths, archivePathPrefix);
  const committed = headSha === undefined
    ? ""
    : (await gitChecked(root, ["diff", "--no-ext-diff", "--find-renames", "--unified=80", comparisonBase, headSha, ...pathspec], "git_diff_failed")).stdout;
  if (!includeWorkingTree) return committed;
  if (headSha !== undefined) {
    const working = (await gitChecked(root, ["diff", "--no-ext-diff", "--find-renames", "--unified=80", "HEAD", ...pathspec], "git_worktree_diff_failed")).stdout;
    return [committed, working.length > 0 ? `\n# WORKING TREE DIFF\n${working}` : ""].join("");
  }
  const staged = (await gitChecked(root, ["diff", "--cached", "--no-ext-diff", "--find-renames", "--unified=80", comparisonBase, ...pathspec], "git_worktree_diff_failed")).stdout;
  const unstaged = (await gitChecked(root, ["diff", "--no-ext-diff", "--find-renames", "--unified=80", ...pathspec], "git_worktree_diff_failed")).stdout;
  return [
    staged.length > 0 ? `# INDEX DIFF FROM EMPTY TREE\n${staged}` : "",
    unstaged.length > 0 ? `\n# UNSTAGED WORKING TREE DIFF\n${unstaged}` : ""
  ].join("");
}

async function buildNameStatus(
  root: string,
  comparisonBase: string,
  headSha: string | undefined,
  includeWorkingTree: boolean,
  excludedPaths: string[],
  archivePathPrefix: string | undefined
): Promise<string> {
  const pathspec = ["--", ".", ...packetExcludePathspec(excludedPaths, archivePathPrefix)];
  const committed = headSha === undefined
    ? ""
    : (await gitChecked(root, ["diff", "--name-status", "--find-renames", comparisonBase, headSha, ...pathspec], "git_diff_name_status_failed")).stdout;
  if (!includeWorkingTree) return committed;
  const working = headSha === undefined
    ? [
        (await gitChecked(root, ["diff", "--cached", "--name-status", "--find-renames", comparisonBase, ...pathspec], "git_worktree_name_status_failed")).stdout,
        (await gitChecked(root, ["diff", "--name-status", "--find-renames", ...pathspec], "git_worktree_name_status_failed")).stdout
      ].filter(Boolean).join("\n")
    : (await gitChecked(root, ["diff", "--name-status", "--find-renames", "HEAD", ...pathspec], "git_worktree_name_status_failed")).stdout;
  const untracked = (await gitChecked(root, ["ls-files", "--others", "--exclude-standard"], "git_untracked_list_failed")).stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizeRepoPath)
    .filter(path => !LOCAL_CODEX_STATE_PATTERN.test(path) && !isPacketExcludedPath(path, archivePathPrefix))
    .map(path => `?\t${path}`)
    .join("\n");
  return [committed, working, untracked].filter(Boolean).join("\n");
}

async function callerEvidence(
  root: string,
  headSha: string | undefined,
  includeWorkingTree: boolean,
  symbols: Map<string, Set<string>>,
  changed: string[],
  archivePathPrefix: string | undefined
): Promise<string> {
  const lines: string[] = [];
  for (const symbol of [...symbols.keys()].sort().slice(0, 80)) {
    const tree = includeWorkingTree || headSha === undefined ? [] : [headSha];
    const result = await gitChecked(root, ["grep", "-n", "-I", "-F", "-e", symbol, ...tree, "--", ":(exclude)*.lock", ...packetExcludePathspec([], archivePathPrefix)], "git_caller_search_failed", [1]);
    const matches = result.stdout.split(/\r?\n/).filter(Boolean).map(line =>
      includeWorkingTree || headSha === undefined || !line.startsWith(`${headSha}:`) ? line : line.slice(headSha.length + 1)
    ).filter(line => {
      const path = normalizeRepoPath(line.split(":", 1)[0] ?? "");
      return !changed.some(changedPath => path === changedPath) && !isPacketExcludedPath(path, archivePathPrefix);
    }).slice(0, 40);
    if (matches.length > 0) lines.push(`## ${symbol}\n${matches.join("\n")}`);
  }
  return lines.length > 0 ? `\`\`\`text\n${lines.join("\n\n")}\n\`\`\`` : "No deterministic external caller/reference matches were found for exported symbols in included files.";
}

function exportedSymbols(text: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /\bexport\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\bpub(?:lic)?\s+(?:async\s+)?(?:fn|struct|enum|trait|class|interface)\s+([A-Za-z_$][\w$]*)/g,
    /\bdef\s+([A-Za-z_][\w]*)\s*\(/g
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) if (match[1] !== undefined) symbols.add(match[1]);
  }
  return [...symbols];
}

function partitionSections(sections: Section[], maxBytes: number): Array<{ body: string; titles: string[]; files: string[] }> {
  const chunks = sections.flatMap(section => splitSection(section, maxBytes));
  const packets: Array<{ body: string; titles: string[]; files: string[] }> = [];
  let current = { body: "", titles: [] as string[], files: [] as string[] };
  for (const chunk of chunks) {
    const rendered = `## ${chunk.title}\n\n${chunk.body}\n\n`;
    if (current.body.length > 0 && Buffer.byteLength(current.body) + Buffer.byteLength(rendered) > maxBytes) {
      packets.push(current);
      current = { body: "", titles: [], files: [] };
    }
    current.body += rendered;
    current.titles.push(chunk.title);
    current.files.push(...chunk.files);
  }
  if (current.body.length > 0) packets.push(current);
  return packets;
}

function splitSection(section: Section, maxBytes: number): Section[] {
  const overhead = Buffer.byteLength(`## ${section.title} (part 999)\n\n`);
  if (Buffer.byteLength(section.body) + overhead <= maxBytes) return [section];
  const lines = section.body.split("\n");
  const parts: string[] = [];
  let current = "";
  for (const line of lines) {
    const lineParts = splitUtf8ByBytes(line, Math.max(1, maxBytes - overhead));
    for (const linePart of lineParts) {
      const next = `${current}${current.length > 0 ? "\n" : ""}${linePart}`;
      if (current.length > 0 && Buffer.byteLength(next) + overhead > maxBytes) {
        parts.push(current);
        current = linePart;
      } else current = next;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts.map((body, index) => ({ ...section, title: `${section.title} (part ${index + 1}/${parts.length})`, body }));
}

function splitUtf8ByBytes(value: string, maxBytes: number): string[] {
  if (Buffer.byteLength(value) <= maxBytes) return [value];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function packetHeader(index: number, total: number): string {
  return `# Context packet ${index} of ${total}\n\n`;
}

function reviewPrompt(args: ProCodeReviewArgs, manifest: ReviewPacketManifest, packetPaths: string[]): string {
  const focus = args.request?.focus?.length ? args.request.focus.join(", ") : undefined;
  const extra = args.request?.additionalInstructions?.trim();
  const reviewScope = manifest.reviewScope ?? "changes";
  return [
    reviewLabel(manifest),
    "",
    "Answer the caller's request using the attached repository context.",
    "",
    extra === undefined || extra.length === 0
      ? `Caller request: Analyze the attached ${reviewScope === "repository" ? "repository" : "change"} and provide the most useful grounded response.`
      : `Caller request: ${extra}`,
    focus === undefined ? "" : `Requested emphasis: ${focus}.`,
    reviewScope === "repository"
      ? `Scope: complete repository snapshot at ${manifest.headRef} (${manifest.headSha ?? "unborn; working tree only"}).`
      : `Scope: ${manifest.baseRef} (${manifest.baseSha}) through ${manifest.headRef} (${manifest.headSha}); merge base ${manifest.mergeBaseSha}.`,
    `Attached context: ${packetPaths.length} packet${packetPaths.length === 1 ? "" : "s"}, packet-001 through packet-${String(packetPaths.length).padStart(3, "0")}.`
  ].filter(Boolean).join("\n");
}

function reviewLabel(manifest: ReviewPacketManifest): string {
  const repositoryName = basename(manifest.repositoryRoot) || "repository";
  return `Codex Pro request - ${repositoryName} @ ${manifest.headSha?.slice(0, 12) ?? manifest.headRef}`;
}

function requestMarkdown(args: ProCodeReviewArgs, manifest: ReviewPacketManifest, packetPaths: string[]): string {
  const reviewScope = manifest.reviewScope ?? "changes";
  return [
    "# ChatGPT Pro request",
    "",
    `Review scope: \`${reviewScope}\``,
    reviewScope === "changes" ? `Base: \`${manifest.baseRef}\`` : "",
    `Head: \`${manifest.headRef}\``,
    `Requested emphasis: ${(args.request?.focus ?? []).join(", ") || "none"}`,
    `Output mode: \`${args.output?.mode ?? "full"}\``,
    `Packets: ${packetPaths.length}`,
    "",
    args.request?.additionalInstructions ?? ""
  ].join("\n");
}

async function validationOutput(args: ProCodeReviewArgs, root: string, lexicalRoot: string): Promise<string | undefined> {
  if (args.context?.includeValidationOutput === false) return undefined;
  if (args.context?.validationOutput !== undefined) return args.context.validationOutput;
  const path = args.context?.validationOutputPath;
  if (path === undefined) return undefined;
  const supplied = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (!isInside(root, supplied) && !isInside(lexicalRoot, supplied)) {
    throw new ReviewPreparationError(`Path escapes repository root: ${supplied}`, "repository_path_escape");
  }
  // Canonicalize the parent without following the leaf. macOS exposes /var as
  // a link to /private/var, and Windows can likewise alias temporary roots.
  // Comparing the uncanonicalized spelling to a real repository root would
  // reject an otherwise in-repository path before we can inspect the leaf.
  const absolute = join(await realpath(dirname(supplied)), basename(supplied));
  assertInside(root, absolute);
  const linkInfo = await lstat(absolute);
  if (linkInfo.isSymbolicLink()) {
    throw new ReviewPreparationError("validationOutputPath must not be a symbolic link.", "validation_output_symlink");
  }
  const resolved = await realpath(absolute);
  assertInside(root, resolved);
  const info = await stat(resolved);
  if (!info.isFile()) throw new ReviewPreparationError("validationOutputPath must be a regular file.", "validation_output_not_regular");
  if (info.size > DEFAULT_SOURCE_BYTES) throw new ReviewPreparationError("Validation output exceeds the portable safety limit.", "validation_output_oversized");
  return await readFile(resolved, "utf8");
}

function emptyManifest(input: Omit<ReviewPacketManifest, "schemaVersion" | "packets" | "exclusions" | "partitions" | "crossPacketDependencies" | "validationOutputIncluded">): ReviewPacketManifest {
  return {
    schemaVersion: 1,
    ...input,
    packets: [],
    exclusions: input.files.filter(item => item.status !== "included").map(item => `${item.path}: ${item.reason ?? item.status}`),
    partitions: [],
    crossPacketDependencies: [],
    validationOutputIncluded: false
  };
}

async function gitCommit(root: string, ref: string): Promise<string | undefined> {
  const result = await runGit(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length === 0 ? undefined : value;
}

async function gitRequired(root: string, args: string[], code: string): Promise<string> {
  const result = await gitChecked(root, args, code);
  const value = result.stdout.trim();
  if (value.length === 0) throw new ReviewPreparationError(result.stderr.trim() || `git ${args.join(" ")} returned no value.`, code);
  return value;
}

async function gitChecked(root: string, args: string[], code: string, allowedNonzero: number[] = []): Promise<GitResult> {
  const result = await runGit(root, args);
  if (result.code !== 0 && !allowedNonzero.includes(result.code)) {
    throw new ReviewPreparationError(result.stderr.trim() || `git ${args.join(" ")} failed with exit code ${result.code}.`, code);
  }
  return result;
}

async function gitBlob(root: string, headSha: string, path: string): Promise<Buffer> {
  const result = await runGitBuffer(root, ["show", `${headSha}:${path}`]);
  if (result.code !== 0) {
    throw new ReviewPreparationError(result.stderr.toString("utf8").trim() || `Git blob is unavailable at ${headSha}:${path}.`, "git_blob_unavailable");
  }
  return result.stdout;
}

async function runGit(root: string, args: string[]): Promise<GitResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn("git", ["-c", "core.quotepath=false", ...args], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", code => resolveResult({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code: code ?? -1 }));
  });
}

async function runGitBuffer(root: string, args: string[]): Promise<{ stdout: Buffer; stderr: Buffer; code: number }> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn("git", ["-c", "core.quotepath=false", ...args], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", code => resolveResult({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? -1 }));
  });
}

function lineNumber(value: string): string {
  return value.split(/\r?\n/).map((line, index) => `${String(index + 1).padStart(6, " ")} | ${line}`).join("\n");
}

function isBinary(value: Buffer): boolean {
  return value.subarray(0, Math.min(value.length, 8192)).includes(0);
}

function hash(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function repositoryRelativeArchivePrefix(root: string, archiveRoot: string): string | undefined {
  const absolute = isAbsolute(archiveRoot) ? resolve(archiveRoot) : resolve(root, archiveRoot);
  const rel = relative(resolve(root), absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return normalizeRepoPath(rel).replace(/\/$/, "");
}

function isPacketExcludedPath(path: string, archivePathPrefix: string | undefined): boolean {
  const normalized = normalizeRepoPath(path);
  return SECRET_PATH_PATTERNS.some(pattern => pattern.test(normalized))
    || (archivePathPrefix !== undefined && (normalized === archivePathPrefix || normalized.startsWith(`${archivePathPrefix}/`)));
}

function excludedPathReason(path: string, archivePathPrefix: string | undefined): string {
  const normalized = normalizeRepoPath(path);
  if (archivePathPrefix !== undefined && (normalized === archivePathPrefix || normalized.startsWith(`${archivePathPrefix}/`))) {
    return "review_archive_path";
  }
  return "secret_path_policy";
}

function generatedPathReason(path: string): string | undefined {
  if (GENERATED_PLUGIN_RUNTIME_PATTERN.test(path)) return "generated_plugin_runtime";
  if (GENERATED_DIRECTORY_PATTERN.test(path)) return "generated_directory";
  return undefined;
}

function assertInside(root: string, target: string): void {
  if (isInside(root, target)) return;
  throw new ReviewPreparationError(`Path escapes repository root: ${target}`, "repository_path_escape");
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ReviewPreparationError(`${name} must be non-empty.`, `invalid_${name}`);
  return trimmed;
}
