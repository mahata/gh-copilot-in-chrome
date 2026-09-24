import { chmod, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CredentialStore } from "./keychain.ts";
import { EXTENSION_ORIGIN, HOST_NAME } from "../protocol/identity.ts";

const SUPPORTED_PLATFORM = "darwin";
const UNINSTALL_FLAG = "--uninstall";
const LAUNCHER_MODE = 0o755;
const HOST_MANIFEST_MODE = 0o644;
const SUCCESS = 0;
const FAILURE = 1;

export type InstallerOptions = {
  args: readonly string[];
  platform: NodeJS.Platform;
  home: string;
  nodePath: string;
  companionEntryPath: string;
  store: Pick<CredentialStore, "forgetToken">;
  output: { log: (line: string) => void; error: (line: string) => void };
};

type CompanionInstallPaths = ReturnType<typeof companionInstallPaths>;

export function companionInstallPaths(home: string) {
  const applicationSupport = join(home, "Library", "Application Support");
  const launcherDirectory = join(applicationSupport, "prompt-harbor");
  return {
    launcherDirectory,
    launcherPath: join(launcherDirectory, "companion"),
    hostManifestPath: join(applicationSupport, "Google", "Chrome", "NativeMessagingHosts", `${HOST_NAME}.json`),
  };
}

export async function runInstaller({ args, platform, home, nodePath, companionEntryPath, store, output }: InstallerOptions) {
  if (platform !== SUPPORTED_PLATFORM) {
    output.error("The companion installer supports macOS only.");
    return FAILURE;
  }
  const paths = companionInstallPaths(home);
  if (args.length === 0) {
    await install(paths, nodePath, companionEntryPath);
    output.log("Installed the Prompt Harbor companion.");
    output.log(`  Launcher: ${paths.launcherPath}`);
    output.log(`  Chrome host manifest: ${paths.hostManifestPath}`);
    output.log("Reopen the extension's side panel to use it. Install again after moving this checkout or changing Node.js.");
    return SUCCESS;
  }
  if (args.length === 1 && args[0] === UNINSTALL_FLAG) {
    await uninstall(paths);
    output.log("Removed the Prompt Harbor companion.");
    return forgetSavedToken(store, output);
  }
  output.error("Usage: pnpm companion:install | pnpm companion:uninstall");
  return FAILURE;
}

async function install({ launcherDirectory, launcherPath, hostManifestPath }: CompanionInstallPaths, nodePath: string, companionEntryPath: string) {
  await mkdir(launcherDirectory, { recursive: true });
  await writeFile(launcherPath, `#!/bin/sh\nexec ${quoteForShell(nodePath)} ${quoteForShell(companionEntryPath)} "$@"\n`);
  await chmod(launcherPath, LAUNCHER_MODE);

  const hostManifest = {
    name: HOST_NAME,
    description: "Local GitHub Copilot SDK companion for Prompt Harbor",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [EXTENSION_ORIGIN],
  };
  await mkdir(dirname(hostManifestPath), { recursive: true });
  await writeFile(hostManifestPath, `${JSON.stringify(hostManifest, null, 2)}\n`);
  await chmod(hostManifestPath, HOST_MANIFEST_MODE);
}

async function uninstall({ launcherDirectory, launcherPath, hostManifestPath }: CompanionInstallPaths) {
  await rm(hostManifestPath, { force: true });
  await rm(launcherPath, { force: true });
  await rmdir(launcherDirectory).catch(() => undefined);
}

async function forgetSavedToken(store: InstallerOptions["store"], output: InstallerOptions["output"]) {
  let tokenWasSaved: boolean;
  try {
    tokenWasSaved = await store.forgetToken();
  } catch {
    output.error("Could not remove the saved PAT from your macOS login keychain.");
    output.error(`Delete the ${HOST_NAME} item in Keychain Access instead.`);
    return FAILURE;
  }
  output.log(
    tokenWasSaved
      ? "Removed the saved PAT from your macOS login keychain."
      : "No saved PAT was found in your macOS login keychain.",
  );
  return SUCCESS;
}

function quoteForShell(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
