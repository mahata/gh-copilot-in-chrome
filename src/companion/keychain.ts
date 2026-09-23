import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { SYSTEM_PATH } from "./system-path.ts";
import { HOST_NAME } from "../protocol/identity.ts";
import { isFineGrainedPersonalAccessToken } from "../protocol/messages.ts";

export const MAX_SECURITY_OUTPUT_LENGTH = 4_096;

const SECURITY_TIMEOUT_MS = 10_000;
const SECURITY_PATH = "/usr/bin/security";
const ITEM_NOT_FOUND_EXIT_CODE = 44;
const ITEM_ARGUMENTS = ["-s", HOST_NAME, "-a", "fine-grained-pat"];

export type SecurityResult = { exitCode: number | null; output: string };
export type SecurityRunner = (args: readonly string[], input?: string) => Promise<SecurityResult>;

export type CredentialStore = {
  hasSavedToken: () => Promise<boolean>;
  loadToken: () => Promise<string | undefined>;
  saveToken: (token: string) => Promise<void>;
  forgetToken: () => Promise<boolean>;
};

export function createKeychainStore(runSecurity: SecurityRunner = createSecurityRunner()): CredentialStore {
  return {
    async hasSavedToken() {
      const { exitCode } = await runSecurity(["find-generic-password", ...ITEM_ARGUMENTS]);
      return exitCode === 0;
    },

    async loadToken() {
      const { exitCode, output } = await runSecurity(["find-generic-password", ...ITEM_ARGUMENTS, "-w"]);
      if (exitCode === ITEM_NOT_FOUND_EXIT_CODE) return undefined;
      const savedToken = output.endsWith("\n") ? output.slice(0, -1) : output;
      if (exitCode !== 0 || !isFineGrainedPersonalAccessToken(savedToken)) {
        throw new Error("The saved PAT could not be read from the macOS Keychain.");
      }
      return savedToken;
    },

    async saveToken(token) {
      if (!isFineGrainedPersonalAccessToken(token)) throw new Error("Only a fine-grained PAT can be saved.");
      const { exitCode } = await runSecurity(["-i"], `add-generic-password -U ${ITEM_ARGUMENTS.join(" ")} -w ${token}\n`);
      if (exitCode !== 0) throw new Error("The PAT could not be saved to the macOS Keychain.");
    },

    async forgetToken() {
      const { exitCode } = await runSecurity(["delete-generic-password", ...ITEM_ARGUMENTS]);
      if (exitCode === ITEM_NOT_FOUND_EXIT_CODE) return false;
      if (exitCode !== 0) throw new Error("The saved PAT could not be removed from the macOS Keychain.");
      return true;
    },
  };
}

export function createSecurityRunner({ executablePath = SECURITY_PATH, timeoutMs = SECURITY_TIMEOUT_MS } = {}): SecurityRunner {
  return (args, input = "") =>
    new Promise((resolve) => {
      let output = "";
      const child = spawn(executablePath, args, {
        env: { HOME: homedir(), PATH: SYSTEM_PATH },
        stdio: ["pipe", "pipe", "ignore"],
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      child.once("error", () => resolve({ exitCode: null, output: "" }));
      child.once("close", (exitCode) => resolve({ exitCode, output }));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output = (output + chunk).slice(0, MAX_SECURITY_OUTPUT_LENGTH);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
}
