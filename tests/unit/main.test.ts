import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameDecoder } from "../../src/companion/framing.ts";
import { EXTENSION_ORIGIN } from "../../src/protocol/identity.ts";

const mainPath = fileURLToPath(new URL("../../src/companion/main.ts", import.meta.url));
const installedSdkVersion: unknown = JSON.parse(
  readFileSync(new URL("../../node_modules/@github/copilot-sdk/package.json", import.meta.url), "utf8"),
).version;
const startupTimeout = { timeout: 10_000 };
const launchedCompanions: ChildProcess[] = [];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "companion-home-"));
});

afterEach(() => {
  for (const child of launchedCompanions.splice(0)) child.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

function launchCompanion(args: string[]) {
  const child = spawn(process.execPath, [mainPath, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home },
  });
  launchedCompanions.push(child);
  const frames: unknown[] = [];
  const decoder = createFrameDecoder((frame) => frames.push(frame));
  let outputByteCount = 0;
  let errorText = "";
  child.stdout.on("data", (chunk: Buffer) => {
    outputByteCount += chunk.length;
    decoder.push(chunk);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (errorText += chunk));
  const exitCode = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, frames, exitCode, outputByteCount: () => outputByteCount, errorText: () => errorText };
}

describe("companion entry point", { timeout: 15_000 }, () => {
  it("refuses to start unless Chrome launches it for the extension", async () => {
    const { exitCode, outputByteCount, errorText } = launchCompanion([]);
    await expect(exitCode).resolves.toBe(1);
    expect(outputByteCount()).toBe(0);
    expect(errorText()).toMatch(/only runs when Chrome starts it/);
  });

  it("greets Chrome with the installed SDK version and no saved PAT in an empty home, then exits when its input ends", async () => {
    const { child, frames, exitCode } = launchCompanion([EXTENSION_ORIGIN]);
    await vi.waitFor(
      () => expect(frames).toEqual([{ type: "hello", protocolVersion: 2, sdkVersion: installedSdkVersion, savedToken: false }]),
      startupTimeout,
    );
    child.stdin.end();
    await expect(exitCode).resolves.toBe(0);
    expect(readdirSync(home)).toEqual([]);
  });

  it("exits cleanly when Chrome terminates it", async () => {
    const { child, frames, exitCode } = launchCompanion([EXTENSION_ORIGIN]);
    await vi.waitFor(() => expect(frames).toHaveLength(1), startupTimeout);
    child.kill("SIGTERM");
    await expect(exitCode).resolves.toBe(0);
  });
});
