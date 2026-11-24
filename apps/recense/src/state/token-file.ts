import { constants } from "node:fs";
import { type FileHandle, lstat, open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isStateModeError, StateDirModeError, stateFileError, TokenFileModeError } from "./files.ts";

type TokenFileOptions = { tighten?: boolean };

async function withTokenFile<T>(
  path: string,
  { tighten = false }: TokenFileOptions,
  use: (file: FileHandle) => Promise<T>,
): Promise<T | null> {
  try {
    if (!tighten) {
      const dir = resolve(dirname(path));
      if ((await stat(dir)).mode & 0o077) throw new StateDirModeError(dir);
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Token file must be a regular file.");
    if (!tighten && info.mode & 0o077) throw new TokenFileModeError(resolve(path));
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat();
      if (!opened.isFile()) throw new Error("Token file must be a regular file.");
      if (tighten) await file.chmod(0o600);
      else if (opened.mode & 0o077) throw new TokenFileModeError(resolve(path));
      return await use(file);
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw stateFileError(path, error);
  }
}

export async function readTokenFile(path: string, options: TokenFileOptions = {}): Promise<string | null> {
  return withTokenFile(path, options, async (file) => (await file.readFile("utf8")).replace(/[\r\n]+$/, ""));
}

/** Refuse unsafe credentials before a command creates locks or writes service files. */
export async function checkTokenFileMode(path: string): Promise<void> {
  try {
    await withTokenFile(path, {}, async () => {});
  } catch (error) {
    if (isStateModeError(error)) throw error;
    // Leave other failures to the command's credential or recovery path.
  }
}
