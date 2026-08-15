import { createBridge, type CreateBridgeOptions } from "./bridge.js";
import {
  ChatGPTBrowserPort,
  type BrowserBridgePortOptions
} from "./browser-port.js";
import type { Browser, BrowserEnv } from "./browser-runtime.js";
import type { ChatGPTBridge } from "./types.js";

export type CreateChatGPTBridgeOptions = {
  browser: Browser;
  clipboard?: BrowserEnv["clipboard"];
}
  & BrowserBridgePortOptions
  & Pick<CreateBridgeOptions, "stateDir" | "now" | "sleep">;

/** Ordinary public factory for one direct visible ChatGPT bridge. */
export function createChatGPTBridge(
  options: CreateChatGPTBridgeOptions
): ChatGPTBridge {
  const env: BrowserEnv = {
    browser: options.browser,
    ...(options.clipboard === undefined ? {} : { clipboard: options.clipboard })
  };
  const port = new ChatGPTBrowserPort(env, {
    ...(options.acknowledgementTimeoutMs === undefined
      ? {}
      : { acknowledgementTimeoutMs: options.acknowledgementTimeoutMs }),
    ...(options.attachmentTimeoutMs === undefined
      ? {}
      : { attachmentTimeoutMs: options.attachmentTimeoutMs }),
    ...(options.artifactTimeoutMs === undefined
      ? {}
      : { artifactTimeoutMs: options.artifactTimeoutMs }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs })
  });
  return createBridge({
    port,
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}
