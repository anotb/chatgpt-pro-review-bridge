import { describe, expect, it, vi } from "vitest";

import {
  CHATGPT_HOME,
  BrowserRuntimeError,
  acquireChatGPTPage,
  exactTabId,
  normalizeBrowserPage,
  type BrowserPage
} from "../../src/bridge/browser-runtime.js";

describe("lean browser runtime", () => {
  it("normalizes raw Tab.playwright while preserving the outer exact tab ID", async () => {
    const playwright = {
      marker: "playwright-page",
      locator() {
        expect(this).toBe(playwright);
        return {};
      }
    };
    const clipboard = { readText: vi.fn(async () => "virtual") };
    const page = normalizeBrowserPage({
      id: "raw-tab",
      url: "https://chatgpt.com/c/raw-tab",
      clipboard,
      playwright
    });

    expect(await page.url?.()).toBe("https://chatgpt.com/c/raw-tab");
    expect(page.locator?.("main")).toEqual({});
    expect((page as BrowserPage & { marker?: string }).marker).toBe("playwright-page");
    expect(page.clipboard).toBe(clipboard);
    expect(exactTabId(page)).toBe("raw-tab");
  });

  it("rejects an explicit page outside the exact https://chatgpt.com origin", async () => {
    await expect(acquireChatGPTPage({
      browser: {},
      page: fakePage("evil", "https://chatgpt.com.evil.example/c/nope")
    })).rejects.toMatchObject({ code: "unsafe_origin" } satisfies Partial<BrowserRuntimeError>);
  });

  it("reuses the one exact controlled ChatGPT tab", async () => {
    const page = fakePage("chat-one", "https://chatgpt.com/c/one");
    const acquired = await acquireChatGPTPage({
      browser: { tabs: { list: async () => [page] } }
    });

    expect(acquired.page).toBeDefined();
    expect(acquired.tabId).toBe("chat-one");
    expect(acquired.url).toBe("https://chatgpt.com/c/one");
  });

  it("fails closed when more than one controlled ChatGPT tab exists", async () => {
    const create = vi.fn(async () => fakePage("fresh", CHATGPT_HOME));
    await expect(acquireChatGPTPage({
      browser: {
        tabs: {
          list: async () => [
            fakePage("one", "https://chatgpt.com/c/one"),
            fakePage("two", "https://chatgpt.com/c/two")
          ],
          create
        }
      }
    })).rejects.toMatchObject({
      code: "ambiguous_chatgpt_tabs"
    } satisfies Partial<BrowserRuntimeError>);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates ChatGPT home when no controlled ChatGPT tab exists", async () => {
    const create = vi.fn(async (url: string) => fakePage("fresh", url));
    const env: {
      browser: { tabs: { list: () => Promise<never[]>; create: typeof create } };
      page?: BrowserPage;
      expectedTabId?: string;
    } = { browser: { tabs: { list: async () => [], create } } };
    const acquired = await acquireChatGPTPage(env);

    expect(create).toHaveBeenCalledExactlyOnceWith(CHATGPT_HOME);
    expect(acquired).toMatchObject({ tabId: "fresh", url: CHATGPT_HOME });
    expect(env.page).toBe(acquired.page);
    expect(env.expectedTabId).toBe("fresh");
  });

  it("creates a genuinely fresh tab instead of inheriting the previous binding", async () => {
    const create = vi.fn(async (url: string) => fakePage("fresh-two", url));
    const env = {
      browser: { tabs: { create } },
      page: fakePage("old-one", "https://chatgpt.com/c/old"),
      expectedTabId: "old-one"
    };
    const acquired = await acquireChatGPTPage(env, { fresh: true });

    expect(create).toHaveBeenCalledExactlyOnceWith(CHATGPT_HOME);
    expect(acquired.tabId).toBe("fresh-two");
    expect(env.expectedTabId).toBe("fresh-two");
  });

  it("blocks only a cheaply proven visible login wall", async () => {
    const page = fakePage("logged-out", CHATGPT_HOME, {
      account: false,
      composer: true,
      conversationLinks: 0,
      messages: false,
      login: true
    });
    await expect(acquireChatGPTPage({ browser: {}, page }))
      .rejects.toMatchObject({ code: "login_required" } satisfies Partial<BrowserRuntimeError>);
  });

  it("lets an exact visible login control override the guest profile button", async () => {
    const page = fakePage("guest-profile", CHATGPT_HOME, {
      account: true,
      composer: true,
      conversationLinks: 0,
      messages: false,
      login: true
    });
    await expect(acquireChatGPTPage({ browser: {}, page }))
      .rejects.toMatchObject({ code: "login_required" } satisfies Partial<BrowserRuntimeError>);
  });
});

function fakePage(
  id: string,
  url: string,
  auth: {
    account: boolean;
    composer: boolean;
    conversationLinks: number;
    messages: boolean;
    login: boolean;
  } = {
    account: true,
    composer: true,
    conversationLinks: 1,
    messages: false,
    login: false
  }
): BrowserPage {
  return {
    id,
    url: () => url,
    evaluate: async <T>() => auth as T
  };
}
