import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readPageState } from "../../src/browser/page-state.js";
import type { PageLike } from "../../src/types.js";

describe("readPageState", () => {
  it("does not treat signed-in settings text as a login blocker", async () => {
    const state = await readPageState(textPage(
      "Chat history New chat Search chats Library Projects Security and login"
    ));

    expect(state.signedIn).toBe(true);
    expect(state.blocker).toBeUndefined();
  });

  it("still reports login blockers when signed-in markers are absent", async () => {
    const state = await readPageState(textPage("Welcome back Log in Sign up"));

    expect(state.signedIn).toBe(false);
    expect(state.blocker?.kind).toBe("login_required");
  });

  it("does not let the logged-out shell's generic navigation markers mask the login wall", async () => {
    const state = await readPageState(textPage(
      "New chat Search chats Chat with ChatGPT Log in Log in Sign up for free"
    ));

    expect(state.signedIn).toBe(false);
    expect(state.blocker?.kind).toBe("login_required");
  });

  it("does not treat a logged-out Create account button as an authenticated account menu", async () => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/",
      title: () => Promise.resolve("ChatGPT"),
      content: () => Promise.resolve("<main>Welcome back Log in Sign up</main><button aria-label=\"Create account\">Sign up</button>")
    });

    expect(state.signedIn).toBe(false);
    expect(state.blocker?.kind).toBe("login_required");
  });

  it("does not let generic shell markers suppress one visible login control", async () => {
    const html = await readFile(new URL("../fixtures/chat-logged-out-current.html", import.meta.url), "utf8");
    const state = await readPageState({
      url: () => "https://chatgpt.com/",
      title: () => Promise.resolve("ChatGPT"),
      content: () => Promise.resolve(html)
    });

    expect(state.signedIn).toBe(false);
    expect(state.blocker?.kind).toBe("login_required");
  });

  it("uses the structured evaluate snapshot to classify one visible login control", async () => {
    const state = await readPageState(snapshotPage({
      visibleText: "New chat Search chats Chat with ChatGPT Log in",
      blockerText: "",
      loginControl: true
    }));

    expect(state.signedIn).toBe(false);
    expect(state.blocker?.kind).toBe("login_required");
  });

  it("evaluates login controls without a global HTMLElement constructor", async () => {
    const loginControl = {
      closest: () => null,
      getAttribute: (name: string) => name === "aria-label" ? "Log in" : null,
      getClientRects: () => [{}],
      innerText: "Log in",
      textContent: "Log in"
    };
    const state = await readPageState({
      url: () => "https://chatgpt.com/",
      title: () => Promise.resolve("ChatGPT"),
      evaluate: async <T, A = unknown>(pageFunction: (arg: A) => T | Promise<T>, arg?: A) => {
        const run = Function(
          "document",
          "window",
          "HTMLElement",
          "arg",
          `"use strict"; return (${pageFunction.toString()})(arg);`
        ) as (...args: unknown[]) => T | Promise<T>;
        return await run({
          body: { innerText: "Welcome back Log in" },
          querySelectorAll: (selector: string) => selector.startsWith("button, a, ") ? [loginControl] : []
        }, {
          getComputedStyle: () => ({ display: "block", visibility: "visible" })
        }, undefined, arg);
      }
    });

    expect(state.signedIn).toBe(false);
    expect(state.blocker?.kind).toBe("login_required");
  });

  it("normalizes a missing additive login-control signal from older structured adapters", async () => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/",
      title: () => Promise.resolve("ChatGPT"),
      evaluate: async <T>() => ({
        visibleText: "New chat Search chats",
        blockerSurface: { text: "", hasConversationMessages: false },
        authenticationSurface: {
          accountControl: true,
          conversationLinkCount: 0,
          hasComposer: false,
          hasConversationMessages: false
        }
      }) as T
    });

    expect(state.signedIn).toBe(true);
    expect(state.blocker).toBeUndefined();
  });

  it("rejects a present non-boolean login-control signal", async () => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/",
      title: () => Promise.resolve("ChatGPT"),
      evaluate: async <T>() => ({
        visibleText: "New chat Search chats",
        blockerSurface: { text: "", hasConversationMessages: false },
        authenticationSurface: {
          accountControl: true,
          conversationLinkCount: 0,
          hasComposer: false,
          hasConversationMessages: false,
          loginControl: "false"
        }
      }) as T
    });

    expect(state.signedIn).toBe(false);
    expect(state.visibleText).toBe("");
  });

  it("merges legacy visible-text snapshots with HTML structure when it is available", async () => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/",
      title: () => Promise.resolve("ChatGPT"),
      evaluate: async <T>() => "New chat Search chats Chat with ChatGPT Log in" as T,
      content: () => Promise.resolve(
        "<main>New chat Search chats Chat with ChatGPT</main><button>Log in</button>"
      )
    });

    expect(state.signedIn).toBe(false);
    expect(state.blocker?.kind).toBe("login_required");
  });

  it("ignores login words and controls scoped inside conversation messages", async () => {
    const state = await readPageState(snapshotPage({
      visibleText: "New chat Search chats The user asked why the Log in button appears.",
      blockerText: "",
      hasConversationMessages: true,
      loginControl: false
    }));

    expect(state.signedIn).toBe(true);
    expect(state.blocker).toBeUndefined();
  });

  it("does not treat a hidden login control as explicit login UI", async () => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/",
      title: () => Promise.resolve("ChatGPT"),
      content: () => Promise.resolve(
        "<main>New chat Search chats Chat with ChatGPT</main><button hidden>Log in</button>"
      )
    });

    expect(state.signedIn).toBe(true);
    expect(state.blocker).toBeUndefined();
  });

  it("does not treat a login control under a hidden fallback ancestor as explicit login UI", async () => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/",
      title: () => Promise.resolve("ChatGPT"),
      content: () => Promise.resolve(
        "<main>New chat Search chats Chat with ChatGPT</main><div hidden><button>Log in</button></div>"
      )
    });

    expect(state.signedIn).toBe(true);
    expect(state.blocker).toBeUndefined();
  });

  it.each(["script", "style", "template", "noscript"])(
    "ignores login markup inside a fallback %s subtree",
    async inertTag => {
      const state = await readPageState({
        url: () => "https://chatgpt.com/",
        title: () => Promise.resolve("ChatGPT"),
        content: () => Promise.resolve([
          "<main>New chat Search chats Chat with ChatGPT</main>",
          `<${inertTag}><button>Log in</button></${inertTag}>`
        ].join(""))
      });

      expect(state.signedIn).toBe(true);
      expect(state.blocker).toBeUndefined();
      expect(state.visibleText).not.toContain("Log in");
    }
  );

  it.each(["script", "style", "template", "noscript"])(
    "does not let fallback %s markup impersonate authenticated structure",
    async inertTag => {
      const state = await readPageState({
        url: () => "https://chatgpt.com/",
        title: () => Promise.resolve("ChatGPT"),
        content: () => Promise.resolve([
          "<main>New chat Search chats Chat with ChatGPT</main>",
          `<${inertTag}>`,
          "<a href=\"/c/fake\">Fake history</a>",
          "<div id=\"prompt-textarea\" contenteditable=\"true\" aria-label=\"Ask ChatGPT\"></div>",
          "<button data-testid=\"accounts-profile-button\" aria-haspopup=\"menu\">Fake profile</button>",
          `</${inertTag}>`,
          "<button>Log in</button>"
        ].join(""))
      });

      expect(state.signedIn).toBe(false);
      expect(state.blocker?.kind).toBe("login_required");
      expect(state.visibleText).not.toContain("Fake profile");
    }
  );

  it("ignores login markup inside HTML comments in the fallback", async () => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/",
      title: () => Promise.resolve("ChatGPT"),
      content: () => Promise.resolve([
        "<!doctype html><main>New chat Search chats Chat with ChatGPT</main>",
        "<!-- <button>Log in</button> -->"
      ].join(""))
    });

    expect(state.signedIn).toBe(true);
    expect(state.blocker).toBeUndefined();
    expect(state.visibleText).not.toContain("Log in");
  });

  it("does not let commented markup impersonate authenticated structure", async () => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/",
      title: () => Promise.resolve("ChatGPT"),
      content: () => Promise.resolve([
        "<main>New chat Search chats Chat with ChatGPT</main>",
        "<!-- <a href=\"/c/fake\">Fake history</a>",
        "<div id=\"prompt-textarea\" contenteditable=\"true\" aria-label=\"Ask ChatGPT\"></div>",
        "<button data-testid=\"accounts-profile-button\" aria-haspopup=\"menu\">Fake profile</button> -->",
        "<button>Log in</button>"
      ].join(""))
    });

    expect(state.signedIn).toBe(false);
    expect(state.blocker?.kind).toBe("login_required");
    expect(state.visibleText).not.toContain("Fake profile");
  });

  it("does not let hidden authentication structure override a visible login control", async () => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/",
      title: () => Promise.resolve("ChatGPT"),
      content: () => Promise.resolve([
        "<main>New chat Search chats Chat with ChatGPT</main>",
        "<a href=\"/c/stale\" hidden>Stale conversation</a>",
        "<div id=\"prompt-textarea\" contenteditable=\"true\" aria-label=\"Ask ChatGPT\" hidden></div>",
        "<button data-testid=\"accounts-profile-button\" aria-haspopup=\"menu\" hidden>Profile</button>",
        "<button>Log in</button>"
      ].join(""))
    });

    expect(state.signedIn).toBe(false);
    expect(state.blocker?.kind).toBe("login_required");
  });

  it.each([
    ["hidden", "hidden"],
    ["aria-hidden", "aria-hidden=\"true\""],
    ["display none", "style=\"display: none\""],
    ["hidden visibility", "style=\"visibility: hidden\""]
  ])("ignores authentication descendants of a %s fallback ancestor", async (_label, parentAttributes) => {
    const state = await readPageState({
      url: () => "https://chatgpt.com/",
      title: () => Promise.resolve("ChatGPT"),
      content: () => Promise.resolve([
        "<main>New chat Search chats Chat with ChatGPT</main>",
        `<section ${parentAttributes}>`,
        "<a href=\"/c/stale\">Hidden conversation</a>",
        "<div id=\"prompt-textarea\" contenteditable=\"true\" aria-label=\"Ask ChatGPT\"></div>",
        "<button data-testid=\"accounts-profile-button\" aria-haspopup=\"menu\">Hidden profile</button>",
        "<article data-message-author-role=\"assistant\">Hidden conversation message</article>",
        "</section>",
        "<button>Log in</button>"
      ].join(""))
    });

    expect(state.signedIn).toBe(false);
    expect(state.blocker?.kind).toBe("login_required");
    expect(state.visibleText).not.toContain("Hidden profile");
    expect(state.visibleText).not.toContain("Hidden conversation message");
  });

  it.each([
    ["an account control", { accountControl: true }],
    ["conversation history and a composer", { conversationLinkCount: 1, hasComposer: true }]
  ])("lets strong authentication structure override visible login UI from %s", async (_label, surface) => {
    const state = await readPageState(snapshotPage({
      visibleText: "New chat Search chats Log in",
      blockerText: "Log in",
      loginControl: true,
      ...surface
    }));

    expect(state.signedIn).toBe(true);
    expect(state.blocker).toBeUndefined();
  });

  it("uses current authenticated DOM structure to reject a false login blocker", async () => {
    const html = await readFile(new URL("../fixtures/chat-authenticated-current.html", import.meta.url), "utf8");
    const state = await readPageState({
      url: () => "https://chatgpt.com/c/canonical-fixture",
      title: () => Promise.resolve("Codex Pro Fixture"),
      content: () => Promise.resolve(html)
    });

    expect(state.signedIn).toBe(true);
    expect(state.conversationId).toBe("canonical-fixture");
    expect(state.blocker).toBeUndefined();
  });
});

function textPage(text: string): PageLike {
  return {
    url: () => "https://chatgpt.com/",
    title: () => Promise.resolve("ChatGPT"),
    evaluate: async <T>() => text as T
  };
}

type SnapshotOverrides = {
  visibleText: string;
  blockerText: string;
  accountControl?: boolean;
  conversationLinkCount?: number;
  hasComposer?: boolean;
  hasConversationMessages?: boolean;
  loginControl?: boolean;
};

function snapshotPage(overrides: SnapshotOverrides): PageLike {
  const hasConversationMessages = overrides.hasConversationMessages ?? false;
  return {
    url: () => "https://chatgpt.com/",
    title: () => Promise.resolve("ChatGPT"),
    evaluate: async <T>() => ({
      visibleText: overrides.visibleText,
      blockerSurface: {
        text: overrides.blockerText,
        hasConversationMessages
      },
      authenticationSurface: {
        accountControl: overrides.accountControl ?? false,
        conversationLinkCount: overrides.conversationLinkCount ?? 0,
        hasComposer: overrides.hasComposer ?? false,
        hasConversationMessages,
        loginControl: overrides.loginControl ?? false
      }
    }) as T
  };
}
