import type {
  ArtifactInventoryData,
  CommandResult,
  ConfigurationInspectionData,
  ConfigurationSnapshotData,
  RuntimeEnv
} from "../types.js";

export type ReviewOutputMode = "full" | "indexed";
export type ReviewScope = "changes" | "repository";

export type ProCodeReviewArgs = {
  /** Omit repositoryRoot for a context-free Pro question. */
  repositoryRoot?: string;
  /** Required for change scope. Omit for a complete repository review. */
  baseRef?: string;
  headRef?: string;
  request?: {
    focus?: string[];
    additionalInstructions?: string;
  };
  /** Submit a new question in this existing canonical Chat conversation. */
  thread?: {
    url?: string;
    id?: string;
  };
  target?: {
    experience?: "chat";
    intelligence?: "Pro";
    strict?: boolean;
  };
  context?: {
    /** Defaults to none without repository refs and review-packets with them. */
    mode?: "none" | "review-packets";
    /** Defaults to changes when baseRef is present and repository when it is omitted. */
    scope?: ReviewScope;
    includeWorkingTree?: boolean;
    includeInstructions?: boolean;
    includeChangedFiles?: boolean;
    includeRelevantCallers?: boolean;
    includeRelatedTests?: boolean;
    includeValidationOutput?: boolean;
    validationOutput?: string;
    validationOutputPath?: string;
    onBudgetExceeded?: "partition" | "block";
    maxPacketBytes?: number;
    maxTotalBytes?: number;
    maxSourceFileBytes?: number;
  };
  output?: {
    mode?: ReviewOutputMode;
    archive?: boolean;
    archiveRoot?: string;
    downloadArtifacts?: "all" | "none";
    returnFullMarkdown?: boolean;
    hardTransportLimitBytes?: number;
  };
  safeguards?: {
    submitOnce?: boolean;
    verifyTargetBeforeSubmit?: boolean;
    verifyTargetAfterCompletion?: boolean;
    failOnFallback?: boolean;
    restorePreviousConfiguration?: boolean;
  };
  polling?: {
    callTimeoutMs?: number;
    totalTimeoutMs?: number;
    maxPollCallsPerInvocation?: number;
    stableMs?: number;
    pollMs?: number;
  };
  resume?: {
    archiveDirectory: string;
    /** Optional cross-check. The immutable submission receipt is authoritative. */
    threadUrl?: string;
    /** Optional canonical Chat conversation-id cross-check. */
    conversationId?: string;
    /** Backward-compatible evidence flag; the archived receipt must independently verify it. */
    submitted?: true;
    artifactBaseline?: ArtifactInventoryData;
  };
  diagnosticMetadata?: Record<string, unknown>;
};

export type ReviewState =
  | "PREPARE_CONTEXT"
  | "PREFLIGHT_BROWSER"
  | "OPEN_CHAT"
  | "RECOVER_THREAD"
  | "SNAPSHOT_CONFIGURATION"
  | "APPLY_PRO"
  | "VERIFY_PRO_BEFORE_SUBMIT"
  | "BASELINE_ARTIFACTS"
  | "ATTACH_PACKETS"
  | "SUBMIT_ONCE"
  | "POLL_METADATA"
  | "READ_FULL_MARKDOWN_ONCE"
  | "VERIFY_PRO_AFTER_COMPLETION"
  | "ENUMERATE_NEW_ARTIFACTS"
  | "DOWNLOAD_AND_HASH_ARTIFACTS"
  | "ARCHIVE_RUN"
  | "RESTORE_PREVIOUS_CONFIGURATION"
  | "VERIFY_RESTORATION"
  | "RETURN_FULL_RESULT";

export type ReviewStepEvidence = {
  state: ReviewState;
  startedAt: string;
  endedAt: string;
  ok: boolean;
  status?: string;
  data?: unknown;
  blocker?: CommandResult["blocker"];
};

export type ReviewArtifact = {
  name: string;
  kind?: string;
  path: string;
  sizeBytes?: number;
  sha256: string;
  sourceLabel?: string;
  sourceReference?: string;
  /** Stable key from the pre/post visible artifact inventory. */
  inventoryKey?: string;
};

export type PacketFileRecord = {
  path: string;
  category: string;
  status: "included" | "excluded" | "oversized" | "binary" | "generated" | "ignored";
  reason?: string;
  sizeBytes?: number;
  sha256?: string;
  packet?: string;
};

export type ReviewPacketManifest = {
  schemaVersion: 1;
  /** Older packet archives omitted this field and are read as review-packets. */
  mode?: "none" | "review-packets";
  generatedAt: string;
  repositoryRoot: string;
  /** Older packet archives omitted this field and are read as changes. */
  reviewScope?: ReviewScope;
  baseRef?: string;
  headRef: string;
  baseSha?: string;
  headSha?: string;
  mergeBaseSha?: string;
  branch?: string;
  dirty: boolean;
  includeWorkingTree: boolean;
  packets: Array<{ path: string; sizeBytes: number; sha256: string; sections: string[] }>;
  files: PacketFileRecord[];
  exclusions: string[];
  partitions: Array<{ packet: string; files: string[] }>;
  crossPacketDependencies: Array<{ symbol: string; paths: string[] }>;
  validationOutputIncluded: boolean;
};

export type PreparedReviewContext = {
  mode: "none" | "review-packets";
  archiveDirectory: string;
  requestPath: string;
  promptPath: string;
  packetPaths: string[];
  manifestPath: string;
  manifest: ReviewPacketManifest;
  manifestSha256: string;
  prompt: string;
};

export type ProCodeReviewResult = {
  ok: boolean;
  status: "completed" | "in_progress" | "blocked" | "failed" | "completed_with_warnings";
  submitted: boolean;
  resubmitAllowed: false;
  nextAction?: "poll_same_thread";
  responseMarkdown?: string;
  responseIndex?: Array<{ heading: string; level: number; offset: number }>;
  archiveDirectory?: string;
  thread?: { url?: string; id?: string };
  artifacts: ReviewArtifact[];
  configuration: {
    before?: ConfigurationSnapshotData;
    requested: { experience: "chat"; intelligence: "Pro" };
    applied?: ConfigurationInspectionData;
    verifiedBeforeSubmit: boolean;
    verifiedAfterCompletion: boolean;
    restored: boolean;
    restorationVerified: boolean;
  };
  provenance: {
    contextMode: "none" | "review-packets";
    reviewScope?: ReviewScope;
    repositoryRoot?: string;
    baseRef?: string;
    headRef?: string;
    baseSha?: string;
    headSha?: string;
    mergeBaseSha?: string;
    packetManifestPath?: string;
    packetManifestSha256?: string;
    responseSha256?: string;
  };
  warnings: string[];
  blocker?: CommandResult["blocker"];
  rawSteps: ReviewStepEvidence[];
};

export type ReviewWorkflowDependencies = {
  env: RuntimeEnv;
};
