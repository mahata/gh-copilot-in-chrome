import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAsset, isSea } from "node:sea";
import { createKeychainStore } from "./keychain.ts";
import { BUILD_INFO_ASSET, bundledRuntimePath } from "./layout.ts";
import { runCompanion } from "./run.ts";
import { createSdkGateway } from "./sdk-gateway.ts";
import { isBoundedField } from "../protocol/messages.ts";

const UNKNOWN_SDK_VERSION = "unknown";

// A built companion is a single executable application with the Copilot runtime beside it.
// Run from a checkout, the SDK finds its runtime in node_modules instead.
const isBuiltCompanion = isSea();
const runtimePath = isBuiltCompanion ? bundledRuntimePath(dirname(process.execPath), process.arch) : undefined;

const companion = runCompanion({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  args: process.argv.slice(2),
  createGateway: () => createSdkGateway({ runtimePath }),
  store: createKeychainStore(),
  sdkVersion: await readSdkVersion(isBuiltCompanion ? readBuiltSdkVersion : readCheckoutSdkVersion),
});
process.once("SIGTERM", () => void companion.shutdown());
process.exitCode = await companion.done;

async function readSdkVersion(read: () => Promise<unknown>) {
  try {
    const version = await read();
    return isBoundedField(version) ? version : UNKNOWN_SDK_VERSION;
  } catch {
    return UNKNOWN_SDK_VERSION;
  }
}

async function readBuiltSdkVersion() {
  const { sdkVersion }: { sdkVersion?: unknown } = JSON.parse(getAsset(BUILD_INFO_ASSET, "utf8"));
  return sdkVersion;
}

async function readCheckoutSdkVersion() {
  const sdkManifestUrl = new URL("../package.json", import.meta.resolve("@github/copilot-sdk"));
  const { version }: { version?: unknown } = JSON.parse(await readFile(sdkManifestUrl, "utf8"));
  return version;
}
