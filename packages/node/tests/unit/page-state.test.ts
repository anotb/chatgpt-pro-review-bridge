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
