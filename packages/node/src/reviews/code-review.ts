import { mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { parseConversationId, readPageState, type PageState } from "../browser/page-state.js";
import { captureArtifactBaseline, captureArtifactDelta } from "../commands/artifact-inventory.js";
import { downloadLatestArtifact } from "../commands/artifacts.js";
import { applyConfiguration, configurationMatchesSelection, inspectConfiguration, restoreConfiguration, snapshotConfiguration } from "../commands/configuration.js";
import { openExperience } from "../commands/experience.js";
import { attachFiles, downloadLatestFile } from "../commands/files.js";
import { composeMessage, messageStatus, readLatest, submitMessage, waitForMessage } from "../commands/messages.js";
import { bootstrap } from "../commands/session.js";
import { newThread, openThread, searchThreads } from "../commands/threads.js";
import { redactReportValue } from "../safety/report-redaction.js";
import type {
  ApplyConfigurationData,
  ArtifactDeltaData,
  ArtifactInventoryData,
  CommandResult,
  ConfigurationInspectionData,
  ConfigurationSnapshotData,
  DownloadedFile,
  MessageStatusData,
  OpenThreadData,
  ReadLatestData,
  RestoreConfigurationData,
  RuntimeEnv,
  SubmitData,
  WaitData
} from "../types.js";
import {
  assertPathInside,
  markdownSectionIndex,
  preserveDownloadedArtifact,
  sanitizeArtifactFilename,
  sha256File,
  sha256Text,
  writeImmutableFile,
  writeImmutableJson
} from "./archive.js";
import { parseFindingsAppendix } from "./findings.js";
import { prepareReviewContext, ReviewPreparationError } from "./packet-builder.js";
import type {
  PreparedReviewContext,
  ProCodeReviewArgs,
  ProCodeReviewResult,
  ReviewArtifact,
  ReviewState,
  ReviewStepEvidence
} from "./types.js";

export type ReviewWorkflowPort = {
  now(): Date;
  bootstrap(target?: { url?: string; conversationId?: string }): Promise<CommandResult<unknown>>;
  openChat(): Promise<CommandResult<unknown>>;
  newThread(): Promise<CommandResult<OpenThreadData>>;
  openThread(target: { url?: string; conversationId?: string }): Promise<CommandResult<OpenThreadData>>;
  recoverThread(query: string, expectedPrompt: string): Promise<CommandResult<OpenThreadData>>;
  snapshotConfiguration(): Promise<CommandResult<ConfigurationSnapshotData>>;
  applyPro(): Promise<CommandResult<ApplyConfigurationData>>;
  inspectConfiguration(): Promise<CommandResult<ConfigurationInspectionData>>;
  restoreConfiguration(snapshot: ConfigurationSnapshotData): Promise<CommandResult<RestoreConfigurationData>>;
  pageState(): Promise<PageState>;
  artifactBaseline(): Promise<CommandResult<ArtifactInventoryData>>;
  artifactDelta(baseline: ArtifactInventoryData): Promise<CommandResult<ArtifactDeltaData>>;
  attach(paths: string[]): Promise<CommandResult<unknown>>;
  messageStatus(): Promise<CommandResult<MessageStatusData>>;
  compose(text: string): Promise<CommandResult<unknown>>;
  submit(text: string, previousTurnCount: number | undefined): Promise<CommandResult<SubmitData>>;
  waitMetadata(afterAssistantTurnCount: number, timeoutMs: number, stableMs: number, pollMs: number): Promise<CommandResult<WaitData>>;
  readFullMarkdown(): Promise<CommandResult<ReadLatestData>>;
  readLatestUser(): Promise<CommandResult<ReadLatestData>>;
  downloadFile(destDir: string, filename: string, assistantIndex: number, occurrenceIndex: number): Promise<CommandResult<DownloadedFile>>;
  downloadImage(destDir: string, index: number, turnId?: string): Promise<CommandResult<DownloadedFile>>;
};

class ReviewWorkflowError extends Error {
  constructor(readonly result: CommandResult<unknown>, readonly state: ReviewState) {
    super(result.blocker?.message ?? result.error?.message ?? `Review workflow failed during ${state}.`);
    this.name = "ReviewWorkflowError";
  }
}

class ReviewInProgress extends Error {
  constructor() {
    super("The submitted review is still generating.");
    this.name = "ReviewInProgress";
  }
}

export async function codeReview(env: RuntimeEnv, args: ProCodeReviewArgs): Promise<ProCodeReviewResult> {
  return runCodeReviewWithPort(args, defaultReviewWorkflowPort(env));
}

export async function runCodeReviewWithPort(args: ProCodeReviewArgs, port: ReviewWorkflowPort): Promise<ProCodeReviewResult> {
  const headRef = args.headRef ?? "HEAD";
  const requested = { experience: "chat" as const, intelligence: "Pro" as const };
  const steps: ReviewStepEvidence[] = [];
  const warnings: string[] = [];
  const artifacts: ReviewArtifact[] = [];
  let prepared: PreparedReviewContext | undefined;
  let archiveDirectory = args.resume?.archiveDirectory;
  let configurationBefore: ConfigurationSnapshotData | undefined;
  let applied: ConfigurationInspectionData | undefined;
  let verifiedBeforeSubmit = false;
  let verifiedAfterCompletion = false;
  let restored = false;
  let restorationVerified = false;
  let submitted = false;
  let threadUrl = args.resume?.threadUrl;
  let threadId = args.resume?.conversationId;
  let responseMarkdown: string | undefined;
  let responseSha256: string | undefined;
  let blocker: CommandResult["blocker"] | undefined;
  let terminalStatus: ProCodeReviewResult["status"] = "failed";
  let artifactBaseline: ArtifactInventoryData | undefined = args.resume?.artifactBaseline;
  let primaryError: unknown;
  let recoveryQuery: string | undefined;
  let releaseLease: (() => Promise<void>) | undefined;
  let archivedSubmission: ArchivedSubmission | undefined;

  const runStep = async <T>(state: ReviewState, operation: () => Promise<T>): Promise<T> => {
    const startedAt = port.now().toISOString();
    try {
      const value = await operation();
      const endedAt = port.now().toISOString();
      if (isCommandResult(value)) {
        const evidence: ReviewStepEvidence = { state, startedAt, endedAt, ok: value.ok, status: value.status };
        if (value.data !== undefined) evidence.data = state === "READ_FULL_MARKDOWN_ONCE" ? responseMetadata(value.data) : value.data;
        if (value.blocker !== undefined) evidence.blocker = value.blocker;
        steps.push(evidence);
      } else {
        steps.push({ state, startedAt, endedAt, ok: true, data: value });
      }
      if (archiveDirectory !== undefined) {
        await writeJsonReplacing(join(archiveDirectory, "workflow-progress.json"), {
          lastCompletedState: state,
          updatedAt: endedAt,
          steps
        }).catch(() => undefined);
      }
      return value;
    } catch (error) {
      const endedAt = port.now().toISOString();
      steps.push({ state, startedAt, endedAt, ok: false, status: error instanceof Error ? error.name : "error" });
      if (archiveDirectory !== undefined) {
        await writeJsonReplacing(join(archiveDirectory, "workflow-progress.json"), {
          lastFailedState: state,
          updatedAt: endedAt,
          steps
        }).catch(() => undefined);
      }
      throw error;
    }
  };

  try {
    if (args.resume === undefined) {
      prepared = await runStep("PREPARE_CONTEXT", () => prepareReviewContext(args, port.now()));
      archiveDirectory = prepared.archiveDirectory;
      releaseLease = await acquireReviewLease(archiveDirectory, port.now());
    } else {
      archiveDirectory = args.resume.archiveDirectory;
      releaseLease = await acquireReviewLease(archiveDirectory, port.now());
      prepared = await readArchivedPreparedContext(args.resume.archiveDirectory);
      try {
        configurationBefore = await readArchivedConfigurationSnapshot(archiveDirectory);
      } catch (error) {
        throw new ReviewPreparationError(
          `The original configuration snapshot is missing or invalid; automatic restoration cannot be proven. ${error instanceof Error ? error.message : String(error)}`,
          "resume_configuration_snapshot_invalid"
        );
      }
      archivedSubmission = await readArchivedSubmission(args.resume.archiveDirectory, sha256Text(normalizePrompt(prepared.prompt)));
      const checkpoint = await readOptionalThreadCheckpoint(args.resume.archiveDirectory);
      validateThreadCheckpoint(checkpoint, archivedSubmission, prepared);
      const archivedTarget = checkpoint !== undefined
        && (archivedSubmission.state === "intent" || isProvisionalConversationId(archivedSubmission.thread.id))
        ? checkpoint.current
        : archivedSubmission.thread;
      const archivedThreadId = archivedTarget.id ?? conversationIdFromUrl(archivedTarget.url);
      const suppliedUrlId = conversationIdFromUrl(threadUrl);
      if (threadId !== undefined && archivedThreadId !== undefined && threadId !== archivedThreadId) {
        throw new ReviewPreparationError("resume.conversationId does not match the immutable archived submission receipt.", "resume_thread_mismatch");
      }
      if (suppliedUrlId !== undefined && archivedThreadId !== undefined && suppliedUrlId !== archivedThreadId) {
        throw new ReviewPreparationError("resume.threadUrl does not match the immutable archived submission receipt.", "resume_thread_mismatch");
      }
      threadId = archivedThreadId ?? threadId ?? suppliedUrlId;
      threadUrl = archivedTarget.url ?? threadUrl;
      if (args.resume.artifactBaseline !== undefined
        && sha256Text(JSON.stringify(args.resume.artifactBaseline)) !== sha256Text(JSON.stringify(archivedSubmission.artifactBaseline))) {
        throw new ReviewPreparationError("resume.artifactBaseline does not match the immutable archived submission baseline.", "resume_artifact_baseline_mismatch");
      }
      artifactBaseline = archivedSubmission.artifactBaseline;
      recoveryQuery = checkpoint?.recoveryQuery ?? recoveryQueryFromPrepared(prepared);
      submitted = true;
    }

    requireOk(await runStep("PREFLIGHT_BROWSER", () => port.bootstrap(args.resume === undefined ? undefined : {
      ...(threadUrl === undefined ? {} : { url: threadUrl }),
      ...(threadId === undefined ? {} : { conversationId: threadId })
    })), "PREFLIGHT_BROWSER");
    requireOk(await runStep("OPEN_CHAT", () => port.openChat()), "OPEN_CHAT");
    if (args.resume === undefined) {
      const opened = requireData(await runStep("OPEN_CHAT", () => port.newThread()), "OPEN_CHAT");
      threadUrl = opened.data.url || opened.context.url;
      threadId = opened.data.conversationId ?? opened.context.conversationId;
    } else {
      const intentNeedsRecovery = archivedSubmission?.state === "intent"
        && (threadId === undefined || isProvisionalConversationId(threadId))
        && conversationIdFromUrl(threadUrl) === undefined;
      let openResult = intentNeedsRecovery
        ? await runStep("RECOVER_THREAD", () => port.recoverThread(recoveryQuery!, prepared!.prompt))
        : await runStep("OPEN_CHAT", () => port.openThread({
            ...(threadId === undefined ? {} : { conversationId: threadId }),
            ...(threadUrl === undefined ? {} : { url: threadUrl })
          }));
      if (!openResult.ok && isProvisionalConversationId(threadId) && recoveryQuery !== undefined) {
        openResult = await runStep("RECOVER_THREAD", () => port.recoverThread(recoveryQuery!, prepared!.prompt));
      }
      const opened = requireData(openResult, openResult.ok ? "OPEN_CHAT" : "RECOVER_THREAD");
      const openedThreadId = opened.data.conversationId ?? conversationIdFromUrl(opened.data.url || opened.context.url);
      const expectedThreadId = archivedSubmission?.thread.id ?? conversationIdFromUrl(archivedSubmission?.thread.url);
      if (expectedThreadId !== undefined
        && openedThreadId !== undefined
        && !isProvisionalConversationId(expectedThreadId)
        && openedThreadId !== expectedThreadId) {
        throw new ReviewPreparationError("The visible opened thread does not match the immutable submission receipt.", "resume_opened_thread_mismatch");
      }
      threadUrl = opened.data.url || opened.context.url || threadUrl;
      threadId = opened.data.conversationId ?? opened.context.conversationId;
      await persistThreadCheckpoint(archiveDirectory!, prepared!, threadUrl, threadId, port.now());
      const latestUser = requireData(await port.readLatestUser(), "POLL_METADATA");
      const observedUserSha256 = sha256Text(normalizePrompt(latestUser.data.text));
      const expectedUserSha256 = archivedSubmission?.userTurnSha256 ?? sha256Text(normalizePrompt(prepared!.prompt));
      if (observedUserSha256 !== expectedUserSha256) {
        throw new ReviewPreparationError(
          "The latest visible user turn is not the archived submitted review prompt. Resume refused to capture a later or ambiguous response.",
          "resume_user_turn_mismatch"
        );
      }
      if (archivedSubmission?.state === "intent" && archiveDirectory !== undefined) {
        await writeImmutableJson(join(archiveDirectory, "submission-confirmation.json"), {
          schemaVersion: 2,
          state: "confirmed",
          submitted: true,
          resubmitAllowed: false,
          submittedAt: port.now().toISOString(),
          promptSha256: sha256Text(normalizePrompt(prepared!.prompt)),
          userTurnSha256: observedUserSha256,
          thread: { url: threadUrl, id: threadId },
          baselineTurnCount: archivedSubmission.baselineTurnCount,
          baselineAssistantCount: archivedSubmission.baselineAssistantCount,
          artifactBaseline: archivedSubmission.artifactBaseline,
          reconciliation: "visible_prompt_match"
        });
        archivedSubmission = {
          ...archivedSubmission,
          state: "confirmed",
          submitted: true,
          userTurnSha256: observedUserSha256,
          thread: { ...(threadUrl === undefined ? {} : { url: threadUrl }), ...(threadId === undefined ? {} : { id: threadId }) }
        };
      }
    }
    await assertPageSafe(port, "PREFLIGHT_BROWSER");

    if (args.resume !== undefined && archiveDirectory !== undefined && configurationBefore === undefined) {
      try {
        configurationBefore = await readArchivedConfigurationSnapshot(archiveDirectory);
      } catch (error) {
        throw new ReviewPreparationError(
          `The original configuration snapshot is missing or invalid; automatic restoration cannot be proven. ${error instanceof Error ? error.message : String(error)}`,
          "resume_configuration_snapshot_invalid"
        );
      }
    }
    if (configurationBefore === undefined) {
      configurationBefore = requireData(await runStep("SNAPSHOT_CONFIGURATION", () => port.snapshotConfiguration()), "SNAPSHOT_CONFIGURATION").data;
    } else {
      steps.push({
        state: "SNAPSHOT_CONFIGURATION",
        startedAt: port.now().toISOString(),
        endedAt: port.now().toISOString(),
        ok: true,
        status: "restored_from_archive",
        data: { capturedAt: configurationBefore.capturedAt, selection: configurationBefore.selection }
      });
    }
    if (archiveDirectory !== undefined && args.resume === undefined) {
      await writeImmutableJson(join(archiveDirectory, "configuration.before.json"), configurationBefore);
    }

    const appliedResult = requireData(await runStep("APPLY_PRO", () => port.applyPro()), "APPLY_PRO");
    applied = appliedResult.data.after;
    verifiedBeforeSubmit = appliedResult.data.verified && configurationMatchesSelection(appliedResult.data.after, { intelligence: "Pro" });
    if (!verifiedBeforeSubmit) throw workflowBlocker("model_fallback", "pro_precondition_unverified", "The visible Chat setting did not strictly verify Pro before submission.", "VERIFY_PRO_BEFORE_SUBMIT");
    await runStep("VERIFY_PRO_BEFORE_SUBMIT", async () => {
      await assertPageSafe(port, "VERIFY_PRO_BEFORE_SUBMIT");
      return { verified: true, active: appliedResult.data.after.active };
    });

    if (artifactBaseline === undefined) {
      if (args.resume !== undefined && archiveDirectory !== undefined) {
        artifactBaseline = await readArchivedArtifactBaseline(archiveDirectory).catch(() => undefined);
      }
    }
    if (artifactBaseline === undefined) {
      artifactBaseline = requireData(await runStep("BASELINE_ARTIFACTS", () => port.artifactBaseline()), "BASELINE_ARTIFACTS").data;
    }

    let baselineAssistantCount = 0;
    if (args.resume === undefined) {
      const attachments = [prepared!.manifestPath, ...prepared!.packetPaths];
      requireOk(await runStep("ATTACH_PACKETS", () => port.attach(attachments)), "ATTACH_PACKETS");
      const beforeMessage = requireData(await port.messageStatus(), "SUBMIT_ONCE");
      baselineAssistantCount = beforeMessage.data.assistantTurnCount;
      requireOk(await port.compose(prepared!.prompt), "SUBMIT_ONCE");
      await assertPageSafe(port, "VERIFY_PRO_BEFORE_SUBMIT");
      if (archiveDirectory !== undefined) {
        await writeImmutableJson(join(archiveDirectory, "submission-intent.json"), {
          schemaVersion: 2,
          state: "intent",
          resubmitAllowed: false,
          createdAt: port.now().toISOString(),
          promptSha256: sha256Text(normalizePrompt(prepared!.prompt)),
          thread: { url: threadUrl, id: threadId },
          baselineTurnCount: beforeMessage.data.turnCount,
          baselineAssistantCount,
          artifactBaseline
        });
      }

      let submitResult: CommandResult<SubmitData> | undefined;
      let submitError: unknown;
      try {
        submitResult = await runStep("SUBMIT_ONCE", () => port.submit(prepared!.prompt, beforeMessage.data.turnCount));
      } catch (error) {
        submitError = error;
      }
      threadUrl = submitResult?.context.url ?? threadUrl;
      threadId = submitResult?.context.conversationId ?? threadId;
      const afterMessage = await port.messageStatus().catch(() => undefined);
      const latestUser = await port.readLatestUser().catch(() => undefined);
      const latestUserText = latestUser?.ok === true ? latestUser.data?.text : undefined;
      const exactUserTurn = latestUserText !== undefined
        && sha256Text(normalizePrompt(latestUserText)) === sha256Text(normalizePrompt(prepared!.prompt));
      const pageAdvanced = afterMessage?.ok === true && (
        (beforeMessage.data.turnCount !== undefined
          && afterMessage.data?.turnCount !== undefined
          && afterMessage.data.turnCount > beforeMessage.data.turnCount)
        || afterMessage.data?.generationActive === true
      );
      const submitReported = submitResult?.ok === true && submitResult.data?.submitted === true;
      const submissionState = exactUserTurn ? "confirmed" : (submitReported || pageAdvanced ? "ambiguous" : "failed");
      submitted = submissionState !== "failed";
      if (archiveDirectory !== undefined) {
        await writeImmutableJson(join(archiveDirectory, "submission.json"), {
          schemaVersion: 2,
          state: submissionState,
          submitted,
          resubmitAllowed: false,
          submittedAt: port.now().toISOString(),
          promptSha256: sha256Text(normalizePrompt(prepared!.prompt)),
          ...(exactUserTurn ? { userTurnSha256: sha256Text(normalizePrompt(latestUserText!)) } : {}),
          thread: { url: threadUrl, id: threadId },
          baselineTurnCount: beforeMessage.data.turnCount,
          baselineAssistantCount,
          artifactBaseline,
          result: redactReportValue(submitResult ?? { error: submitError instanceof Error ? { name: submitError.name, message: submitError.message } : String(submitError) })
        });
        await persistThreadCheckpoint(archiveDirectory, prepared!, threadUrl, threadId, port.now());
      }
      if (submissionState !== "confirmed") {
        throw workflowBlocker(
          "unknown",
          submissionState === "ambiguous" ? "submission_ambiguous" : "submission_unconfirmed",
          submissionState === "ambiguous"
            ? "ChatGPT showed possible submission progress, but the exact visible user turn could not be proven. The prompt will not be resent."
            : "The single allowed submit attempt did not produce a matching visible user turn. The prompt will not be resent automatically.",
          "SUBMIT_ONCE"
        );
      }
      if (submitResult?.ok !== true && submitError !== undefined) {
        warnings.push(`Submit transport reported an error after the exact visible user turn was confirmed: ${submitError instanceof Error ? submitError.message : String(submitError)}`);
      }
    } else {
      const current = requireData(await port.messageStatus(), "POLL_METADATA");
      // A resumed review owns a fresh one-prompt thread. Poll the already-visible
      // latest assistant turn even when the cheap status probe calls it
      // "partial"; the bounded metadata wait is responsible for confirming
      // response actions, text stability, and inactive generation. Using the
      // full assistant count here waits for a nonexistent duplicate response.
      baselineAssistantCount = archivedSubmission?.baselineAssistantCount
        ?? Math.max(0, current.data.assistantTurnCount - (current.data.assistantTurnCount > 0 ? 1 : 0));
    }

    const callTimeoutMs = positive(args.polling?.callTimeoutMs, 45_000);
    const totalTimeoutMs = positive(args.polling?.totalTimeoutMs, 1_800_000);
    const stableMs = positive(args.polling?.stableMs, 3_000);
    const pollMs = positive(args.polling?.pollMs, 1_000);
    const maxCalls = Math.max(1, Math.min(
      positive(args.polling?.maxPollCallsPerInvocation, 1),
      Math.ceil(totalTimeoutMs / callTimeoutMs)
    ));
    let complete = false;
    for (let call = 0; call < maxCalls; call += 1) {
      const wait = await runStep("POLL_METADATA", () => port.waitMetadata(baselineAssistantCount, callTimeoutMs, stableMs, pollMs));
      const polledThreadId = wait.context.conversationId ?? conversationIdFromUrl(wait.context.url);
      if (polledThreadId !== undefined) {
        threadUrl = wait.context.url ?? threadUrl;
        threadId = polledThreadId;
      }
      if (archiveDirectory !== undefined) await persistThreadCheckpoint(archiveDirectory, prepared!, threadUrl, threadId, port.now());
      await assertPageSafe(port, "POLL_METADATA");
      if (wait.ok && wait.data?.complete === true) {
        complete = true;
        break;
      }
      if (wait.status !== "timeout") requireOk(wait, "POLL_METADATA");
    }
    if (!complete) throw new ReviewInProgress();

    const archivedResponse = archiveDirectory === undefined
      ? undefined
      : await readFile(join(archiveDirectory, "response.md"), "utf8").catch(() => undefined);
    if (archivedResponse !== undefined) {
      responseMarkdown = archivedResponse;
      responseSha256 = sha256Text(responseMarkdown);
      steps.push({
        state: "READ_FULL_MARKDOWN_ONCE",
        startedAt: port.now().toISOString(),
        endedAt: port.now().toISOString(),
        ok: true,
        status: "restored_from_archive",
        data: { bytes: Buffer.byteLength(responseMarkdown), sha256: responseSha256 }
      });
    } else {
      const read = requireData(await runStep("READ_FULL_MARKDOWN_ONCE", () => port.readFullMarkdown()), "READ_FULL_MARKDOWN_ONCE");
      responseMarkdown = read.data.markdown ?? read.data.text;
      responseSha256 = sha256Text(responseMarkdown);
      if (archiveDirectory !== undefined) await writeImmutableFile(join(archiveDirectory, "response.md"), responseMarkdown);
    }

    const after = requireData(await runStep("VERIFY_PRO_AFTER_COMPLETION", () => port.inspectConfiguration()), "VERIFY_PRO_AFTER_COMPLETION");
    await assertPageSafe(port, "VERIFY_PRO_AFTER_COMPLETION");
    verifiedAfterCompletion = after.data.verified && configurationMatchesSelection(after.data, { intelligence: "Pro" });
    if (!verifiedAfterCompletion) throw workflowBlocker("model_fallback", "pro_postcondition_unverified", "The visible Chat setting no longer strictly verifies Pro after completion; the response is archived but is not accepted as a verified Pro review.", "VERIFY_PRO_AFTER_COMPLETION");

    const delta = requireData(await runStep("ENUMERATE_NEW_ARTIFACTS", () => port.artifactDelta(artifactBaseline!)), "ENUMERATE_NEW_ARTIFACTS").data;
    if ((args.output?.downloadArtifacts ?? "all") === "all" && archiveDirectory !== undefined) {
      const artifactArchiveDirectory = archiveDirectory;
      await runStep("DOWNLOAD_AND_HASH_ARTIFACTS", async () => {
        const staging = await mkdtemp(join(tmpdir(), "chatgpt-pro-review-artifacts-"));
        const checkpointArtifacts = await readArtifactDownloadCheckpoint(artifactArchiveDirectory);
        artifacts.push(...checkpointArtifacts);
        const checkpointCount = checkpointArtifacts.length;
        const used = new Set(checkpointArtifacts.map(artifact => artifact.name.toLocaleLowerCase()));
        try {
          for (const item of delta.added) {
            if (artifacts.some(artifact => artifactMatchesInventoryItem(artifact, item))) continue;
            let downloaded: CommandResult<DownloadedFile>;
            let desiredName: string;
            let metadata: { kind?: string; sourceLabel?: string; sourceReference?: string; inventoryKey?: string };
            if (item.kind === "file") {
              desiredName = sanitizeArtifactFilename(item.filename, "generated-file");
              downloaded = await port.downloadFile(staging, item.filename, item.assistantIndex, item.occurrenceIndex);
              metadata = {
                kind: "file",
                sourceLabel: item.filename,
                sourceReference: `assistant:${item.assistantIndex}:occurrence:${item.occurrenceIndex}`,
                inventoryKey: item.key
              };
            } else {
              desiredName = `generated-image-${String(item.artifact.index + 1).padStart(3, "0")}.png`;
              downloaded = await port.downloadImage(staging, item.artifact.index, item.artifact.turnId);
              metadata = {
                kind: "image",
                sourceLabel: item.artifact.alt ?? item.artifact.ariaLabel ?? `image ${item.artifact.index}`,
                sourceReference: item.artifact.turnId ?? `index:${item.artifact.index}`,
                inventoryKey: item.key
              };
            }
            const saved = requireData(downloaded, "DOWNLOAD_AND_HASH_ARTIFACTS").data;
            artifacts.push(await preserveDownloadedArtifact(saved.path, artifactArchiveDirectory, desiredName, used, metadata));
            await writeJsonReplacing(join(artifactArchiveDirectory, "artifacts", "download-checkpoint.json"), {
              schemaVersion: 1,
              updatedAt: port.now().toISOString(),
              artifacts
            });
          }
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
        return { downloaded: artifacts.length - checkpointCount, reused: checkpointCount, total: artifacts.length };
      });
    } else if (delta.added.length > 0) {
      warnings.push(`${delta.added.length} new artifacts were detected but downloadArtifacts was explicitly disabled.`);
    }

    if (archiveDirectory !== undefined && responseMarkdown !== undefined) {
      const completedArchiveDirectory = archiveDirectory;
      const archivedResponse = responseMarkdown;
      await runStep("ARCHIVE_RUN", async () => {
        const findings = parseFindingsAppendix(archivedResponse);
        if (findings !== undefined) await writeImmutableJson(join(completedArchiveDirectory, "findings.json"), findings);
        await writeImmutableJson(join(completedArchiveDirectory, "artifacts", "manifest.json"), artifacts);
        return { responseSha256, findingsParsed: findings !== undefined, artifacts: artifacts.length };
      });
    }
    terminalStatus = warnings.length > 0 ? "completed_with_warnings" : "completed";
  } catch (error) {
    primaryError = error;
    if (error instanceof ReviewInProgress) {
      terminalStatus = "in_progress";
    } else if (error instanceof ReviewPreparationError) {
      archiveDirectory = error.archiveDirectory ?? archiveDirectory;
      terminalStatus = "blocked";
      blocker = {
        kind: error.code.includes("secret")
          ? "confirmation"
          : error.code.includes("configuration_snapshot")
            ? "configuration_restore_failed"
            : "unknown",
        code: error.code,
        message: error.message,
        resumable: error.code === "review_archive_locked"
      };
    } else if (error instanceof ReviewWorkflowError) {
      terminalStatus = error.result.status === "blocked" || error.result.status === "needs_confirmation" ? "blocked" : "failed";
      blocker = error.result.blocker;
      if (error.result.error !== undefined) warnings.push(error.result.error.message);
    } else {
      terminalStatus = "failed";
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (terminalStatus !== "in_progress" && configurationBefore !== undefined && (args.safeguards?.restorePreviousConfiguration ?? true)) {
      try {
        const restore = await runStep("RESTORE_PREVIOUS_CONFIGURATION", () => port.restoreConfiguration(configurationBefore!));
        restored = restore.data?.restored === true;
        restorationVerified = restore.ok && restored;
        if (!restorationVerified) {
          const message = restore.blocker?.message ?? restore.error?.message ?? "The prior visible Chat configuration could not be strictly restored.";
          warnings.push(message);
          blocker = restore.blocker ?? { kind: "configuration_restore_failed", code: "configuration_restore_failed", message, resumable: false };
          if (terminalStatus === "completed") terminalStatus = "completed_with_warnings";
        }
        steps.push({
          state: "VERIFY_RESTORATION",
          startedAt: port.now().toISOString(),
          endedAt: port.now().toISOString(),
          ok: restorationVerified,
          status: restorationVerified ? "verified" : "unverified"
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Configuration restoration failed: ${message}`);
        blocker = { kind: "configuration_restore_failed", code: "configuration_restore_error", message, resumable: false };
        if (terminalStatus === "completed") terminalStatus = "completed_with_warnings";
      }
    }
  }

  const provenance: ProCodeReviewResult["provenance"] = {
    repositoryRoot: prepared?.manifest.repositoryRoot ?? args.repositoryRoot,
    baseRef: prepared?.manifest.baseRef ?? args.baseRef,
    headRef: prepared?.manifest.headRef ?? headRef
  };
  if (prepared?.manifest.baseSha !== undefined) provenance.baseSha = prepared.manifest.baseSha;
  if (prepared?.manifest.headSha !== undefined) provenance.headSha = prepared.manifest.headSha;
  if (prepared?.manifest.mergeBaseSha !== undefined) provenance.mergeBaseSha = prepared.manifest.mergeBaseSha;
  if (prepared !== undefined) {
    provenance.packetManifestPath = prepared.manifestPath;
    provenance.packetManifestSha256 = prepared.manifestSha256;
  }
  if (responseSha256 !== undefined) provenance.responseSha256 = responseSha256;

  const result: ProCodeReviewResult = {
    ok: (terminalStatus === "completed" || terminalStatus === "completed_with_warnings")
      && blocker?.kind !== "configuration_restore_failed",
    status: terminalStatus,
    submitted,
    resubmitAllowed: false,
    artifacts,
    configuration: {
      requested,
      verifiedBeforeSubmit,
      verifiedAfterCompletion,
      restored,
      restorationVerified
    },
    provenance,
    warnings,
    rawSteps: steps
  };
  if (configurationBefore !== undefined) result.configuration.before = configurationBefore;
  if (applied !== undefined) result.configuration.applied = applied;
  if (archiveDirectory !== undefined) result.archiveDirectory = archiveDirectory;
  if (threadUrl !== undefined || threadId !== undefined) result.thread = { ...(threadUrl === undefined ? {} : { url: threadUrl }), ...(threadId === undefined ? {} : { id: threadId }) };
  if (blocker !== undefined) result.blocker = blocker;
  if (terminalStatus === "in_progress") result.nextAction = "poll_same_thread";

  if (responseMarkdown !== undefined && (terminalStatus === "completed" || terminalStatus === "completed_with_warnings")) {
    const mode = args.output?.mode ?? "full";
    const hardLimit = args.output?.hardTransportLimitBytes;
    const overHardLimit = hardLimit !== undefined && Buffer.byteLength(responseMarkdown) > hardLimit;
    if (mode === "full" && !overHardLimit && args.output?.returnFullMarkdown !== false) {
      result.responseMarkdown = responseMarkdown;
    } else {
      result.responseIndex = markdownSectionIndex(responseMarkdown);
      if (overHardLimit) {
        result.warnings.push(`The complete response is archived at ${join(archiveDirectory ?? "", "response.md")}, but its ${Buffer.byteLength(responseMarkdown)} bytes exceed the explicitly configured hard transport limit of ${hardLimit}. No content was summarized or truncated.`);
        if (result.status === "completed") result.status = "completed_with_warnings";
      }
    }
  }

  try {
    if (archiveDirectory !== undefined && (releaseLease !== undefined || result.blocker?.code !== "review_archive_locked")) {
      const configurationRecord = {
        before: configurationBefore,
        requested,
        applied,
        verifiedBeforeSubmit,
        verifiedAfterCompletion,
        restored,
        restorationVerified
      };
      const receipt = {
        ...result,
        responseMarkdown: responseMarkdown === undefined ? undefined : { bytes: Buffer.byteLength(responseMarkdown), sha256: responseSha256 },
        diagnosticMetadata: args.diagnosticMetadata,
        primaryError: primaryError instanceof Error ? { name: primaryError.name, message: primaryError.message } : undefined
      };
      try {
        await writeJsonReplacing(join(archiveDirectory, "configuration.json"), configurationRecord);
        await writeJsonReplacing(join(archiveDirectory, "run-report.redacted.json"), redactReportValue(receipt));
        await writeJsonReplacing(join(archiveDirectory, "receipt.json"), receipt);
      } catch (error) {
        const message = `Required terminal provenance could not be committed: ${error instanceof Error ? error.message : String(error)}`;
        result.ok = false;
        result.status = "failed";
        result.warnings.push(message);
        result.blocker = {
          kind: "unknown",
          code: "archive_terminal_commit_failed",
          message,
          resumable: false
        };
      }
    }
    steps.push({ state: "RETURN_FULL_RESULT", startedAt: port.now().toISOString(), endedAt: port.now().toISOString(), ok: result.ok, status: result.status });
    return result;
  } finally {
    await releaseLease?.();
  }
}

export function defaultReviewWorkflowPort(env: RuntimeEnv): ReviewWorkflowPort {
  return {
    now: () => env.now?.() ?? new Date(),
    bootstrap: target => bootstrap(env, target === undefined
      ? { preferExistingTab: true }
      : {
          existingTab: {
            target: target.conversationId === undefined
              ? { type: "url", url: target.url! }
              : { type: "conversationId", conversationId: target.conversationId },
            ifMissing: "open",
            ifMultiple: "first",
            requireChatGPT: true
          }
        }),
    openChat: () => openExperience(env, { experience: "chat" }),
    newThread: () => newThread(env),
    openThread: target => openThread(env, { ...target, timeoutMs: 12_000 }),
    recoverThread: (query, expectedPrompt) => recoverReviewThread(env, query, expectedPrompt),
    snapshotConfiguration: () => snapshotConfiguration(env, { experience: "chat" }),
    applyPro: () => applyConfiguration(env, { experience: "chat", desired: { intelligence: "Pro" }, strict: true }),
    inspectConfiguration: () => inspectConfiguration(env, { experience: "chat", includeOptions: false }),
    restoreConfiguration: snapshot => restoreConfiguration(env, { snapshot, strict: true }),
    pageState: async () => {
      if (env.page === undefined) throw new Error("No visible ChatGPT page is attached.");
      return readPageState(env.page);
    },
    artifactBaseline: () => captureArtifactBaseline(env),
    artifactDelta: baseline => captureArtifactDelta(env, { baseline }),
    attach: paths => attachFiles(env, { paths, includeHashes: true }),
    messageStatus: () => messageStatus(env, { maxPreviewChars: 0 }),
    compose: text => composeMessage(env, { text, mode: "replace" }),
    submit: (text, previousTurnCount) => submitMessage(env, { text, ...(previousTurnCount === undefined ? {} : { previousTurnCount }) }),
    waitMetadata: (afterAssistantTurnCount, timeoutMs, stableMs, pollMs) => waitForMessage(env, {
      afterAssistantTurnCount,
      timeoutMs,
      stableMs,
      pollMs,
      responseContent: "metadata"
    }),
    readFullMarkdown: () => readLatest(env, { role: "assistant", format: "markdown" }),
    readLatestUser: () => readLatest(env, { role: "user", format: "text" }),
    downloadFile: (destDir, filename, assistantIndex, occurrenceIndex) => downloadLatestFile(env, {
      destDir,
      filenamePattern: `^${escapeRegExp(filename)}$`,
      occurrenceIndex,
      from: { assistantIndex }
    }),
    downloadImage: (destDir, index, turnId) => downloadLatestArtifact(env, {
      destDir,
      prefer: "visible_image_source",
      which: { index, ...(turnId === undefined ? {} : { turnId }) }
    })
  };
}

async function assertPageSafe(port: ReviewWorkflowPort, state: ReviewState): Promise<void> {
  const page = await port.pageState();
  if (page.blocker !== undefined && page.blocker.kind !== "modal") {
    throw new ReviewWorkflowError({
      ok: false,
      status: "blocked",
      warnings: [],
      blocker: { ...page.blocker, resumable: page.blocker.kind !== "model_fallback" && page.blocker.kind !== "model_unavailable" },
      context: { timestamp: port.now().toISOString(), url: page.url }
    }, state);
  }
}

function requireOk<T>(result: CommandResult<T>, state: ReviewState): CommandResult<T> {
  if (!result.ok) throw new ReviewWorkflowError(result, state);
  return result;
}

function requireData<T>(result: CommandResult<T>, state: ReviewState): CommandResult<T> & { data: T } {
  if (!result.ok || result.data === undefined) throw new ReviewWorkflowError(result, state);
  return result as CommandResult<T> & { data: T };
}

function workflowBlocker(kind: NonNullable<CommandResult["blocker"]>["kind"], code: string, message: string, state: ReviewState): ReviewWorkflowError {
  return new ReviewWorkflowError({
    ok: false,
    status: "blocked",
    warnings: [],
    blocker: { kind, code, message, resumable: false },
    context: { timestamp: new Date().toISOString() }
  }, state);
}

function isCommandResult(value: unknown): value is CommandResult<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { ok?: unknown }).ok === "boolean" && typeof (value as { status?: unknown }).status === "string";
}

function responseMetadata(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const data = value as Partial<ReadLatestData>;
  const text = data.markdown ?? data.text;
  return text === undefined ? value : { format: data.format, bytes: Buffer.byteLength(text), sha256: sha256Text(text) };
}

async function readArchivedConfigurationSnapshot(archiveDirectory: string): Promise<ConfigurationSnapshotData> {
  const value = JSON.parse(await readFile(join(archiveDirectory, "configuration.before.json"), "utf8")) as ConfigurationSnapshotData;
  if (value.experience !== "chat" || typeof value.capturedAt !== "string") throw new Error("Archived configuration snapshot is invalid.");
  return value;
}

async function readArchivedPreparedContext(archiveDirectory: string): Promise<PreparedReviewContext> {
  const manifestPath = join(archiveDirectory, "context", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PreparedReviewContext["manifest"];
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packets)) throw new Error("Archived review packet manifest is invalid.");
  const promptPath = join(archiveDirectory, "prompt.md");
  return {
    archiveDirectory,
    requestPath: join(archiveDirectory, "request.md"),
    promptPath,
    packetPaths: manifest.packets.map(packet => join(archiveDirectory, "context", packet.path)),
    manifestPath,
    manifest,
    manifestSha256: await sha256File(manifestPath),
    prompt: await readFile(promptPath, "utf8")
  };
}

async function readArchivedArtifactBaseline(archiveDirectory: string): Promise<ArtifactInventoryData> {
  const submission = JSON.parse(await readFile(join(archiveDirectory, "submission.json"), "utf8")) as { artifactBaseline?: ArtifactInventoryData };
  if (submission.artifactBaseline === undefined || !Array.isArray(submission.artifactBaseline.items)) throw new Error("Archived artifact baseline is invalid.");
  return submission.artifactBaseline;
}

type ArchivedSubmission = {
  submitted: boolean;
  resubmitAllowed: false;
  schemaVersion?: 1 | 2;
  state: "confirmed" | "intent";
  promptSha256?: string;
  userTurnSha256?: string;
  baselineTurnCount?: number;
  baselineAssistantCount?: number;
  thread: { url?: string; id?: string };
  artifactBaseline: ArtifactInventoryData;
};

type ThreadCheckpoint = {
  schemaVersion: 1;
  current: { url?: string; id?: string };
  recoveryQuery: string;
  promptSha256: string;
  updatedAt: string;
};

async function readArchivedSubmission(archiveDirectory: string, expectedPromptSha256: string): Promise<ArchivedSubmission> {
  const confirmation = await readOptionalJson(join(archiveDirectory, "submission-confirmation.json"));
  const submittedRecord = confirmation ?? await readOptionalJson(join(archiveDirectory, "submission.json"));
  const intentOnly = submittedRecord === undefined;
  const value = (submittedRecord ?? await readOptionalJson(join(archiveDirectory, "submission-intent.json"))) as Partial<ArchivedSubmission> | undefined;
  if (value === undefined) {
    throw new ReviewPreparationError("The archive has no durable submission intent or confirmation record.", "resume_submission_unverified");
  }
  const state = intentOnly ? "intent" : (value.state ?? "confirmed");
  if (value.resubmitAllowed !== false
    || (state === "confirmed" && value.submitted !== true)
    || (state !== "confirmed" && state !== "intent")) {
    throw new ReviewPreparationError("The archived submission receipt does not prove a submit-once, non-resubmittable review.", "resume_submission_unverified");
  }
  if (value.promptSha256 !== undefined && value.promptSha256 !== expectedPromptSha256) {
    throw new ReviewPreparationError("The archived submission prompt hash does not match prompt.md.", "resume_prompt_hash_mismatch");
  }
  if (value.thread === undefined || (value.thread.url === undefined && value.thread.id === undefined)) {
    throw new ReviewPreparationError("The archived submission receipt has no canonical Chat conversation target.", "resume_thread_missing");
  }
  if (value.artifactBaseline === undefined || !Array.isArray(value.artifactBaseline.items)) {
    throw new ReviewPreparationError("The archived submission receipt has no valid artifact baseline.", "resume_artifact_baseline_invalid");
  }
  return { ...value, state, submitted: state === "confirmed" } as ArchivedSubmission;
}

async function readOptionalJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function conversationIdFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const match = new URL(url).pathname.match(/^\/c\/([^/]+)/);
    return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function isProvisionalConversationId(value: string | undefined): boolean {
  return value?.startsWith("WEB:") === true;
}

function recoveryQueryFromPrepared(prepared: PreparedReviewContext): string {
  const firstLine = prepared.prompt.split(/\r?\n/, 1)[0]?.trim();
  if (firstLine?.startsWith("Codex Pro review - ") === true) return firstLine;
  const legacyCanary = prepared.prompt.match(/CANARY_OK:[a-z0-9]+/i)?.[0];
  return legacyCanary ?? prepared.manifest.headSha?.slice(0, 12) ?? prepared.manifest.headRef;
}

async function persistThreadCheckpoint(
  archiveDirectory: string,
  prepared: PreparedReviewContext,
  url: string | undefined,
  id: string | undefined,
  now: Date
): Promise<void> {
  if (url === undefined && id === undefined) return;
  const checkpoint: ThreadCheckpoint = {
    schemaVersion: 1,
    current: { ...(url === undefined ? {} : { url }), ...(id === undefined ? {} : { id }) },
    recoveryQuery: recoveryQueryFromPrepared(prepared),
    promptSha256: sha256Text(prepared.prompt),
    updatedAt: now.toISOString()
  };
  await writeJsonReplacing(join(archiveDirectory, "thread-checkpoint.json"), checkpoint);
}

async function readArchivedThreadCheckpoint(archiveDirectory: string): Promise<ThreadCheckpoint> {
  const value = JSON.parse(await readFile(join(archiveDirectory, "thread-checkpoint.json"), "utf8")) as Partial<ThreadCheckpoint>;
  if (value.schemaVersion !== 1 || value.current === undefined || typeof value.recoveryQuery !== "string" || typeof value.promptSha256 !== "string") {
    throw new Error("Archived thread checkpoint is invalid.");
  }
  return value as ThreadCheckpoint;
}

async function readOptionalThreadCheckpoint(archiveDirectory: string): Promise<ThreadCheckpoint | undefined> {
  try {
    return await readArchivedThreadCheckpoint(archiveDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ReviewPreparationError(
      `The archived thread checkpoint is invalid. ${error instanceof Error ? error.message : String(error)}`,
      "resume_checkpoint_invalid"
    );
  }
}

function validateThreadCheckpoint(
  checkpoint: ThreadCheckpoint | undefined,
  submission: ArchivedSubmission,
  prepared: PreparedReviewContext
): void {
  if (checkpoint === undefined) return;
  if (checkpoint.promptSha256 !== sha256Text(prepared.prompt)) {
    throw new ReviewPreparationError("The mutable thread checkpoint prompt hash does not match the immutable archived prompt.", "resume_checkpoint_prompt_mismatch");
  }
  const submittedId = submission.thread.id ?? conversationIdFromUrl(submission.thread.url);
  const checkpointId = checkpoint.current.id ?? conversationIdFromUrl(checkpoint.current.url);
  if (submittedId !== undefined && checkpointId !== undefined && !isProvisionalConversationId(submittedId) && submittedId !== checkpointId) {
    throw new ReviewPreparationError("The mutable thread checkpoint points at a different conversation than the immutable submission receipt.", "resume_checkpoint_thread_mismatch");
  }
}

async function recoverReviewThread(env: RuntimeEnv, query: string, expectedPrompt: string): Promise<CommandResult<OpenThreadData>> {
  const search = await searchThreads(env, { query, limit: 3 });
  if (!search.ok || search.data === undefined) {
    return {
      ok: false,
      status: search.status,
      warnings: search.warnings,
      ...(search.blocker === undefined ? {} : { blocker: search.blocker }),
      ...(search.error === undefined ? {} : { error: search.error }),
      context: search.context
    };
  }
  const expected = normalizePrompt(expectedPrompt);
  for (const candidate of search.data.results) {
    const opened = await openThread(env, { url: new URL(candidate.href, "https://chatgpt.com/").toString(), timeoutMs: 12_000 });
    if (!opened.ok) continue;
    const user = await readLatest(env, { role: "user", format: "text" });
    if (user.ok && promptMatches(normalizePrompt(user.data?.text ?? ""), expected, query)) return opened;
  }
  return {
    ok: false,
    status: "not_found",
    warnings: search.warnings,
    blocker: {
      kind: "not_found",
      code: "review_thread_recovery_not_found",
      message: "The provisional Chat conversation ID expired, and visible Chat search found no prompt-identical review thread.",
      resumable: true
    },
    context: search.context
  };
}

function normalizePrompt(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function promptMatches(actual: string, expected: string, query: string): boolean {
  if (actual === expected) return true;
  if (!actual.includes(query) || !expected.includes(query)) return false;
  const scope = expected.split("\n").find(line => line.startsWith("Scope: "));
  return scope !== undefined && actual.includes(scope);
}

async function readArtifactDownloadCheckpoint(archiveDirectory: string): Promise<ReviewArtifact[]> {
  const artifactsDirectory = resolve(archiveDirectory, "artifacts");
  const checkpointPath = join(artifactsDirectory, "download-checkpoint.json");
  const manifestPath = join(artifactsDirectory, "manifest.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      value = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (manifestError) {
      if ((manifestError as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw manifestError;
    }
  }

  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.artifacts)
      ? value.artifacts
      : undefined;
  if (entries === undefined) throw new Error("The archived artifact download checkpoint is invalid.");

  const verified: ReviewArtifact[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)
      || typeof entry.name !== "string"
      || typeof entry.path !== "string"
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || (entry.inventoryKey !== undefined && typeof entry.inventoryKey !== "string")) {
      throw new Error("The archived artifact download checkpoint contains an invalid entry.");
    }
    const expectedPath = resolve(artifactsDirectory, sanitizeArtifactFilename(entry.name));
    assertPathInside(artifactsDirectory, entry.path);
    if (!sameResolvedPath(expectedPath, entry.path)) {
      throw new Error(`The archived artifact path does not match its recorded name: ${entry.path}`);
    }
    const saved = await stat(entry.path);
    if (!saved.isFile()
      || (typeof entry.sizeBytes === "number" && saved.size !== entry.sizeBytes)
      || await sha256File(entry.path) !== entry.sha256) {
      throw new Error(`The archived artifact no longer matches its checkpoint: ${entry.path}`);
    }
    verified.push(entry as ReviewArtifact);
  }
  return verified;
}

function artifactMatchesInventoryItem(
  artifact: ReviewArtifact,
  item: ArtifactDeltaData["added"][number]
): boolean {
  if (artifact.inventoryKey !== undefined) return artifact.inventoryKey === item.key;
  if (item.kind === "file") {
    return artifact.kind === "file"
      && artifact.sourceLabel === item.filename
      && artifact.sourceReference === `assistant:${item.assistantIndex}:occurrence:${item.occurrenceIndex}`;
  }
  const expectedName = `generated-image-${String(item.artifact.index + 1).padStart(3, "0")}.png`;
  const expectedReference = item.artifact.turnId ?? `index:${item.artifact.index}`;
  return artifact.kind === "image"
    && artifact.name === expectedName
    && (artifact.sourceReference === expectedReference
      || (item.artifact.turnId === undefined && artifact.sourceReference === undefined));
}

function sameResolvedPath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLocaleLowerCase() === resolvedRight.toLocaleLowerCase()
    : resolvedLeft === resolvedRight;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function acquireReviewLease(archiveDirectory: string, now: Date): Promise<() => Promise<void>> {
  const leasePath = join(archiveDirectory, ".workflow.lock");
  let handle;
  try {
    handle = await open(leasePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ReviewPreparationError(
        "Another process or task already holds the exclusive lease for this review archive.",
        "review_archive_locked",
        undefined,
        archiveDirectory
      );
    }
    throw error;
  }
  await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, acquiredAt: now.toISOString() })}\n`);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close().catch(() => undefined);
    await rm(leasePath, { force: true });
  };
}

async function writeJsonReplacing(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.next-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!(["EEXIST", "EPERM", "ENOTEMPTY"] as Array<string | undefined>).includes((error as NodeJS.ErrnoException).code)) throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
