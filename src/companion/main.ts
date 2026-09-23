import { readFile } from "node:fs/promises";
import { createKeychainStore } from "./keychain.ts";
import { runCompanion } from "./run.ts";
import { createSdkGateway } from "./sdk-gateway.ts";
import { isBoundedField } from "../protocol/messages.ts";

const UNKNOWN_SDK_VERSION = "unknown";

const companion = runCompanion({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  args: process.argv.slice(2),
  createGateway: createSdkGateway,
  store: createKeychainStore(),
  sdkVersion: await readSdkVersion(),
});
process.once("SIGTERM", () => void companion.shutdown());
process.exitCode = await companion.done;

async function readSdkVersion() {
  try {
    const sdkManifestUrl = new URL("../package.json", import.meta.resolve("@github/copilot-sdk"));
    const { version }: { version?: unknown } = JSON.parse(await readFile(sdkManifestUrl, "utf8"));
    return isBoundedField(version) ? version : UNKNOWN_SDK_VERSION;
  } catch {
    return UNKNOWN_SDK_VERSION;
  }
}
