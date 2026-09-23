import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companionInstallPaths, runInstaller } from "../../src/companion/install.ts";
import { EXTENSION_ORIGIN, HOST_NAME } from "../../src/protocol/identity.ts";

let home: string;
let messages: { log: string[]; error: string[] };

const nodePath = "/opt/node 24/bin/node";
const companionEntryPath = "/Users/octocat/Octo's checkout/src/companion/main.ts";

function install(overrides: Partial<Parameters<typeof runInstaller>[0]> = {}) {
  return runInstaller({
    args: [],
    platform: "darwin",
    home,
    nodePath,
    companionEntryPath,
    output: { log: (line) => messages.log.push(line), error: (line) => messages.error.push(line) },
    ...overrides,
  });
}

function uninstall() {
  return install({ args: ["--uninstall"] });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "installer-home-"));
  messages = { log: [], error: [] };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("companionInstallPaths", () => {
  it("places the launcher in Application Support and the host manifest where Chrome looks for it", () => {
    expect(companionInstallPaths("/Users/octocat")).toEqual({
      launcherDirectory: "/Users/octocat/Library/Application Support/gh-copilot-in-chrome",
      launcherPath: "/Users/octocat/Library/Application Support/gh-copilot-in-chrome/companion",
      hostManifestPath: `/Users/octocat/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json`,
    });
  });
});

describe("runInstaller", () => {
  it("writes an executable launcher that pins this Node binary and the companion entry point", async () => {
    await expect(install()).resolves.toBe(0);
    const { launcherPath } = companionInstallPaths(home);

    expect(readFileSync(launcherPath, "utf8")).toBe(
      `#!/bin/sh\nexec '/opt/node 24/bin/node' '/Users/octocat/Octo'\\''s checkout/src/companion/main.ts' "$@"\n`,
    );
    expect(statSync(launcherPath).mode & 0o777).toBe(0o755);
  });

  it("registers the launcher with Chrome for the pinned extension only", async () => {
    await install();
    const { launcherPath, hostManifestPath } = companionInstallPaths(home);

    expect(JSON.parse(readFileSync(hostManifestPath, "utf8"))).toEqual({
      name: HOST_NAME,
      description: "Local Copilot SDK companion for gh-copilot-in-chrome",
      path: launcherPath,
      type: "stdio",
      allowed_origins: [EXTENSION_ORIGIN],
    });
    expect(statSync(hostManifestPath).mode & 0o777).toBe(0o644);
    expect(messages.log.join("\n")).toContain(hostManifestPath);
    expect(messages.error).toEqual([]);
  });

  it("builds a launcher that forwards Chrome's arguments through quoted paths", async () => {
    const toolDirectory = join(home, "Node's tools");
    const fakeNodePath = join(toolDirectory, "node");
    mkdirSync(toolDirectory);
    writeFileSync(fakeNodePath, `#!/bin/sh\nfor argument in "$@"; do printf '%s\\n' "$argument"; done\n`);
    chmodSync(fakeNodePath, 0o755);
    await install({ nodePath: fakeNodePath });

    const launched = spawnSync(companionInstallPaths(home).launcherPath, [EXTENSION_ORIGIN], { encoding: "utf8" });
    expect(launched.status).toBe(0);
    expect(launched.stdout).toBe(`${companionEntryPath}\n${EXTENSION_ORIGIN}\n`);
  });

  it("replaces an earlier install when run again", async () => {
    await install({ nodePath: "/usr/local/bin/node" });
    await expect(install()).resolves.toBe(0);
    expect(readFileSync(companionInstallPaths(home).launcherPath, "utf8")).toContain(`'${nodePath}'`);
  });

  it("uninstalls both files and the empty launcher directory, leaving other hosts alone", async () => {
    await install();
    const { launcherDirectory, hostManifestPath } = companionInstallPaths(home);
    const otherHostManifest = join(hostManifestPath, "..", "com.example.other_host.json");
    writeFileSync(otherHostManifest, "{}");

    await expect(uninstall()).resolves.toBe(0);
    expect(existsSync(launcherDirectory)).toBe(false);
    expect(existsSync(hostManifestPath)).toBe(false);
    expect(existsSync(otherHostManifest)).toBe(true);
  });

  it("keeps a launcher directory that holds other files", async () => {
    await install();
    const { launcherDirectory } = companionInstallPaths(home);
    writeFileSync(join(launcherDirectory, "notes.txt"), "mine");

    await expect(uninstall()).resolves.toBe(0);
    expect(readdirSync(launcherDirectory)).toEqual(["notes.txt"]);
  });

  it("uninstalls cleanly when nothing is installed", async () => {
    await expect(uninstall()).resolves.toBe(0);
    expect(messages.error).toEqual([]);
  });

  it.each([
    ["outside macOS", { platform: "linux" as const }, /macOS only/],
    ["with an unknown argument", { args: ["--force"] }, /Usage: npm run companion:install/],
  ])("refuses to run %s without touching the home directory", async (_description, overrides, message) => {
    await expect(install(overrides)).resolves.toBe(1);
    expect(messages.error.join("\n")).toMatch(message);
    expect(readdirSync(home)).toEqual([]);
  });
});
