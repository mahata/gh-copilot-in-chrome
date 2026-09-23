import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXTENSION_ID, EXTENSION_ORIGIN, HOST_NAME } from "../../src/protocol/identity.ts";

function chromeExtensionIdFromPublicKey(base64PublicKey: string) {
  const hexDigest = createHash("sha256").update(Buffer.from(base64PublicKey, "base64")).digest("hex");
  return [...hexDigest.slice(0, 32)].map((hexDigit) => String.fromCharCode(97 + Number.parseInt(hexDigit, 16))).join("");
}

describe("native messaging identity", () => {
  it("pins the extension ID that Chrome derives from the manifest key", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8")) as { key?: string };
    expect(manifest.key).toBeTypeOf("string");
    expect(chromeExtensionIdFromPublicKey(manifest.key ?? "")).toBe(EXTENSION_ID);
  });

  it("uses the only origin format allowed for native messaging callers", () => {
    expect(EXTENSION_ORIGIN).toBe(`chrome-extension://${EXTENSION_ID}/`);
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });

  it("names the host with characters Chrome accepts", () => {
    expect(HOST_NAME).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/);
  });
});
