import { join } from "node:path";

export const COMPANION_EXECUTABLE_NAME = "prompt-harbor-companion";
export const RUNTIME_DIRECTORY_NAME = "copilot-runtime";
export const BUILD_INFO_ASSET = "build-info.json";

export type BuildInfo = { sdkVersion: string };

export function bundledRuntimePath(companionDirectory: string, arch: string) {
  return join(companionDirectory, RUNTIME_DIRECTORY_NAME, "prebuilds", `darwin-${arch}`, "copilot-runtime");
}
