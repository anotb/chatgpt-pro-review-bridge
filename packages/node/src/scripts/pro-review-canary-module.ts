import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createChatGPT } from "../client.js";
import { redactReportValue } from "../safety/report-redaction.js";
import type { BrowserLike, PageLike } from "../types.js";
import type { ProCodeReviewResult } from "../reviews/types.js";

export type ProReviewCanaryResume = {
  repositoryRoot: string;
  token: string;
  archiveDirectory: string;
  threadUrl: string;
  requireArtifact: boolean;
};

export type ProReviewCanaryOptions = {
  reportDir?: string;
  requireArtifact?: boolean;
  resume?: ProReviewCanaryResume;
};

export type ProReviewCanaryResult = {
  ok: boolean;
  status: ProCodeReviewResult["status"];
  token: string;
  review: ProCodeReviewResult;
  resume?: ProReviewCanaryResume;
  checks: {
    fullResponseToken: boolean;
    exactlyOneVisibleUserPrompt: boolean;
    proVerifiedBefore: boolean;
    proVerifiedAfter: boolean;
    configurationRestored: boolean;
    artifactsCaptured: boolean;
    artifactContentToken: boolean;
  };
  failures: string[];
  diagnosticPath: string;
};

type CanaryRuntime = { agent: unknown; browser?: BrowserLike };

