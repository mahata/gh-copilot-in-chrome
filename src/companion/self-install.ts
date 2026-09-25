import { stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  DELETE_SAVED_PAT_OPTION,
  installCompanion,
  KEEP_SAVED_PAT_OPTION,
  parseUninstallArguments,
  reportInstallation,
  UNINSTALL_OPTION,
  uninstallCompanion,
} from "./install.ts";
import type { UninstallOptions } from "./install.ts";
import { COMPANION_EXECUTABLE_NAME, UNINSTALL_SCRIPT_NAME } from "./layout.ts";

export const INSTALL_OPTION = "--install";
const SUCCESS = 0;
const FAILURE = 1;

export type SelfInstallerOptions = UninstallOptions & {
  args: readonly string[];
  executablePath: string;
  home: string;
};

export function isSelfInstallerCommand(args: readonly string[]) {
  return args[0] === INSTALL_OPTION || args[0] === UNINSTALL_OPTION;
}

// The installer package runs `--install <home folder>` on the companion in its scripts, which copies
// the directory holding the executable. The uninstall script beside an installed companion runs `--uninstall`.
export async function runSelfInstaller({ args, executablePath, home, ...uninstallOptions }: SelfInstallerOptions) {
  const { output } = uninstallOptions;
  try {
    if (args[0] === INSTALL_OPTION) {
      const [, target, ...extra] = args;
      if (target === undefined || extra.length > 0 || !isAbsolute(target) || !(await isDirectory(target))) {
        output.error(`Usage: ${COMPANION_EXECUTABLE_NAME} ${INSTALL_OPTION} <home folder>`);
        return FAILURE;
      }
      reportInstallation(await installCompanion(target, dirname(executablePath)), output);
      return SUCCESS;
    }
    const savedPat = parseUninstallArguments(args);
    if (savedPat === undefined) {
      output.error(`Usage: ${UNINSTALL_SCRIPT_NAME} [${KEEP_SAVED_PAT_OPTION} | ${DELETE_SAVED_PAT_OPTION}]`);
      return FAILURE;
    }
    return await uninstallCompanion(home, savedPat, uninstallOptions);
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return FAILURE;
  }
}

async function isDirectory(path: string) {
  const entry = await stat(path).catch(() => undefined);
  return entry?.isDirectory() === true;
}
