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
  loginControl: boolean;
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
  const explicitLoginWall = snapshot.authenticationSurface.loginControl && !structurallySignedIn;
  const loginWall = !structurallySignedIn
    && (explicitLoginWall
      || (classifiedBlocker?.kind === "login_required" && isLikelyLoginWall(visibleText)));
  const signedIn = (isLikelySignedIn(visibleText) || structurallySignedIn) && !loginWall;
  const blocker = explicitLoginWall && classifiedBlocker === undefined
    ? loginRequiredBlocker(visibleText)
    : (classifiedBlocker?.kind === "login_required" && signedIn
      ? undefined
      : classifiedBlocker);
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
      const value = await withTimeout(page.evaluate((loginLabels: string[]) => {
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
        const isVisible = (element: Element): boolean => {
          if (element.closest("[hidden], [aria-hidden='true']") !== null) return false;
          const style = window.getComputedStyle(element);
          return style.display !== "none"
            && style.visibility !== "hidden"
            && style.visibility !== "collapse"
            && element.getClientRects().length > 0;
        };
        const normalizedLoginLabels = new Set(loginLabels.map(label => label.trim().toLocaleLowerCase()));
        const loginControl = Array.from(document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']"))
          .filter(element => element.closest(messageSelector) === null)
          .filter(isVisible)
          .some(element => {
            const names = [
              element.getAttribute("aria-label"),
              element.getAttribute("value"),
              (element as HTMLElement).innerText ?? element.textContent
            ];
            return names.some(name => typeof name === "string"
              && normalizedLoginLabels.has(name.replace(/\s+/g, " ").trim().toLocaleLowerCase()));
          });
        const hasConversationMessages = Array.from(document.querySelectorAll(messageSelector)).some(isVisible);
        const text = Array.from(document.querySelectorAll(systemSelector))
          .filter(element => element.closest(messageSelector) === null)
          .map(element => (element.textContent ?? "") + " " + (element.getAttribute("aria-label") ?? ""))
          .join(" ");
        return {
          visibleText: document.body?.innerText ?? "",
          blockerSurface: { text, hasConversationMessages },
          authenticationSurface: {
            accountControl: Array.from(document.querySelectorAll(accountControlSelector)).some(isVisible),
            conversationLinkCount: Array.from(document.querySelectorAll(conversationLinkSelector)).filter(isVisible).length,
            hasComposer: Array.from(document.querySelectorAll(composerSelector)).some(isVisible),
            hasConversationMessages,
            loginControl
          }
        };
      }, [...localeLabels.loginBlocker]), 1000, "Timed out while reading the visible ChatGPT page state.");
      const normalized = normalizePageDomSnapshot(value);
      if (normalized !== undefined) {
        if (typeof value === "string") {
          const htmlSnapshot = await readHtmlPageSnapshot(page);
          if (htmlSnapshot !== undefined) {
            return { ...htmlSnapshot, visibleText: value };
          }
          normalized.blockerSurface = await readLegacyBlockerSurface(page);
        }
        return normalized;
      }
    } catch {
      // Fall back to content parsing below.
    }
  }

  if (typeof page.content === "function") {
    return await readHtmlPageSnapshot(page) ?? emptyPageDomSnapshot();
  }

  return emptyPageDomSnapshot();
}

