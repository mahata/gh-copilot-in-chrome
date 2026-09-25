import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { constants, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companionBuildDirectory } from "../../src/companion/build.ts";
import { createFrameDecoder } from "../../src/companion/framing.ts";
import { companionInstallPaths } from "../../src/companion/install.ts";
import { bundledRuntimePath, COMPANION_EXECUTABLE_NAME } from "../../src/companion/layout.ts";
import { REFUSAL_NOTICE } from "../../src/companion/run.ts";
import { SYSTEM_PATH } from "../../src/companion/system-path.ts";
import { EXTENSION_ORIGIN } from "../../src/protocol/identity.ts";
import { PROTOCOL_VERSION } from "../../src/protocol/messages.ts";

const GITHUB_TEAM_ID = "VEKTX9H2N7";
const MACH_O_ARCHITECTURES: Partial<Record<string, string>> = { arm64: "arm64", x64: "x86_64" };
const startupTimeout = { timeout: 10_000 };
const buildDirectory = companionBuildDirectory(process.arch);
const builtExecutablePath = join(buildDirectory, COMPANION_EXECUTABLE_NAME);
const installCliPath = fileURLToPath(new URL("../../src/companion/install-cli.ts", import.meta.url));
const installedSdkVersion: unknown = JSON.parse(
  readFileSync(new URL("../../node_modules/@github/copilot-sdk/package.json", import.meta.url), "utf8"),
).version;
const launchedCompanions: ChildProcess[] = [];
const temporaryDirectories: string[] = [];

beforeAll(() => {
  if (!existsSync(builtExecutablePath)) {
    throw new Error(`There is no companion build in ${buildDirectory}. Run pnpm test:companion, which builds one first.`);
  }
});

afterEach(() => {
  for (const child of launchedCompanions.splice(0)) child.kill("SIGKILL");
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function launchCompanion(executablePath: string, env: NodeJS.ProcessEnv) {
  const child = spawn(executablePath, [EXTENSION_ORIGIN], { stdio: ["pipe", "pipe", "inherit"], env });
  launchedCompanions.push(child);
  const frames: unknown[] = [];
  const decoder = createFrameDecoder((frame) => frames.push(frame));
  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
  const exitCode = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, frames, exitCode };
}

function codesign(args: string[]) {
  return spawnSync("/usr/bin/codesign", args, { encoding: "utf8" });
}

describe("built companion", () => {
  it("is a signed executable for this Mac's architecture", () => {
    const fileType = spawnSync("/usr/bin/file", ["-b", builtExecutablePath], { encoding: "utf8" }).stdout;
    expect(fileType).toBe(`Mach-O 64-bit executable ${MACH_O_ARCHITECTURES[process.arch]}\n`);
    expect(codesign(["--verify", "--strict", builtExecutablePath]).status).toBe(0);
  });

  it("carries the Copilot runtime for this architecture, still signed by GitHub, where the companion looks for it", () => {
    const runtimePath = bundledRuntimePath(buildDirectory, process.arch);
    expect(statSync(runtimePath).mode & 0o111).toBe(0o111);
    for (const path of [runtimePath, join(dirname(runtimePath), "runtime.node")]) {
      expect(codesign(["--verify", "--strict", path]).status).toBe(0);
      expect(codesign(["--display", "--verbose=2", path]).stderr).toContain(`TeamIdentifier=${GITHUB_TEAM_ID}`);
    }
  });

  it("refuses to start unless Chrome launches it for the extension", () => {
    const refused = spawnSync(builtExecutablePath, [], { encoding: "utf8", env: {} });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toBe(REFUSAL_NOTICE);
  });

  it("greets Chrome with the SDK version it was built with, without Node.js or even a PATH", async () => {
    const home = temporaryDirectory("companion-home-");
    const { child, frames, exitCode } = launchCompanion(builtExecutablePath, { HOME: home });
    await vi.waitFor(
      () => expect(frames).toEqual([{ type: "hello", protocolVersion: PROTOCOL_VERSION, sdkVersion: installedSdkVersion, savedToken: false }]),
      startupTimeout,
    );
    child.stdin.end();
    await expect(exitCode).resolves.toBe(0);
    expect(readdirSync(home)).toEqual([]);
  });

  it("ignores NODE_OPTIONS, which would otherwise let another program load code into it", () => {
    const directory = temporaryDirectory("companion-node-options-");
    const markerPath = join(directory, "preloaded");
    const preloadPath = join(directory, "preload.cjs");
    writeFileSync(preloadPath, `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "");\n`);
    const env = { NODE_OPTIONS: `--require=${preloadPath}` };

    spawnSync(process.execPath, ["--eval", ""], { env });
    expect(existsSync(markerPath)).toBe(true);
    rmSync(markerPath);

    expect(spawnSync(builtExecutablePath, [], { env }).status).toBe(1);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("carries a Copilot runtime that starts from wherever the companion is copied, here without a token", async () => {
    const copy = join(temporaryDirectory("companion-copy-"), "companion");
    cpSync(buildDirectory, copy, { recursive: true, mode: constants.COPYFILE_FICLONE });
    const runtimeHome = temporaryDirectory("copilot-runtime-home-");
    const client = new CopilotClient({
      mode: "empty",
      connection: RuntimeConnection.forStdio({
        path: bundledRuntimePath(copy, process.arch),
        env: { HOME: runtimeHome, TMPDIR: runtimeHome, COPILOT_HOME: runtimeHome, PATH: SYSTEM_PATH },
      }),
      baseDirectory: runtimeHome,
      workingDirectory: runtimeHome,
      useLoggedInUser: false,
      logLevel: "error",
    });
    try {
      await client.start();
      expect(await client.getAuthStatus()).toMatchObject({ isAuthenticated: false });
      expect(await client.stop()).toEqual([]);
    } catch (error) {
      await client.forceStop();
      throw error;
    }
  });
});

describe("installed companion", () => {
  it("is a copy of the build that Chrome can start from its install location until it is uninstalled", async () => {
    const home = temporaryDirectory("companion-install-home-");
    const env = { ...process.env, HOME: home };
    expect(spawnSync(process.execPath, [installCliPath], { encoding: "utf8", env }).status).toBe(0);
    const { applicationDirectory, companionDirectory, executablePath, hostManifestPath } = companionInstallPaths(home);

    expect(JSON.parse(readFileSync(hostManifestPath, "utf8"))).toMatchObject({ path: executablePath, allowed_origins: [EXTENSION_ORIGIN] });
    expect(realpathSync(executablePath)).not.toBe(realpathSync(builtExecutablePath));
    expect(statSync(executablePath).size).toBe(statSync(builtExecutablePath).size);
    expect(codesign(["--verify", "--strict", executablePath]).status).toBe(0);
    expect(existsSync(bundledRuntimePath(companionDirectory, process.arch))).toBe(true);

    const { child, frames, exitCode } = launchCompanion(executablePath, { HOME: home });
    await vi.waitFor(() => expect(frames).toEqual([expect.objectContaining({ type: "hello", sdkVersion: installedSdkVersion })]), startupTimeout);
    child.stdin.end();
    await expect(exitCode).resolves.toBe(0);

    const uninstalled = spawnSync(process.execPath, [installCliPath, "--uninstall"], { encoding: "utf8", env });
    expect(uninstalled.status).toBe(0);
    expect(uninstalled.stdout).toContain("No saved PAT was found in your macOS login keychain.");
    expect(existsSync(applicationDirectory)).toBe(false);
    expect(existsSync(hostManifestPath)).toBe(false);
  });
});
