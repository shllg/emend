import { isAbsolute } from "node:path";
import { assertOutputFolder, assertTempParent, inside } from "../screenshots/safety.ts";

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
  assertOutputFolder(folder, states, canonicalize);
  const path = canonicalize(folder),
    repo = canonicalize(checkout);
  if (!inside(canonicalize(tmp), path)) throw new Error("Ref folder must be inside the real temporary directory");
  if (path === repo || inside(repo, path) || inside(path, repo)) throw new Error("Ref folder overlaps the checkout");
}
export { assertOutputFolder } from "../screenshots/safety.ts";
