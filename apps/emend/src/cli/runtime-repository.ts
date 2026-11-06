import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isWorktreeRoot } from "./publish/root.ts";
import type { CliRuntime } from "./runtime.ts";

function contains(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function hasRepository(directory: string): Promise<boolean> {
  try {
    const git = join(directory, ".git");
    const entry = await lstat(git);
    if (!entry.isDirectory()) return isWorktreeRoot(directory);
    try {
      await lstat(join(git, "HEAD"));
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

export async function repositoryRoots(cwd: string, home = homedir()): Promise<string[]> {
  const roots: string[] = [];
  const homePath = isAbsolute(home)
    ? await realpath(home).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        return null;
      })
    : null;
  let directory = await realpath(cwd);
  for (;;) {
    if (directory !== homePath && (await hasRepository(directory))) roots.push(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return roots;
}

export function pathInRepository(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => contains(root, path));
}

export async function runtimeInRepository(runtime: CliRuntime, cwd: string, home = homedir()): Promise<string | null> {
  const roots = await repositoryRoots(cwd, home);
  if (roots.length === 0) return null;
  const paths = await Promise.all([realpath(runtime.node), realpath(runtime.entry)]);
  return paths.find((path) => pathInRepository(path, roots)) ?? null;
}
