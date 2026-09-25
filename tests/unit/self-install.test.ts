import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { companionInstallPaths } from "../../src/companion/install.ts";
import { COMPANION_EXECUTABLE_NAME } from "../../src/companion/layout.ts";
import { isSelfInstallerCommand, runSelfInstaller } from "../../src/companion/self-install.ts";
import type { SelfInstallerOptions } from "../../src/companion/self-install.ts";
import { EXTENSION_ORIGIN } from "../../src/protocol/identity.ts";

let root: string;
let home: string;
let buildDirectory: string;
let messages: { log: string[]; error: string[] };

function selfInstall(args: string[], overrides: Partial<SelfInstallerOptions> = {}) {
  return runSelfInstaller({
    args,
    executablePath: join(buildDirectory, COMPANION_EXECUTABLE_NAME),
    home,
    store: { hasSavedToken: async () => false, forgetToken: async () => false },
    output: { log: (line) => messages.log.push(line), error: (line) => messages.error.push(line) },
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "self-install-"));
  home = join(root, "home");
  buildDirectory = join(root, "package-scripts", "companion");
  mkdirSync(home);
  mkdirSync(buildDirectory, { recursive: true });
  writeFileSync(join(buildDirectory, COMPANION_EXECUTABLE_NAME), "#!/bin/sh\necho 'packaged build'\n");
  chmodSync(join(buildDirectory, COMPANION_EXECUTABLE_NAME), 0o755);
  writeFileSync(join(buildDirectory, "LICENSE.txt"), "license");
  messages = { log: [], error: [] };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isSelfInstallerCommand", () => {
  it("recognizes only the install and uninstall commands, never the origin Chrome passes", () => {
    expect(isSelfInstallerCommand(["--install", "/Users/octocat"])).toBe(true);
    expect(isSelfInstallerCommand(["--uninstall"])).toBe(true);
    expect(isSelfInstallerCommand([EXTENSION_ORIGIN])).toBe(false);
    expect(isSelfInstallerCommand([])).toBe(false);
  });
});

describe("runSelfInstaller", () => {
  it("installs the directory holding the executable into the given home folder", async () => {
    await expect(selfInstall(["--install", home])).resolves.toBe(0);
    const { companionDirectory, executablePath, hostManifestPath } = companionInstallPaths(home);

    expect(spawnSync(executablePath, { encoding: "utf8" }).stdout).toBe("packaged build\n");
    expect(readFileSync(join(companionDirectory, "LICENSE.txt"), "utf8")).toBe("license");
    expect(JSON.parse(readFileSync(hostManifestPath, "utf8"))).toMatchObject({ path: executablePath, allowed_origins: [EXTENSION_ORIGIN] });
    expect(messages.log).toContain("Installed the Prompt Harbor companion.");
    expect(messages.error).toEqual([]);
  });

  it.each([
    ["no home folder", ["--install"]],
    ["a relative home folder", ["--install", "home"]],
    ["a home folder that does not exist", ["--install", "/nonexistent/prompt-harbor-home"]],
    ["extra arguments", ["--install", "HOME", "--force"]],
  ])("refuses to install into %s", async (_description, args) => {
    await expect(selfInstall(args.map((arg) => (arg === "HOME" ? home : arg)))).resolves.toBe(1);
    expect(messages.error.join("\n")).toContain(`Usage: ${COMPANION_EXECUTABLE_NAME} --install <home folder>`);
    expect(readdirSync(home)).toEqual([]);
  });

  it("reports an install that fails instead of throwing", async () => {
    writeFileSync(join(home, "Library"), "not a folder");

    await expect(selfInstall(["--install", home])).resolves.toBe(1);
    expect(messages.error).toHaveLength(1);
    expect(messages.log).toEqual([]);
  });

  it("uninstalls from the user's home folder, keeping a saved PAT unless asked to delete it", async () => {
    await selfInstall(["--install", home]);
    const forgetToken = vi.fn(async () => true);
    const store = { hasSavedToken: async () => true, forgetToken };

    await expect(selfInstall(["--uninstall"], { store })).resolves.toBe(0);
    expect(existsSync(companionInstallPaths(home).applicationDirectory)).toBe(false);
    expect(forgetToken).not.toHaveBeenCalled();
    expect(messages.log.join("\n")).toContain("Kept the PAT saved in your macOS login keychain.");
  });

  it("deletes the saved PAT when asked to", async () => {
    const forgetToken = vi.fn(async () => true);

    await expect(selfInstall(["--uninstall", "--delete-saved-pat"], { store: { hasSavedToken: async () => true, forgetToken } })).resolves.toBe(0);
    expect(forgetToken).toHaveBeenCalledTimes(1);
  });

  it("names the uninstall script's options for an unknown one", async () => {
    await expect(selfInstall(["--uninstall", "--force"])).resolves.toBe(1);
    expect(messages.error).toEqual(["Usage: uninstall [--keep-saved-pat | --delete-saved-pat]"]);
  });
});
