export { createBridge, type CreateBridgeOptions } from "./bridge.js";
export {
  ChatGPTBrowserPort,
  createBrowserBridgePort,
  type BrowserBridgePortOptions
} from "./browser-port.js";
export {
  createChatGPTBridge,
  type CreateChatGPTBridgeOptions
} from "./factory.js";
export type {
  BridgeBinding,
  BridgeObservation,
  BridgePort,
  BridgeSubmission
} from "./port.js";
export type {
  BridgeArtifact,
  BridgeBlocker,
  BridgeHandle,
  BridgeOutput,
  BridgePhase,
  BridgeResult,
  BridgeRunInput,
  BridgeSelection,
  BridgeTargetOption,
  BridgeTargetSnapshot,
  BridgeThread,
  BridgeWaitOptions,
  BridgeResumeOptions,
  ChatGPTBridge
} from "./types.js";
