import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { companionInstallPaths, runInstaller } from "../../src/companion/install.ts";
import { bundledRuntimePath, COMPANION_EXECUTABLE_NAME } from "../../src/companion/layout.ts";
import { EXTENSION_ORIGIN, HOST_NAME } from "../../src/protocol/identity.ts";

let root: string;
let home: string;
let buildDirectory: string;
let messages: { log: string[]; error: string[] };
let forgetToken: Mock<() => Promise<boolean>>;

function writeBuild(label: string) {
  const runtimePath = bundledRuntimePath(buildDirectory, "arm64");
  mkdirSync(dirname(runtimePath), { recursive: true });
  const executablePath = join(buildDirectory, COMPANION_EXECUTABLE_NAME);
  writeFileSync(executablePath, `#!/bin/sh\necho '${label}'\n`);
  writeFileSync(runtimePath, "runtime wrapper");
  writeFileSync(join(dirname(runtimePath), "runtime.node"), "runtime library");
  chmodSync(executablePath, 0o755);
  chmodSync(runtimePath, 0o755);
}

function install(overrides: Partial<Parameters<typeof runInstaller>[0]> = {}) {
  return runInstaller({
    args: [],
    platform: "darwin",
    home,
    buildDirectory,
    store: { forgetToken },
    output: { log: (line) => messages.log.push(line), error: (line) => messages.error.push(line) },
    ...overrides,
  });
}

function uninstall() {
  return install({ args: ["--uninstall"] });
}

function runInstalledCompanion() {
  return spawnSync(companionInstallPaths(home).executablePath, { encoding: "utf8" }).stdout;
}

function makeBuildUncopyable() {
  const unreadableFile = join(buildDirectory, "unreadable");
  writeFileSync(unreadableFile, "");
  chmodSync(unreadableFile, 0o000);
  return () => rmSync(unreadableFile);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "installer-"));
  home = join(root, "home");
  buildDirectory = join(root, "build");
  mkdirSync(home);
  writeBuild("first build");
  messages = { log: [], error: [] };
  forgetToken = vi.fn(async () => false);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("companionInstallPaths", () => {
  it("places the companion in Application Support and the host manifest where Chrome looks for it", () => {
    expect(companionInstallPaths("/Users/octocat")).toEqual({
      applicationDirectory: "/Users/octocat/Library/Application Support/prompt-harbor",
      companionDirectory: "/Users/octocat/Library/Application Support/prompt-harbor/companion",
      executablePath: "/Users/octocat/Library/Application Support/prompt-harbor/companion/prompt-harbor-companion",
      hostManifestPath: `/Users/octocat/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json`,
    });
  });
});

