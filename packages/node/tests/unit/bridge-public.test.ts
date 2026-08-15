import { describe, expect, it } from "vitest";

import {
  ChatGPTBrowserPort,
  createBridge,
  createBrowserBridgePort,
  createChatGPTBridge
} from "../../src/index.js";

describe("public bridge surface", () => {
  it("exports only the direct bridge factories and adapter", () => {
    const browser = { tabs: { list: async () => [fakePage()] } };
    expect(createBridge).toBeTypeOf("function");
    expect(createChatGPTBridge).toBeTypeOf("function");
    expect(createBrowserBridgePort({ page: fakePage() })).toBeInstanceOf(ChatGPTBrowserPort);
    expect(createChatGPTBridge({ browser })).toMatchObject({
      submit: expect.any(Function),
      collect: expect.any(Function),
      run: expect.any(Function),
      inspectTargets: expect.any(Function)
    });
  });
});

function fakePage() {
  return {
    id: "tab-public-test",
    url: () => "https://chatgpt.com/",
    evaluate: async <T>() => ({}) as T
  };
}
