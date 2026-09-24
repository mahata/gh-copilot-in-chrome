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

  it("reports the page unreadable without an active tab", async () => {
    const runInTab = vi.fn();
    expect(await readActivePage({ activeTabId: async () => undefined, runInTab })).toEqual({
      ok: false,
      failure: "page_unreadable",
    });
    expect(runInTab).not.toHaveBeenCalled();
  });

  it.each([
    ["page_access_needed", "Cannot access contents of the page. Extension manifest must request permission to access the respective host."],
    ["page_access_needed", 'Cannot access contents of url "file:///tmp/a.html". Extension manifest must request permission to access this host.'],
    ["page_restricted", "Cannot access a chrome:// URL"],
    ["page_restricted", "Cannot access a chrome-extension:// URL of different extension"],
    ["page_restricted", "The extensions gallery cannot be scripted."],
    ["page_restricted", "The New Tab Page cannot be scripted."],
    ["page_restricted", "This page cannot be scripted due to an ExtensionsSettings policy."],
    ["page_error_page", "Frame with ID 0 is showing error page"],
  ])("reports %s when Chrome says %j", async (failure, message) => {
    const runInTab = async () => {
      throw new Error(message);
    };
    expect(await readActivePage({ activeTabId: async () => 7, runInTab })).toEqual({ ok: false, failure });
  });

  it("passes on Chrome's reason for a refusal it does not recognize", async () => {
    const runInTab = async () => {
      throw new Error(`No tab with id: 7.${"x".repeat(400)}`);
    };
    const result = await readActivePage({ activeTabId: async () => 7, runInTab });
    expect(result).toEqual({ ok: false, failure: "page_unreadable", detail: `No tab with id: 7.${"x".repeat(282)}` });
  });

  it("reports the page unreadable when looking up the active tab fails", async () => {
    const activeTabId = async () => {
      throw new Error("tabs.query failed");
    };
    expect(await readActivePage({ activeTabId, runInTab: vi.fn() })).toEqual({ ok: false, failure: "page_unreadable" });
  });

  it.each([
    ["no result", undefined],
    ["a result over the limits", { ...page, text: "x".repeat(PAGE_LIMITS.text + 1) }],
    ["a result with extra fields", { ...page, html: "<p>Body</p>" }],
  ])("reports the page unreadable for %s", async (_description, value) => {
    expect(await readActivePage({ activeTabId: async () => 7, runInTab: async () => value })).toEqual({
      ok: false,
      failure: "page_unreadable",
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
