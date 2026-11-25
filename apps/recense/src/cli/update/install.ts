import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";

import { readRegular } from "../publish/read.ts";
import { isInstalledManifest } from "./manifest.ts";

export const updatePackage = "@shllg/recense";
export const updateDoc = "https://github.com/shllg/recense/blob/release/docs/setup/update.md";

export type Install =
  | { kind: "mise" }
  | { kind: "pnpm" }
  | { kind: "npm"; prefix: string }
  | { kind: "local"; where: "mise-link" | "checkout" | "marked"; root?: string }
  | { kind: "unknown" };

const packageTail = ["node_modules", "@shllg", "recense", "dist", "recense.mjs"];
const listLimit = 64;

function endsWith(segments: string[], tail: string[]): boolean {
  return (
    segments.length >= tail.length &&
    tail.every((part, index) => segments[segments.length - tail.length + index] === part)
  );
}

async function listedNames(folder: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const { name } of await opendir(folder)) {
      if (names.length === listLimit) return [];
      names.push(name);
    }
  } catch {
    return [];
  }
  return names.sort();
}

/**
 * npm puts node_modules under lib, while bun and embedded aube put it at the install root.
 * pnpm uses a numeric folder or v<digits>/<hash>, and aube CLI uses global-aube/<id>.
 */
export async function misePackageFolders(installFolder: string): Promise<string[]> {
  const roots = [join(installFolder, "lib"), installFolder];
  const names = await listedNames(installFolder);
  for (const name of names) {
    if (/^\d+$/.test(name)) roots.push(join(installFolder, name));
  }
  for (const name of [...names.filter((name) => /^v\d+$/.test(name)), "global-aube"]) {
    const parent = join(installFolder, name);
    for (const child of await listedNames(parent)) {
      if (!child.startsWith(".") && child !== "node_modules") roots.push(join(parent, child));
    }
  }
  const folders: string[] = [];
  for (const root of roots) {
    const candidate = join(root, "node_modules", updatePackage);
    try {
      if ((await stat(candidate)).isDirectory()) folders.push(candidate);
    } catch {
      // No package directory at this path.
    }
  }
  return folders;
}

async function realMiseFolder(candidate: string): Promise<string | undefined> {
  try {
    return await realpath(candidate);
  } catch {
    return undefined;
  }
}

export async function locateMisePackage(installFolder: string): Promise<string | undefined> {
  let first: { path: string; real: string } | undefined;
  for (const path of await misePackageFolders(installFolder)) {
    const real = await realMiseFolder(path);
    if (real === undefined) continue;
    if (first && first.real !== real) return undefined;
    first ??= { path, real };
  }
  return first?.path;
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
    if (!endsWith(realEntry.split(sep), ["dist", "recense.mjs"])) return { kind: "unknown" };
    folder = await realpath(dirname(dirname(realEntry)));
    manifest = JSON.parse((await readRegular(join(folder, "package.json"), 64 * 1024)).toString("utf8"));
    if (!isInstalledManifest(manifest)) return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
  if (manifest.recenseLocalBuild !== undefined) return { kind: "local", where: "marked" };
  const segments = realEntry.split(sep).filter(Boolean);
  const modules = segments.filter((part) => part === "node_modules").length;
  if (segments.includes("linked-installs")) return { kind: "local", where: "mise-link" };
  const installs = segments.findIndex(
    (part, index) => part === "installs" && segments[index + 1] === "npm-shllg-recense",
  );
  if (installs !== -1) {
    const version = segments[installs + 2];
    if (!version || version.startsWith(".") || ["lib", "node_modules"].includes(version)) return { kind: "unknown" };
    if (!endsWith(segments, packageTail)) return { kind: "unknown" };
    const installFolder = sep + segments.slice(0, installs + 3).join(sep);
    for (const candidate of await misePackageFolders(installFolder)) {
      if ((await realMiseFolder(candidate)) === folder) return { kind: "mise" };
    }
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
  if (lead.at(-1) === "lib" && modules === 1 && !lead.includes("npm-shllg-recense")) {
    const prefix = sep + lead.slice(0, -1).join(sep);
    try {
      if ((await realpath(join(prefix, "bin/recense"))) === join(folder, "bin/recense")) return { kind: "npm", prefix };
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
