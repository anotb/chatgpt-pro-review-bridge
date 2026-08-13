import type { BlockerKind, PageLike } from "../types.js";
import { classifyVisibleText } from "../safety/blockers.js";
import { compactVisibleText } from "../safety/redaction.js";
import { escapeRegExp, localeLabels } from "../dom/locale-labels.js";
import { withTimeout } from "../commands/timeouts.js";

export type PageState = {
  url: string;
  conversationId?: string;
  title?: string;
  visibleText: string;
  signedIn: boolean;
  blocker?: { kind: BlockerKind; message: string; visibleText?: string };
};

type AuthenticationSurface = {
  accountControl: boolean;
  conversationLinkCount: number;
  hasComposer: boolean;
  hasConversationMessages: boolean;
};

type PageDomSnapshot = {
  visibleText: string;
  blockerSurface: { text: string; hasConversationMessages: boolean };
  authenticationSurface: AuthenticationSurface;
};

export function parseConversationId(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, "https://chatgpt.com");
  } catch {
    return undefined;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] !== "c" || segments[1] === undefined || segments[1].length === 0) {
    return undefined;
  }
  return segments[1];
}

export async function readPageState(page: PageLike): Promise<PageState> {
  const rawUrl = typeof page.url === "function" ? await Promise.resolve(page.url()).catch(() => "") : "";
  const url = typeof rawUrl === "string" ? rawUrl : "";
  const rawTitle = typeof page.title === "function" ? await page.title().catch(() => undefined) : undefined;
  const title = typeof rawTitle === "string" ? rawTitle : undefined;
  const snapshot = await readPageSnapshot(page);
  const visibleText = snapshot.visibleText;
  const blockerSurface = snapshot.blockerSurface;
  const fullPageBlocker = classifyVisibleText(visibleText);
  const classifiedBlocker = blockerSurface.hasConversationMessages
    ? classifyVisibleText(blockerSurface.text)
    : (classifyVisibleText(blockerSurface.text) ?? fullPageBlocker);
  const structurallySignedIn = isStructurallySignedIn(snapshot.authenticationSurface);
  const loginWall = classifiedBlocker?.kind === "login_required"
    && isLikelyLoginWall(visibleText)
    && !structurallySignedIn;
  const signedIn = (isLikelySignedIn(visibleText) || structurallySignedIn) && !loginWall;
  const blocker = classifiedBlocker?.kind === "login_required" && signedIn
    ? undefined
    : classifiedBlocker;
  const conversationId = parseConversationId(url);

  const state: PageState = {
    url,
    visibleText: compactVisibleText(visibleText),
    signedIn
  };

  if (conversationId !== undefined) {
    state.conversationId = conversationId;
  }

  if (title !== undefined) {
    state.title = title;
  }

  if (blocker !== undefined) {
    state.blocker = blocker;
  }

  return state;
}

