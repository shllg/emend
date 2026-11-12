import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";

import { readRegular } from "../publish/read.ts";
import { isInstalledManifest } from "./manifest.ts";

export const updatePackage = "@shllg/emend";
export const updateDoc = "https://github.com/shllg/emend/blob/release/docs/setup/update.md";

export type Install =
  | { kind: "mise" }
  | { kind: "pnpm" }
  | { kind: "npm"; prefix: string }
  | { kind: "local"; where: "mise-link" | "checkout" | "marked"; root?: string }
  | { kind: "unknown" };

const packageTail = ["node_modules", "@shllg", "emend", "dist", "emend.mjs"];

function endsWith(segments: string[], tail: string[]): boolean {
  return (
    segments.length >= tail.length &&
    tail.every((part, index) => segments[segments.length - tail.length + index] === part)
  );
}

/** Walk up from the entry's folder and return the first folder that holds a `.git` entry. */
export async function checkoutRoot(realEntry: string): Promise<string | undefined> {
  let directory = dirname(realEntry);
  for (;;) {
    try {
      await lstat(join(directory, ".git"));
      return directory;
    } catch {
      // No entry here, or none that can be checked: keep looking upward.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Confirm package identity and ownership; pnpm evidence comes from its global list. */
export async function detectInstall(
  entry: string,
  confirmPnpm: (folder: string) => Promise<boolean> = async () => false,
): Promise<Install> {
  let realEntry: string;
  let folder: string;
  let manifest: unknown;
  try {
    if (!isAbsolute(entry)) return { kind: "unknown" };
    realEntry = await realpath(entry);
    if (!endsWith(realEntry.split(sep), ["dist", "emend.mjs"])) return { kind: "unknown" };
    folder = await realpath(dirname(dirname(realEntry)));
    manifest = JSON.parse((await readRegular(join(folder, "package.json"), 64 * 1024)).toString("utf8"));
    if (!isInstalledManifest(manifest)) return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
  if (manifest.emendLocalBuild !== undefined) return { kind: "local", where: "marked" };
  const segments = realEntry.split(sep).filter(Boolean);
  const modules = segments.filter((part) => part === "node_modules").length;
  if (segments.includes("linked-installs")) return { kind: "local", where: "mise-link" };
  const installs = segments.findIndex(
    (part, index) => part === "installs" && segments[index + 1] === "npm-shllg-emend",
  );
  if (installs !== -1) {
    const version = segments[installs + 2];
    const rest = segments.slice(installs + 3);
    if (
      version &&
      !["lib", "node_modules"].includes(version) &&
      ((rest.length === packageTail.length && endsWith(rest, packageTail)) ||
        (rest.length === packageTail.length + 1 && endsWith(rest, ["lib", ...packageTail])))
    )
      return { kind: "mise" };
    return { kind: "unknown" };
  }
  if (modules === 0) {
    const root = await checkoutRoot(realEntry);
    return root === undefined ? { kind: "unknown" } : { kind: "local", where: "checkout", root };
  }
  if (!endsWith(segments, packageTail)) return { kind: "unknown" };
  if (segments.includes("pnpm") || segments.includes(".pnpm"))
    return { kind: (await confirmPnpm(folder)) ? "pnpm" : "unknown" };
  const lead = segments.slice(0, -packageTail.length);
  if (lead.at(-1) === "lib" && modules === 1 && !lead.includes("npm-shllg-emend")) {
    const prefix = sep + lead.slice(0, -1).join(sep);
    try {
      if ((await realpath(join(prefix, "bin/emend"))) === join(folder, "bin/emend")) return { kind: "npm", prefix };
    } catch {
      /* Missing or foreign launchers do not establish ownership. */
    }
  }
  return { kind: "unknown" };
}

export type Method = "mise" | "pnpm" | "npm";
export const methodTool: Record<Method, string> = { mise: "mise", pnpm: "pnpm", npm: "npm" };

export function npmPrefix(install: Install): string {
  return install.kind === "npm" ? install.prefix : "";
}

/** The update command: scripts of the new package never run (`--ignore-scripts`). */
export function updateArgs(install: Install): string[] {
  if (install.kind === "npm")
    return ["install", "--global", "--prefix", install.prefix, "--ignore-scripts", `${updatePackage}@latest`];
  if (install.kind === "pnpm")
    return ["add", "--global", "--ignore-scripts", "--ignore-pnpmfile", `${updatePackage}@latest`];
  return ["upgrade", "--bump", `npm:${updatePackage}`];
}

/** The command that prints where the new package lives. */
export function locateArgs(install: Install): string[] {
  if (install.kind === "pnpm") return ["list", "--global", "--json", "--depth", "0", "--config.ignore-pnpmfile=true"];
  return ["where", `npm:${updatePackage}`];
}

/** The command that installs the old version again. */
export function restoreArgs(install: Install, version: string): string[] {
  if (install.kind === "npm")
    return ["install", "--global", "--prefix", install.prefix, "--ignore-scripts", `${updatePackage}@${version}`];
  if (install.kind === "pnpm")
    return ["add", "--global", "--ignore-scripts", "--ignore-pnpmfile", `${updatePackage}@${version}`];
  return ["use", "--global", `npm:${updatePackage}@${version}`];
}
