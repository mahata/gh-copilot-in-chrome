import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

export type NoticeComponent = {
  name: string;
  version: string;
  inclusion: string;
  homepage?: string;
  license?: string;
  licenseText?: string;
  // Replaces the package.json sentence when a component without license text is not an npm package.
  missingLicenseNote?: string;
};

type PackageManifest = { name?: unknown; version?: unknown; license?: unknown; homepage?: unknown; repository?: unknown };

const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying)(\.(md|markdown|txt|rst))?$/i;
const SEPARATOR = "=".repeat(80);
const NODE_MODULES_SEGMENT = `${sep}node_modules${sep}`;

// Maps bundled module files to the packages they came from. The companion's own sources and
// the bundler's virtual modules are not in node_modules, so they are skipped.
export async function findPackageDirectories(moduleIds: readonly string[]) {
  const packageDirectories = new Set<string>();
  const manifestsByDirectory = new Map<string, Promise<PackageManifest | undefined>>();
  for (const moduleId of moduleIds) {
    if (!isAbsolute(moduleId) || !moduleId.includes(NODE_MODULES_SEGMENT)) continue;
    for (let directory = dirname(moduleId); basename(directory) !== "node_modules" && directory !== dirname(directory); directory = dirname(directory)) {
      let manifest = manifestsByDirectory.get(directory);
      if (manifest === undefined) {
        manifest = readManifest(directory);
        manifestsByDirectory.set(directory, manifest);
      }
      const { name, version } = (await manifest) ?? {};
      if (typeof name === "string" && typeof version === "string") {
        packageDirectories.add(directory);
        break;
      }
    }
  }
  return [...packageDirectories];
}

export async function describePackage(packageDirectory: string, inclusion: string): Promise<NoticeComponent> {
  const manifest = await readManifest(packageDirectory);
  const { name, version } = manifest ?? {};
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`${join(packageDirectory, "package.json")} has no name or version.`);
  }
  const licenseFile = (await readdir(packageDirectory)).filter((entry) => LICENSE_FILE_PATTERN.test(entry)).sort()[0];
  return {
    name,
    version,
    inclusion,
    homepage: homepageOf(manifest),
    license: licenseOf(manifest),
    licenseText: licenseFile === undefined ? undefined : await readFile(join(packageDirectory, licenseFile), "utf8"),
  };
}

export function formatNotices(components: readonly NoticeComponent[]) {
  const sections = components.map(({ name, version, inclusion, homepage, license, licenseText, missingLicenseNote }) => {
    const lines = [SEPARATOR, `${name} ${version}`];
    if (homepage !== undefined) lines.push(homepage);
    lines.push(inclusion);
    if (licenseText !== undefined) {
      if (license !== undefined) lines.push(`License: ${license}`);
      lines.push("", licenseText.trimEnd());
    } else if (missingLicenseNote !== undefined) {
      lines.push(missingLicenseNote);
    } else {
      lines.push(`License: ${license ?? "not declared"}, as its package.json declares. The package includes no license text.`);
    }
    return lines.join("\n");
  });
  return [
    "Third-party software in the Prompt Harbor companion",
    "",
    "The Prompt Harbor companion includes the following software, which is distributed under its own terms.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}

export function nodeLicenseUrl(version: string) {
  return `https://github.com/nodejs/node/blob/${version}/LICENSE`;
}

// Node.js tarballs, and installs made from them or by Homebrew, keep the LICENSE, which also covers
// the libraries built into the binary, beside bin/. The nodejs.org installer package keeps no copy,
// so a companion built with that Node.js links to the published LICENSE for its version instead.
export async function describeNode(executablePath: string, version: string): Promise<NoticeComponent & { licensePath: string }> {
  const licensePath = join(dirname(dirname(executablePath)), "LICENSE");
  const licenseText = await readFile(licensePath, "utf8").catch(() => undefined);
  return {
    name: "Node.js",
    version,
    inclusion: "The companion executable is this Node.js binary with the companion's code embedded.",
    homepage: "https://nodejs.org/",
    licenseText,
    missingLicenseNote:
      licenseText === undefined
        ? `Its LICENSE, which also covers the libraries built into it, was not beside the Node.js binary that built this companion. It is published at ${nodeLicenseUrl(version)}.`
        : undefined,
    licensePath,
  };
}

async function readManifest(directory: string): Promise<PackageManifest | undefined> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    return typeof manifest === "object" && manifest !== null ? manifest : undefined;
  } catch {
    return undefined;
  }
}

function licenseOf({ license }: PackageManifest = {}) {
  if (typeof license === "string") return license;
  if (typeof license === "object" && license !== null && "type" in license && typeof license.type === "string") return license.type;
  return undefined;
}

function homepageOf({ homepage, repository }: PackageManifest = {}) {
  if (typeof homepage === "string") return homepage;
  const url = typeof repository === "string" ? repository : typeof repository === "object" && repository !== null && "url" in repository ? repository.url : undefined;
  return typeof url === "string" ? url.replace(/^git\+/, "").replace(/\.git$/, "") : undefined;
}
