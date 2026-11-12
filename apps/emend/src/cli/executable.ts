import { constants } from "node:fs";
import { access, lstat, readlink, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, parse, sep } from "node:path";
import { CliError } from "./http.ts";
import { pathInRepository, repositoryRoots } from "./runtime-repository.ts";

export async function pathThroughRepository(
  absolutePath: string,
  roots: readonly string[],
  { allowMissingLeaf = false } = {},
): Promise<boolean> {
  let parent = parse(absolutePath).root;
  if (pathInRepository(parent, roots)) return true;
  let pending = absolutePath.slice(parent.length).split(sep).filter(Boolean);
  // The whole-walk limit is stricter than the kernel limit per resolution and fails closed.
  let links = 0;
  while (pending.length) {
    const component = pending.shift() as string;
    const path = join(parent, component);
    // Follow each link separately: realpath skips intermediate repository paths.
    if (pathInRepository(path, roots)) return true;
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      // A missing final target is safe only after checking every parent and repository boundary.
      if (allowMissingLeaf && pending.length === 0 && error.code === "ENOENT") return null;
      throw error;
    });
    if (info === null) return false;
    if (info.isSymbolicLink()) {
      if (++links > 40) throw new Error("Too many symbolic links in helper path");
      const target = await readlink(path);
      if (isAbsolute(target)) parent = parse(target).root;
      pending = target.split(sep).filter(Boolean).concat(pending);
    } else {
      parent = await realpath(path);
      if (pathInRepository(parent, roots)) return true;
    }
  }
  return false;
}

/** Absent names are harmless; existing names must pass the same hop walk as a helper. */
async function executableInRepository(file: string, roots: readonly string[]): Promise<boolean | null> {
  try {
    await lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  return pathThroughRepository(file, roots, { allowMissingLeaf: true });
}

/** Keep absolute entries without dot components, preserving their original spelling. */
function absoluteEntries(searchPath: string): string[] {
  return searchPath.split(delimiter).filter((entry) => {
    if (!isAbsolute(entry)) return false;
    const tail = entry.slice(parse(entry).root.length);
    return tail === "" || tail.split(sep).every((part) => part !== "." && part !== "..");
  });
}

/** Filter names that children may resolve themselves, such as an env shebang's node. */
export async function filterExecutablePath(
  names: readonly string[],
  searchPath: string,
  roots: readonly string[],
): Promise<string> {
  const trusted: string[] = [];
  for (const entry of absoluteEntries(searchPath)) {
    try {
      if (await pathThroughRepository(entry, roots)) continue;
      let safe = true;
      for (const name of names) {
        if (await executableInRepository(join(entry, name), roots)) {
          safe = false;
          break;
        }
      }
      if (safe) trusted.push(entry);
    } catch {
      // Uncheckable names must not remain on a child's PATH.
    }
  }
  return trusted.join(delimiter);
}

export async function findExecutable(
  name: string,
  searchPath = process.env.PATH ?? "",
  options: { cwd?: string; home?: string } = {},
) {
  const entries = absoluteEntries(searchPath);
  let roots: string[];
  try {
    roots = await repositoryRoots(options.cwd ?? process.cwd(), options.home);
  } catch {
    throw new CliError(`Could not check where ${name} on PATH runs; emend does not run it.`);
  }
  const safe: string[] = [];
  let skipped = false;
  for (const entry of entries) {
    try {
      if (await pathThroughRepository(entry, roots)) {
        try {
          if ((await stat(join(entry, name))).isFile()) {
            await access(join(entry, name), constants.X_OK);
            skipped = true;
          }
        } catch {
          // An absent or inaccessible candidate is not a match.
        }
      } else safe.push(entry);
    } catch {
      // An unresolved PATH directory cannot supply a trusted helper.
    }
  }
  const trusted: string[] = [];
  let found: string | undefined;
  for (const entry of safe) {
    const file = join(entry, name);
    try {
      const inRepository = await executableInRepository(file, roots);
      if (inRepository === null) {
        trusted.push(entry);
        continue;
      }
      if (inRepository) {
        skipped = true;
        continue;
      }
    } catch {
      // An unresolved executable must not remain on the child PATH.
      continue;
    }
    try {
      if ((await stat(file)).isFile()) {
        await access(file, constants.X_OK);
        found ??= file;
      }
    } catch {
      /* Try the next absolute PATH entry. */
    }
    trusted.push(entry);
  }
  if (found) return { file: found, path: trusted.join(delimiter) };
  if (skipped) throw new CliError(`${name} on PATH sits inside the current repository; emend does not run it.`);
  throw new CliError(`${name} was not found on PATH`);
}
