import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CredentialStore } from "./keychain.ts";
import { COMPANION_EXECUTABLE_NAME } from "./layout.ts";
import { EXTENSION_ORIGIN, HOST_NAME } from "../protocol/identity.ts";

const SUPPORTED_PLATFORM = "darwin";
const UNINSTALL_FLAG = "--uninstall";
const HOST_MANIFEST_MODE = 0o644;
const STAGING_PREFIX = ".staging-";
const PREVIOUS_PREFIX = ".previous-";
const LEFTOVER_PREFIXES: readonly string[] = [STAGING_PREFIX, PREVIOUS_PREFIX];
const SUCCESS = 0;
const FAILURE = 1;

export type InstallerOptions = {
  args: readonly string[];
  platform: NodeJS.Platform;
  home: string;
  buildDirectory: string;
  store: Pick<CredentialStore, "forgetToken">;
  output: { log: (line: string) => void; error: (line: string) => void };
};

type CompanionInstallPaths = ReturnType<typeof companionInstallPaths>;

export function companionInstallPaths(home: string) {
  const applicationSupport = join(home, "Library", "Application Support");
  const applicationDirectory = join(applicationSupport, "prompt-harbor");
  const companionDirectory = join(applicationDirectory, "companion");
  return {
    applicationDirectory,
    companionDirectory,
    executablePath: join(companionDirectory, COMPANION_EXECUTABLE_NAME),
    hostManifestPath: join(applicationSupport, "Google", "Chrome", "NativeMessagingHosts", `${HOST_NAME}.json`),
  };
}

export async function runInstaller({ args, platform, home, buildDirectory, store, output }: InstallerOptions) {
  if (platform !== SUPPORTED_PLATFORM) {
    output.error("The companion installer supports macOS only.");
    return FAILURE;
  }
  const paths = companionInstallPaths(home);
  if (args.length === 0) {
    if (!(await isFile(join(buildDirectory, COMPANION_EXECUTABLE_NAME)))) {
      output.error(`No built companion was found in ${buildDirectory}.`);
      output.error("Run pnpm companion:install, which builds it first.");
      return FAILURE;
    }
    await install(paths, buildDirectory);
    output.log("Installed the Prompt Harbor companion.");
    output.log(`  Companion: ${paths.executablePath}`);
    output.log(`  Chrome host manifest: ${paths.hostManifestPath}`);
    output.log("Reopen the extension's side panel to use it.");
    output.log("It runs without this checkout or Node.js. Run pnpm companion:install again to update it.");
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

async function install({ applicationDirectory, companionDirectory, executablePath, hostManifestPath }: CompanionInstallPaths, buildDirectory: string) {
  await mkdir(applicationDirectory, { recursive: true });
  await recoverFromInterruptedInstall(applicationDirectory, companionDirectory);
  const staging = await mkdtemp(join(applicationDirectory, STAGING_PREFIX));
  try {
    await cp(buildDirectory, staging, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    await replaceWithRenames(companionDirectory, staging, join(applicationDirectory, `${PREVIOUS_PREFIX}${randomUUID()}`));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await removeLeftovers(applicationDirectory, LEFTOVER_PREFIXES);

  const hostManifest = {
    name: HOST_NAME,
    description: "Local GitHub Copilot SDK companion for Prompt Harbor",
    path: executablePath,
    type: "stdio",
    allowed_origins: [EXTENSION_ORIGIN],
  };
  await mkdir(dirname(hostManifestPath), { recursive: true });
  await writeFile(hostManifestPath, `${JSON.stringify(hostManifest, null, 2)}\n`);
  await chmod(hostManifestPath, HOST_MANIFEST_MODE);
}

// Moving the earlier install aside and the new copy in are both renames, so an interrupted copy
// never leaves a half-written companion where Chrome starts it.
async function replaceWithRenames(target: string, replacement: string, previous: string) {
  const movedAside = await rename(target, previous).then(
    () => true,
    (error: unknown) => {
      if (isMissingFileError(error)) return false;
      throw error;
    },
  );
  try {
    await rename(replacement, target);
  } catch (error) {
    if (movedAside) await rename(previous, target);
    throw error;
  }
}

// An install stopped between its two renames leaves the earlier companion moved aside and none in
// place. Put it back, and delete moved-aside copies only while a companion is in place, so a copy
// that fails afterwards still leaves the earlier companion.
async function recoverFromInterruptedInstall(applicationDirectory: string, companionDirectory: string) {
  const entries = await readdir(applicationDirectory);
  const [movedAside, ...otherMovedAside] = entries.filter((entry) => entry.startsWith(PREVIOUS_PREFIX));
  if (movedAside !== undefined && otherMovedAside.length === 0 && !(await pathExists(companionDirectory))) {
    await rename(join(applicationDirectory, movedAside), companionDirectory);
  }
  await removeLeftovers(applicationDirectory, (await pathExists(companionDirectory)) ? LEFTOVER_PREFIXES : [STAGING_PREFIX]);
}

async function uninstall({ applicationDirectory, companionDirectory, hostManifestPath }: CompanionInstallPaths) {
  await rm(hostManifestPath, { force: true });
  await rm(companionDirectory, { recursive: true, force: true });
  await removeLeftovers(applicationDirectory, LEFTOVER_PREFIXES);
  await rmdir(applicationDirectory).catch(() => undefined);
}

async function removeLeftovers(applicationDirectory: string, prefixes: readonly string[]) {
  const entries = await readdir(applicationDirectory).catch(() => []);
  for (const entry of entries) {
    if (prefixes.some((prefix) => entry.startsWith(prefix))) {
      await rm(join(applicationDirectory, entry), { recursive: true, force: true });
    }
  }
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

async function isFile(path: string) {
  const file = await stat(path).catch(() => undefined);
  return file?.isFile() === true;
}

async function pathExists(path: string) {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isMissingFileError(error)) return false;
      throw error;
    },
  );
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
