import { describe, expect, it, vi } from "vitest";
import { capturePage, PAGE_LIMITS, readActivePage } from "../../src/sidepanel/page.ts";

const page = { url: "https://example.com/", title: "Example", text: "Body", truncated: false };

describe("readActivePage", () => {
  it("captures the active tab with the page limits", async () => {
    const runInTab = vi.fn(async () => page);
    const result = await readActivePage({ activeTabId: async () => 7, runInTab });
    expect(result).toEqual({ ok: true, page });
    expect(runInTab).toHaveBeenCalledWith(7, capturePage, PAGE_LIMITS);
  });

  it("reports the page unavailable without an active tab", async () => {
    const runInTab = vi.fn();
    expect(await readActivePage({ activeTabId: async () => undefined, runInTab })).toEqual({
      ok: false,
      failure: "page_unavailable",
    });
    expect(runInTab).not.toHaveBeenCalled();
  });

  it("reports the page unavailable when Chrome refuses to run the script", async () => {
    const runInTab = vi.fn(async () => {
      throw new Error("Cannot access contents of the page.");
    });
    expect(await readActivePage({ activeTabId: async () => 7, runInTab })).toEqual({ ok: false, failure: "page_unavailable" });
  });

  it.each([
    ["no result", undefined],
    ["a result over the limits", { ...page, text: "x".repeat(PAGE_LIMITS.text + 1) }],
    ["a result with extra fields", { ...page, html: "<p>Body</p>" }],
  ])("reports the page unavailable for %s", async (_description, value) => {
    expect(await readActivePage({ activeTabId: async () => 7, runInTab: async () => value })).toEqual({
      ok: false,
      failure: "page_unavailable",
    });
  });

  it("gives up on a page that does not answer in time", async () => {
    vi.useFakeTimers();
    try {
      const result = readActivePage({ activeTabId: async () => 7, runInTab: () => new Promise(() => {}), timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toEqual({ ok: false, failure: "page_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
