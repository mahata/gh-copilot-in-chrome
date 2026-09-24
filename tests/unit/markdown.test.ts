import { describe, expect, it } from "vitest";
import { decodeEntities, safeHref } from "../../src/sidepanel/markdown.ts";

describe("reply Markdown helpers", () => {
  it("allows only http, https and mailto links", () => {
    expect(safeHref("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(safeHref("http://example.com")).toBe("http://example.com/");
    expect(safeHref("mailto:octocat@example.com")).toBe("mailto:octocat@example.com");
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref(" JavaScript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(safeHref("chrome-extension://abc/sidepanel.html")).toBeUndefined();
    expect(safeHref("/relative")).toBeUndefined();
    expect(safeHref("#anchor")).toBeUndefined();
  });

  it("decodes character references and leaves everything else alone", () => {
    expect(decodeEntities("Tom &amp; Jerry &lt;3 &quot;hi&quot; &#39;x&#x27;")).toBe(`Tom & Jerry <3 "hi" 'x'`);
    expect(decodeEntities("a & b &unknown; &amp")).toBe("a & b &unknown; &amp");
    expect(decodeEntities("&#0; &#xD800; &#x110000;")).toBe("\ufffd \ufffd \ufffd");
  });
});
