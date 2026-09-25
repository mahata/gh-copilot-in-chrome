import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "rolldown";
import { BUILD_INFO_ASSET, bundledRuntimePath, COMPANION_EXECUTABLE_NAME, RUNTIME_DIRECTORY_NAME } from "./layout.ts";
import type { BuildInfo } from "./layout.ts";
import { REFUSAL_NOTICE } from "./run.ts";

const SUPPORTED_PLATFORM = "darwin";
const SUPPORTED_ARCHITECTURES: readonly string[] = ["arm64", "x64"];
const CODESIGN_PATH = "/usr/bin/codesign";
const STAGING_SUFFIX = ".staging-";
const KOFFI_STUB_ID = "\0prompt-harbor:koffi-stub";
const SMOKE_TEST_TIMEOUT_MS = 10_000;
const SUCCESS = 0;
const FAILURE = 1;

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const companionEntryPath = fileURLToPath(new URL("./main.ts", import.meta.url));

export type BuilderOptions = {
  platform: NodeJS.Platform;
  arch: string;
  outputDirectory: string;
  output: { log: (line: string) => void; error: (line: string) => void };
};

class CompanionBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionBuildError";
  }
}

export function companionBuildDirectory(arch: string) {
  return join(repositoryRoot, "dist-companion", `${SUPPORTED_PLATFORM}-${arch}`);
}

export async function runBuilder({ platform, arch, outputDirectory, output }: BuilderOptions) {
  if (platform !== SUPPORTED_PLATFORM) {
    output.error("The companion builds on macOS only, for the Mac that builds it.");
    return FAILURE;
  }
  if (!SUPPORTED_ARCHITECTURES.includes(arch)) {
    output.error(`The companion builds for Apple silicon (arm64) and Intel (x64) Macs, not ${arch}.`);
    return FAILURE;
  }
  try {
    const { sdkVersion } = await buildCompanion(arch, outputDirectory);
    output.log(`Built the Prompt Harbor companion for ${SUPPORTED_PLATFORM}-${arch} with Copilot SDK ${sdkVersion}:`);
    output.log(`  ${outputDirectory}`);
    return SUCCESS;
  } catch (error) {
    if (!(error instanceof CompanionBuildError)) throw error;
    output.error(error.message);
    return FAILURE;
  }
}

