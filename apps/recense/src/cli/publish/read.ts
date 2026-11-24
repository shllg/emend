import { constants, type Stats } from "node:fs";
import { lstat, open, stat as pathStat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { stateFileError } from "../../state/files.ts";
import { CliError } from "../error.ts";
import { escapeReference } from "../escape.ts";

export class OversizedFile extends CliError {
  constructor() {
    super("file exceeds its size limit");
  }
}
export class NotRegularFile extends CliError {
  constructor() {
    super("expected a regular file");
  }
}
export const inside = (root: string, file: string) => {
  const path = relative(root, file);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
};
export interface PublishedFolder {
  root: string;
  argument: string;
}
export class PublishedFolderEscape extends CliError {
  constructor(argument: string) {
    super(`symlink leaves the published folder: ${escapeReference(argument)}`);
  }
}
export function checkPublishedFolders(file: string, folders: readonly PublishedFolder[] = []): void {
  for (const folder of folders) if (!inside(folder.root, file)) throw new PublishedFolderEscape(folder.argument);
}
const nativeFs = { lstat, open, realpath, stat: pathStat, platform: process.platform };
export class GitFolderRead extends CliError {
  constructor(file: string) {
    super(`refusing to read inside the git folder: ${escapeReference(file)}`);
  }
}
export function outsideGitSegments(file: string, root: string) {
  for (const segment of relative(root, file).split(sep)) {
    const normalized = segment
      .replace(/[\u206a-\u206f]/gu, "")
      .toLowerCase()
      .replace(/[. ]+$/, "");
    if ([".git", "git~1"].includes(normalized)) throw new GitFolderRead(file);
  }
}
export function outsideGit(file: string, gitDirs: string[], roots: string[] = []) {
  if (gitDirs.some((folder) => inside(folder, file))) throw new GitFolderRead(file);
  const root = roots.find((root) => inside(root, file));
  if (root) outsideGitSegments(file, root);
}
/** Git never follows a symlink in a leading path component, even inside the worktree. */
export async function leadingFolders(root: string, file: string): Promise<boolean> {
  if (!inside(root, file)) return false;
  let folder = root;
  for (const part of relative(root, dirname(file)).split(sep).filter(Boolean)) {
    folder = join(folder, part);
    try {
      if (!(await lstat(folder)).isDirectory()) return false;
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  }
  return true;
}
export async function sourcePath(
  file: string,
  roots: string[],
  gitDirs: string[],
  folders: readonly PublishedFolder[] = [],
): Promise<string> {
  const actual = await realpath(file);
  checkPublishedFolders(actual, folders);
  outsideGit(actual, gitDirs, roots);
  if (!roots.some((root) => inside(root, actual))) throw new CliError("source is outside the allowed doc roots");
  const root = roots.find((root) => inside(root, file));
  if (root && !(await leadingFolders(root, file))) throw new CliError("source is behind a symlink or non-folder");
  return actual;
}
export async function readRegular(
  file: string,
  limit: number,
  roots?: string[],
  fs = nativeFs,
  gitDirs: string[] = [],
  check?: (info: Stats, actual: string) => void | Promise<void>,
): Promise<Buffer> {
  outsideGit(await fs.realpath(file), gitDirs, roots);
  const root = roots?.find((root) => inside(root, file));
  if (root && !(await leadingFolders(root, file))) throw new CliError("source is behind a symlink or non-folder");
  const info = await fs.lstat(file);
  if (!info.isFile()) throw new NotRegularFile();
  if (info.size > limit) throw new OversizedFile();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== info.dev || stat.ino !== info.ino)
      throw new CliError("file changed while reading");
    if (stat.size > limit) throw new OversizedFile();
    // On Linux check the opened descriptor, including directory symlink swaps, before reading.
    const actual = await fs.realpath(file);
    await check?.(stat, actual);
    outsideGit(actual, gitDirs, roots);
    if (root && !(await leadingFolders(root, file))) throw new CliError("file changed while reading");
    const resolved = await fs.stat(actual);
    if (resolved.dev !== stat.dev || resolved.ino !== stat.ino) throw new CliError("file changed while reading");
    if (fs.platform === "linux" && (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== actual)
      throw new CliError("file changed while reading");
    if (roots && !roots.some((root) => inside(root, actual)))
      throw new CliError("source is outside the allowed doc roots");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new CliError("file changed while reading");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new CliError("file changed while reading");
    return bytes;
  } catch (error) {
    throw stateFileError(file, error);
  } finally {
    await handle.close().catch((error: unknown) => {
      throw stateFileError(file, error);
    });
  }
}
