import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeychainStore, createSecurityRunner, MAX_SECURITY_OUTPUT_LENGTH } from "../../src/companion/keychain.ts";
import type { SecurityResult, SecurityRunner } from "../../src/companion/keychain.ts";

const token = `github_pat_${"K".repeat(82)}`;
const itemArguments = ["-s", "io.github.mahata.gh_copilot_in_chrome", "-a", "fine-grained-pat"];
const loginKeychain = "login.keychain";

function fakeSecurity(result: Partial<SecurityResult>) {
  return vi.fn<SecurityRunner>(async () => ({ exitCode: 0, output: "", ...result }));
}

describe("keychain credential store", () => {
  describe("hasSavedToken", () => {
    it("looks up the item's attributes in the login keychain without reading its secret", async () => {
      const runSecurity = fakeSecurity({ exitCode: 0, output: 'keychain: "/Users/octocat/Library/Keychains/login.keychain-db"\n' });
      await expect(createKeychainStore(runSecurity).hasSavedToken()).resolves.toBe(true);
      expect(runSecurity).toHaveBeenCalledExactlyOnceWith(["find-generic-password", ...itemArguments, loginKeychain]);
    });

    it.each([
      ["no item exists", 44],
      ["the lookup fails", 51],
      ["the tool cannot run", null],
    ])("reports no saved token when %s", async (_description, exitCode) => {
      await expect(createKeychainStore(fakeSecurity({ exitCode })).hasSavedToken()).resolves.toBe(false);
    });
  });

  describe("loadToken", () => {
    it("reads the secret from the login keychain and drops the trailing newline", async () => {
      const runSecurity = fakeSecurity({ exitCode: 0, output: `${token}\n` });
      await expect(createKeychainStore(runSecurity).loadToken()).resolves.toBe(token);
      expect(runSecurity).toHaveBeenCalledExactlyOnceWith(["find-generic-password", ...itemArguments, "-w", loginKeychain]);
    });

    it("returns nothing when no item exists", async () => {
      await expect(createKeychainStore(fakeSecurity({ exitCode: 44 })).loadToken()).resolves.toBeUndefined();
    });

    it.each([
      ["the lookup fails", { exitCode: 51, output: "" }],
      ["the tool cannot run", { exitCode: null, output: "" }],
      ["the item holds a classic token", { exitCode: 0, output: `ghp_${"a".repeat(36)}\n` }],
      ["the item holds more than one line", { exitCode: 0, output: `${token}\n${token}\n` }],
      ["the item is empty", { exitCode: 0, output: "\n" }],
    ])("rejects without echoing the output when %s", async (_description, result) => {
      const failure = await createKeychainStore(fakeSecurity(result))
        .loadToken()
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toMatch(/ghp_|github_pat_/);
    });
  });

  describe("saveToken", () => {
    it("writes the token into the login keychain through the tool's standard input, never its arguments", async () => {
      const runSecurity = fakeSecurity({ exitCode: 0 });
      await createKeychainStore(runSecurity).saveToken(token);
      expect(runSecurity).toHaveBeenCalledExactlyOnceWith(
        ["-i"],
        `add-generic-password -U -s io.github.mahata.gh_copilot_in_chrome -a fine-grained-pat -w ${token} ${loginKeychain}\n`,
      );
    });

    it.each([
      ["a classic token", `ghp_${"a".repeat(36)}`],
      ["a second command after a newline", `github_pat_abc\ndelete-keychain login.keychain`],
      ["an extra argument after a space", `github_pat_abc -A`],
      ["an oversized token", `github_pat_${"a".repeat(245)}`],
    ])("refuses %s without running the tool", async (_description, candidate) => {
      const runSecurity = fakeSecurity({ exitCode: 0 });
      await expect(createKeychainStore(runSecurity).saveToken(candidate)).rejects.toBeInstanceOf(Error);
      expect(runSecurity).not.toHaveBeenCalled();
    });

    it.each([51, null])("rejects when the tool exits with %s", async (exitCode) => {
      await expect(createKeychainStore(fakeSecurity({ exitCode })).saveToken(token)).rejects.toBeInstanceOf(Error);
    });
  });

  describe("forgetToken", () => {
    it("deletes the item from the login keychain and reports that it removed one", async () => {
      const runSecurity = fakeSecurity({ exitCode: 0 });
      await expect(createKeychainStore(runSecurity).forgetToken()).resolves.toBe(true);
      expect(runSecurity).toHaveBeenCalledExactlyOnceWith(["delete-generic-password", ...itemArguments, loginKeychain]);
    });

    it("reports that nothing was removed when no item exists", async () => {
      await expect(createKeychainStore(fakeSecurity({ exitCode: 44 })).forgetToken()).resolves.toBe(false);
    });

    it.each([51, null])("rejects when the tool exits with %s", async (exitCode) => {
      await expect(createKeychainStore(fakeSecurity({ exitCode })).forgetToken()).rejects.toBeInstanceOf(Error);
    });
  });
});

