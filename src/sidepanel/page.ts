import {
  MAX_PAGE_SELECTION_LENGTH,
  MAX_PAGE_TEXT_LENGTH,
  MAX_PAGE_TITLE_LENGTH,
  MAX_PAGE_URL_LENGTH,
  parsePageContext,
} from "../protocol/messages.ts";
import type { PageContext } from "../protocol/messages.ts";

export const PAGE_CAPTURE_TIMEOUT_MS = 5_000;

export type PageLimits = { url: number; title: number; text: number; selection: number };

export const PAGE_LIMITS: PageLimits = {
  url: MAX_PAGE_URL_LENGTH,
  title: MAX_PAGE_TITLE_LENGTH,
  text: MAX_PAGE_TEXT_LENGTH,
  selection: MAX_PAGE_SELECTION_LENGTH,
};

export type PageCaptureFailure = "page_unavailable" | "page_timeout";

export type PageCaptureResult = { ok: true; page: PageContext } | { ok: false; failure: PageCaptureFailure };

export type PageCaptureDeps = {
  activeTabId: () => Promise<number | undefined>;
  runInTab: (tabId: number, capture: typeof capturePage, limits: PageLimits) => Promise<unknown>;
  timeoutMs?: number;
};

// Chrome serializes this function into the page, so it must not reference anything outside its body.
export function capturePage(limits: PageLimits): PageContext {
  let truncated = false;
  const cap = (value: string, maxLength: number) => {
    if (value.length <= maxLength) return value;
    truncated = true;
    const cut = value.slice(0, maxLength);
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  };
  const tidy = (value: string) =>
    value
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const root = document.body ?? document.documentElement;
  const text = cap(tidy(root?.innerText ?? ""), limits.text);
  const selection = cap(tidy(globalThis.getSelection?.()?.toString() ?? ""), limits.selection);
  const page: PageContext = {
    url: cap(location.href, limits.url),
    title: cap(document.title.trim(), limits.title),
    text,
    truncated: false,
  };
  if (selection !== "") page.selection = selection;
  page.truncated = truncated;
  return page;
}

export async function readActivePage({
  activeTabId,
  runInTab,
  timeoutMs = PAGE_CAPTURE_TIMEOUT_MS,
}: PageCaptureDeps): Promise<PageCaptureResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const capture = (async () => {
    const tabId = await activeTabId();
    if (tabId === undefined) return undefined;
    return parsePageContext(await runInTab(tabId, capturePage, PAGE_LIMITS));
  })().catch(() => undefined);
  try {
    const outcome = await Promise.race([capture, timedOut]);
    if (outcome === "timeout") return { ok: false, failure: "page_timeout" };
    return outcome ? { ok: true, page: outcome } : { ok: false, failure: "page_unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export function chromePageCaptureDeps(): PageCaptureDeps {
  return {
    async activeTabId() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id;
    },
    async runInTab(tabId, capture, limits) {
      const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: capture, args: [limits] });
      return frame?.result;
    },
  };
}
