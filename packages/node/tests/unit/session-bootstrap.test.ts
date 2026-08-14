import { describe, expect, it } from "vitest";

import { bootstrap } from "../../src/commands/session.js";
import type { BrowserLike, PageLike } from "../../src/types.js";

describe("session bootstrap state reuse", () => {
  it("uses the state captured by attach without probing the page again", async () => {
    let urlReads = 0;
    let titleReads = 0;
    let evaluations = 0;
    const page = {
      id: "existing-tab",
      url: () => {
        urlReads += 1;
        return "https://chatgpt.com/c/existing-conversation";
      },
      title: async () => {
        titleReads += 1;
        return "Existing conversation";
      },
      evaluate: async (_fn: unknown, argument: unknown) => {
        evaluations += 1;
        return {
          visibleText: "Chat history Chat with ChatGPT",
          blockerSurface: { text: "", hasConversationMessages: true },
          authenticationSurface: {
            accountControl: true,
            conversationLinkCount: 1,
            hasComposer: true,
            hasConversationMessages: true,
            loginControl: false
          }
        };
      }
    } as PageLike;
    const browser: BrowserLike = { name: "chrome" };

    const result = await bootstrap({ browser, page });

    expect(result).toMatchObject({
      ok: true,
      data: {
        browserName: "chrome",
        tabId: "existing-tab",
        url: "https://chatgpt.com/c/existing-conversation",
        loggedIn: true
      },
      context: {
        url: "https://chatgpt.com/c/existing-conversation",
        title: "Existing conversation",
        conversationId: "existing-conversation",
        tabId: "existing-tab"
      }
    });
    expect(urlReads).toBe(1);
    expect(titleReads).toBe(1);
    expect(evaluations).toBe(1);
  });
});
