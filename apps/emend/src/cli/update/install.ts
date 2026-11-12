import { lstat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

export const updatePackage = "@shllg/emend";
export const updateDoc = "https://github.com/shllg/emend/blob/release/docs/setup/update.md";

export type Install =
  | { kind: "mise" }
  | { kind: "pnpm" }
  | { kind: "npm"; prefix: string }
  | { kind: "local"; where: "mise-link" | "checkout"; root?: string }
  | { kind: "unknown" };

const packageTail = ["node_modules", "@shllg", "emend", "dist", "emend.mjs"];

function endsWith(segments: string[], tail: string[]): boolean {
  return (
    segments.length >= tail.length &&
    tail.every((part, index) => segments[segments.length - tail.length + index] === part)
  );
}

function packageCopies(segments: string[]): number {
  return segments.filter((part, index) => part === "@shllg" && segments[index + 1] === "emend").length;
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

/**
 * Tell how emend was installed from the real path of its entry file. Compares whole path
 * segments, never substrings, so a look-alike folder or file name matches nothing.
 */
export async function detectInstall(
  realEntry: string,
  findCheckout: (realEntry: string) => Promise<string | undefined> = checkoutRoot,
): Promise<Install> {
  if (!realEntry.startsWith(sep)) return { kind: "unknown" };
  const segments = realEntry.split(sep).filter(Boolean);
  const copies = packageCopies(segments);
  const modules = segments.filter((part) => part === "node_modules").length;
  const installs = segments.findIndex(
    (part, index) =>
      part === "installs" &&
      segments[index + 1] === "npm-shllg-emend" &&
      Boolean(segments[index + 2]) &&
      !["lib", "node_modules"].includes(segments[index + 2] as string),
  );
  if (installs !== -1 && copies === 1) {
    const rest = segments.slice(installs + 3);
    if (
      (endsWith(rest, ["lib", ...packageTail]) && rest.length === packageTail.length + 1) ||
      (endsWith(rest, packageTail) && rest.length === packageTail.length)
    )
      return { kind: "mise" };
  }
  if (segments.includes("linked-installs")) return { kind: "local", where: "mise-link" };
  if (modules === 0) {
    const root = await findCheckout(realEntry);
    if (root !== undefined) return { kind: "local", where: "checkout", root };
    return { kind: "unknown" };
  }
  if (copies !== 1 || !endsWith(segments, packageTail)) return { kind: "unknown" };
  if (segments.includes(".pnpm") || segments.includes("pnpm")) return { kind: "pnpm" };
  const lead = segments.slice(0, segments.length - packageTail.length);
  const foreign = ["installs", "linked-installs", "npm-shllg-emend", ".pnpm", "pnpm"];
  if (lead[lead.length - 1] === "lib" && modules === 1 && !lead.some((part) => foreign.includes(part))) {
    return { kind: "npm", prefix: sep + lead.slice(0, -1).join(sep) };
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
  if (install.kind === "pnpm") return ["add", "--global", "--ignore-scripts", `${updatePackage}@latest`];
  return ["upgrade", "--bump", `npm:${updatePackage}`];
}

/** The command that prints where the new package lives. */
export function locateArgs(install: Install): string[] {
  if (install.kind === "pnpm") return ["root", "--global"];
  return ["where", `npm:${updatePackage}`];
}

/** The command that installs the old version again. */
export function restoreArgs(install: Install, version: string): string[] {
  if (install.kind === "npm") return ["install", "--global", "--prefix", install.prefix, `${updatePackage}@${version}`];
  if (install.kind === "pnpm") return ["add", "--global", `${updatePackage}@${version}`];
  return ["use", "--global", `npm:${updatePackage}@${version}`];
}
