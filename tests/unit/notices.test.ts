import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeNode, describePackage, findPackageDirectories, formatNotices, nodeLicenseUrl } from "../../src/companion/notices.ts";

let root: string;
let scopedPackage: string;
let plainPackage: string;

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "notices-"));
  scopedPackage = join(root, "node_modules", ".pnpm", "@scope+pkg@1.0.0", "node_modules", "@scope", "pkg");
  plainPackage = join(root, "node_modules", "plain");
  writeFile(
    join(scopedPackage, "package.json"),
    JSON.stringify({ name: "@scope/pkg", version: "1.0.0", license: "MIT", repository: { type: "git", url: "git+https://github.com/scope/pkg.git" } }),
  );
  writeFile(join(scopedPackage, "dist", "esm", "package.json"), JSON.stringify({ type: "module" }));
  writeFile(join(scopedPackage, "dist", "esm", "index.js"), "");
  writeFile(join(scopedPackage, "dist", "cjs", "index.js"), "");
  writeFile(join(plainPackage, "package.json"), JSON.stringify({ name: "plain", version: "2.0.0", license: { type: "ISC" }, homepage: "https://plain.example" }));
  writeFile(join(plainPackage, "LICENSE.md"), "ISC license text\n\n");
  writeFile(join(plainPackage, "license-checker.js"), "");
  writeFile(join(plainPackage, "lib", "a.js"), "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findPackageDirectories", () => {
  it("maps each bundled module to the package it came from, once, skipping the companion's own and virtual modules", async () => {
    const moduleIds = [
      "\0rolldown/runtime.js",
      join(root, "src", "companion", "main.ts"),
      join(scopedPackage, "dist", "esm", "index.js"),
      join(scopedPackage, "dist", "cjs", "index.js"),
      join(plainPackage, "lib", "a.js"),
    ];
    await expect(findPackageDirectories(moduleIds)).resolves.toEqual([scopedPackage, plainPackage]);
  });
});

describe("describePackage", () => {
  it("reads the package's name, version, declared license, homepage and license file", async () => {
    await expect(describePackage(plainPackage, "Bundled.")).resolves.toEqual({
      name: "plain",
      version: "2.0.0",
      inclusion: "Bundled.",
      homepage: "https://plain.example",
      license: "ISC",
      licenseText: "ISC license text\n\n",
    });
  });

  it("falls back to the repository for the homepage and notes a missing license file", async () => {
    await expect(describePackage(scopedPackage, "Included.")).resolves.toEqual({
      name: "@scope/pkg",
      version: "1.0.0",
      inclusion: "Included.",
      homepage: "https://github.com/scope/pkg",
      license: "MIT",
      licenseText: undefined,
    });
  });

  it("refuses a directory that is not a package", async () => {
    await expect(describePackage(join(scopedPackage, "dist", "esm"), "Bundled.")).rejects.toThrow(/no name or version/);
  });
});

describe("describeNode", () => {
  it("includes the LICENSE kept beside bin/ in Node.js tarball layouts", async () => {
    const prefix = join(root, "node-v26.0.0-darwin-arm64");
    writeFile(join(prefix, "bin", "node"), "");
    writeFile(join(prefix, "LICENSE"), "Node.js is licensed for use as follows:\n");

    const node = await describeNode(join(prefix, "bin", "node"), "v26.0.0");
    expect(node).toMatchObject({ name: "Node.js", version: "v26.0.0", licenseText: "Node.js is licensed for use as follows:\n" });
    expect(node.missingLicenseNote).toBeUndefined();
    expect(formatNotices([node])).toContain("Node.js v26.0.0\nhttps://nodejs.org/\n");
  });

  it("links to the LICENSE published for its version when the installer package kept no copy", async () => {
    writeFile(join(root, "usr", "local", "bin", "node"), "");

    const node = await describeNode(join(root, "usr", "local", "bin", "node"), "v26.0.0");
    expect(node.licenseText).toBeUndefined();
    expect(node.licensePath).toBe(join(root, "usr", "local", "LICENSE"));
    expect(formatNotices([node])).toContain(`It is published at ${nodeLicenseUrl("v26.0.0")}.`);
    expect(nodeLicenseUrl("v26.0.0")).toBe("https://github.com/nodejs/node/blob/v26.0.0/LICENSE");
    expect(formatNotices([node])).not.toContain("package.json");
  });
});

describe("formatNotices", () => {
  it("lists each component with its license text, or its declared license when it ships none", async () => {
    const notices = formatNotices([await describePackage(plainPackage, "Bundled."), await describePackage(scopedPackage, "Included.")]);

    expect(notices).toMatch(/^Third-party software in the Prompt Harbor companion\n/);
    expect(notices).toContain("plain 2.0.0\nhttps://plain.example\nBundled.\nLicense: ISC\n\nISC license text\n");
    expect(notices).toContain(
      "@scope/pkg 1.0.0\nhttps://github.com/scope/pkg\nIncluded.\nLicense: MIT, as its package.json declares. The package includes no license text.\n",
    );
    expect(notices.indexOf("plain 2.0.0")).toBeLessThan(notices.indexOf("@scope/pkg 1.0.0"));
  });
});
