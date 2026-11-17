import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertOutputFolder, assertTempParent, inside } from "../screenshots/safety.ts";

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
  tmp: string,
  states: readonly string[],
  canonicalize: (path: string) => string,
): void {
  if (![folder, checkout, tmp].every(isAbsolute)) throw new Error("Ref paths must be absolute");
  assertTempParent(tmp, states, canonicalize);
  assertOutputFolder(folder, states, canonicalize, "ref");
  const path = canonicalize(folder),
    repo = canonicalize(checkout);
  if (!inside(canonicalize(tmp), path)) throw new Error("Ref folder must be inside the real temporary directory");
  if (path === repo || inside(repo, path) || inside(path, repo)) throw new Error("Ref folder overlaps the checkout");
}
export { assertOutputFolder } from "../screenshots/safety.ts";
