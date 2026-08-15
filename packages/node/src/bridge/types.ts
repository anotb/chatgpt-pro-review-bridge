export type BridgePhase =
  | "prepared"
  | "submitted"
  | "generating"
  | "completed"
  | "uncertain";

export type BridgeThread =
  | "new"
  | "current"
  | { url: string }
  | { conversationId: string };

/** The adapter-owned axis is fixed; its visible labels remain fully dynamic. */
export type BridgeSelection = {
  power?: string;
};

export type BridgeWaitOptions = {
  timeoutMs?: number;
  pollMs?: number;
};

export type BridgeRunInput = {
  /** Stable caller-owned ID. Reuse it with the exact request after interruption. */
  operationId: string;
  prompt: string;
  thread?: BridgeThread;
  selection?: BridgeSelection;
  tools?: string[];
  files?: string[];
  wait?: boolean | BridgeWaitOptions;
  downloadDir?: string;
};

export type BridgeHandle = {
  version: 1;
  operationId: string;
  promptSha256: string;
  /** Exact safe presentation hashes recorded before Send for crash recovery. */
  promptPresentationSha256s?: string[];
  /** Enables the attachment-envelope ownership rule without persisting file names. */
  attachmentCount?: number;
  /** Hash of the exact rendered user turn when ChatGPT transforms composer text. */
  renderedPromptSha256?: string;
  createdAt: string;
  statePath?: string;
  threadUrl?: string;
  conversationId?: string;
  tabId?: string;
  /** Stable visible message identities, when ChatGPT exposes them. */
  userTurnId?: string;
  assistantTurnId?: string;
  userTurnBefore?: number;
  assistantTurnBefore?: number;
};

export type BridgeTargetOption = {
  label: string;
  selected: boolean;
  disabled?: boolean;
};

export type BridgeTargetSnapshot = {
  active: BridgeSelection;
  options: Record<string, BridgeTargetOption[]>;
};

export type BridgeArtifact = {
  kind: "file" | "image";
  name?: string;
  path?: string;
  bytes?: number;
  sha256?: string;
  /** Explicit result of the caller-requested local artifact transfer. */
  transfer?: BridgeArtifactTransfer;
};

export type BridgeArtifactTransferFailureCode =
  | "artifact_preview_timeout"
  | "artifact_download_unavailable"
  | "artifact_transfer_failed";

export type BridgeArtifactTransfer =
  | { status: "not_requested" }
  | { status: "downloaded" }
  | { status: "failed"; code: BridgeArtifactTransferFailureCode };

export type BridgeOutput = {
  markdown?: string;
  text?: string;
  fidelity: "clipboard_markdown" | "dom_text";
  artifacts: BridgeArtifact[];
  partial?: boolean;
};

export type BridgeBlocker = {
  code: string;
  message: string;
  /** True only when collect can safely reconcile this same operation. */
  resumable: boolean;
};

export type BridgeResult = {
  phase: BridgePhase;
  handle: BridgeHandle;
  selection?: {
    requested: BridgeSelection;
    active: BridgeSelection;
    verified: boolean;
  };
  output?: BridgeOutput;
  blocker?: BridgeBlocker;
};

/**
 * Minimal redacted persistence. It intentionally stores no prompt text,
 * submitted input/output paths, response text, browser profile data, or account
 * identifiers. The handle may contain its own operation-journal path.
 */
export type BridgeOperationRecord = {
  schemaVersion: 1;
  handle: BridgeHandle;
  requestSha256: string;
  phase: BridgePhase;
  selection: BridgeSelection;
  updatedAt: string;
  uncertainty?: string;
};

export type BridgeResumeOptions = {
  wait?: boolean | BridgeWaitOptions;
  downloadDir?: string;
};

export type ChatGPTBridge = {
  inspectTargets(): Promise<BridgeTargetSnapshot>;
  submit(input: BridgeRunInput): Promise<BridgeResult>;
  /** A zero-wait collect is the status operation and never submits. */
  collect(handle: BridgeHandle, options?: BridgeResumeOptions): Promise<BridgeResult>;
  run(input: BridgeRunInput): Promise<BridgeResult>;
};