// The build runs this Node.js binary's single executable application support, so it produces a
// companion for this Node.js binary's architecture only.
async function buildCompanion(arch: string, outputDirectory: string): Promise<BuildInfo> {
  const { sdkVersion, runtimePackageDirectory } = await locateSdk(arch);
  await mkdir(dirname(outputDirectory), { recursive: true });
  await removeStaleStagingDirectories(outputDirectory);
  const staging = await mkdtemp(`${outputDirectory}${STAGING_SUFFIX}`);
  try {
    const companionDirectory = join(staging, "companion");
    const intermediatesDirectory = join(staging, "intermediates");
    const executablePath = join(companionDirectory, COMPANION_EXECUTABLE_NAME);
    const bundlePath = join(intermediatesDirectory, "companion.mjs");
    const buildInfoPath = join(intermediatesDirectory, BUILD_INFO_ASSET);
    const seaConfigPath = join(intermediatesDirectory, "sea-config.json");
    const buildInfo: BuildInfo = { sdkVersion };

    await mkdir(companionDirectory);
    await bundleCompanion(bundlePath);
    await writeFile(buildInfoPath, JSON.stringify(buildInfo));
    await writeFile(
      seaConfigPath,
      JSON.stringify({
        main: bundlePath,
        mainFormat: "module",
        output: executablePath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        execArgvExtension: "none",
        assets: { [BUILD_INFO_ASSET]: buildInfoPath },
      }),
    );
    runTool(process.execPath, ["--build-sea", seaConfigPath]);
    runTool(CODESIGN_PATH, ["--sign", "-", "--force", executablePath]);

    await cp(runtimePackageDirectory, join(companionDirectory, RUNTIME_DIRECTORY_NAME), {
      recursive: true,
      errorOnExist: true,
      force: false,
      mode: constants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
    });
    await checkRuntimeFiles(bundledRuntimePath(companionDirectory, arch));
    checkCompanionRefusesToStartAlone(executablePath);

    await rm(outputDirectory, { recursive: true, force: true });
    await rename(companionDirectory, outputDirectory);
    return buildInfo;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function locateSdk(arch: string) {
  const sdkManifestPath = fileURLToPath(new URL("../package.json", import.meta.resolve("@github/copilot-sdk")));
  const sdkVersion = await readPackageVersion(sdkManifestPath);
  const runtimePackage = `@github/copilot-sdk-${SUPPORTED_PLATFORM}-${arch}`;
  let runtimeManifestPath: string;
  try {
    runtimeManifestPath = createRequire(sdkManifestPath).resolve(`${runtimePackage}/package.json`);
  } catch {
    throw new CompanionBuildError(
      `${runtimePackage} is not installed. Run pnpm install --frozen-lockfile on this Mac, without --no-optional.`,
    );
  }
  const runtimeVersion = await readPackageVersion(runtimeManifestPath);
  if (runtimeVersion !== sdkVersion) {
    throw new CompanionBuildError(
      `${runtimePackage} ${runtimeVersion} does not match @github/copilot-sdk ${sdkVersion}. Run pnpm install --frozen-lockfile.`,
    );
  }
  return { sdkVersion, runtimePackageDirectory: dirname(runtimeManifestPath) };
}

async function readPackageVersion(manifestPath: string) {
  const { version }: { version?: unknown } = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof version !== "string") throw new CompanionBuildError(`${manifestPath} has no version.`);
  return version;
}

async function bundleCompanion(bundlePath: string) {
  const { rolldown } = await import("rolldown");
  const bundle = await rolldown({
    input: companionEntryPath,
    cwd: repositoryRoot,
    platform: "node",
    plugins: [stubKoffi()],
    logLevel: "warn",
    onLog(level, log, handler) {
      handler(level === "warn" ? "error" : level, log);
    },
  });
  try {
    await bundle.write({ file: bundlePath, format: "esm", codeSplitting: false });
  } finally {
    await bundle.close();
  }
}

// The SDK needs koffi only for its in-process runtime. The companion always starts the runtime as
// a child process, and a single executable application could not load koffi's native addon anyway.
function stubKoffi(): Plugin {
  return {
    name: "prompt-harbor:stub-koffi",
    resolveId(source) {
      return source === "koffi" ? KOFFI_STUB_ID : null;
    },
    load(id) {
      if (id !== KOFFI_STUB_ID) return null;
      return 'export default new Proxy({}, { get() { throw new Error("The companion does not include koffi."); } });';
    },
  };
}

async function checkRuntimeFiles(runtimePath: string) {
  for (const path of [runtimePath, join(dirname(runtimePath), "runtime.node")]) {
    const file = await stat(path).catch(() => undefined);
    if (!file?.isFile() || file.size === 0) {
      throw new CompanionBuildError(`The Copilot runtime is missing ${basename(path)}. Run pnpm install --frozen-lockfile.`);
    }
  }
}

function checkCompanionRefusesToStartAlone(executablePath: string) {
  const { status, stdout, stderr } = spawnSync(executablePath, [], { encoding: "utf8", env: {}, timeout: SMOKE_TEST_TIMEOUT_MS });
  if (status !== FAILURE || stdout !== "" || stderr !== REFUSAL_NOTICE) {
    throw new CompanionBuildError("The built companion did not start. Its single executable application may be damaged.");
  }
}

function runTool(command: string, args: readonly string[]) {
  const { status, stderr, error } = spawnSync(command, args, { encoding: "utf8" });
  if (status === SUCCESS) return;
  const detail = error?.message ?? stderr.trim();
  throw new CompanionBuildError(`${basename(command)} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`);
}

async function removeStaleStagingDirectories(outputDirectory: string) {
  const prefix = `${basename(outputDirectory)}${STAGING_SUFFIX}`;
  for (const entry of await readdir(dirname(outputDirectory))) {
    if (entry.startsWith(prefix)) await rm(join(dirname(outputDirectory), entry), { recursive: true, force: true });
  }
}