export async function readVisibleText(page: PageLike): Promise<string> {
  return (await readPageSnapshot(page)).visibleText;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelySignedIn(visibleText: string): boolean {
  const markers = localeLabels.signedInMarkers.map(escapeRegExp).join("|");
  return new RegExp("\\b(" + markers + ")\\b", "i").test(visibleText);
}

async function readPageSnapshot(page: PageLike): Promise<PageDomSnapshot> {
  if (typeof page.evaluate === "function") {
    try {
      const value = await withTimeout(page.evaluate(() => {
        const messageSelector = "[data-message-author-role], [data-testid^='conversation-turn']";
        const systemSelector = [
          "[role='alert']",
          "[role='status']",
          "[role='dialog']",
          "[aria-live='assertive']",
          "[data-testid*='toast' i]",
          "[data-testid*='banner' i]",
          "[class*='toast' i]",
          "[class*='banner' i]"
        ].join(", ");
        const accountControlSelector = [
          "button[data-testid*='profile' i]",
          "button[data-testid*='account' i]",
          "[role='button'][data-testid*='profile' i]",
          "[role='button'][data-testid*='account' i]",
          "button[aria-haspopup='menu'][aria-label*='profile' i]",
          "button[aria-haspopup='menu'][aria-label*='account' i]",
          "button[aria-haspopup='menu'] img"
        ].join(", ");
        const conversationLinkSelector = [
          "a[href^='/c/']",
          "a[href^='https://chatgpt.com/c/']",
          "a[href^='https://www.chatgpt.com/c/']"
        ].join(", ");
        const composerSelector = [
          "#prompt-textarea",
          "textarea[data-id='root']",
          "[contenteditable='true'][data-testid*='composer' i]",
          "[contenteditable='true'][aria-label*='ChatGPT' i]"
        ].join(", ");
        const hasConversationMessages = document.querySelector(messageSelector) !== null;
        const text = Array.from(document.querySelectorAll(systemSelector))
          .filter(element => element.closest(messageSelector) === null)
          .map(element => (element.textContent ?? "") + " " + (element.getAttribute("aria-label") ?? ""))
          .join(" ");
        return {
          visibleText: document.body?.innerText ?? "",
          blockerSurface: { text, hasConversationMessages },
          authenticationSurface: {
            accountControl: document.querySelector(accountControlSelector) !== null,
            conversationLinkCount: document.querySelectorAll(conversationLinkSelector).length,
            hasComposer: document.querySelector(composerSelector) !== null,
            hasConversationMessages
          }
        };
      }), 1000, "Timed out while reading the visible ChatGPT page state.");
      const normalized = normalizePageDomSnapshot(value);
      if (normalized !== undefined) {
        if (typeof value === "string") {
          normalized.blockerSurface = await readLegacyBlockerSurface(page);
        }
        return normalized;
      }
    } catch {
      // Fall back to content parsing below.
    }
  }

  if (typeof page.content === "function") {
    try {
      const html = await withTimeout(page.content(), 1000, "Timed out while reading page content.");
      return snapshotFromHtml(html);
    } catch {
      return emptyPageDomSnapshot();
    }
  }

  return emptyPageDomSnapshot();
}

function normalizePageDomSnapshot(value: unknown): PageDomSnapshot | undefined {
  if (typeof value === "string") {
    return {
      visibleText: value,
      blockerSurface: { text: value, hasConversationMessages: false },
      authenticationSurface: emptyAuthenticationSurface()
    };
  }
  if (typeof value !== "object" || value === null) return undefined;
  const snapshot = value as Partial<PageDomSnapshot>;
  const blockerSurface = snapshot.blockerSurface;
  const authenticationSurface = snapshot.authenticationSurface;
  if (typeof snapshot.visibleText !== "string"
    || typeof blockerSurface !== "object"
    || blockerSurface === null
    || typeof blockerSurface.text !== "string"
    || typeof blockerSurface.hasConversationMessages !== "boolean"
    || !isAuthenticationSurface(authenticationSurface)) {
    return undefined;
  }
  return snapshot as PageDomSnapshot;
}

async function readLegacyBlockerSurface(page: PageLike): Promise<PageDomSnapshot["blockerSurface"]> {
  if (typeof page.evaluate !== "function") return { text: "", hasConversationMessages: false };
  try {
    const value = await withTimeout(page.evaluate(() => {
      const messageSelector = "[data-message-author-role], [data-testid^=\'conversation-turn\']";
      const systemSelector = [
        "[role=\'alert\']",
        "[role=\'status\']",
        "[role=\'dialog\']",
        "[aria-live=\'assertive\']",
        "[data-testid*=\'toast\' i]",
        "[data-testid*=\'banner\' i]",
        "[class*=\'toast\' i]",
        "[class*=\'banner\' i]"
      ].join(", ");
      const text = Array.from(document.querySelectorAll(systemSelector))
        .filter(element => element.closest(messageSelector) === null)
        .map(element => `${element.textContent ?? ""} ${element.getAttribute("aria-label") ?? ""}`)
        .join(" ");
      return { text, hasConversationMessages: document.querySelector(messageSelector) !== null };
    }), 1000, "Timed out while reading legacy blocker surfaces.");
    if (typeof value === "object" && value !== null
      && typeof (value as { text?: unknown }).text === "string"
      && typeof (value as { hasConversationMessages?: unknown }).hasConversationMessages === "boolean") {
      return value as PageDomSnapshot["blockerSurface"];
    }
  } catch {
    // Preserve the conservative empty surface for legacy adapters that cannot evaluate it.
  }
  return { text: "", hasConversationMessages: false };
}

function snapshotFromHtml(html: string): PageDomSnapshot {
  const messageSelectorPattern = /data-message-author-role=|data-testid=["']conversation-turn/i;
  const hasConversationMessages = messageSelectorPattern.test(html);
  const withoutMessages = html.replace(
    /<([a-z0-9-]+)\b[^>]*(?:data-message-author-role|data-testid=["']conversation-turn)[^>]*>[\s\S]*?<\/\1>/gi,
    " "
  );
  const conversationLinkCount = Array.from(html.matchAll(
    /<a\b[^>]*href=["'](?:https:\/\/(?:www\.)?chatgpt\.com)?\/c\/[^"']+/gi
  )).length;
  const buttonLikeTags = html.match(/<(?:button\b[^>]*|[a-z0-9-]+\b(?=[^>]*\brole=["']button["'])[^>]*)>/gi) ?? [];
  const accountControl = buttonLikeTags.some(tag =>
    /data-testid=["'][^"']*(?:profile|account)[^"']*["']/i.test(tag)
      || (/aria-haspopup=["']menu["']/i.test(tag)
        && /aria-label=["'][^"']*(?:profile|account)[^"']*["']/i.test(tag))
  ) || /<button\b[^>]*aria-haspopup=["']menu["'][^>]*>[\s\S]{0,1000}?<img\b/i.test(html);
  const hasComposer = /\bid=["']prompt-textarea["']/i.test(html)
    || /\bdata-testid=["'][^"']*composer[^"']*["']/i.test(html)
    || /contenteditable=["']true["'][^>]*(?:aria-label=["'][^"']*ChatGPT|role=["']textbox)/i.test(html);

  return {
    visibleText: htmlToText(html),
    blockerSurface: { text: htmlToText(withoutMessages), hasConversationMessages },
    authenticationSurface: {
      accountControl,
      conversationLinkCount,
      hasComposer,
      hasConversationMessages
    }
  };
}

function emptyPageDomSnapshot(): PageDomSnapshot {
  return {
    visibleText: "",
    blockerSurface: { text: "", hasConversationMessages: false },
    authenticationSurface: emptyAuthenticationSurface()
  };
}

function emptyAuthenticationSurface(): AuthenticationSurface {
  return {
    accountControl: false,
    conversationLinkCount: 0,
    hasComposer: false,
    hasConversationMessages: false
  };
}

function isAuthenticationSurface(value: unknown): value is AuthenticationSurface {
  if (typeof value !== "object" || value === null) return false;
  const surface = value as Partial<AuthenticationSurface>;
  return typeof surface.accountControl === "boolean"
    && typeof surface.conversationLinkCount === "number"
    && Number.isInteger(surface.conversationLinkCount)
    && surface.conversationLinkCount >= 0
    && typeof surface.hasComposer === "boolean"
    && typeof surface.hasConversationMessages === "boolean";
}

function isStructurallySignedIn(surface: AuthenticationSurface): boolean {
  return surface.accountControl
    || (surface.conversationLinkCount > 0 && (surface.hasComposer || surface.hasConversationMessages));
}

function isLikelyLoginWall(visibleText: string): boolean {
  const labels = localeLabels.loginBlocker.map(escapeRegExp).join("|");
  const matches = visibleText.match(new RegExp("(?:" + labels + ")", "gi")) ?? [];
  return matches.length >= 2 || /\bsign\s?up\b|\bcreate (?:an )?account\b/i.test(visibleText);
}
