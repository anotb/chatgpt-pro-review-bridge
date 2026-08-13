import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { tabIdFromPage } from "../browser/attach.js";
import { parseConversationId, readPageState, type PageState } from "../browser/page-state.js";
import { captureArtifactBaseline, captureArtifactDelta } from "../commands/artifact-inventory.js";
import { downloadLatestArtifact } from "../commands/artifacts.js";
import { applyConfiguration, configurationMatchesSelection, inspectConfiguration, restoreConfiguration, snapshotConfiguration } from "../commands/configuration.js";
import { openExperience } from "../commands/experience.js";
import { attachFiles, downloadLatestFile } from "../commands/files.js";
import { composeMessage, messageStatus, readLatest, submitMessage, waitForMessage } from "../commands/messages.js";
import { bootstrap } from "../commands/session.js";
import { listVisibleThreads, newThread, openThread, searchThreads } from "../commands/threads.js";
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
import { prepareReviewContext, ReviewPreparationError } from "./packet-builder.js";
import { acquireReviewLease } from "./review-lease.js";
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
  bootstrapRecovery?(target?: { tabId?: string }): Promise<CommandResult<unknown>>;
  openChat(): Promise<CommandResult<unknown>>;
  newThread(): Promise<CommandResult<OpenThreadData>>;
  openThread(target: { url?: string; conversationId?: string }): Promise<CommandResult<OpenThreadData>>;
  recoverThread(
    query: string,
    expectedPrompt: string,
    preferred?: { url?: string; conversationId?: string; tabId?: string }
  ): Promise<CommandResult<OpenThreadData>>;
  snapshotConfiguration(): Promise<CommandResult<ConfigurationSnapshotData>>;
  applyPro(): Promise<CommandResult<ApplyConfigurationData>>;
  inspectConfiguration(): Promise<CommandResult<ConfigurationInspectionData>>;
  restoreConfiguration(snapshot: ConfigurationSnapshotData): Promise<CommandResult<RestoreConfigurationData>>;
  pageState(): Promise<PageState & { tabId?: string }>;
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

type ConversationAffinity = {
  canonicalId: string | undefined;
  routeId: string | undefined;
  invocationTabId: string | undefined;
};

const MAX_RECOVERY_CANDIDATES = 6;
const RECOVERY_CANDIDATE_OPEN_TIMEOUT_MS = 6_000;

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

class ArchivedTerminalOutcomeError extends Error {
  constructor(readonly outcome: ArchivedTerminalOutcome) {
    super(outcome.blocker.message);
    this.name = "ArchivedTerminalOutcomeError";
  }
}

export async function codeReview(env: RuntimeEnv, args: ProCodeReviewArgs): Promise<ProCodeReviewResult> {
  return runCodeReviewWithPort(args, defaultReviewWorkflowPort(env));
}

