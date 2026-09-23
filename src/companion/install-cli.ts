import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { runInstaller } from "./install.ts";
import { createKeychainStore } from "./keychain.ts";

process.exitCode = await runInstaller({
  args: process.argv.slice(2),
  platform: process.platform,
  home: homedir(),
  nodePath: process.execPath,
  companionEntryPath: fileURLToPath(new URL("./main.ts", import.meta.url)),
  store: createKeychainStore(),
  output: console,
});
