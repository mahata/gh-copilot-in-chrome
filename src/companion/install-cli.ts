import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { runInstaller } from "./install.ts";

process.exitCode = await runInstaller({
  args: process.argv.slice(2),
  platform: process.platform,
  home: homedir(),
  nodePath: process.execPath,
  companionEntryPath: fileURLToPath(new URL("./main.ts", import.meta.url)),
  output: console,
});
