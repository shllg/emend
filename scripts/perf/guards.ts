import { lstatSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { assertOutputFolder, inside } from "../screenshots/safety.ts";

export function refParent(
  parent: Record<string, string | undefined> = process.env,
  parentHome = homedir(),
): string {
  return join(parent.XDG_CACHE_HOME || join(parentHome, ".cache"), "emend-perf");
}

/** Node can resolve modules from node_modules in any ancestor of the export. */
export function assertPrivateAncestors(
  folder: string,
  uid: number,
  stat: (path: string) => Pick<Stats, "isDirectory" | "isSymbolicLink" | "uid" | "mode"> = lstatSync,
): void {
  if (!isAbsolute(folder)) throw new Error("The ref folder must be absolute");
  for (let path = folder; ; path = dirname(path)) {
    const entry = stat(path);
    let reason: string | undefined;
    if (entry.isSymbolicLink()) reason = "is a symbolic link";
    else if (!entry.isDirectory()) reason = "is not a directory";
    else if (entry.uid !== uid && entry.uid !== 0) reason = "is owned by another user";
    else if ((entry.mode & 0o022) !== 0) reason = "is writable by group or others";
    if (reason)
      throw new Error(`The ref folder's parent ${path} ${reason}; Node would load modules from its node_modules`);
    if (dirname(path) === path) return;
  }
}

/** Prevent pnpm from finding a workspace in an ancestor of a ref export. */
export function assertWorkspaceRoot(folder: string): void {
  for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
    let regular = false;
    try {
      regular = lstatSync(join(folder, file)).isFile();
    } catch {
      // A missing or unreadable entry cannot establish the export's workspace root.
    }
    if (!regular) throw new Error(`The ref has no pnpm workspace root of its own: ${file} is missing or not a regular file`);
  }
}

// Output intentionally lives in .wt/perf; only ref exports must be outside the checkout.
export function assertRefFolder(
  folder: string,
  checkout: string,
  parent: string,
  states: readonly string[],
  canonicalize: (path: string) => string,
): void {
  if (!isAbsolute(parent)) throw new Error("The ref parent folder must be absolute");
  if (![folder, checkout].every(isAbsolute)) throw new Error("Ref paths must be absolute");
  assertOutputFolder(parent, states, canonicalize, "ref parent");
  assertOutputFolder(folder, states, canonicalize, "ref");
  const path = canonicalize(folder),
    repo = canonicalize(checkout);
  if (!inside(canonicalize(parent), path)) throw new Error("Ref folder must be inside the ref parent folder");
  if (path === repo || inside(repo, path) || inside(path, repo)) throw new Error("Ref folder overlaps the checkout");
}
export { assertOutputFolder } from "../screenshots/safety.ts";