export async function runCodeReviewWithPort(args: ProCodeReviewArgs, port: ReviewWorkflowPort): Promise<ProCodeReviewResult> {
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
  let threadUrl = args.resume?.threadUrl ?? args.thread?.url;
  let threadId = args.resume?.conversationId ?? args.thread?.id;
  let responseMarkdown: string | undefined;
  let responseSha256: string | undefined;
  let blocker: CommandResult["blocker"] | undefined;
  let terminalStatus: ProCodeReviewResult["status"] = "failed";
  let artifactBaseline: ArtifactInventoryData | undefined = args.resume?.artifactBaseline;
  let primaryError: unknown;
  let recoveryQuery: string | undefined;
  let releaseLease: (() => Promise<void>) | undefined;
  let archivedSubmission: ArchivedSubmission | undefined;
  let resumedMessageStatus: MessageStatusData | undefined;
  let terminalOutcomeAlreadyFinal = false;
  const affinity: ConversationAffinity = { canonicalId: undefined, routeId: undefined, invocationTabId: undefined };
  let recoveryHint: { url?: string; conversationId?: string; tabId?: string } | undefined;

  const runStep = async <T>(state: ReviewState, operation: () => Promise<T>): Promise<T> => {
    const startedAt = port.now().toISOString();
    try {
      const value = await operation();
      const endedAt = port.now().toISOString();
      if (isCommandResult(value)) {
        const evidence: ReviewStepEvidence = { state, startedAt, endedAt, ok: value.ok, status: value.status };
        if (value.data !== undefined) evidence.data = state === "READ_FULL_MARKDOWN_ONCE" ? responseMetadata(value.data) : value.data;
        if (value.blocker !== undefined) evidence.blocker = value.blocker;
        if (value.warnings.length > 0) {
          evidence.warnings = [...value.warnings];
          for (const warning of value.warnings) {
            if (!warnings.includes(warning)) warnings.push(warning);
          }
        }
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
    validateRequestedThread(args);
    if (args.resume === undefined) {
      const requestedThreadId = args.thread?.id ?? conversationIdFromUrl(args.thread?.url);
      if (requestedThreadId !== undefined) {
        affinity.canonicalId = requestedThreadId;
        affinity.routeId = requestedThreadId;
      }
      prepared = await runStep("PREPARE_CONTEXT", () => prepareReviewContext(args, port.now()));
      archiveDirectory = prepared.archiveDirectory;
      releaseLease = await acquireReviewLease(archiveDirectory);
    } else {
      archiveDirectory = args.resume.archiveDirectory;
      releaseLease = await acquireReviewLease(archiveDirectory);
      terminalOutcomeAlreadyFinal = await archivedFinalMarkerExists(args.resume.archiveDirectory);
      prepared = await readArchivedPreparedContext(args.resume.archiveDirectory);
      let archiveCommitFailure: ArchivedTerminalOutcome | undefined;
      let terminalOutcome: ArchivedTerminalOutcome | undefined;
      let terminalMarkerError: unknown;
      try {
        archiveCommitFailure = await readArchivedCommitFailure(args.resume.archiveDirectory);
        terminalOutcome = await readArchivedTerminalOutcome(args.resume.archiveDirectory);
      } catch (error) {
        terminalMarkerError = error;
      }
      const archivedFinalOutcome = archiveCommitFailure
        ?? (terminalOutcome?.blocker.resumable === false ? terminalOutcome : undefined);
      const submissionRecordExists = await archivedSubmissionRecordExists(args.resume.archiveDirectory);
      if (!submissionRecordExists) {
        if (terminalMarkerError !== undefined) throw terminalMarkerError;
        if (archivedFinalOutcome !== undefined && archivedFinalOutcome.submitted === false) {
          await validateArchivedTerminalBinding(args.resume.archiveDirectory, archivedFinalOutcome, undefined);
          throw new ArchivedTerminalOutcomeError(archivedFinalOutcome);
        }
      }
      try {
        configurationBefore = await readArchivedConfigurationSnapshot(archiveDirectory);
      } catch (error) {
        throw new ReviewPreparationError(
          `The original configuration snapshot is missing or invalid; automatic restoration cannot be proven. ${error instanceof Error ? error.message : String(error)}`,
          "resume_configuration_snapshot_invalid"
        );
      }
      try {
        archivedSubmission = await readArchivedSubmission(args.resume.archiveDirectory, prepared);
      } catch (error) {
        const missingSubmission = error instanceof ReviewPreparationError
          && error.code === "resume_submission_unverified";
        if (!missingSubmission || submissionRecordExists) throw error;
        if (terminalMarkerError !== undefined) throw terminalMarkerError;
        if (archivedFinalOutcome !== undefined
          && archivedFinalOutcome.submitted === false
          && missingSubmission) {
          await validateArchivedTerminalBinding(args.resume.archiveDirectory, archivedFinalOutcome, undefined);
          throw new ArchivedTerminalOutcomeError(archivedFinalOutcome);
        }
        throw error;
      }
      if (terminalMarkerError !== undefined) throw terminalMarkerError;
      submitted = archivedSubmission.submitted;
      if (archivedFinalOutcome !== undefined) {
        await validateArchivedTerminalBinding(args.resume.archiveDirectory, archivedFinalOutcome, archivedSubmission);
        throw new ArchivedTerminalOutcomeError(archivedFinalOutcome);
      }
      const checkpoint = await readOptionalThreadCheckpoint(args.resume.archiveDirectory);
      validateThreadCheckpoint(checkpoint, archivedSubmission, prepared);
      const receiptThreadId = archivedSubmission.thread.id ?? conversationIdFromUrl(archivedSubmission.thread.url);
      const receiptIsProvisional = isProvisionalConversationId(receiptThreadId);
      const suppliedUrlId = conversationIdFromUrl(threadUrl);
      if (threadId !== undefined && suppliedUrlId !== undefined && threadId !== suppliedUrlId) {
        throw new ReviewPreparationError("resume.conversationId and resume.threadUrl refer to different Chat conversations.", "resume_thread_mismatch");
      }
      const suppliedThreadId = threadId ?? suppliedUrlId;
      if (!receiptIsProvisional && suppliedThreadId !== undefined && receiptThreadId !== undefined && suppliedThreadId !== receiptThreadId) {
        throw new ReviewPreparationError("The caller-supplied resume thread does not match the immutable archived submission receipt.", "resume_thread_mismatch");
      }
      if (receiptIsProvisional) {
        const checkpointId = checkpoint?.current.id ?? conversationIdFromUrl(checkpoint?.current.url);
        const candidateId = suppliedThreadId !== undefined && !isProvisionalConversationId(suppliedThreadId)
          ? suppliedThreadId
          : checkpointId !== undefined && !isProvisionalConversationId(checkpointId)
            ? checkpointId
            : undefined;
        const recoveryTabId = checkpoint?.current.tabId ?? archivedSubmission.thread.tabId;
        recoveryHint = {
          ...(candidateId === undefined ? {} : { conversationId: candidateId }),
          ...(candidateId !== undefined && suppliedUrlId === candidateId && threadUrl !== undefined
            ? { url: threadUrl }
            : candidateId !== undefined && checkpointId === candidateId && checkpoint?.current.url !== undefined
              ? { url: checkpoint.current.url }
              : {}),
          ...(recoveryTabId === undefined ? {} : { tabId: recoveryTabId })
        };
        threadId = receiptThreadId;
        threadUrl = archivedSubmission.thread.url;
        affinity.routeId = receiptThreadId;
      } else {
        threadId = receiptThreadId ?? suppliedThreadId;
        threadUrl = archivedSubmission.thread.url ?? threadUrl;
        affinity.canonicalId = receiptThreadId;
        affinity.routeId = receiptThreadId;
        recoveryHint = archivedSubmission.thread.tabId === undefined ? undefined : { tabId: archivedSubmission.thread.tabId };
      }
      if (args.resume.artifactBaseline !== undefined
        && sha256Text(JSON.stringify(args.resume.artifactBaseline)) !== sha256Text(JSON.stringify(archivedSubmission.artifactBaseline))) {
        throw new ReviewPreparationError("resume.artifactBaseline does not match the immutable archived submission baseline.", "resume_artifact_baseline_mismatch");
      }
      artifactBaseline = archivedSubmission.artifactBaseline;
      recoveryQuery = checkpoint?.recoveryQuery ?? recoveryQueryFromPrepared(prepared);
    }

    const needsProvisionalRecovery = args.resume !== undefined
      && (isProvisionalConversationId(threadId)
        || (archivedSubmission !== undefined && archivedSubmission.state !== "confirmed" && affinity.canonicalId === undefined));
    const archivedTabTarget = args.resume === undefined ? undefined : recoveryHint?.tabId;
    const ordinaryBootstrapTarget = needsProvisionalRecovery
      ? undefined
      : (args.resume === undefined && args.thread === undefined)
        ? undefined
        : {
          ...(threadUrl === undefined ? {} : { url: threadUrl }),
          ...(threadId === undefined ? {} : { conversationId: threadId })
        };
    const boot = requireOk(await runStep("PREFLIGHT_BROWSER", async () => {
      const useRecoveryBootstrap = args.resume !== undefined
        && (needsProvisionalRecovery || archivedTabTarget !== undefined)
        && port.bootstrapRecovery !== undefined;
      const first = makeExistingTabRetryResumable(
        await (useRecoveryBootstrap
          ? port.bootstrapRecovery!(archivedTabTarget === undefined ? undefined : { tabId: archivedTabTarget })
          : port.bootstrap(ordinaryBootstrapTarget)),
        args.resume !== undefined
      );
      if (first.ok && archivedTabTarget !== undefined && !needsProvisionalRecovery && affinity.canonicalId !== undefined) {
        const claimed = await port.pageState().catch(() => undefined);
        const claimedId = claimed?.conversationId ?? conversationIdFromUrl(claimed?.url);
        if (claimedId !== affinity.canonicalId) {
          return makeExistingTabRetryResumable(await port.bootstrap(ordinaryBootstrapTarget), true);
        }
      }
      if (first.ok || archivedTabTarget === undefined || first.blocker?.code !== "existing_tab_not_found") return first;
      return makeExistingTabRetryResumable(await port.bootstrap(ordinaryBootstrapTarget), true);
    }), "PREFLIGHT_BROWSER");
    affinity.invocationTabId = boot.context.tabId;
    requireOk(await runStep("OPEN_CHAT", () => port.openChat()), "OPEN_CHAT");
    if (args.resume === undefined) {
      const opened = requireData(await runStep("OPEN_CHAT", () => args.thread === undefined
        ? port.newThread()
        : port.openThread({
            ...(threadUrl === undefined ? {} : { url: threadUrl }),
            ...(threadId === undefined ? {} : { conversationId: threadId })
          })), "OPEN_CHAT");
      threadUrl = opened.data.url || opened.context.url;
      threadId = opened.data.conversationId ?? opened.context.conversationId;
      affinity.invocationTabId = opened.context.tabId ?? affinity.invocationTabId;
      const openedThreadId = threadId ?? conversationIdFromUrl(threadUrl);
      affinity.routeId = openedThreadId;
      if (openedThreadId !== undefined && !isProvisionalConversationId(openedThreadId)) affinity.canonicalId = openedThreadId;
      const openedPage = await establishConversationAffinity(port, affinity, "OPEN_CHAT", false);
      threadUrl = openedPage.url ?? threadUrl;
      threadId = affinity.canonicalId ?? affinity.routeId ?? threadId;
    } else {
      const needsThreadRecovery = needsProvisionalRecovery;
      const openResult = needsThreadRecovery
        ? await runStep("RECOVER_THREAD", () => port.recoverThread(recoveryQuery!, prepared!.prompt, recoveryHint))
        : await runStep("OPEN_CHAT", () => port.openThread({
            ...(threadId === undefined ? {} : { conversationId: threadId }),
            ...(threadUrl === undefined ? {} : { url: threadUrl })
          }));
      const opened = requireData(openResult, openResult.ok ? "OPEN_CHAT" : "RECOVER_THREAD");
      const openedThreadId = opened.data.conversationId ?? conversationIdFromUrl(opened.data.url || opened.context.url);
      const expectedThreadId = archivedSubmission?.thread.id ?? conversationIdFromUrl(archivedSubmission?.thread.url);
      if (expectedThreadId !== undefined
        && openedThreadId !== undefined
        && !isProvisionalConversationId(expectedThreadId)
        && openedThreadId !== expectedThreadId) {
        throw new ReviewPreparationError("The visible opened thread does not match the immutable submission receipt.", "resume_opened_thread_mismatch");
      }
      const openedThreadUrl = opened.data.url || opened.context.url || threadUrl;
      affinity.invocationTabId = opened.context.tabId ?? affinity.invocationTabId;
      if (needsThreadRecovery) {
        if (openedThreadId === undefined || isProvisionalConversationId(openedThreadId)) {
          throw resumableConversationBlocker(
            "resume_recovered_thread_not_canonical",
            "The prompt-identical recovered Chat conversation did not expose a canonical conversation ID.",
            "RECOVER_THREAD",
            openedThreadUrl
          );
        }
        // Adopt the recovered candidate only for this invocation before checking
        // command provenance. Nothing is persisted until its prompt and turn
        // evidence have also been verified below.
        affinity.canonicalId = openedThreadId;
        affinity.routeId = openedThreadId;
        threadUrl = openedThreadUrl;
        threadId = openedThreadId;
        await assertConversationAffinity(port, affinity, "RECOVER_THREAD", true);
      } else {
        threadUrl = openedThreadUrl;
        threadId = openedThreadId;
        await assertConversationAffinity(port, affinity, "OPEN_CHAT", true);
      }
      const latestUser = requireData(await port.readLatestUser(), "POLL_METADATA");
      assertCommandContextAffinity(latestUser.context, affinity, "RECOVER_THREAD", true);
      const observedUserSha256 = sha256Text(normalizeVisiblePrompt(latestUser.data.text));
      const visiblePromptProven = archivedSubmission?.userTurnSha256 !== undefined
        ? observedUserSha256 === archivedSubmission.userTurnSha256
          || visibleUserTurnContainsExactPrompt(latestUser.data.text, prepared!.prompt)
        : visibleUserTurnContainsExactPrompt(latestUser.data.text, prepared!.prompt);
      if (!visiblePromptProven) {
        const message = "The latest visible user turn is not the archived submitted review prompt. Resume refused to capture a later or ambiguous response.";
        if (isProvisionalConversationId(expectedThreadId)) {
          throw new ReviewWorkflowError({
            ok: false,
            status: "blocked",
            warnings: [],
            blocker: {
              kind: "unknown",
              code: "resume_recovered_thread_prompt_mismatch",
              message: message + " The provisional receipt remains resumable and was not rebound to this candidate.",
              resumable: true
            },
            context: { timestamp: port.now().toISOString(), ...(threadUrl === undefined ? {} : { url: threadUrl }) }
          }, "RECOVER_THREAD");
        }
        throw new ReviewPreparationError(message, "resume_user_turn_mismatch");
      }
      await assertConversationAffinity(port, affinity, "RECOVER_THREAD", true);
      const recoveryStatus = requireData(await port.messageStatus(), "POLL_METADATA");
      assertCommandContextAffinity(recoveryStatus.context, affinity, "POLL_METADATA", true);
      resumedMessageStatus = recoveryStatus.data;
      assertSubmittedTurnOwnership(archivedSubmission, resumedMessageStatus, threadUrl);
      await assertConversationAffinity(port, affinity, "RECOVER_THREAD", true);
      await persistThreadCheckpoint(archiveDirectory!, prepared!, threadUrl, threadId, affinity.invocationTabId, port.now());
      const receiptNeedsConfirmation = archivedSubmission !== undefined
        && (archivedSubmission.state !== "confirmed" || isProvisionalConversationId(expectedThreadId));
      if (archivedSubmission !== undefined && receiptNeedsConfirmation && archiveDirectory !== undefined) {
        await writeImmutableJson(join(archiveDirectory, "submission-confirmation.json"), {
          schemaVersion: archivedSubmission.schemaVersion === 3 ? 3 : 2,
          state: "confirmed",
          submitted: true,
          resubmitAllowed: false,
          submittedAt: port.now().toISOString(),
          promptSha256: sha256Text(normalizePrompt(prepared!.prompt)),
          userTurnSha256: sha256Text(normalizeVisiblePrompt(prepared!.prompt)),
          thread: { url: threadUrl, id: threadId, ...(affinity.invocationTabId === undefined ? {} : { tabId: affinity.invocationTabId }) },
          baselineTurnCount: archivedSubmission.baselineTurnCount,
          baselineAssistantCount: archivedSubmission.baselineAssistantCount,
          artifactBaseline: archivedSubmission.artifactBaseline,
          ...submissionIntegrityFields(archivedSubmission),
          reconciliation: "visible_prompt_match"
        });
        archivedSubmission = {
          ...archivedSubmission,
          state: "confirmed",
          submitted: true,
          userTurnSha256: observedUserSha256,
          thread: {
            ...(threadUrl === undefined ? {} : { url: threadUrl }),
            ...(threadId === undefined ? {} : { id: threadId }),
            ...(affinity.invocationTabId === undefined ? {} : { tabId: affinity.invocationTabId })
          }
        };
      }
    }
    await assertConversationAffinity(port, affinity, "PREFLIGHT_BROWSER", args.resume !== undefined);

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

    let appliedData: ApplyConfigurationData;
    if (configurationBefore.inspection.verified
      && configurationMatchesSelection(configurationBefore.inspection, { intelligence: "Pro" })) {
      const now = port.now().toISOString();
      appliedData = {
        requested: { intelligence: "Pro" },
        selected: [],
        before: configurationBefore.inspection,
        after: configurationBefore.inspection,
        verified: true
      };
      steps.push({ state: "APPLY_PRO", startedAt: now, endedAt: now, ok: true, status: "already_verified", data: appliedData });
    } else {
      appliedData = requireData(await runStep("APPLY_PRO", () => port.applyPro()), "APPLY_PRO").data;
    }
    applied = appliedData.after;
    verifiedBeforeSubmit = appliedData.verified && configurationMatchesSelection(appliedData.after, { intelligence: "Pro" });
    if (!verifiedBeforeSubmit) throw workflowBlocker("model_fallback", "pro_precondition_unverified", "The visible Chat setting did not strictly verify Pro before submission.", "VERIFY_PRO_BEFORE_SUBMIT");
    await runStep("VERIFY_PRO_BEFORE_SUBMIT", async () => {
      await assertConversationAffinity(port, affinity, "VERIFY_PRO_BEFORE_SUBMIT", args.resume !== undefined);
      return { verified: true, active: appliedData.after.active };
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
      if (prepared!.mode === "review-packets") {
        const attachments = [prepared!.uploadManifestPath, ...prepared!.packetPaths];
        await assertConversationAffinity(port, affinity, "ATTACH_PACKETS", false);
        requireOk(await runStep("ATTACH_PACKETS", () => port.attach(attachments)), "ATTACH_PACKETS");
      }
      await assertConversationAffinity(port, affinity, "SUBMIT_ONCE", false);
      const beforeMessage = requireData(await port.messageStatus(), "SUBMIT_ONCE");
      baselineAssistantCount = beforeMessage.data.assistantTurnCount;
      await assertConversationAffinity(port, affinity, "SUBMIT_ONCE", false);
      requireOk(await port.compose(prepared!.prompt), "SUBMIT_ONCE");
      await assertConversationAffinity(port, affinity, "VERIFY_PRO_BEFORE_SUBMIT", false);
      const submissionIntegrity = archiveDirectory === undefined
        ? undefined
        : await createSubmissionIntegrity(prepared!, archiveDirectory, configurationBefore!, artifactBaseline!);
      if (archiveDirectory !== undefined) {
        await writeImmutableJson(join(archiveDirectory, "submission-intent.json"), {
          schemaVersion: 3,
          state: "intent",
          resubmitAllowed: false,
          createdAt: port.now().toISOString(),
          promptSha256: sha256Text(normalizePrompt(prepared!.prompt)),
          thread: {
            ...(threadUrl === undefined ? {} : { url: threadUrl }),
            ...(threadId === undefined ? {} : { id: threadId }),
            ...(affinity.invocationTabId === undefined ? {} : { tabId: affinity.invocationTabId })
          },
          ...(beforeMessage.data.turnCount === undefined ? {} : { baselineTurnCount: beforeMessage.data.turnCount }),
          baselineAssistantCount,
          artifactBaseline,
          ...submissionIntegrity
        });
      }

      let submitResult: CommandResult<SubmitData> | undefined;
      let submitError: unknown;
      try {
        submitResult = await runStep("SUBMIT_ONCE", () => port.submit(prepared!.prompt, beforeMessage.data.turnCount));
      } catch (error) {
        submitError = error;
      }
      const afterMessage = await port.messageStatus().catch(() => undefined);
      const latestUser = await port.readLatestUser().catch(() => undefined);
      const visiblePage = await port.pageState().catch(() => undefined);
      const visibleConversationId = visiblePage?.conversationId ?? conversationIdFromUrl(visiblePage?.url);
      const latestUserText = latestUser?.ok === true ? latestUser.data?.text : undefined;
      const exactUserTurn = latestUserText !== undefined
        && visibleUserTurnContainsExactPrompt(latestUserText, prepared!.prompt);
      const pageAdvanced = afterMessage?.ok === true && (
        (beforeMessage.data.turnCount !== undefined
          && afterMessage.data?.turnCount !== undefined
          && afterMessage.data.turnCount > beforeMessage.data.turnCount)
        || afterMessage.data?.generationActive === true
      );
      const submitReported = submitResult?.ok === true && submitResult.data?.submitted === true;
      const submitConversationId = submitResult?.context.conversationId ?? conversationIdFromUrl(submitResult?.context.url);
      const candidateOnBoundTab = visiblePage?.tabId === undefined
        || affinity.invocationTabId === undefined
        || visiblePage.tabId === affinity.invocationTabId;
      const canonicalTransitionProven = exactUserTurn
        && candidateOnBoundTab
        && (pageAdvanced || submitReported)
        && (submitConversationId === undefined
          || submitConversationId === affinity.routeId
          || submitConversationId === visibleConversationId);
      const preSubmitRouteId = affinity.routeId;
      if (canonicalTransitionProven
        && affinity.canonicalId === undefined
        && visibleConversationId !== undefined
        && !isProvisionalConversationId(visibleConversationId)) {
        affinity.canonicalId = visibleConversationId;
        affinity.routeId = visibleConversationId;
        threadId = visibleConversationId;
        threadUrl = visiblePage?.url ?? threadUrl;
      }
      let postSubmitAffinityError: unknown;
      try {
        const acceptedProvisionalContext = canonicalTransitionProven
          && isProvisionalConversationId(preSubmitRouteId)
          && submitConversationId === preSubmitRouteId;
        if (submitResult !== undefined) {
          assertCommandContextAffinity(
            submitResult.context,
            affinity,
            "SUBMIT_ONCE",
            true,
            acceptedProvisionalContext ? preSubmitRouteId : undefined
          );
        }
        await assertConversationAffinity(port, affinity, "SUBMIT_ONCE", true);
      } catch (error) {
        postSubmitAffinityError = error;
      }
      const submissionState = postSubmitAffinityError === undefined && exactUserTurn
        ? "confirmed"
        : (submitReported || pageAdvanced || postSubmitAffinityError !== undefined ? "ambiguous" : "failed");
      submitted = submissionState !== "failed";
      if (archiveDirectory !== undefined) {
        const archivedSubmissionRecord: ArchivedSubmission = {
          schemaVersion: 3,
          state: submissionState,
          submitted,
          resubmitAllowed: false,
          submittedAt: port.now().toISOString(),
          promptSha256: sha256Text(normalizePrompt(prepared!.prompt)),
          ...(exactUserTurn ? { userTurnSha256: sha256Text(normalizeVisiblePrompt(prepared!.prompt)) } : {}),
          thread: {
            ...(threadUrl === undefined ? {} : { url: threadUrl }),
            ...(threadId === undefined ? {} : { id: threadId }),
            ...(affinity.invocationTabId === undefined ? {} : { tabId: affinity.invocationTabId })
          },
          ...(beforeMessage.data.turnCount === undefined ? {} : { baselineTurnCount: beforeMessage.data.turnCount }),
          baselineAssistantCount,
          artifactBaseline,
          ...submissionIntegrity,
          result: redactReportValue(submitResult ?? { error: submitError instanceof Error ? { name: submitError.name, message: submitError.message } : String(submitError) })
        };
        await writeImmutableJson(join(archiveDirectory, "submission.json"), archivedSubmissionRecord);
        archivedSubmission = archivedSubmissionRecord;
        await persistThreadCheckpoint(archiveDirectory, prepared!, threadUrl, threadId, affinity.invocationTabId, port.now());
      }
      if (postSubmitAffinityError !== undefined) throw postSubmitAffinityError;
      if (submissionState !== "confirmed") {
        if (submissionState === "ambiguous") {
          warnings.push("Chat advanced after the single submit attempt, but the exact rendered user turn is not yet provable. Resume this archive to reconcile the visible prompt; do not resend it.");
          throw new ReviewInProgress();
        }
        throw workflowBlocker(
          "unknown",
          "submission_unconfirmed",
          "The single allowed submit attempt did not produce a matching visible user turn. The prompt will not be resent automatically.",
          "SUBMIT_ONCE"
        );
      }
      if (submitResult?.ok !== true && submitError !== undefined) {
        warnings.push(`Submit transport reported an error after the exact visible user turn was confirmed: ${submitError instanceof Error ? submitError.message : String(submitError)}`);
      }
    } else {
      const current = resumedMessageStatus === undefined
        ? requireData(await port.messageStatus(), "POLL_METADATA").data
        : resumedMessageStatus;
      // A resumed review owns a fresh one-prompt thread. Poll the already-visible
      // latest assistant turn even when the cheap status probe calls it
      // "partial"; the bounded metadata wait is responsible for confirming
      // response actions, text stability, and inactive generation. Using the
      // full assistant count here waits for a nonexistent duplicate response.
      baselineAssistantCount = archivedSubmission?.baselineAssistantCount
        ?? Math.max(0, current.assistantTurnCount - (current.assistantTurnCount > 0 ? 1 : 0));
    }

    const callTimeoutMs = positive(args.polling?.callTimeoutMs, 20_000);
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
      assertCommandContextAffinity(wait.context, affinity, "POLL_METADATA", true);
      const polledPage = await assertConversationAffinity(port, affinity, "POLL_METADATA", true);
      threadUrl = polledPage.url ?? threadUrl;
      threadId = affinity.canonicalId ?? affinity.routeId ?? threadId;
      if (archiveDirectory !== undefined) {
        await persistThreadCheckpoint(archiveDirectory, prepared!, threadUrl, threadId, affinity.invocationTabId, port.now());
      }
      if (wait.ok && wait.data?.complete === true) {
        complete = true;
        break;
      }
      // A bounded wait that observed assistant text reports `partial`, while a
      // wait that observed no text reports `timeout`. Both mean the same thing
      // to this resumable workflow unless the DOM explicitly proved that
      // generation was stopped: Pro has not produced a complete answer yet.
      // Do not turn an ordinary "Pro is thinking" snapshot into a terminal
      // workflow failure merely because some partial text is already visible.
      const resumablePoll = wait.status === "timeout"
        || (wait.status === "partial" && wait.data?.completionState !== "stopped");
      if (!resumablePoll) requireOk(wait, "POLL_METADATA");
    }
    if (!complete) throw new ReviewInProgress();

    if (submitted) {
      const finalOwnership = requireData(await port.messageStatus(), "READ_FULL_MARKDOWN_ONCE").data;
      assertSubmittedTurnOwnership(archivedSubmission, finalOwnership, threadUrl);
    }
    await assertConversationAffinity(port, affinity, "READ_FULL_MARKDOWN_ONCE", true);
    const finalUser = requireData(await port.readLatestUser(), "READ_FULL_MARKDOWN_ONCE");
    if (!visibleUserTurnContainsExactPrompt(finalUser.data.text, prepared!.prompt)) {
      throw resumableConversationBlocker(
        "conversation_prompt_affinity_lost",
        "The latest visible user turn no longer matches the archived submitted prompt. The response and artifacts were not read.",
        "READ_FULL_MARKDOWN_ONCE",
        threadUrl
      );
    }

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
      await assertConversationAffinity(port, affinity, "READ_FULL_MARKDOWN_ONCE", true);
      const read = requireData(await runStep("READ_FULL_MARKDOWN_ONCE", () => port.readFullMarkdown()), "READ_FULL_MARKDOWN_ONCE");
      await assertConversationAffinity(port, affinity, "READ_FULL_MARKDOWN_ONCE", true);
      responseMarkdown = read.data.markdown ?? read.data.text;
      responseSha256 = sha256Text(responseMarkdown);
      if (submitted) {
        const postReadOwnership = requireData(await port.messageStatus(), "READ_FULL_MARKDOWN_ONCE").data;
        assertSubmittedTurnOwnership(archivedSubmission, postReadOwnership, threadUrl);
      }
      if (archiveDirectory !== undefined) await writeImmutableFile(join(archiveDirectory, "response.md"), responseMarkdown);
    }

    await assertConversationAffinity(port, affinity, "VERIFY_PRO_AFTER_COMPLETION", true);
    const after = requireData(await runStep("VERIFY_PRO_AFTER_COMPLETION", () => port.inspectConfiguration()), "VERIFY_PRO_AFTER_COMPLETION");
    await assertConversationAffinity(port, affinity, "VERIFY_PRO_AFTER_COMPLETION", true);
    verifiedAfterCompletion = after.data.verified && configurationMatchesSelection(after.data, { intelligence: "Pro" });
    if (!verifiedAfterCompletion) throw workflowBlocker("model_fallback", "pro_postcondition_unverified", "The visible Chat setting no longer strictly verifies Pro after completion; the response is archived but is not accepted as a verified Pro review.", "VERIFY_PRO_AFTER_COMPLETION");

    const finalizedArtifacts = archiveDirectory === undefined
      ? undefined
      : await readFinalizedArtifactManifest(archiveDirectory);
    await assertConversationAffinity(port, affinity, "ENUMERATE_NEW_ARTIFACTS", true);
    const delta = finalizedArtifacts === undefined
      ? requireData(await runStep("ENUMERATE_NEW_ARTIFACTS", () => port.artifactDelta(artifactBaseline!)), "ENUMERATE_NEW_ARTIFACTS").data
      : await runStep("ENUMERATE_NEW_ARTIFACTS", async () => ({
          baseline: artifactBaseline!,
          current: artifactBaseline!,
          added: [],
          finalizedArchive: true
        }));
    await assertConversationAffinity(port, affinity, "ENUMERATE_NEW_ARTIFACTS", true);
    if (finalizedArtifacts !== undefined) {
      artifacts.push(...finalizedArtifacts);
      await runStep("DOWNLOAD_AND_HASH_ARTIFACTS", async () => ({
        downloaded: 0,
        reused: finalizedArtifacts.length,
        total: finalizedArtifacts.length,
        finalizedArchive: true
      }));
    } else if ((args.output?.downloadArtifacts ?? "all") === "all" && archiveDirectory !== undefined) {
      const artifactArchiveDirectory = archiveDirectory;
      await runStep("DOWNLOAD_AND_HASH_ARTIFACTS", async () => {
        await assertConversationAffinity(port, affinity, "DOWNLOAD_AND_HASH_ARTIFACTS", true);
        const staging = await mkdtemp(join(tmpdir(), "chatgpt-pro-review-artifacts-"));
        const checkpointArtifacts = await readArtifactDownloadCheckpoint(artifactArchiveDirectory);
        artifacts.push(...checkpointArtifacts);
        const checkpointCount = checkpointArtifacts.length;
        const used = new Set(checkpointArtifacts.map(artifact => artifact.name.toLocaleLowerCase()));
        try {
          for (const item of delta.added) {
            await assertConversationAffinity(port, affinity, "DOWNLOAD_AND_HASH_ARTIFACTS", true);
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
        await assertConversationAffinity(port, affinity, "DOWNLOAD_AND_HASH_ARTIFACTS", true);
        return { downloaded: artifacts.length - checkpointCount, reused: checkpointCount, total: artifacts.length };
      });
    } else if (delta.added.length > 0) {
      warnings.push(`${delta.added.length} new artifacts were detected but downloadArtifacts was explicitly disabled.`);
    }

    if (archiveDirectory !== undefined && responseMarkdown !== undefined) {
      const completedArchiveDirectory = archiveDirectory;
      const archivedResponse = responseMarkdown;
      await runStep("ARCHIVE_RUN", async () => {
        await assertConversationAffinity(port, affinity, "ARCHIVE_RUN", true);
        await writeImmutableJson(join(completedArchiveDirectory, "artifacts", "manifest.json"), artifacts);
        return { responseSha256, responseBytes: Buffer.byteLength(archivedResponse), artifacts: artifacts.length };
      });
    }
    terminalStatus = warnings.length > 0 ? "completed_with_warnings" : "completed";
  } catch (error) {
    primaryError = error;
    if (error instanceof ArchivedTerminalOutcomeError) {
      terminalOutcomeAlreadyFinal = true;
      terminalStatus = error.outcome.status;
      submitted = error.outcome.submitted;
      blocker = error.outcome.blocker;
      warnings.push(...error.outcome.warnings);
      threadUrl = error.outcome.thread?.url ?? threadUrl;
      threadId = error.outcome.thread?.id ?? threadId;
      responseSha256 = error.outcome.response?.sha256;
    } else if (error instanceof ReviewInProgress) {
      terminalStatus = "in_progress";
    } else if (error instanceof ReviewPreparationError) {
      archiveDirectory = error.archiveDirectory ?? archiveDirectory;
      if (archivedSubmission !== undefined) {
        submitted = archivedSubmission.submitted;
        threadUrl = archivedSubmission.thread.url ?? threadUrl;
        threadId = archivedSubmission.thread.id ?? conversationIdFromUrl(archivedSubmission.thread.url) ?? threadId;
      }
      terminalStatus = "blocked";
      blocker = {
        kind: error.code.includes("configuration_snapshot")
          ? "configuration_restore_failed"
          : "unknown",
        code: error.code,
        message: error.message,
        resumable: isCorrectableResumePreparationError(error.code)
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
    if (!terminalOutcomeAlreadyFinal
      && terminalStatus !== "in_progress"
      && configurationBefore !== undefined
      && args.safeguards?.restorePreviousConfiguration === true) {
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

  const contextMode = prepared?.mode
    ?? (args.context?.mode === "none" || (args.repositoryRoot === undefined && args.baseRef === undefined) ? "none" : "review-packets");
  const provenance: ProCodeReviewResult["provenance"] = { contextMode };
  if (contextMode === "review-packets") {
    provenance.reviewScope = prepared?.manifest.reviewScope ?? args.context?.scope ?? (args.baseRef === undefined ? "repository" : "changes");
    const repositoryRoot = prepared?.manifest.repositoryRoot ?? args.repositoryRoot;
    const baseRef = prepared?.manifest.baseRef ?? args.baseRef;
    const headRef = prepared?.manifest.headRef ?? args.headRef ?? "HEAD";
    if (repositoryRoot !== undefined) provenance.repositoryRoot = repositoryRoot;
    if (baseRef !== undefined) provenance.baseRef = baseRef;
    provenance.headRef = headRef;
  }
  if (contextMode === "review-packets" && prepared?.manifest.baseSha !== undefined) provenance.baseSha = prepared.manifest.baseSha;
  if (contextMode === "review-packets" && prepared?.manifest.headSha !== undefined) provenance.headSha = prepared.manifest.headSha;
  if (contextMode === "review-packets" && prepared?.manifest.mergeBaseSha !== undefined) provenance.mergeBaseSha = prepared.manifest.mergeBaseSha;
  if (prepared?.mode === "review-packets") {
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
    if (archiveDirectory !== undefined
      && !terminalOutcomeAlreadyFinal
      && (releaseLease !== undefined || result.blocker?.code !== "review_archive_locked")) {
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
        if (result.blocker?.resumable === false && result.status !== "in_progress") {
          const terminalOutcome: ArchivedTerminalOutcome = {
            schemaVersion: 1,
            finalizedAt: port.now().toISOString(),
            status: result.status,
            ok: result.ok,
            submitted: result.submitted,
            resubmitAllowed: false,
            blocker: result.blocker,
            warnings: result.warnings,
            ...(result.thread === undefined ? {} : { thread: result.thread }),
            ...(responseMarkdown === undefined || responseSha256 === undefined
              ? {}
              : { response: { bytes: Buffer.byteLength(responseMarkdown), sha256: responseSha256 } })
          };
          await writeImmutableJson(join(archiveDirectory, "terminal-outcome.json"), terminalOutcome);
        }
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
        const archiveCommitFailure: ArchivedTerminalOutcome = {
          schemaVersion: 1,
          finalizedAt: port.now().toISOString(),
          status: "failed",
          ok: false,
          submitted: result.submitted,
          resubmitAllowed: false,
          blocker: result.blocker,
          warnings: result.warnings,
          ...(result.thread === undefined ? {} : { thread: result.thread }),
          ...(responseMarkdown === undefined || responseSha256 === undefined
            ? {}
            : { response: { bytes: Buffer.byteLength(responseMarkdown), sha256: responseSha256 } })
        };
        try {
          await writeImmutableJson(join(archiveDirectory, "archive-commit-failure.json"), archiveCommitFailure);
        } catch (markerError) {
          result.warnings.push(`The authoritative archive commit failure marker could not be written: ${markerError instanceof Error ? markerError.message : String(markerError)}`);
        }
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
            ifMultiple: "block",
            requireChatGPT: true
          }
        }),
    bootstrapRecovery: target => bootstrap(env, target?.tabId === undefined
      ? { preferExistingTab: false }
      : {
          existingTab: {
            target: { type: "tabId", tabId: target.tabId },
            ifMissing: "block",
            ifMultiple: "block",
            requireChatGPT: true
          },
          preferExistingTab: false
        }),
    openChat: () => openExperience(env, { experience: "chat" }),
    newThread: () => newThread(env),
    openThread: target => openThread(env, { ...target, timeoutMs: 12_000 }),
    recoverThread: (query, expectedPrompt, preferred) => recoverReviewThread(env, query, expectedPrompt, preferred),
    snapshotConfiguration: () => snapshotConfiguration(env, { experience: "chat" }),
    applyPro: () => applyConfiguration(env, { experience: "chat", desired: { intelligence: "Pro" }, strict: true }),
    inspectConfiguration: () => inspectConfiguration(env, { experience: "chat", includeOptions: false }),
    restoreConfiguration: snapshot => restoreConfiguration(env, { snapshot, strict: true }),
    pageState: async () => {
      if (env.page === undefined) throw new Error("No visible ChatGPT page is attached.");
      const state = await readPageState(env.page);
      const tabId = tabIdFromPage(env.page);
      return tabId === undefined ? state : { ...state, tabId };
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

async function assertConversationAffinity(
  port: ReviewWorkflowPort,
  affinity: ConversationAffinity,
  state: ReviewState,
  resumable: boolean
): Promise<PageState & { tabId?: string }> {
  const page = await port.pageState();
  return assertConversationAffinityAgainstPage(port, affinity, state, resumable, page);
}

async function establishConversationAffinity(
  port: ReviewWorkflowPort,
  affinity: ConversationAffinity,
  state: ReviewState,
  resumable: boolean
): Promise<PageState & { tabId?: string }> {
  const page = await port.pageState();
  const observedId = page.conversationId ?? conversationIdFromUrl(page.url);
  if (affinity.invocationTabId === undefined && page.tabId !== undefined) affinity.invocationTabId = page.tabId;
  if (affinity.routeId === undefined && observedId !== undefined) {
    affinity.routeId = observedId;
    if (!isProvisionalConversationId(observedId)) affinity.canonicalId = observedId;
  }
  return assertConversationAffinityAgainstPage(port, affinity, state, resumable, page);
}

function assertConversationAffinityAgainstPage(
  port: ReviewWorkflowPort,
  affinity: ConversationAffinity,
  state: ReviewState,
  resumable: boolean,
  page: PageState & { tabId?: string }
): PageState & { tabId?: string } {
  if (page.blocker !== undefined && page.blocker.kind !== "modal") {
    throw new ReviewWorkflowError({
      ok: false,
      status: "blocked",
      warnings: [],
      blocker: { ...page.blocker, resumable: page.blocker.kind !== "model_fallback" && page.blocker.kind !== "model_unavailable" },
      context: { timestamp: port.now().toISOString(), url: page.url, ...(page.tabId === undefined ? {} : { tabId: page.tabId }) }
    }, state);
  }
  const observedId = page.conversationId ?? conversationIdFromUrl(page.url);
  const expectedId = affinity.canonicalId ?? affinity.routeId;
  if (expectedId !== undefined && observedId !== expectedId) {
    throw conversationAffinityBlocker(
      "conversation_binding_lost",
      `The visible Chat conversation changed from ${expectedId} to ${observedId ?? "an unverifiable target"}. The archived conversation binding was not changed.`,
      state,
      resumable,
      page
    );
  }
  if (expectedId === undefined && observedId !== undefined) {
    throw conversationAffinityBlocker(
      "conversation_binding_lost",
      `The visible Chat conversation changed to ${observedId} before the workflow could prove that it contains the archived submitted prompt.`,
      state,
      resumable,
      page
    );
  }
  if (affinity.invocationTabId !== undefined && page.tabId !== undefined && page.tabId !== affinity.invocationTabId) {
    throw conversationAffinityBlocker(
      "conversation_tab_affinity_lost",
      `The workflow moved from bound browser tab ${affinity.invocationTabId} to ${page.tabId}.`,
      state,
      resumable,
      page
    );
  }
  return page;
}

function conversationAffinityBlocker(
  code: string,
  message: string,
  state: ReviewState,
  resumable: boolean,
  page?: { url?: string; tabId?: string }
): ReviewWorkflowError {
  return new ReviewWorkflowError({
    ok: false,
    status: "blocked",
    warnings: [],
    blocker: {
      kind: "selector_drift",
      code,
      message,
      resumable
    },
    context: {
      timestamp: new Date().toISOString(),
      ...(page?.url === undefined ? {} : { url: page.url }),
      ...(page?.tabId === undefined ? {} : { tabId: page.tabId })
    }
  }, state);
}

function assertCommandContextAffinity(
  context: { url?: string; conversationId?: string; tabId?: string },
  affinity: ConversationAffinity,
  state: ReviewState,
  resumable: boolean,
  allowedConversationId?: string
): void {
  const observedId = context.conversationId ?? conversationIdFromUrl(context.url);
  const expectedId = affinity.canonicalId ?? affinity.routeId;
  if (observedId !== undefined
    && expectedId !== undefined
    && observedId !== expectedId
    && observedId !== allowedConversationId) {
    throw conversationAffinityBlocker(
      "conversation_binding_lost",
      `The ${state} result came from Chat conversation ${observedId}, but this invocation is immutably bound to ${expectedId}.`,
      state,
      resumable,
      context
    );
  }
  if (context.tabId !== undefined && affinity.invocationTabId !== undefined && context.tabId !== affinity.invocationTabId) {
    throw conversationAffinityBlocker(
      "conversation_tab_affinity_lost",
      `The ${state} result came from browser tab ${context.tabId}, but this invocation is immutably bound to ${affinity.invocationTabId}.`,
      state,
      resumable,
      context
    );
  }
}

function resumableConversationBlocker(code: string, message: string, state: ReviewState, url?: string): ReviewWorkflowError {
  return conversationAffinityBlocker(code, message, state, true, url === undefined ? undefined : { url });
}

function isCorrectableResumePreparationError(code: string): boolean {
  return code === "review_archive_locked"
    || code === "resume_thread_mismatch"
    || code === "resume_artifact_baseline_mismatch"
    || code === "resume_opened_thread_mismatch"
    || code === "resume_user_turn_mismatch";
}

function assertSubmittedTurnOwnership(
  submission: ArchivedSubmission | undefined,
  current: MessageStatusData,
  url: string | undefined
): void {
  if (submission === undefined) return;
  const laterAssistantCycle = typeof submission.baselineAssistantCount === "number"
    && Number.isInteger(submission.baselineAssistantCount)
    && Number.isInteger(current.assistantTurnCount)
    && current.assistantTurnCount > submission.baselineAssistantCount + 1;
  const laterTurnCycle = typeof submission.baselineTurnCount === "number"
    && typeof current.turnCount === "number"
    && Number.isInteger(submission.baselineTurnCount)
    && Number.isInteger(current.turnCount)
    && current.turnCount > submission.baselineTurnCount + 2;
  if (!laterAssistantCycle && !laterTurnCycle) return;
  throw resumableConversationBlocker(
    "resume_conversation_turn_ambiguous",
    "The recovered conversation contains another user/assistant cycle after the archived one-shot submission. Even though the latest user text may be identical, response ownership is ambiguous and no response or artifacts were accepted.",
    "POLL_METADATA",
    url
  );
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
  let manifest: PreparedReviewContext["manifest"];
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PreparedReviewContext["manifest"];
  } catch {
    throw new ReviewPreparationError("Archived review packet manifest is missing or invalid.", "resume_packet_manifest_invalid");
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packets)) {
    throw new ReviewPreparationError("Archived review packet manifest is invalid.", "resume_packet_manifest_invalid");
  }
  const promptPath = join(archiveDirectory, "prompt.md");
  const contextDirectory = resolve(archiveDirectory, "context");
  const packetPaths: string[] = [];
  for (const packet of manifest.packets) {
    if (typeof packet.path !== "string" || typeof packet.sha256 !== "string" || !Number.isInteger(packet.sizeBytes)) {
      throw new ReviewPreparationError("Archived review packet metadata is invalid.", "resume_packet_manifest_invalid");
    }
    const packetPath = resolve(contextDirectory, packet.path);
    try {
      assertPathInside(contextDirectory, packetPath);
    } catch {
      throw new ReviewPreparationError("Archived review packet path escapes the context directory.", "resume_packet_path_escape");
    }
    const packetMatches = await stat(packetPath)
      .then(async packetStat => packetStat.isFile()
        && packetStat.size === packet.sizeBytes
        && await sha256File(packetPath) === packet.sha256)
      .catch(() => false);
    if (!packetMatches) {
      throw new ReviewPreparationError(`Archived review packet failed size/hash verification: ${packet.path}`, "resume_packet_integrity_mismatch");
    }
    packetPaths.push(packetPath);
  }
  const candidateUploadManifestPath = join(contextDirectory, "manifest.upload.json");
  let uploadManifestPath = candidateUploadManifestPath;
  try {
    const uploadManifestStat = await stat(candidateUploadManifestPath);
    if (!uploadManifestStat.isFile()) throw new Error("Archived upload manifest is not a regular file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ReviewPreparationError("Archived upload manifest is invalid.", "resume_upload_manifest_invalid");
    }
    uploadManifestPath = manifestPath;
  }
  let prompt: string;
  try {
    prompt = await readFile(promptPath, "utf8");
  } catch {
    throw new ReviewPreparationError("Archived submitted prompt is missing or unreadable.", "resume_prompt_invalid");
  }
  return {
    mode: manifest.mode === "none" ? "none" : "review-packets",
    archiveDirectory,
    requestPath: join(archiveDirectory, "request.md"),
    promptPath,
    packetPaths,
    manifestPath,
    uploadManifestPath,
    manifest,
    manifestSha256: await sha256File(manifestPath),
    prompt
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
  schemaVersion?: 1 | 2 | 3;
  state: "confirmed" | "intent" | "ambiguous" | "failed";
  submittedAt?: string;
  promptSha256?: string;
  manifestSha256?: string;
  uploadManifestSha256?: string;
  configurationSnapshotSha256?: string;
  artifactBaselineSha256?: string;
  packetBindings?: Array<{ path: string; sizeBytes: number; sha256: string }>;
  userTurnSha256?: string;
  baselineTurnCount?: number;
  baselineAssistantCount?: number;
  thread: { url?: string; id?: string; tabId?: string };
  artifactBaseline: ArtifactInventoryData;
  result?: unknown;
};

type ArchivedTerminalOutcome = {
  schemaVersion: 1;
  finalizedAt: string;
  status: Exclude<ProCodeReviewResult["status"], "in_progress">;
  ok: boolean;
  submitted: boolean;
  resubmitAllowed: false;
  blocker: NonNullable<ProCodeReviewResult["blocker"]>;
  warnings: string[];
  thread?: { url?: string; id?: string };
  response?: { bytes: number; sha256: string };
};

type ThreadCheckpoint = {
  schemaVersion: 1;
  current: { url?: string; id?: string; tabId?: string };
  recoveryQuery: string;
  promptSha256: string;
  updatedAt: string;
};

async function readArchivedSubmission(archiveDirectory: string, prepared: PreparedReviewContext): Promise<ArchivedSubmission> {
  const confirmation = await readOptionalJson(join(archiveDirectory, "submission-confirmation.json"));
  const submittedRecord = confirmation ?? await readOptionalJson(join(archiveDirectory, "submission.json"));
  const intentOnly = submittedRecord === undefined;
  const value = (submittedRecord ?? await readOptionalJson(join(archiveDirectory, "submission-intent.json"))) as Partial<ArchivedSubmission> | undefined;
  if (value === undefined) {
    throw new ReviewPreparationError("The archive has no durable submission intent or confirmation record.", "resume_submission_unverified");
  }
  const state = intentOnly ? "intent" : (value.state ?? "confirmed");
  if (value.resubmitAllowed !== false
    || ((state === "confirmed" || state === "ambiguous") && value.submitted !== true)
    || ((state === "intent" || state === "failed") && value.submitted === true)
    || (state !== "confirmed" && state !== "intent" && state !== "ambiguous" && state !== "failed")
    || !isRecord(value.thread)
    || (value.thread.url !== undefined && typeof value.thread.url !== "string")
    || (value.thread.id !== undefined && typeof value.thread.id !== "string")
    || (value.thread.tabId !== undefined && typeof value.thread.tabId !== "string")) {
    throw new ReviewPreparationError("The archived submission receipt does not prove a submit-once, non-resubmittable review.", "resume_submission_unverified");
  }
  const expectedPromptSha256 = sha256Text(normalizePrompt(prepared.prompt));
  if (value.promptSha256 !== undefined && value.promptSha256 !== expectedPromptSha256) {
    throw new ReviewPreparationError("The archived submission prompt hash does not match prompt.md.", "resume_prompt_hash_mismatch");
  }
  if (value.thread === undefined || (value.thread.url === undefined && value.thread.id === undefined)) {
    throw new ReviewPreparationError("The archived submission receipt has no canonical Chat conversation target.", "resume_thread_missing");
  }
  if (value.artifactBaseline === undefined || !Array.isArray(value.artifactBaseline.items)) {
    throw new ReviewPreparationError("The archived submission receipt has no valid artifact baseline.", "resume_artifact_baseline_invalid");
  }
  if (value.schemaVersion === 3) {
    const expectedIntegrity = await createSubmissionIntegrity(
      prepared,
      archiveDirectory,
      await readArchivedConfigurationSnapshot(archiveDirectory),
      value.artifactBaseline
    );
    const actualIntegrity = submissionIntegrityFields(value);
    if (value.promptSha256 !== expectedPromptSha256
      || actualIntegrity.manifestSha256 !== expectedIntegrity.manifestSha256
      || actualIntegrity.uploadManifestSha256 !== expectedIntegrity.uploadManifestSha256
      || actualIntegrity.configurationSnapshotSha256 !== expectedIntegrity.configurationSnapshotSha256
      || actualIntegrity.artifactBaselineSha256 !== expectedIntegrity.artifactBaselineSha256
      || sha256Text(JSON.stringify(actualIntegrity.packetBindings)) !== sha256Text(JSON.stringify(expectedIntegrity.packetBindings))) {
      throw new ReviewPreparationError("The immutable submission receipt no longer matches the archived prompt, packet set, manifest, configuration snapshot, or artifact baseline.", "resume_submission_integrity_mismatch");
    }
  }
  return { ...value, state, submitted: state === "confirmed" || state === "ambiguous" } as ArchivedSubmission;
}

async function archivedSubmissionRecordExists(archiveDirectory: string): Promise<boolean> {
  for (const name of ["submission-confirmation.json", "submission.json", "submission-intent.json"]) {
    if (await stat(join(archiveDirectory, name)).then(entry => entry.isFile()).catch(() => false)) return true;
  }
  return false;
}

async function createSubmissionIntegrity(
  prepared: PreparedReviewContext,
  archiveDirectory: string,
  configurationBefore: ConfigurationSnapshotData,
  artifactBaseline: ArtifactInventoryData
): Promise<Required<Pick<ArchivedSubmission,
  "manifestSha256" | "uploadManifestSha256" | "configurationSnapshotSha256" | "artifactBaselineSha256" | "packetBindings">>> {
  const configurationPath = join(archiveDirectory, "configuration.before.json");
  // Ensure the caller is binding the exact archived snapshot, not merely an
  // equivalent in-memory value supplied during resume.
  const archivedConfiguration = await readArchivedConfigurationSnapshot(archiveDirectory);
  if (sha256Text(JSON.stringify(configurationBefore)) !== sha256Text(JSON.stringify(archivedConfiguration))) {
    throw new ReviewPreparationError("The in-memory configuration snapshot does not match configuration.before.json.", "submission_configuration_snapshot_mismatch");
  }
  return {
    manifestSha256: await sha256File(prepared.manifestPath),
    uploadManifestSha256: await sha256File(prepared.uploadManifestPath),
    configurationSnapshotSha256: await sha256File(configurationPath),
    artifactBaselineSha256: sha256Text(JSON.stringify(artifactBaseline)),
    packetBindings: prepared.manifest.packets.map(packet => ({
      path: packet.path,
      sizeBytes: packet.sizeBytes,
      sha256: packet.sha256
    }))
  };
}

function submissionIntegrityFields(value: Partial<ArchivedSubmission>): Partial<ArchivedSubmission> {
  return {
    ...(value.manifestSha256 === undefined ? {} : { manifestSha256: value.manifestSha256 }),
    ...(value.uploadManifestSha256 === undefined ? {} : { uploadManifestSha256: value.uploadManifestSha256 }),
    ...(value.configurationSnapshotSha256 === undefined ? {} : { configurationSnapshotSha256: value.configurationSnapshotSha256 }),
    ...(value.artifactBaselineSha256 === undefined ? {} : { artifactBaselineSha256: value.artifactBaselineSha256 }),
    ...(value.packetBindings === undefined ? {} : { packetBindings: value.packetBindings })
  };
}

async function readArchivedTerminalOutcome(archiveDirectory: string): Promise<ArchivedTerminalOutcome | undefined> {
  const value = await readArchivedTerminalMarker(
    join(archiveDirectory, "terminal-outcome.json"),
    "resume_terminal_outcome_invalid",
    "terminal outcome"
  );
  if (value === undefined) return undefined;
  const outcome = validateArchivedTerminalOutcome(value, "resume_terminal_outcome_invalid");
  if (outcome.blocker.resumable !== false) {
    throw new ReviewPreparationError("The archived terminal outcome is resumable and therefore cannot be authoritative.", "resume_terminal_outcome_invalid");
  }
  return outcome;
}

async function readArchivedCommitFailure(archiveDirectory: string): Promise<ArchivedTerminalOutcome | undefined> {
  const value = await readArchivedTerminalMarker(
    join(archiveDirectory, "archive-commit-failure.json"),
    "resume_archive_commit_failure_invalid",
    "archive commit failure"
  );
  if (value === undefined) return undefined;
  const outcome = validateArchivedTerminalOutcome(value, "resume_archive_commit_failure_invalid");
  if (outcome.status !== "failed"
    || outcome.ok !== false
    || outcome.blocker.code !== "archive_terminal_commit_failed"
    || outcome.blocker.resumable !== false) {
    throw new ReviewPreparationError("The archived terminal provenance commit failure marker is invalid.", "resume_archive_commit_failure_invalid");
  }
  return outcome;
}

async function readArchivedTerminalMarker(
  path: string,
  invalidCode: "resume_terminal_outcome_invalid" | "resume_archive_commit_failure_invalid",
  label: string
): Promise<Record<string, unknown> | undefined> {
  try {
    return await readOptionalJson(path);
  } catch (error) {
    throw new ReviewPreparationError(
      `The archived ${label} marker is unreadable or invalid JSON. ${error instanceof Error ? error.message : String(error)}`,
      invalidCode
    );
  }
}

async function validateArchivedTerminalBinding(
  archiveDirectory: string,
  outcome: ArchivedTerminalOutcome,
  submission: ArchivedSubmission | undefined
): Promise<void> {
  const invalidCode = outcome.blocker.code === "archive_terminal_commit_failed"
    ? "resume_archive_commit_failure_invalid"
    : "resume_terminal_outcome_invalid";
  const submittedId = submission?.thread.id ?? conversationIdFromUrl(submission?.thread.url);
  const outcomeId = outcome.thread?.id ?? conversationIdFromUrl(outcome.thread?.url);
  if ((submission === undefined && outcome.submitted)
    || (submission !== undefined && outcome.submitted !== submission.submitted)
    || (submission !== undefined && submittedId !== undefined && outcomeId !== submittedId)) {
    throw new ReviewPreparationError(
      "The archived terminal marker does not match the immutable submission receipt.",
      invalidCode
    );
  }
  if (outcome.response !== undefined) {
    const response = await readFile(join(archiveDirectory, "response.md"), "utf8").catch(() => undefined);
    if (response === undefined
      || Buffer.byteLength(response) !== outcome.response.bytes
      || sha256Text(response) !== outcome.response.sha256) {
      throw new ReviewPreparationError(
        "The archived terminal marker response metadata does not match response.md.",
        invalidCode
      );
    }
  }
}

function validateArchivedTerminalOutcome(
  value: Record<string, unknown>,
  invalidCode: "resume_terminal_outcome_invalid" | "resume_archive_commit_failure_invalid"
): ArchivedTerminalOutcome {
  if (value.schemaVersion !== 1
    || typeof value.finalizedAt !== "string"
    || (value.status !== "blocked" && value.status !== "failed" && value.status !== "completed" && value.status !== "completed_with_warnings")
    || typeof value.ok !== "boolean"
    || typeof value.submitted !== "boolean"
    || value.resubmitAllowed !== false
    || !isRecord(value.blocker)
    || typeof value.blocker.kind !== "string"
    || typeof value.blocker.code !== "string"
    || typeof value.blocker.message !== "string"
    || typeof value.blocker.resumable !== "boolean"
    || !Array.isArray(value.warnings)
    || !value.warnings.every(item => typeof item === "string")
    || (value.thread !== undefined && (!isRecord(value.thread)
      || (value.thread.url !== undefined && typeof value.thread.url !== "string")
      || (value.thread.id !== undefined && typeof value.thread.id !== "string")))
    || (value.response !== undefined && (!isRecord(value.response)
      || !Number.isInteger(value.response.bytes)
      || (value.response.bytes as number) < 0
      || typeof value.response.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(value.response.sha256)))) {
    throw new ReviewPreparationError("The archived terminal outcome is invalid.", invalidCode);
  }
  return value as unknown as ArchivedTerminalOutcome;
}

async function archivedFinalMarkerExists(archiveDirectory: string): Promise<boolean> {
  const markers = ["archive-commit-failure.json", "terminal-outcome.json"];
  for (const marker of markers) {
    if (await stat(join(archiveDirectory, marker)).then(() => true).catch(() => false)) return true;
  }
  return false;
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

async function recoverCurrentVisibleThread(
  port: ReviewWorkflowPort,
  expectedPrompt: string,
  requiredTabId: string | undefined
): Promise<CommandResult<OpenThreadData> | undefined> {
  if (requiredTabId === undefined) return undefined;
  const page = await port.pageState().catch(() => undefined);
  const conversationId = page?.conversationId ?? conversationIdFromUrl(page?.url);
  if (page === undefined
    || page.tabId !== requiredTabId
    || conversationId === undefined
    || isProvisionalConversationId(conversationId)) return undefined;
  const latestUser = await port.readLatestUser().catch(() => undefined);
  if (latestUser?.ok !== true || !visibleUserTurnContainsExactPrompt(latestUser.data?.text ?? "", expectedPrompt)) return undefined;
  return {
    ok: true,
    status: "ok",
    data: {
      url: page.url,
      conversationId,
      ...(page.title === undefined ? {} : { title: page.title })
    },
    warnings: ["Recovered the archived review from the already-visible prompt-identical Chat conversation."],
    context: {
      timestamp: port.now().toISOString(),
      url: page.url,
      conversationId,
      tabId: page.tabId,
      ...(page.title === undefined ? {} : { title: page.title })
    }
  };
}

type RecoveryCandidateEvidence = {
  conversationId: string;
  tabId?: string;
  exactPrompt: boolean;
};

function selectUniqueRecoveryCandidate(
  candidates: RecoveryCandidateEvidence[],
  preferredTabId?: string
): { conversationId: string; tabId?: string } | "ambiguous" | undefined {
  const exact = new Map<string, RecoveryCandidateEvidence>();
  for (const candidate of candidates) {
    if (candidate.exactPrompt && !exact.has(candidate.conversationId)) exact.set(candidate.conversationId, candidate);
  }
  const matches = [...exact.values()];
  if (matches.length === 1) {
    const match = matches[0]!;
    return { conversationId: match.conversationId, ...(match.tabId === undefined ? {} : { tabId: match.tabId }) };
  }
  if (matches.length > 1 && preferredTabId !== undefined) {
    const stableMatches = matches.filter(match => match.tabId === preferredTabId);
    if (stableMatches.length === 1) {
      const match = stableMatches[0]!;
      return { conversationId: match.conversationId, ...(match.tabId === undefined ? {} : { tabId: match.tabId }) };
    }
  }
  return matches.length > 1 ? "ambiguous" : undefined;
}

function recoveryQueryFromPrepared(prepared: PreparedReviewContext): string {
  const firstLine = prepared.prompt.split(/\r?\n/, 1)[0]?.trim();
  if (prepared.mode === "none" && firstLine !== undefined && firstLine.length > 0) return firstLine.slice(0, 200);
  if (firstLine?.startsWith("Codex Pro request - ") === true || firstLine?.startsWith("Codex Pro review - ") === true) return firstLine;
  const legacyCanary = prepared.prompt.match(/CANARY_OK:[a-z0-9]+/i)?.[0];
  return legacyCanary ?? prepared.manifest.headSha?.slice(0, 12) ?? prepared.manifest.headRef;
}

async function persistThreadCheckpoint(
  archiveDirectory: string,
  prepared: PreparedReviewContext,
  url: string | undefined,
  id: string | undefined,
  tabId: string | undefined,
  now: Date
): Promise<void> {
  if (url === undefined && id === undefined && tabId === undefined) return;
  const checkpoint: ThreadCheckpoint = {
    schemaVersion: 1,
    current: {
      ...(url === undefined ? {} : { url }),
      ...(id === undefined ? {} : { id }),
      ...(tabId === undefined ? {} : { tabId })
    },
    recoveryQuery: recoveryQueryFromPrepared(prepared),
    promptSha256: sha256Text(prepared.prompt),
    updatedAt: now.toISOString()
  };
  await writeJsonReplacing(join(archiveDirectory, "thread-checkpoint.json"), checkpoint);
}

async function readArchivedThreadCheckpoint(archiveDirectory: string): Promise<ThreadCheckpoint> {
  const value = JSON.parse(await readFile(join(archiveDirectory, "thread-checkpoint.json"), "utf8")) as Partial<ThreadCheckpoint>;
  if (value.schemaVersion !== 1
    || !isRecord(value.current)
    || (value.current.url !== undefined && typeof value.current.url !== "string")
    || (value.current.id !== undefined && typeof value.current.id !== "string")
    || (value.current.tabId !== undefined && typeof value.current.tabId !== "string")
    || typeof value.recoveryQuery !== "string"
    || typeof value.promptSha256 !== "string") {
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
  if (submittedId !== undefined
    && checkpointId !== undefined
    && !isProvisionalConversationId(submittedId)
    && !isProvisionalConversationId(checkpointId)
    && submittedId !== checkpointId) {
    throw new ReviewPreparationError("The mutable thread checkpoint points at a different conversation than the immutable submission receipt.", "resume_checkpoint_thread_mismatch");
  }
}

type RecoveryProbe = {
  tabId?: string;
  url?: string;
  conversationId?: string;
};

async function recoverReviewThread(
  env: RuntimeEnv,
  query: string,
  expectedPrompt: string,
  preferred?: { url?: string; conversationId?: string; tabId?: string }
): Promise<CommandResult<OpenThreadData>> {
  const warnings: string[] = [];
  const candidates = new Map<string, { url: string; conversationId: string; title?: string }>();
  const addCandidate = (url: string | undefined, conversationId: string | undefined, title?: string): void => {
    if (candidates.size >= MAX_RECOVERY_CANDIDATES) return;
    const id = conversationId ?? conversationIdFromUrl(url);
    if (id === undefined || isProvisionalConversationId(id)) return;
    const canonicalUrl = url ?? new URL(`/c/${id}`, "https://chatgpt.com/").toString();
    if (!candidates.has(id)) candidates.set(id, { url: canonicalUrl, conversationId: id, ...(title === undefined ? {} : { title }) });
  };

  const current = env.page === undefined ? undefined : await readPageState(env.page).catch(() => undefined);
  const probe: RecoveryProbe = {
    ...(env.expectedTabId === undefined ? {} : { tabId: env.expectedTabId }),
    ...(current?.url === undefined ? {} : { url: current.url }),
    ...(current?.conversationId === undefined ? {} : { conversationId: current.conversationId })
  };
  addCandidate(preferred?.url, preferred?.conversationId);
  addCandidate(current?.url, current?.conversationId, current?.title);

  const visible = await listVisibleThreads(env, 20);
  if (visible.ok && visible.data !== undefined) {
    warnings.push(...visible.warnings);
    for (const candidate of visible.data.results
      .map((candidate, index) => ({ candidate, index, score: recoveryCandidateScore(candidate.title, query) }))
      .filter(candidate => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, MAX_RECOVERY_CANDIDATES - candidates.size)) {
      addCandidate(new URL(candidate.candidate.href, "https://chatgpt.com/").toString(), candidate.candidate.conversationId, candidate.candidate.title);
    }
  }

  const search = await searchThreads(env, { query, limit: 12 });
  if (search.ok && search.data !== undefined) {
    warnings.push(...search.warnings);
    for (const candidate of search.data.results.slice(0, MAX_RECOVERY_CANDIDATES - candidates.size)) {
      addCandidate(new URL(candidate.href, "https://chatgpt.com/").toString(), candidate.conversationId, candidate.title);
    }
  } else if (candidates.size === 0) {
    return commandFailureAsOpenThread(search);
  }

  const exactMatches: Array<{ candidate: { url: string; conversationId: string; title?: string }; tabId?: string }> = [];
  for (const candidate of candidates.values()) {
    const opened = await exactClaimOrOpenRecoveryCandidate(env, candidate, probe, preferred?.tabId);
    if (!opened.ok) {
      const restored = await restoreRecoveryProbe(env, probe);
      return restored ?? opened;
    }
    const user = await readLatest(env, { role: "user", format: "text" });
    if (user.ok && visibleUserTurnContainsExactPrompt(user.data?.text ?? "", expectedPrompt)) {
      exactMatches.push({ candidate, ...(opened.context.tabId === undefined ? {} : { tabId: opened.context.tabId }) });
    }
    const restored = await restoreRecoveryProbe(env, probe);
    if (restored !== undefined) return restored;
  }

  const selectedEvidence = selectUniqueRecoveryCandidate(exactMatches.map(match => ({
    conversationId: match.candidate.conversationId,
    ...(match.tabId === undefined ? {} : { tabId: match.tabId }),
    exactPrompt: true
  })), preferred?.tabId);
  const selected = typeof selectedEvidence === "object"
    ? exactMatches.find(match => match.candidate.conversationId === selectedEvidence.conversationId)
    : undefined;
  if (selectedEvidence === "ambiguous") {
    return {
      ok: false,
      status: "blocked",
      warnings,
      blocker: {
        kind: "not_found",
        code: "review_thread_recovery_ambiguous",
        message: "Multiple canonical Chat conversations contain the exact archived prompt. Recovery refused to choose one without a unique archived tab binding.",
        resumable: true
      },
      context: { timestamp: new Date().toISOString(), ...(probe.tabId === undefined ? {} : { tabId: probe.tabId }) }
    };
  }
  if (selected === undefined) {
    return {
      ok: false,
      status: "not_found",
      warnings,
      blocker: {
        kind: "not_found",
        code: "review_thread_recovery_not_found",
        message: "The provisional Chat conversation ID expired, and visible Chat search found no conversation containing the exact archived prompt.",
        resumable: true
      },
      context: search.context
    };
  }

  const finalOpened = await exactClaimOrOpenRecoveryCandidate(env, selected.candidate, probe, selected.tabId ?? preferred?.tabId);
  if (!finalOpened.ok) return finalOpened;
  const finalUser = await readLatest(env, { role: "user", format: "text" });
  if (!finalUser.ok || !visibleUserTurnContainsExactPrompt(finalUser.data?.text ?? "", expectedPrompt)) {
    return {
      ok: false,
      status: "blocked",
      warnings,
      blocker: {
        kind: "unknown",
        code: "review_thread_recovery_changed",
        message: "The selected recovery conversation changed before its exact archived prompt could be reverified.",
        resumable: true
      },
      context: finalOpened.context
    };
  }
  return {
    ...finalOpened,
    warnings: [
      ...warnings,
      ...finalOpened.warnings,
      "Recovered the archived review from a uniquely prompt-identical conversation in visible Chat history."
    ]
  };
}

async function exactClaimOrOpenRecoveryCandidate(
  env: RuntimeEnv,
  candidate: { url: string; conversationId: string; title?: string },
  probe: RecoveryProbe,
  preferredTabId?: string
): Promise<CommandResult<OpenThreadData>> {
  if (preferredTabId !== undefined) {
    const preferredClaim = await bootstrap(env, {
      existingTab: {
        target: { type: "tabId", tabId: preferredTabId },
        ifMissing: "block",
        ifMultiple: "block",
        requireChatGPT: true
      },
      preferExistingTab: false
    });
    if (preferredClaim.ok) {
      const preferredState = env.page === undefined ? undefined : await readPageState(env.page).catch(() => undefined);
      const preferredObservedId = preferredState?.conversationId ?? conversationIdFromUrl(preferredState?.url);
      if (preferredObservedId === candidate.conversationId) {
        return recoveryCandidateSuccess(candidate, preferredClaim, preferredState);
      }
      const restored = await restoreRecoveryProbe(env, probe);
      if (restored !== undefined) return restored;
    } else if (preferredClaim.blocker?.code !== "existing_tab_not_found") {
      return commandFailureAsOpenThread(makeExistingTabRetryResumable(preferredClaim, true));
    }
  }
  const claim = await bootstrap(env, {
    existingTab: {
      target: { type: "conversationId", conversationId: candidate.conversationId },
      ifMissing: "block",
      ifMultiple: "block",
      requireChatGPT: true
    },
    preferExistingTab: false
  });
  if (claim.ok) {
    const state = env.page === undefined ? undefined : await readPageState(env.page).catch(() => undefined);
    const observedId = state?.conversationId ?? conversationIdFromUrl(state?.url)
      ?? claim.context.conversationId ?? conversationIdFromUrl(claim.context.url);
    if (observedId !== candidate.conversationId) {
      const restored = await restoreRecoveryProbe(env, probe);
      return restored ?? recoveryCandidateDrift(candidate, observedId, claim.context);
    }
    return recoveryCandidateSuccess(candidate, claim, state);
  }
  if (claim.blocker?.code !== "existing_tab_not_found") {
    return commandFailureAsOpenThread(makeExistingTabRetryResumable(claim, true));
  }
  const restored = await restoreRecoveryProbe(env, probe);
  if (restored !== undefined) return restored;
  const opened = await openThread(env, { url: candidate.url, timeoutMs: RECOVERY_CANDIDATE_OPEN_TIMEOUT_MS });
  if (opened.context.tabId === undefined && probe.tabId !== undefined) opened.context.tabId = probe.tabId;
  if (!opened.ok) {
    const repaired = await restoreRecoveryProbe(env, probe);
    return repaired ?? opened;
  }
  const state = env.page === undefined ? undefined : await readPageState(env.page).catch(() => undefined);
  const observedId = state?.conversationId ?? conversationIdFromUrl(state?.url)
    ?? opened.data?.conversationId ?? conversationIdFromUrl(opened.data?.url || opened.context.url)
    ?? opened.context.conversationId;
  if (observedId !== candidate.conversationId) {
    const repaired = await restoreRecoveryProbe(env, probe);
    return repaired ?? recoveryCandidateDrift(candidate, observedId, opened.context);
  }
  return opened;
}

async function restoreRecoveryProbe(
  env: RuntimeEnv,
  probe: RecoveryProbe
): Promise<CommandResult<OpenThreadData> | undefined> {
  if (probe.tabId !== undefined && env.expectedTabId !== probe.tabId) {
    const restored = await bootstrap(env, {
      existingTab: {
        target: { type: "tabId", tabId: probe.tabId },
        ifMissing: "block",
        ifMultiple: "block",
        requireChatGPT: true
      },
      preferExistingTab: false
    });
    if (!restored.ok) return commandFailureAsOpenThread(restored);
  }
  if (probe.url === undefined || env.page === undefined) return undefined;
  const current = await readPageState(env.page).catch(() => undefined);
  const currentId = current?.conversationId ?? conversationIdFromUrl(current?.url);
  const alreadyRestored = probe.conversationId !== undefined
    ? currentId === probe.conversationId
    : current?.url === probe.url;
  if (alreadyRestored) return undefined;
  if (typeof env.page.goto !== "function") {
    return recoveryProbeRestoreFailure(probe, "The bound recovery probe cannot navigate back to its original Chat target.");
  }
  try {
    await env.page.goto(probe.url);
  } catch (error) {
    return recoveryProbeRestoreFailure(probe, `The bound recovery probe could not return to its original Chat target: ${error instanceof Error ? error.message : String(error)}`);
  }
  const restoredState = await readPageState(env.page).catch(() => undefined);
  const restoredId = restoredState?.conversationId ?? conversationIdFromUrl(restoredState?.url);
  if ((probe.conversationId !== undefined && restoredId !== probe.conversationId)
    || (probe.conversationId === undefined && restoredState?.url !== probe.url)) {
    return recoveryProbeRestoreFailure(probe, "The bound recovery probe did not return to its original Chat target.");
  }
  return undefined;
}

function recoveryCandidateSuccess(
  candidate: { url: string; conversationId: string; title?: string },
  claim: CommandResult<unknown>,
  state: PageState | undefined
): CommandResult<OpenThreadData> {
  const title = state?.title ?? candidate.title;
  return {
    ok: true,
    status: "ok",
    data: {
      url: state?.url ?? candidate.url,
      conversationId: candidate.conversationId,
      ...(title === undefined ? {} : { title })
    },
    warnings: claim.warnings,
    context: {
      ...claim.context,
      url: state?.url ?? candidate.url,
      conversationId: candidate.conversationId
    }
  };
}

function recoveryCandidateDrift(
  candidate: { conversationId: string },
  observedId: string | undefined,
  context: CommandResult<unknown>["context"]
): CommandResult<OpenThreadData> {
  return {
    ok: false,
    status: "blocked",
    warnings: [],
    blocker: {
      kind: "selector_drift",
      code: "review_thread_recovery_candidate_drift",
      message: `Recovery requested Chat conversation ${candidate.conversationId}, but the claimed or navigated page exposed ${observedId ?? "no canonical conversation ID"}.`,
      resumable: true
    },
    context
  };
}

function recoveryProbeRestoreFailure(probe: RecoveryProbe, message: string): CommandResult<OpenThreadData> {
  return {
    ok: false,
    status: "blocked",
    warnings: [],
    blocker: {
      kind: "selector_drift",
      code: "review_thread_recovery_probe_restore_failed",
      message,
      resumable: true
    },
    context: {
      timestamp: new Date().toISOString(),
      ...(probe.url === undefined ? {} : { url: probe.url }),
      ...(probe.conversationId === undefined ? {} : { conversationId: probe.conversationId }),
      ...(probe.tabId === undefined ? {} : { tabId: probe.tabId })
    }
  };
}

function commandFailureAsOpenThread(result: CommandResult<unknown>): CommandResult<OpenThreadData> {
  return {
    ok: false,
    status: result.status,
    warnings: result.warnings,
    ...(result.blocker === undefined ? {} : { blocker: result.blocker }),
    ...(result.error === undefined ? {} : { error: result.error }),
    context: result.context
  };
}

function makeExistingTabRetryResumable<T>(result: CommandResult<T>, onResume: boolean): CommandResult<T> {
  if (!onResume
    || result.ok
    || (result.blocker?.code !== "existing_tab_ambiguous"
      && result.blocker?.code !== "existing_tab_temporarily_claimed")) return result;
  return {
    ...result,
    blocker: { ...result.blocker, resumable: true }
  };
}

function recoveryCandidateScore(title: string, query: string): number {
  const queryTerms = new Set(recoveryTerms(query));
  return recoveryTerms(title).reduce((score, term) => score + (queryTerms.has(term) ? 1 : 0), 0);
}

function recoveryTerms(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter(term => term.length >= 3)
    .map(term => term.length > 4 && term.endsWith("s") ? term.slice(0, -1) : term);
}

function normalizePrompt(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function visibleUserTurnContainsExactPrompt(actual: string, expected: string): boolean {
  const normalizedActual = normalizeVisiblePrompt(actual);
  const normalizedExpected = normalizeVisiblePrompt(expected);
  if (normalizedActual === normalizedExpected) return true;
  const promptIndex = normalizedActual.indexOf(normalizedExpected);
  if (promptIndex < 0 || normalizedActual.indexOf(normalizedExpected, promptIndex + normalizedExpected.length) >= 0) return false;
  const prefix = normalizedActual.slice(0, promptIndex).trim();
  const suffix = normalizedActual.slice(promptIndex + normalizedExpected.length).trim();
  return isKnownAttachmentEnvelope(prefix) && (suffix === "" || suffix === "Show more");
}

function normalizeVisiblePrompt(value: string): string {
  return normalizePrompt(value).replace(/\s+/g, " ");
}

function isKnownAttachmentEnvelope(prefix: string): boolean {
  if (prefix === "") return true;
  const labels = prefix.split(/\s+File(?=\s|$)/).map(label => label.trim()).filter(Boolean);
  return labels.length > 0 && labels.every(label => /^[^/\\\r\n]{1,240}\.[a-z0-9]{1,12}$/i.test(label));
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

  return verifyArchivedArtifacts(artifactsDirectory, entries);
}

async function verifyArchivedArtifacts(artifactsDirectory: string, entries: unknown[]): Promise<ReviewArtifact[]> {
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

async function readFinalizedArtifactManifest(archiveDirectory: string): Promise<ReviewArtifact[] | undefined> {
  const artifactsDirectory = resolve(archiveDirectory, "artifacts");
  const manifestPath = join(artifactsDirectory, "manifest.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!Array.isArray(value)) throw new Error("The finalized artifact manifest is invalid.");
  return verifyArchivedArtifacts(artifactsDirectory, value);
}

function validateRequestedThread(args: ProCodeReviewArgs): void {
  if (args.resume !== undefined && args.thread !== undefined) {
    throw new ReviewPreparationError("thread and resume cannot be used together.", "thread_resume_conflict");
  }
  if (args.thread === undefined) return;
  const urlId = conversationIdFromUrl(args.thread.url);
  if (args.thread.url === undefined && args.thread.id === undefined) {
    throw new ReviewPreparationError("thread requires a canonical Chat conversation URL or id.", "thread_target_missing");
  }
  if (args.thread.id !== undefined && urlId !== undefined && args.thread.id !== urlId) {
    throw new ReviewPreparationError("thread.url and thread.id refer to different Chat conversations.", "thread_target_mismatch");
  }
  const requestedId = args.thread.id ?? urlId;
  if (requestedId === undefined || isProvisionalConversationId(requestedId)) {
    throw new ReviewPreparationError("thread requires a canonical Chat conversation target.", "thread_target_provisional");
  }
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
