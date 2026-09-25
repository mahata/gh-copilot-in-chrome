import { homedir } from "node:os";
import { companionBuildDirectory } from "./build.ts";
import { runInstaller } from "./install.ts";
import { createKeychainStore } from "./keychain.ts";

process.exitCode = await runInstaller({
  args: process.argv.slice(2),
  platform: process.platform,
  home: homedir(),
  buildDirectory: companionBuildDirectory(process.arch),
  store: createKeychainStore(),
  output: console,
});
