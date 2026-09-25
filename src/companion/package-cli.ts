import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { companionBuildDirectory } from "./build.ts";
import { runPackager } from "./package.ts";

const { version }: { version: string } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const buildDirectory = companionBuildDirectory(process.arch);

process.exitCode = await runPackager({
  platform: process.platform,
  buildDirectory,
  outputDirectory: dirname(buildDirectory),
  version,
  output: console,
});
