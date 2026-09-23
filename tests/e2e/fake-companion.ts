import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayFailure } from "../../src/companion/gateway.ts";
import type { CopilotGateway } from "../../src/companion/gateway.ts";
import type { CredentialStore } from "../../src/companion/keychain.ts";
import { runCompanion } from "../../src/companion/run.ts";
import type { TurnOutcome } from "../../src/protocol/messages.ts";

const FAKE_MODELS = [
  { id: "fake-reply", name: "Fake reply", multiplier: 0 },
  { id: "fake-slow", name: "Fake slow reply", multiplier: 1 },
  { id: "fake-quota", name: "Fake quota failure", multiplier: 0.33 },
];
const FAKE_REPLY = ["Connection confirmed. ", "日本語 ", '<img src="x" onerror="alert(1)">'];
const STEP_DELAY_MS = 20;

const runningMarker = join(requiredEnvironment("FAKE_COMPANION_STATE_DIR"), `${process.pid}.running`);
const keychainPath = requiredEnvironment("FAKE_KEYCHAIN_PATH");
writeFileSync(runningMarker, "");

const companion = runCompanion({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  args: process.argv.slice(2),
  createGateway: createFakeGateway,
  store: createFakeKeychain(),
  sdkVersion: `fake-${process.pid}`,
});
process.once("SIGTERM", () => void companion.shutdown());
process.exitCode = await companion.done;
rmSync(runningMarker, { force: true });

function createFakeGateway(): CopilotGateway {
  return {
    async connect(token) {
      await pause(STEP_DELAY_MS);
      if (token.includes("CRASH")) crash();
      if (token.includes("DENIED")) throw new GatewayFailure("auth_failed");
      if (token.includes("NOMODELS")) return { login: "octocat", models: [] };
      return { login: "octocat", models: FAKE_MODELS };
    },

    startTurn({ model, onEvent }) {
      let abortRequested = false;
      let wakeOnAbort = () => {};
      const abortReceived = new Promise<void>((resolve) => (wakeOnAbort = resolve));
      const outcome = (async (): Promise<TurnOutcome> => {
        await pause(STEP_DELAY_MS);
        if (model === "fake-quota") throw new GatewayFailure("quota_exceeded");
        if (model === "fake-slow") {
          onEvent({ type: "delta", text: "Partial reply " });
          await abortReceived;
          return "stopped";
        }
        for (const text of FAKE_REPLY) {
          if (abortRequested) return "stopped";
          onEvent({ type: "delta", text });
          await pause(STEP_DELAY_MS);
        }
        onEvent({ type: "usage", model, cost: 0 });
        return "complete";
      })();
      return {
        outcome,
        async abort() {
          abortRequested = true;
          wakeOnAbort();
        },
      };
    },

    startNewConversation() {},

    async close() {},
  };
}

function createFakeKeychain(): CredentialStore {
  return {
    async hasSavedToken() {
      return existsSync(keychainPath);
    },

    async loadToken() {
      await pause(STEP_DELAY_MS);
      return existsSync(keychainPath) ? readFileSync(keychainPath, "utf8") : undefined;
    },

    async saveToken(token) {
      await pause(STEP_DELAY_MS);
      if (token.includes("NOSAVE")) throw new Error("The fake Keychain refused to save this PAT.");
      writeFileSync(keychainPath, token);
    },

    async forgetToken() {
      await pause(STEP_DELAY_MS);
      const tokenWasSaved = existsSync(keychainPath);
      rmSync(keychainPath, { force: true });
      return tokenWasSaved;
    },
  };
}

function crash(): never {
  rmSync(runningMarker, { force: true });
  process.exit(3);
}

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
