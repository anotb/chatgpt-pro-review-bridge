import type { BlockerKind } from "../types.js";
import { compactVisibleText } from "./redaction.js";

export type ClassifiedBlocker = {
  kind: BlockerKind;
  message: string;
  visibleText?: string;
};

type BlockerRule = {
  kind: BlockerKind;
  message: string;
  patterns: RegExp[];
};

const RULES: BlockerRule[] = [
  {
    kind: "login_required",
    message: "ChatGPT requires the user to sign in before continuing.",
    patterns: [/\blog\s?in\b/i, /\bsign\s?in\b/i, /\bwelcome back\b/i]
  },
  {
    kind: "captcha",
    message: "ChatGPT is showing a captcha or suspicious-activity challenge.",
    patterns: [/\bcaptcha\b/i, /verify (?:you are|that you are) human/i, /suspicious activity/i]
  },
  {
    kind: "model_unavailable",
    message: "The requested visible ChatGPT model is unavailable for this account or usage window.",
    patterns: [
      /\bout of messages (?:with|for) (?:the )?pro model\b/i,
      /\bpro(?: model)? is temporarily unavailable\b/i,
      /\bpro\b.{0,80}\buntil (?:your )?usage resets\b/i
    ]
  },
  {
    kind: "model_fallback",
    message: "ChatGPT is visibly warning that responses will fall back to another model.",
    patterns: [
      /\bresponses? will use (?:a )?(?:less powerful|smaller) model\b/i,
      /\b(?:responses?|chatgpt|we)\b.{0,60}\bfall(?:ing)? back\b.{0,60}\bmodel\b/i
    ]
  },
  {
    kind: "rate_limit",
    message: "ChatGPT is rate limited or out of usage for this account.",
    patterns: [/usage limit/i, /rate limit/i, /try again later/i, /too many requests/i]
  },
  {
    kind: "permission",
    message: "File upload permission is required. Ask the user to enable both: Codex Settings > Computer Use > Chrome > Permissions > Uploads, and Chrome chrome://extensions > Codex extension > Details > Allow access to file URLs.",
    patterns: [/allow access to file urls/i, /file upload permission/i, /fileChooser\.setFiles/i]
  },
  {
    kind: "permission",
    message: "A browser or ChatGPT permission is required before continuing.",
    patterns: [/permission denied/i, /browser blocked/i]
  },
  {
    kind: "upload_failed",
    message: "ChatGPT reported a file upload failure.",
    patterns: [/upload failed/i, /could(?: not|n't) upload/i, /unsupported file/i, /file is too large/i]
  },
  {
    kind: "download_unavailable",
    message: "No downloadable file or download control is visible.",
    patterns: [/download unavailable/i, /no download/i]
  },
  {
    kind: "not_found",
    message: "The requested ChatGPT conversation or page was not found.",
    patterns: [/conversation not found/i, /404/i, /page not found/i]
  }
];

export function classifyVisibleText(text: string): ClassifiedBlocker | undefined {
  const visibleText = compactVisibleText(text);
  const lowerable = visibleText.length > 0 ? visibleText : text;

  for (const rule of RULES) {
    if (rule.patterns.some(pattern => pattern.test(lowerable))) {
      return { kind: rule.kind, message: rule.message, visibleText };
    }
  }

  if (/\b(confirm|continue|cancel|dismiss)\b/i.test(lowerable) && /\bdialog\b|\bmodal\b/i.test(lowerable)) {
    return {
      kind: "modal",
      message: "ChatGPT is showing a modal dialog that may require user action.",
      visibleText
    };
  }

  return undefined;
}