describe("runInstaller", () => {
  it("copies the whole build, keeping its executables executable", async () => {
    await expect(install()).resolves.toBe(0);
    const { companionDirectory, executablePath } = companionInstallPaths(home);
    const runtimePath = bundledRuntimePath(companionDirectory, "arm64");

    expect(runInstalledCompanion()).toBe("first build\n");
    expect(statSync(executablePath).mode & 0o777).toBe(0o755);
    expect(statSync(runtimePath).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(dirname(runtimePath), "runtime.node"), "utf8")).toBe("runtime library");
  });

  it("registers the installed copy with Chrome for the pinned extension only", async () => {
    await install();
    const { executablePath, hostManifestPath } = companionInstallPaths(home);

    expect(JSON.parse(readFileSync(hostManifestPath, "utf8"))).toEqual({
      name: HOST_NAME,
      description: "Local GitHub Copilot SDK companion for Prompt Harbor",
      path: executablePath,
      type: "stdio",
      allowed_origins: [EXTENSION_ORIGIN],
    });
    expect(statSync(hostManifestPath).mode & 0o777).toBe(0o644);
    expect(messages.log.join("\n")).toContain(executablePath);
    expect(messages.log.join("\n")).toContain(hostManifestPath);
    expect(messages.error).toEqual([]);
    expect(forgetToken).not.toHaveBeenCalled();
  });

  it("installs a copy that keeps working once the build is gone", async () => {
    await install();
    rmSync(buildDirectory, { recursive: true });

    expect(runInstalledCompanion()).toBe("first build\n");
  });

  it("replaces an earlier install completely and leaves no staging copies behind", async () => {
    await install();
    const { applicationDirectory, companionDirectory } = companionInstallPaths(home);
    writeFileSync(join(companionDirectory, "left-by-earlier-build"), "");
    writeBuild("second build");

    await expect(install()).resolves.toBe(0);
    expect(runInstalledCompanion()).toBe("second build\n");
    expect(existsSync(join(companionDirectory, "left-by-earlier-build"))).toBe(false);
    expect(readdirSync(applicationDirectory)).toEqual(["companion"]);
  });

  it("replaces the launcher that earlier versions installed in its place", async () => {
    const { applicationDirectory, companionDirectory } = companionInstallPaths(home);
    mkdirSync(applicationDirectory, { recursive: true });
    writeFileSync(companionDirectory, `#!/bin/sh\nexec node checkout/src/companion/main.ts "$@"\n`);

    await expect(install()).resolves.toBe(0);
    expect(statSync(companionDirectory).isDirectory()).toBe(true);
    expect(runInstalledCompanion()).toBe("first build\n");
  });

  it("keeps the earlier install when copying a new build fails", async () => {
    await install();
    const { applicationDirectory } = companionInstallPaths(home);
    writeBuild("second build");
    makeBuildUncopyable();

    await expect(install()).rejects.toThrow();
    expect(runInstalledCompanion()).toBe("first build\n");
    expect(readdirSync(applicationDirectory)).toEqual(["companion"]);
  });

  it("puts back the companion that an interrupted install moved aside, even when the next copy fails", async () => {
    await install();
    const { applicationDirectory, companionDirectory } = companionInstallPaths(home);
    renameSync(companionDirectory, join(applicationDirectory, ".previous-interrupted"));
    mkdirSync(join(applicationDirectory, ".staging-interrupted"));
    writeBuild("second build");
    makeBuildUncopyable();

    await expect(install()).rejects.toThrow();
    expect(runInstalledCompanion()).toBe("first build\n");
    expect(readdirSync(applicationDirectory)).toEqual(["companion"]);
  });

  it("finishes the update that an interrupted install started", async () => {
    await install();
    const { applicationDirectory, companionDirectory } = companionInstallPaths(home);
    renameSync(companionDirectory, join(applicationDirectory, ".previous-interrupted"));
    writeBuild("second build");

    await expect(install()).resolves.toBe(0);
    expect(runInstalledCompanion()).toBe("second build\n");
    expect(readdirSync(applicationDirectory)).toEqual(["companion"]);
  });

  it("keeps companions moved aside while none is in place until a new copy is in place", async () => {
    const { applicationDirectory } = companionInstallPaths(home);
    mkdirSync(join(applicationDirectory, ".previous-one"), { recursive: true });
    mkdirSync(join(applicationDirectory, ".previous-two"));
    mkdirSync(join(applicationDirectory, ".staging-interrupted"));
    const repairBuild = makeBuildUncopyable();

    await expect(install()).rejects.toThrow();
    expect(readdirSync(applicationDirectory).sort()).toEqual([".previous-one", ".previous-two"]);

    repairBuild();
    await expect(install()).resolves.toBe(0);
    expect(runInstalledCompanion()).toBe("first build\n");
    expect(readdirSync(applicationDirectory)).toEqual(["companion"]);
  });

  it("clears copies that interrupted installs left beside an installed companion, even when the new copy fails", async () => {
    await install();
    const { applicationDirectory } = companionInstallPaths(home);
    mkdirSync(join(applicationDirectory, ".staging-interrupted"));
    mkdirSync(join(applicationDirectory, ".previous-interrupted"));
    makeBuildUncopyable();

    await expect(install()).rejects.toThrow();
    expect(runInstalledCompanion()).toBe("first build\n");
    expect(readdirSync(applicationDirectory)).toEqual(["companion"]);
  });

  it("refuses to install without a built companion, without touching the home directory", async () => {
    await expect(install({ buildDirectory: join(root, "never-built") })).resolves.toBe(1);
    expect(messages.error.join("\n")).toContain(join(root, "never-built"));
    expect(messages.error.join("\n")).toContain("pnpm companion:install");
    expect(readdirSync(home)).toEqual([]);
  });

  it("uninstalls the companion, its host manifest and the empty application directory, leaving other hosts alone", async () => {
    await install();
    const { applicationDirectory, hostManifestPath } = companionInstallPaths(home);
    const otherHostManifest = join(dirname(hostManifestPath), "com.example.other_host.json");
    writeFileSync(otherHostManifest, "{}");

    await expect(uninstall()).resolves.toBe(0);
    expect(existsSync(applicationDirectory)).toBe(false);
    expect(existsSync(hostManifestPath)).toBe(false);
    expect(existsSync(otherHostManifest)).toBe(true);
  });

  it("keeps an application directory that holds other files", async () => {
    await install();
    const { applicationDirectory } = companionInstallPaths(home);
    writeFileSync(join(applicationDirectory, "notes.txt"), "mine");

    await expect(uninstall()).resolves.toBe(0);
    expect(readdirSync(applicationDirectory)).toEqual(["notes.txt"]);
  });

  it("uninstalls the launcher that earlier versions installed", async () => {
    const { applicationDirectory, companionDirectory } = companionInstallPaths(home);
    mkdirSync(applicationDirectory, { recursive: true });
    writeFileSync(companionDirectory, "#!/bin/sh\n");

    await expect(uninstall()).resolves.toBe(0);
    expect(existsSync(applicationDirectory)).toBe(false);
  });

  it("uninstalls cleanly when nothing is installed", async () => {
    await expect(uninstall()).resolves.toBe(0);
    expect(messages.error).toEqual([]);
  });

  it("removes the saved PAT from the Keychain when uninstalling", async () => {
    forgetToken.mockResolvedValue(true);
    await install();

    await expect(uninstall()).resolves.toBe(0);
    expect(forgetToken).toHaveBeenCalledTimes(1);
    expect(messages.log).toContain("Removed the saved PAT from your macOS login keychain.");
    expect(messages.error).toEqual([]);
  });

  it("says so when the Keychain holds no saved PAT", async () => {
    await expect(uninstall()).resolves.toBe(0);
    expect(forgetToken).toHaveBeenCalledTimes(1);
    expect(messages.log).toContain("No saved PAT was found in your macOS login keychain.");
  });

  it("still removes the companion but fails with Keychain Access steps when the saved PAT cannot be removed", async () => {
    forgetToken.mockRejectedValue(new Error("security failed"));
    await install();
    const { applicationDirectory, hostManifestPath } = companionInstallPaths(home);

    await expect(uninstall()).resolves.toBe(1);
    expect(existsSync(applicationDirectory)).toBe(false);
    expect(existsSync(hostManifestPath)).toBe(false);
    expect(messages.error.join("\n")).toContain("Keychain Access");
    expect(messages.error.join("\n")).toContain(HOST_NAME);
    expect(messages.error.join("\n")).not.toContain("security failed");
  });

  it.each([
    ["outside macOS", { platform: "linux" as const }, /macOS only/],
    ["with an unknown argument", { args: ["--force"] }, /Usage: pnpm companion:install/],
  ])("refuses to run %s without touching the home directory", async (_description, overrides, message) => {
    await expect(install(overrides)).resolves.toBe(1);
    expect(messages.error.join("\n")).toMatch(message);
    expect(readdirSync(home)).toEqual([]);
    expect(forgetToken).not.toHaveBeenCalled();
  });
});
