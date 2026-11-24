import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CliError } from "../http.ts";
import { inside, leadingFolders, outsideGit } from "./read.ts";

const statFs = { lstat, realpath, leadingFolders };
export async function statWorktree(
  root: string,
  path: string,
  gitDirs = [join(root, ".git")],
  fs = statFs,
): Promise<Stats | null> {
  const file = join(root, path);
  try {
    if (!(await fs.leadingFolders(root, file))) return null;
    const info = await fs.lstat(file);
    outsideGit(await fs.realpath(info.isSymbolicLink() ? dirname(file) : file), gitDirs, [root]);
    if (!inside(root, await fs.realpath(dirname(file)))) throw new CliError("diff path leaves the worktree");
    return info;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

const nativeFs = { open, realpath, stat, platform: process.platform };
/** Hash raw disk bytes; autocrlf/eol normalization is deliberately absent. */
export async function hashWorktreeFile(
  root: string,
  path: string,
  info: Stats,
  format: "sha1" | "sha256",
  fs = nativeFs,
  gitDirs = [join(root, ".git")],
): Promise<string> {
  const file = join(root, path);
  if (!(await leadingFolders(root, file))) throw new CliError("file changed while reading");
  outsideGit(await fs.realpath(file), gitDirs, [root]);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
      throw new CliError("file changed while reading");
    // Match readRegular's portable identity check and Linux descriptor check before
    // reading, including when a hostile parent symlink is swapped and restored.
    const actual = await fs.realpath(file);
    outsideGit(actual, gitDirs, [root]);
    if (!(await leadingFolders(root, file))) throw new CliError("file changed while reading");
    const resolved = await fs.stat(actual);
    if (resolved.dev !== opened.dev || resolved.ino !== opened.ino) throw new CliError("file changed while reading");
    if (fs.platform === "linux" && (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== actual)
      throw new CliError("file changed while reading");
    if (!inside(root, actual)) throw new CliError("diff path leaves the worktree");
    const hash = createHash(format).update(`blob ${opened.size}\0`);
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
      if (!bytesRead) throw new CliError("file changed while reading");
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if ((await handle.read(chunk, 0, 1, offset)).bytesRead) throw new CliError("file changed while reading");
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
      throw new CliError("file changed while reading");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
