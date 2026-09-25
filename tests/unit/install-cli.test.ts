import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const installCliPath = fileURLToPath(new URL("../../src/companion/install-cli.ts", import.meta.url));
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "installer-cli-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// On macOS, tests/companion runs this command against a real build.
describe("companion installer command", () => {
  it.skipIf(process.platform === "darwin")("refuses to install outside macOS", () => {
    const refused = spawnSync(process.execPath, [installCliPath], { encoding: "utf8", env: { ...process.env, HOME: home } });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/macOS only/);
  });
});
