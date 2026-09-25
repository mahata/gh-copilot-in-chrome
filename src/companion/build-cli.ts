import { companionBuildDirectory, runBuilder } from "./build.ts";

process.exitCode = await runBuilder({
  platform: process.platform,
  arch: process.arch,
  outputDirectory: companionBuildDirectory(process.arch),
  output: console,
});
