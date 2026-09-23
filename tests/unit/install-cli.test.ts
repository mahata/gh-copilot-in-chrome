import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameDecoder } from "../../src/companion/framing.ts";
import { companionInstallPaths } from "../../src/companion/install.ts";
import { EXTENSION_ORIGIN } from "../../src/protocol/identity.ts";

const installCliPath = fileURLToPath(new URL("../../src/companion/install-cli.ts", import.meta.url));
const companionEntryPath = fileURLToPath(new URL("../../src/companion/main.ts", import.meta.url));
let home: string;

function runInstallCli(args: string[]) {
  return spawnSync(process.execPath, [installCliPath, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "installer-cli-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("companion installer command", { timeout: 15_000 }, () => {
  it.runIf(process.platform === "darwin")("installs a launcher that Chrome can start, then uninstalls it", async () => {
    const installed = runInstallCli([]);
    expect(installed.status).toBe(0);
    const { launcherPath, hostManifestPath } = companionInstallPaths(home);
    expect(readFileSync(launcherPath, "utf8")).toContain(`'${process.execPath}' '${companionEntryPath}'`);

    const companion = spawn(launcherPath, [EXTENSION_ORIGIN], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, HOME: home } });
    const frames: unknown[] = [];
    const decoder = createFrameDecoder((frame) => frames.push(frame));
    companion.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
    const exitCode = new Promise<number | null>((resolve) => companion.on("exit", (code) => resolve(code)));
    await vi.waitFor(() => expect(frames).toEqual([expect.objectContaining({ type: "hello", protocolVersion: 2, savedToken: false })]), { timeout: 10_000 });
    companion.stdin.end();
    await expect(exitCode).resolves.toBe(0);

    const uninstalled = runInstallCli(["--uninstall"]);
    expect(uninstalled.status).toBe(0);
    expect(uninstalled.stdout).toContain("No saved PAT was found in your macOS login keychain.");
    expect(existsSync(launcherPath)).toBe(false);
    expect(existsSync(hostManifestPath)).toBe(false);
  });

  it.skipIf(process.platform === "darwin")("refuses to install outside macOS", () => {
    const refused = runInstallCli([]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/macOS only/);
  });
});
