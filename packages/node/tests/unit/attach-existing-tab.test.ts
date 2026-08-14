import { describe, expect, it } from "vitest";
import { bootstrap } from "../../src/commands/session.js";
import type { BrowserLike, PageLike } from "../../src/types.js";

describe("existing Chrome tab bootstrap", () => {
  it("claims the most recent open user ChatGPT tab for selected existing-tab mode", async () => {
    const claimed: unknown[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "user-tab-1", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          return fakeChatGPTPage("user-tab-1", "https://chatgpt.com/c/abc-123", "SDK Review");
        }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "selected", host: "chatgpt" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("user-tab-1");
    expect(result.context.conversationId).toBe("abc-123");
    expect(claimed).toEqual([
      { id: "user-tab-1", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
    ]);
  });

  it("uses user-open Chrome tabs for default preferred existing-tab discovery", async () => {
    const claimed: unknown[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "user-tab-1", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          return fakeChatGPTPage("user-tab-1", "https://chatgpt.com/c/abc-123", "SDK Review");
        }
      },
      tabs: {
        list: async () => []
      }
    };

    const result = await bootstrap({ browser }, { preferExistingTab: true });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("user-tab-1");
    expect(claimed).toEqual([
      { id: "user-tab-1", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
    ]);
  });

  it("uses user-open Chrome tabs when controlled tab enumeration is unavailable", async () => {
    const claimed: unknown[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "user-only", url: "https://chatgpt.com/c/user-only", title: "User-only APIs" }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          return fakeChatGPTPage("user-only", "https://chatgpt.com/c/user-only", "User-only APIs");
        }
      }
    };

    const result = await bootstrap({ browser }, { preferExistingTab: true });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("user-only");
    expect(claimed).toHaveLength(1);
  });

  it.each([
    "https://evil.example/?next=https://chatgpt.com/c/abc",
    "https://evil.example/chatgpt.com/c/abc",
    "https://chatgpt.com.evil.example/c/abc",
    "https://notchatgpt.com/c/abc"
  ])("does not reuse a lookalike controlled URL: %s", async lookalike => {
    const created: string[] = [];
    const lookalikePage = fakeChatGPTPage("lookalike", lookalike, "Lookalike");
    const browser: BrowserLike = {
      name: "chrome",
      tabs: {
        selected: async () => lookalikePage,
        list: async () => [lookalikePage],
        create: async url => {
          created.push(url);
          return fakeChatGPTPage("fresh", url, "ChatGPT");
        }
      }
    };

    const result = await bootstrap({ browser }, { preferExistingTab: true });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("fresh");
    expect(created).toEqual(["https://chatgpt.com/"]);
  });

  it("falls back to a fresh tab when an implicitly preferred user tab is temporarily claimed", async () => {
    const created: string[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "claimed-tab", url: "https://chatgpt.com/c/abc-123", title: "Already Claimed" }
        ],
        claimTab: async () => {
          throw new Error("Tab claimed-tab is already part of browser session existing-session");
        }
      },
      tabs: {
        create: async url => {
          created.push(url);
          return fakeChatGPTPage("fresh-tab", url, "ChatGPT");
        }
      }
    };

    const result = await bootstrap({ browser }, { preferExistingTab: true });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("fresh-tab");
    expect(created).toEqual(["https://chatgpt.com/"]);
  });

  it("does not open a duplicate when an exact existing conversation is temporarily claimed", async () => {
    const created: string[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "claimed-tab", url: "https://chatgpt.com/c/abc-123", title: "Already Claimed" }
        ],
        claimTab: async () => {
          throw new Error("Tab claimed-tab is already part of browser session existing-session");
        }
      },
      tabs: {
        create: async url => {
          created.push(url);
          return fakeChatGPTPage("fresh-tab", url, "ChatGPT");
        }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "open"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.blocker).toMatchObject({
      code: "existing_tab_temporarily_claimed",
      resumable: true
    });
    expect(created).toEqual([]);
  });

  it("claims an exact open user ChatGPT tab by conversation id without navigating", async () => {
    const claimed: unknown[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "other", url: "https://chatgpt.com/c/other", title: "Other Chat" },
          { id: "target", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          return fakeChatGPTPage("target", "https://chatgpt.com/c/abc-123", "SDK Review");
        }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("target");
    expect(claimed).toEqual([
      { id: "target", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
    ]);
  });

  it("does not require sidebar signed-in chrome for narrow conversation tabs", async () => {
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "narrow", url: "https://chatgpt.com/c/abc-123", title: "ChatGPT" }
        ],
        claimTab: async () => fakeNarrowChatGPTPage("narrow", "https://chatgpt.com/c/abc-123", "ChatGPT")
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("narrow");
    expect(result.context.conversationId).toBe("abc-123");
    expect(result.data?.loggedIn).toBe(false);
  });

  it("does not let a stale cached page bypass an explicit existing-tab claim", async () => {
    const claimed: unknown[] = [];
    const stalePage = {
      id: "stale",
      url: () => undefined as unknown as string,
      title: async () => "Stale tab",
      content: async () => "",
      locator: () => ({ count: async () => 0 })
    } as PageLike;
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "target", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          return fakeChatGPTPage("target", "https://chatgpt.com/c/abc-123", "SDK Review");
        }
      }
    };

    const result = await bootstrap({ browser, page: stalePage }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("target");
    expect(result.context.conversationId).toBe("abc-123");
    expect(claimed).toEqual([
      { id: "target", url: "https://chatgpt.com/c/abc-123", title: "SDK Review" }
    ]);
  });

  it("blocks when an explicit existing conversation target is not open", async () => {
    const claimed: unknown[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          {
            id: "opaque-other",
            providerTabId: "stable-other",
            url: "https://chatgpt.com/c/other",
            title: "Other Chat"
          }
        ],
        claimTab: async tab => {
          claimed.push(tab);
          throw new Error("claimTab should not be called for a missing existing-tab target.");
        }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.blocker).toMatchObject({
      kind: "not_found",
      code: "existing_tab_not_found"
    });
    expect(result.blocker?.diagnostics?.existingTab).toEqual({
      requestedTarget: {
        type: "conversationId",
        conversationId: "abc-123"
      },
      userOpenTabsAvailable: true,
      chatgptTabCount: 1,
      mismatchReason: "conversation_id_mismatch",
      candidateTabs: [
        {
          id: "stable-other",
          url: "https://chatgpt.com/c/other",
          title: "Other Chat",
          conversationId: "other"
        }
      ]
    });
    expect(result.blocker?.candidates).toEqual([
      { label: "tab stable-other - Other Chat - https://chatgpt.com/c/other" }
    ]);
    expect(claimed).toEqual([]);
    expect(JSON.stringify(result.blocker?.diagnostics)).not.toContain("say hi");
  });

  it("reports user-open tab enumeration failures without losing the failure reason", async () => {
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => {
          throw new Error("user tabs unavailable");
        },
        claimTab: async () => {
          throw new Error("claimTab should not be called when openTabs fails.");
        }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.blocker?.diagnostics?.existingTab).toEqual({
      requestedTarget: {
        type: "conversationId",
        conversationId: "abc-123"
      },
      userOpenTabsAvailable: false,
      chatgptTabCount: 0,
      mismatchReason: "user_open_tabs_unavailable",
      candidateTabs: []
    });
  });

  it("caps and truncates existing-tab diagnostic candidates", async () => {
    const longTitle = `SDK Review ${"x".repeat(280)}`;
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => Array.from({ length: 12 }, (_, index) => ({
          id: `tab-${index + 1}`,
          url: `https://chatgpt.com/c/other-${index + 1}`,
          title: index === 0 ? longTitle : `Other Chat ${index + 1}`
        })),
        claimTab: async () => {
          throw new Error("claimTab should not be called for a missing existing-tab target.");
        }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "conversationId", conversationId: "abc-123" },
        ifMissing: "block"
      }
    });

    const diagnostics = result.blocker?.diagnostics?.existingTab;
    expect(result.ok).toBe(false);
    expect(diagnostics?.candidateTabs).toHaveLength(10);
    expect(diagnostics?.omittedCandidateCount).toBe(2);
    expect(diagnostics?.candidateTabs[0]?.title).toHaveLength(240);
    expect(diagnostics?.candidateTabs[0]?.title?.endsWith("…")).toBe(true);
    expect(diagnostics?.candidateTabs[9]).toMatchObject({
      id: "tab-10",
      conversationId: "other-10"
    });
  });

  it("blocks ambiguous title matches with metadata-only candidates by default", async () => {
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [
          { id: "one", url: "https://chatgpt.com/c/one", title: "SDK Review" },
          { id: "two", url: "https://chatgpt.com/c/two", title: "SDK Review" }
        ],
        claimTab: async () => fakeChatGPTPage("one", "https://chatgpt.com/c/one", "SDK Review")
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: {
        target: { type: "title", title: "SDK Review" },
        ifMissing: "block"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.blocker).toMatchObject({
      kind: "not_found",
      code: "existing_tab_ambiguous"
    });
    expect(result.blocker?.candidates?.map(candidate => candidate.label)).toEqual([
      "tab one - SDK Review - https://chatgpt.com/c/one",
      "tab two - SDK Review - https://chatgpt.com/c/two"
    ]);
    expect(result.blocker?.diagnostics?.existingTab).toMatchObject({
      requestedTarget: {
        type: "title",
        title: "SDK Review"
      },
      userOpenTabsAvailable: true,
      chatgptTabCount: 2,
      mismatchReason: "multiple_candidates",
      candidateTabs: [
        {
          id: "one",
          url: "https://chatgpt.com/c/one",
          title: "SDK Review",
          conversationId: "one"
        },
        {
          id: "two",
          url: "https://chatgpt.com/c/two",
          title: "SDK Review",
          conversationId: "two"
        }
      ]
    });
  });

  it("hands off an exact controlled tab from list metadata and keeps every controlled tab open", async () => {
    const operations: string[] = [];
    const controlled = [
      { id: "target-provider", url: "https://chatgpt.com/c/abc-123", title: "Review" },
      { id: "other-provider", url: "https://chatgpt.com/c/other", title: "Other" }
    ];
    const browser = {
      name: "chrome",
      tabs: {
        list: async () => {
          operations.push("list");
          return controlled;
        },
        get: async () => {
          operations.push("get");
          throw new Error("get must not run after list succeeds");
        },
        finalize: async (options: { keep?: unknown[] }) => {
          operations.push("finalize");
          expect(options.keep).toEqual(controlled.map(tab => ({ tab, status: "handoff" })));
        }
      }
    } as unknown as BrowserLike;

    const result = await bootstrap({ browser }, {
      existingTab: { target: { type: "tabId", tabId: "target-provider" }, ifMissing: "open" },
      timeoutMs: 100
    });

    expect(result.blocker).toMatchObject({ code: "existing_tab_handoff_completed", resumable: true });
    expect(operations).toEqual(["list", "finalize"]);
  });

  it("reclaims a released provider tab on the next fresh host without handing it off again", async () => {
    const operations: string[] = [];
    const stableId = "target-provider";
    const url = "https://chatgpt.com/c/abc-123";
    const controlled = { id: stableId, url, title: "Review" };
    const released = {
      id: "fresh-opaque-handle",
      providerTabId: stableId,
      url,
      title: "Review"
    };
    const args = {
      existingTab: { target: { type: "tabId" as const, tabId: stableId }, ifMissing: "block" as const },
      timeoutMs: 100
    };

    const first = await bootstrap({
      browser: {
        name: "chrome",
        user: {
          openTabs: async () => {
            operations.push("first:openTabs");
            return [released];
          },
          claimTab: async () => {
            operations.push("first:claimTab");
            throw new Error("Tab is already part of browser session stale-host");
          }
        },
        tabs: {
          list: async () => {
            operations.push("first:list");
            return [controlled];
          },
          finalize: async () => {
            operations.push("first:finalize");
          }
        }
      } as unknown as BrowserLike
    }, args);

    expect(first.blocker).toMatchObject({ code: "existing_tab_handoff_completed", resumable: true });

    const claimed: unknown[] = [];
    const second = await bootstrap({
      browser: {
        name: "chrome",
        user: {
          openTabs: async () => {
            operations.push("second:openTabs");
            return [released];
          },
          claimTab: async (tab: unknown) => {
            operations.push("second:claimTab");
            claimed.push(tab);
            return fakeChatGPTPage("fresh-control-handle", url, "Review");
          }
        },
        tabs: {
          list: async () => {
            throw new Error("A successful fresh user-tab claim must precede controlled-tab listing.");
          },
          finalize: async () => {
            throw new Error("The released tab must not be handed off a second time.");
          },
          create: async () => {
            operations.push("second:create");
            return fakeChatGPTPage("duplicate", "https://chatgpt.com/", "ChatGPT");
          }
        }
      } as unknown as BrowserLike
    }, args);

    expect(second.ok).toBe(true);
    expect(second.context.tabId).toBe(stableId);
    expect(claimed).toEqual([released]);
    expect(operations).toEqual([
      "first:openTabs",
      "first:claimTab",
      "first:list",
      "first:finalize",
      "second:openTabs",
      "second:claimTab"
    ]);
  });

  it("stops exact preclaim when open-tab enumeration fails", async () => {
    const operations: string[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => {
          operations.push("openTabs");
          throw new Error("open tabs unavailable");
        },
        claimTab: async () => {
          operations.push("claimTab");
          return fakeChatGPTPage("unused", "https://chatgpt.com/", "ChatGPT");
        }
      },
      tabs: {
        list: async () => {
          operations.push("list");
          return [];
        },
        finalize: async () => {
          operations.push("finalize");
        },
        create: async () => {
          operations.push("create");
          return fakeChatGPTPage("duplicate", "https://chatgpt.com/", "ChatGPT");
        }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: { target: { type: "tabId", tabId: "target-provider" }, ifMissing: "open" },
      timeoutMs: 100
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      blocker: {
        code: "existing_tab_unresponsive",
        resumable: true,
        diagnostics: {
          existingTab: { mismatchReason: "user_open_tabs_unavailable" }
        }
      }
    });
    expect(operations).toEqual(["openTabs"]);
  });

  it.each([
    { type: "conversationId" as const, conversationId: "abc-123" },
    { type: "url" as const, url: "https://chatgpt.com/c/abc-123" }
  ])("hands off exact $type metadata without opening a duplicate", async target => {
    const operations: string[] = [];
    const browser = {
      name: "chrome",
      tabs: {
        list: async () => [{ id: "provider", url: "https://chatgpt.com/c/abc-123" }],
        finalize: async () => { operations.push("finalize"); },
        create: async () => {
          operations.push("create");
          return fakeChatGPTPage("new", "https://chatgpt.com/", "ChatGPT");
        }
      }
    } as unknown as BrowserLike;

    const result = await bootstrap({ browser }, { existingTab: { target, ifMissing: "open" } });

    expect(result.blocker).toMatchObject({ code: "existing_tab_handoff_completed", resumable: true });
    expect(operations).toEqual(["finalize"]);
  });

  it("matches a released tab by provider ID and preserves that stable ID after claim", async () => {
    const claimed: unknown[] = [];
    const openTab = {
      id: "fresh-opaque-handle",
      providerTabId: "target-provider",
      url: "https://chatgpt.com/c/abc-123",
      title: "Review"
    };
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [openTab],
        claimTab: async tab => {
          claimed.push(tab);
          return fakeChatGPTPage("opaque-control-id", openTab.url, openTab.title);
        }
      },
      tabs: { list: async () => [] }
    };

    const result = await bootstrap({ browser }, {
      existingTab: { target: { type: "tabId", tabId: "target-provider" }, ifMissing: "block" }
    });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("target-provider");
    expect(claimed).toEqual([openTab]);
  });

  it("does not treat an opaque handle or wrong-origin metadata as the requested stable tab", async () => {
    const claimed: unknown[] = [];
    const created: string[] = [];
    const browser = {
      name: "chrome",
      user: {
        openTabs: async () => [{
          id: "target-provider",
          providerTabId: "different-provider",
          url: "https://chatgpt.com/c/wrong"
        }],
        claimTab: async (tab: unknown) => { claimed.push(tab); return fakeChatGPTPage("wrong", "https://chatgpt.com/c/wrong", "Wrong"); }
      },
      tabs: {
        list: async () => [{ id: "target-provider", url: "https://example.com/" }],
        finalize: async () => { throw new Error("wrong-origin metadata must not be handed off"); },
        create: async (url: string) => { created.push(url); return fakeChatGPTPage("fresh", url, "ChatGPT"); }
      }
    } as unknown as BrowserLike;

    const result = await bootstrap({ browser }, {
      existingTab: { target: { type: "tabId", tabId: "target-provider" }, ifMissing: "open" }
    });

    expect(result.ok).toBe(true);
    expect(claimed).toEqual([]);
    expect(created).toEqual(["https://chatgpt.com/"]);
  });

  it("never hydrates generic list metadata through get", async () => {
    const operations: string[] = [];
    const browser = {
      name: "chrome",
      user: {
        openTabs: async () => [{ id: "fresh", url: "https://chatgpt.com/c/fresh" }],
        claimTab: async () => { operations.push("claim"); return fakeChatGPTPage("fresh", "https://chatgpt.com/c/fresh", "Fresh"); }
      },
      tabs: {
        list: async () => [{ id: "stale", url: "https://chatgpt.com/c/stale" }],
        get: async () => { operations.push("get"); return new Promise<PageLike>(() => {}); }
      }
    } as unknown as BrowserLike;

    const result = await bootstrap({ browser }, { preferExistingTab: true });

    expect(result.ok).toBe(true);
    expect(operations).toEqual(["claim"]);
  });

  it("does not apply the exact-resume timeout to ordinary bootstrap", async () => {
    const page = fakeChatGPTPage("ordinary", "https://chatgpt.com/c/ordinary", "Ordinary");
    const browser: BrowserLike = {
      name: "chrome",
      tabs: {
        list: async () => {
          await new Promise(resolve => setTimeout(resolve, 20));
          return [page];
        }
      }
    };

    const result = await bootstrap({ browser }, { preferExistingTab: true, timeoutMs: 1 });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("ordinary");
  });

  it("does not start later state probes after an exact tab URL times out", async () => {
    const calls: string[] = [];
    const claimed = {
      id: "claimed",
      url: async () => {
        calls.push("url");
        await new Promise(resolve => setTimeout(resolve, 40));
        return "https://chatgpt.com/c/exact";
      },
      title: async () => { calls.push("title"); return "Exact"; },
      evaluate: async () => { calls.push("evaluate"); return ""; },
      content: async () => { calls.push("content"); return ""; }
    } as unknown as PageLike;
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [{ id: "exact", url: "https://chatgpt.com/c/exact" }],
        claimTab: async () => claimed
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: { target: { type: "conversationId", conversationId: "exact" }, ifMissing: "block" },
      timeoutMs: 10
    });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(result.blocker).toMatchObject({ code: "existing_tab_unresponsive", resumable: true });
    expect(calls).toEqual(["url"]);
  });

  it("does not fall through to content after an exact state evaluator stalls", async () => {
    const calls: string[] = [];
    const claimed: PageLike = {
      id: "exact",
      url: () => "https://chatgpt.com/c/exact",
      title: async () => { calls.push("title"); return "Exact"; },
      evaluate: async () => { calls.push("evaluate"); return new Promise(() => {}); },
      content: async () => { calls.push("content"); return ""; }
    };
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => [{ id: "exact", url: "https://chatgpt.com/c/exact" }],
        claimTab: async () => claimed
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: { target: { type: "conversationId", conversationId: "exact" }, ifMissing: "block" },
      timeoutMs: 2_000
    });

    expect(result.blocker).toMatchObject({ code: "existing_tab_unresponsive", resumable: true });
    expect(calls).toEqual(["evaluate"]);
  });

  it("stops an exact resume when controlled-tab listing does not respond", async () => {
    const operations: string[] = [];
    const browser: BrowserLike = {
      name: "chrome",
      user: {
        openTabs: async () => { operations.push("openTabs"); return []; },
        claimTab: async () => fakeChatGPTPage("unused", "https://chatgpt.com/", "ChatGPT")
      },
      tabs: {
        list: async () => new Promise<PageLike[]>(() => {}),
        get: async () => { operations.push("get"); return fakeChatGPTPage("unused", "https://chatgpt.com/", "ChatGPT"); },
        create: async () => { operations.push("create"); return fakeChatGPTPage("unused", "https://chatgpt.com/", "ChatGPT"); }
      }
    };

    const result = await bootstrap({ browser }, {
      existingTab: { target: { type: "tabId", tabId: "target" }, ifMissing: "open" },
      timeoutMs: 20
    });

    expect(result.blocker).toMatchObject({ code: "existing_tab_unresponsive", resumable: true });
    expect(operations).toEqual(["openTabs"]);
  });
});

function fakeChatGPTPage(id: string, url: string, title: string): PageLike {
  return {
    id,
    url: () => url,
    title: async () => title,
    content: async () => "<main>New chat Search chats Chat with ChatGPT</main>",
    locator: () => ({ count: async () => 0 }),
    waitForEvent: async () => ({})
  } as PageLike;
}

function fakeNarrowChatGPTPage(id: string, url: string, title: string): PageLike {
  return {
    id,
    url: () => url,
    title: async () => title,
    content: async () => [
      "<main>",
      "<a>Skip to content</a>",
      "<div data-message-author-role=\"user\">say hi</div>",
      "<div data-message-author-role=\"assistant\">hi</div>",
      "<footer>ChatGPT is AI and can make mistakes. Check important info.</footer>",
      "</main>"
    ].join(""),
    locator: () => ({ count: async () => 0 }),
    waitForEvent: async () => ({})
  } as PageLike;
}
