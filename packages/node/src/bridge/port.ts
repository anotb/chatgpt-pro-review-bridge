import type { BridgeOutputPort } from "./output.js";
import type { BridgeTargetPort } from "./targets.js";
import type { BridgeHandle, BridgePhase, BridgeThread } from "./types.js";

export type BridgeBinding = {
  tabId?: string;
  threadUrl?: string;
  conversationId?: string;
  userTurnCount: number;
  assistantTurnCount: number;
  lastUserTurnId?: string;
  lastAssistantTurnId?: string;
};

export type BridgeSubmission = {
  confirmed: boolean;
  renderedPromptSha256?: string;
  userTurnId?: string;
  threadUrl?: string;
  conversationId?: string;
  tabId?: string;
};

export type BridgeObservation = {
  phase: Extract<BridgePhase, "submitted" | "generating" | "completed" | "uncertain">;
  /** True only when the observed assistant turn belongs to this handle. */
  responseOwned: boolean;
  userTurnId?: string;
  assistantTurnId?: string;
  uncertainty?: string;
};

/**
 * Narrow browser seam. The bridge core owns operation policy; the adapter owns
 * visible ChatGPT mechanics and exact postconditions.
 */
export type BridgePort = BridgeTargetPort & BridgeOutputPort & {
  /** Read-only validation that must not acquire or mutate visible browser state. */
  preflightFiles(paths: readonly string[]): Promise<void>;
  bindThread(thread: BridgeThread): Promise<BridgeBinding>;
  bindHandle(handle: BridgeHandle): Promise<BridgeBinding>;
  selectTool(label: string): Promise<void>;
  attachFiles(paths: readonly string[]): Promise<void>;
  composePrompt(prompt: string): Promise<void>;
  /** Hash-only exact presentation evidence to persist before Send. */
  submissionPresentationSha256s(prompt: string): Promise<readonly string[]>;
  submitPrompt(input: {
    prompt: string;
    promptSha256: string;
    userTurnBefore: number;
    assistantTurnBefore: number;
    lastUserTurnId?: string;
    lastAssistantTurnId?: string;
    power?: string;
  }): Promise<BridgeSubmission>;
  observe(handle: BridgeHandle): Promise<BridgeObservation>;
};