describe("security tool runner", () => {
  let directory: string;

  function fakeTool(script: string) {
    const toolPath = join(directory, "security");
    writeFileSync(toolPath, `#!/bin/sh\n${script}\n`);
    chmodSync(toolPath, 0o755);
    return toolPath;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "security-runner-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("runs the tool without a shell, with only HOME and a system PATH, and feeds it the input", async () => {
    vi.stubEnv("HOME", join(directory, "home"));
    vi.stubEnv("GH_TOKEN", "gho_ambient");
    const executablePath = fakeTool(
      `printf '%s\\n' "$#" "$1" "$2" "HOME=$HOME" "PATH=$PATH" "GH_TOKEN=\${GH_TOKEN-unset}"\ncat\nexit 7`,
    );
    const runSecurity = createSecurityRunner({ executablePath });

    await expect(runSecurity(["find-generic-password", "-s two words"], "from stdin\n")).resolves.toEqual({
      exitCode: 7,
      output: [
        "2",
        "find-generic-password",
        "-s two words",
        `HOME=${join(directory, "home")}`,
        "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
        "GH_TOKEN=unset",
        "from stdin",
        "",
      ].join("\n"),
    });
  });

  it("keeps only a bounded amount of output", async () => {
    const executablePath = fakeTool(`head -c ${MAX_SECURITY_OUTPUT_LENGTH * 4} /dev/zero | tr '\\0' x`);
    const { exitCode, output } = await createSecurityRunner({ executablePath })([]);
    expect(exitCode).toBe(0);
    expect(output).toBe("x".repeat(MAX_SECURITY_OUTPUT_LENGTH));
  });

  it("kills a tool that outlives its time limit", async () => {
    const executablePath = fakeTool("exec sleep 5");
    const startedAt = Date.now();
    await expect(createSecurityRunner({ executablePath, timeoutMs: 100 })([])).resolves.toEqual({ exitCode: null, output: "" });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("reports a tool that cannot start", async () => {
    const runSecurity = createSecurityRunner({ executablePath: join(directory, "missing") });
    await expect(runSecurity([], "ignored\n")).resolves.toEqual({ exitCode: null, output: "" });
  });

  it.runIf(process.platform === "darwin")(
    "finds no saved PAT through the real tool in a home without a keychain, and creates nothing there",
    async () => {
      const emptyHome = join(directory, "home");
      mkdirSync(emptyHome);
      vi.stubEnv("HOME", emptyHome);

      const store = createKeychainStore();
      await expect(store.hasSavedToken()).resolves.toBe(false);
      await expect(store.loadToken()).resolves.toBeUndefined();
      await expect(store.forgetToken()).resolves.toBe(false);
      expect(readdirSync(emptyHome)).toEqual([]);
    },
  );
});