async function readHtmlPageSnapshot(page: PageLike): Promise<PageDomSnapshot | undefined> {
  if (typeof page.content !== "function") return undefined;
  try {
    const html = await withTimeout(page.content(), 1000, "Timed out while reading page content.");
    return snapshotFromHtml(html);
  } catch {
    return undefined;
  }
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
  const authenticationSurface = normalizeAuthenticationSurface(snapshot.authenticationSurface);
  if (typeof snapshot.visibleText !== "string"
    || typeof blockerSurface !== "object"
    || blockerSurface === null
    || typeof blockerSurface.text !== "string"
    || typeof blockerSurface.hasConversationMessages !== "boolean"
    || authenticationSurface === undefined) {
    return undefined;
  }
  return {
    visibleText: snapshot.visibleText,
    blockerSurface: {
      text: blockerSurface.text,
      hasConversationMessages: blockerSurface.hasConversationMessages
    },
    authenticationSurface
  };
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
  const visibleHtml = htmlWithoutHiddenSubtrees(html);
  const messageSelectorPattern = /data-message-author-role=|data-testid=["']conversation-turn/i;
  const openingTags = visibleHtml.match(/<[a-z0-9-]+\b[^>]*>/gi) ?? [];
  const visibleOpeningTags = openingTags.filter(tag => !htmlControlIsHidden(tag));
  const hasConversationMessages = visibleOpeningTags.some(tag => messageSelectorPattern.test(tag));
  const withoutMessages = visibleHtml.replace(
    /<([a-z0-9-]+)\b[^>]*(?:data-message-author-role|data-testid=["']conversation-turn)[^>]*>[\s\S]*?<\/\1>/gi,
    " "
  );
  const conversationLinkCount = visibleOpeningTags.filter(tag => {
    if (!/^<a\b/i.test(tag)) return false;
    const href = htmlAttribute(tag, "href");
    return typeof href === "string" && /^(?:https:\/\/(?:www\.)?chatgpt\.com)?\/c\//i.test(href);
  }).length;
  const buttonLikeTags = visibleHtml.match(/<(?:button\b[^>]*|[a-z0-9-]+\b(?=[^>]*\brole=["']button["'])[^>]*)>/gi) ?? [];
  const accountControl = buttonLikeTags.filter(tag => !htmlControlIsHidden(tag)).some(tag =>
    /data-testid=["'][^"']*(?:profile|account)[^"']*["']/i.test(tag)
      || (/aria-haspopup=["']menu["']/i.test(tag)
        && /aria-label=["'][^"']*(?:profile|account)[^"']*["']/i.test(tag))
  ) || Array.from(visibleHtml.matchAll(/<button\b([^>]*)>[\s\S]{0,1000}?<img\b[\s\S]*?<\/button>/gi))
    .some(match => !htmlControlIsHidden(match[1] ?? "") && /aria-haspopup=["']menu["']/i.test(match[1] ?? ""));
  const hasComposer = visibleOpeningTags.some(tag =>
    /\bid=["']prompt-textarea["']/i.test(tag)
      || /\bdata-testid=["'][^"']*composer[^"']*["']/i.test(tag)
      || (/contenteditable=["']true["']/i.test(tag)
        && /(?:aria-label=["'][^"']*ChatGPT|role=["']textbox)/i.test(tag))
  );

  return {
    visibleText: htmlToText(visibleHtml),
    blockerSurface: { text: htmlToText(withoutMessages), hasConversationMessages },
    authenticationSurface: {
      accountControl,
      conversationLinkCount,
      hasComposer,
      hasConversationMessages,
      loginControl: hasVisibleLoginControlInHtml(withoutMessages)
    }
  };
}

function htmlWithoutHiddenSubtrees(html: string): string {
  const voidElements = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"
  ]);
  const ancestors: Array<{ tagName: string; startsHiddenSubtree: boolean }> = [];
  const visibleParts: string[] = [];
  const tagPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi;
  let hiddenDepth = 0;
  let cursor = 0;

  for (const match of html.matchAll(tagPattern)) {
    const token = match[0];
    const tokenIndex = match.index;
    if (hiddenDepth === 0) visibleParts.push(html.slice(cursor, tokenIndex));

    const rawTagName = match[1];
    if (rawTagName === undefined) {
      cursor = tokenIndex + token.length;
      continue;
    }

    const tagName = rawTagName.toLocaleLowerCase();
    if (/^<\//.test(token)) {
      const hiddenDepthBeforeClose = hiddenDepth;
      let matchingAncestor = -1;
      for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        if (ancestors[index]?.tagName === tagName) {
          matchingAncestor = index;
          break;
        }
      }
      if (matchingAncestor >= 0) {
        for (let index = ancestors.length - 1; index >= matchingAncestor; index -= 1) {
          if (ancestors[index]?.startsHiddenSubtree) hiddenDepth -= 1;
        }
        ancestors.length = matchingAncestor;
      }
      if (hiddenDepthBeforeClose === 0 && hiddenDepth === 0) visibleParts.push(token);
    } else {
      const startsHiddenSubtree = isInertHtmlSubtree(tagName) || htmlControlIsHidden(token);
      if (hiddenDepth === 0 && !startsHiddenSubtree) visibleParts.push(token);
      const selfClosing = /\/\s*>$/.test(token) || voidElements.has(tagName);
      if (!selfClosing) {
        ancestors.push({ tagName, startsHiddenSubtree });
        if (startsHiddenSubtree) hiddenDepth += 1;
      }
    }

    cursor = tokenIndex + token.length;
  }

  if (hiddenDepth === 0) visibleParts.push(html.slice(cursor));
  return visibleParts.join("");
}

function isInertHtmlSubtree(tagName: string): boolean {
  return tagName === "script"
    || tagName === "style"
    || tagName === "template"
    || tagName === "noscript";
}

function hasVisibleLoginControlInHtml(html: string): boolean {
  const loginLabels = new Set(localeLabels.loginBlocker.map(normalizeControlName));
  const pairedControls = html.matchAll(
    /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>|<([a-z][a-z0-9-]*)\b([^>]*\brole=["']button["'][^>]*)>([\s\S]*?)<\/\4>/gi
  );
  for (const match of pairedControls) {
    const attributes = match[2] ?? match[5] ?? "";
    const contents = match[3] ?? match[6] ?? "";
    if (htmlControlIsHidden(attributes)) continue;
    if (htmlControlNames(attributes, contents).some(name => loginLabels.has(normalizeControlName(name)))) {
      return true;
    }
  }

  for (const match of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attributes = match[1] ?? "";
    if (htmlControlIsHidden(attributes)) continue;
    const type = htmlAttribute(attributes, "type")?.toLocaleLowerCase();
    if (type !== "button" && type !== "submit") continue;
    if (htmlControlNames(attributes, "").some(name => loginLabels.has(normalizeControlName(name)))) {
      return true;
    }
  }

  return false;
}

function htmlControlNames(attributes: string, contents: string): string[] {
  return [htmlAttribute(attributes, "aria-label"), htmlAttribute(attributes, "value"), htmlToText(contents)]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
}

function htmlControlIsHidden(attributes: string): boolean {
  const attributeNamesOnly = attributes.replace(/"[^"]*"|'[^']*'/g, "\"\"");
  return /(?:^|[\s<])hidden(?=[\s=/>]|$)/i.test(attributeNamesOnly)
    || /\baria-hidden\s*=\s*["']true["']/i.test(attributes)
    || /\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))/i.test(attributes);
}

function htmlAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp("\\b" + escapeRegExp(name) + "\\s*=\\s*([\\\"'])(.*?)\\1", "i"));
  return match?.[2];
}

function normalizeControlName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
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
    hasConversationMessages: false,
    loginControl: false
  };
}

function normalizeAuthenticationSurface(value: unknown): AuthenticationSurface | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const surface = value as Partial<AuthenticationSurface>;
  const hasLoginControl = Object.prototype.hasOwnProperty.call(surface, "loginControl");
  if (hasLoginControl && typeof surface.loginControl !== "boolean") return undefined;
  if (!(typeof surface.accountControl === "boolean"
    && typeof surface.conversationLinkCount === "number"
    && Number.isInteger(surface.conversationLinkCount)
    && surface.conversationLinkCount >= 0
    && typeof surface.hasComposer === "boolean"
    && typeof surface.hasConversationMessages === "boolean")) {
    return undefined;
  }
  return {
    accountControl: surface.accountControl,
    conversationLinkCount: surface.conversationLinkCount,
    hasComposer: surface.hasComposer,
    hasConversationMessages: surface.hasConversationMessages,
    loginControl: hasLoginControl ? surface.loginControl as boolean : false
  };
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

function loginRequiredBlocker(visibleText: string): NonNullable<PageState["blocker"]> {
  return {
    kind: "login_required",
    message: "ChatGPT requires the user to sign in before continuing.",
    visibleText: compactVisibleText(visibleText)
  };
}