export async function runProReviewCanaryStep(
  runtime: CanaryRuntime,
  options: ProReviewCanaryOptions = {}
): Promise<ProReviewCanaryResult> {
  if (runtime.agent === undefined || runtime.agent === null) {
    throw new Error("The Pro review canary must run in a visible Codex browser-bridge JavaScript context.");
  }
  const reportDir = resolve(options.reportDir ?? join(process.cwd(), "reports", "pro-review-canary"));
  await mkdir(reportDir, { recursive: true });
  const state = options.resume ?? await createFixture(reportDir, options.requireArtifact ?? true);
  const chatgpt = createChatGPT({ agent: runtime.agent, ...(runtime.browser === undefined ? {} : { browser: runtime.browser }) });
  const artifactInstruction = state.requireArtifact
    ? `Also create a downloadable CSV named review-canary-${state.token}.csv with one header named token and one row containing exactly ${state.token}.`
    : "Do not create an artifact for this canary.";
  const common = {
    repositoryRoot: state.repositoryRoot,
    baseRef: "HEAD",
    headRef: "HEAD",
    request: {
      focus: ["correctness", "tests"],
      additionalInstructions: `Start the response with the exact line CANARY_OK:${state.token}. ${artifactInstruction}`
    },
    output: {
      mode: "full" as const,
      archive: true,
      archiveRoot: join(reportDir, "runs"),
      downloadArtifacts: "all" as const,
      returnFullMarkdown: true
    },
    polling: { callTimeoutMs: 25_000, totalTimeoutMs: 25_000, maxPollCallsPerInvocation: 1, stableMs: 1_500, pollMs: 750 },
    diagnosticMetadata: { canary: true, token: state.token }
  };
  const review = options.resume === undefined
    ? await chatgpt.reviews.codeReview(common)
    : await chatgpt.reviews.codeReview({
        ...common,
        resume: {
          threadUrl: state.threadUrl,
          submitted: true,
          archiveDirectory: state.archiveDirectory
        }
      });

  const promptCount = review.thread?.url === undefined
    ? 0
    : await countVisibleUserPrompts(runtime.browser, review.thread.url, state.token);
  const artifactToken = await artifactContainsToken(review, state.token);
  const checks = {
    fullResponseToken: review.responseMarkdown?.includes(`CANARY_OK:${state.token}`) === true,
    exactlyOneVisibleUserPrompt: promptCount === 1,
    proVerifiedBefore: review.configuration.verifiedBeforeSubmit,
    proVerifiedAfter: review.configuration.verifiedAfterCompletion,
    configurationRestored: review.configuration.restorationVerified,
    artifactsCaptured: !state.requireArtifact || review.artifacts.length > 0,
    artifactContentToken: !state.requireArtifact || artifactToken
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (review.status === "in_progress") failures.length = 0;
  const diagnosticPath = join(reportDir, `canary-${state.token}.redacted.json`);
  const resume = review.status === "in_progress" && review.thread?.url !== undefined && review.archiveDirectory !== undefined
    ? {
        repositoryRoot: state.repositoryRoot,
        token: state.token,
        archiveDirectory: review.archiveDirectory,
        threadUrl: review.thread.url,
        requireArtifact: state.requireArtifact
      }
    : undefined;
  const result: ProReviewCanaryResult = {
    ok: review.status === "in_progress" ? true : review.ok && failures.length === 0,
    status: review.status,
    token: state.token,
    review,
    checks,
    failures,
    diagnosticPath,
    ...(resume === undefined ? {} : { resume })
  };
  await writeFile(diagnosticPath, `${JSON.stringify(redactReportValue({ ...result, review: reviewReceipt(review) }), null, 2)}\n`, "utf8");
  return result;
}

async function createFixture(reportDir: string, requireArtifact: boolean): Promise<ProReviewCanaryResume> {
  const token = randomUUID().replace(/-/g, "").slice(0, 16);
  const repositoryRoot = await mkdtemp(join(reportDir, `fixture-${token}-`));
  await mkdir(join(repositoryRoot, "src"), { recursive: true });
  await writeFile(join(repositoryRoot, "src", "counter.js"), "export function next(value) { return value + 1; }\n", "utf8");
  await runGit(repositoryRoot, ["init", "-b", "main"]);
  await runGit(repositoryRoot, ["config", "user.name", "Pro Review Canary"]);
  await runGit(repositoryRoot, ["config", "user.email", "pro-review-canary@example.invalid"]);
  await runGit(repositoryRoot, ["add", "."]);
  await runGit(repositoryRoot, ["commit", "-m", "canary base"]);
  await writeFile(join(repositoryRoot, "src", "counter.js"), "export function next(value) {\n  if (!Number.isFinite(value)) throw new TypeError('finite value required');\n  return value + 1;\n}\n", "utf8");
  return { repositoryRoot, token, archiveDirectory: "", threadUrl: "", requireArtifact };
}

async function countVisibleUserPrompts(browser: BrowserLike | undefined, threadUrl: string, token: string): Promise<number> {
  const openTabs = await browser?.user?.openTabs?.();
  const candidates = Array.isArray(openTabs) ? openTabs.filter(tab => tab.url === threadUrl) : [];
  if (candidates.length !== 1 || browser?.user?.claimTab === undefined) return 0;
  const page = await browser.user.claimTab(candidates[0]!);
  if (typeof page.evaluate !== "function") return 0;
  return page.evaluate((wanted: string) => Array.from(document.querySelectorAll("[data-message-author-role='user']"))
    .filter(node => ((node as HTMLElement).innerText ?? node.textContent ?? "").includes(wanted)).length, token);
}

async function artifactContainsToken(review: ProCodeReviewResult, token: string): Promise<boolean> {
  for (const artifact of review.artifacts) {
    const body = await readFile(artifact.path).catch(() => undefined);
    if (body !== undefined && body.includes(Buffer.from(token))) return true;
  }
  return false;
}

function reviewReceipt(review: ProCodeReviewResult): unknown {
  return {
    ...review,
    responseMarkdown: review.responseMarkdown === undefined
      ? undefined
      : { bytes: Buffer.byteLength(review.responseMarkdown), containsCanaryMarker: /CANARY_OK:/.test(review.responseMarkdown) }
  };
}

async function runGit(root: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    child.stderr.on("data", chunk => errors.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolvePromise() : reject(new Error(Buffer.concat(errors).toString("utf8"))));
  });
}
