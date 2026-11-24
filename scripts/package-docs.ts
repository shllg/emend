import { constants, copyFileSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const names = ["README.md", "LICENSE"];

function matchingCopy(root: string, name: string): boolean {
  const target = join(root, "apps/recense", name);
  return (
    Boolean(lstatSync(target, { throwIfNoEntry: false })?.isFile()) &&
    readFileSync(target).equals(readFileSync(join(root, name)))
  );
}

export function cleanPackageDocs(root: string): void {
  for (const name of names) {
    if (matchingCopy(root, name)) rmSync(join(root, "apps/recense", name));
  }
}

export function preparePackageDocs(root: string): void {
  const copied: string[] = [];
  try {
    for (const name of names) {
      const target = join(root, "apps/recense", name);
      if (lstatSync(target, { throwIfNoEntry: false })) {
        if (!matchingCopy(root, name)) {
          throw new Error(`package-docs: apps/recense/${name} differs from the root ${name}; remove it`);
        }
        rmSync(target);
      }
      copyFileSync(join(root, name), target, constants.COPYFILE_EXCL);
      copied.push(name);
    }
  } catch (error) {
    for (const name of copied) {
      if (matchingCopy(root, name)) rmSync(join(root, "apps/recense", name));
    }
    throw error;
  }
}

export function requirePnpmPacking(userAgent: string | undefined): void {
  if (!userAgent?.startsWith("pnpm/")) {
    throw new Error(
      "package-docs: pack @shllg/recense with pnpm (pnpm pack or pnpm publish); npm would publish its private workspace devDependencies.",
    );
  }
}

// Only pnpm packs this package: its root pnpmfile strips devDependencies.
// These prepack/postpack document copies are never committed.
if (import.meta.main) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  try {
    if (process.argv[2] === "prepare") {
      requirePnpmPacking(process.env.npm_config_user_agent);
      preparePackageDocs(root);
    } else if (process.argv[2] === "clean") cleanPackageDocs(root);
    else throw new Error("Usage: node scripts/package-docs.ts prepare|clean");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
