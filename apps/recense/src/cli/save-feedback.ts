import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, link, lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { stateAccessError } from "../state/files.ts";
import { escapeReference } from "./escape.ts";
import { CliError, CliSignalExit, CliUsageError } from "./http.ts";

export type CheckedFolder = { path: string; handle: FileHandle; identity: Stats };
export type SavedFeedback = { path: string; identity: Stats };
const sameIdentity = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino;
const changedFolder = () =>
  new CliError("The save folder changed while recense was writing to it; nothing was confirmed.");

export async function assertSaveFolder(folder: CheckedFolder): Promise<void> {
  try {
    const current = await lstat(folder.path);
    if (!current.isDirectory() || !sameIdentity(current, folder.identity)) throw changedFolder();
  } catch {
    throw changedFolder();
  }
}

export async function checkSaveFolder(folder: string, stateDir?: string): Promise<CheckedFolder> {
  const path = resolve(folder);
  const fail = (reason: string) => new CliError(`Cannot save feedback in ${escapeReference(folder)}: ${reason}.`);
  let handle: FileHandle;
  try {
    handle = await open(path, (constants.O_RDONLY ?? 0) | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw fail(
      code === "ENOENT"
        ? "folder does not exist"
        : code === "ELOOP"
          ? "folder is a symlink"
          : code === "ENOTDIR"
            ? "not a directory"
            : "cannot read folder",
    );
  }
  try {
    const identity = await handle.stat();
    if (!identity.isDirectory()) throw fail("not a directory");
    // Without getuid (Windows) there is no owner check; macOS ACLs can grant access even with mode 0700.
    if (process.getuid && identity.uid !== process.getuid()) throw fail("folder is not owned by the current user");
    if (identity.mode & 0o077) throw fail("folder has group or other permissions");
    const checked = { path, handle, identity };
    await assertSaveFolder(checked);
    const actual = await realpath(path);
    await assertSaveFolder({ ...checked, path: actual });
    if (stateDir) {
      let statePath: string | undefined;
      try {
        statePath = await realpath(stateDir);
      } catch (error) {
        // An existing save folder cannot be inside a state folder that does not exist.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw stateAccessError(stateDir, error);
      }
      if (statePath) {
        const suffix = relative(statePath, actual);
        if (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
          throw new CliUsageError("--save cannot point into recense's state folder.");
      }
    }
    return checked;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function verifySavedFeedback(folder: CheckedFolder, saved: SavedFeedback): Promise<void> {
  await assertSaveFolder(folder);
  try {
    const current = await lstat(saved.path);
    if (!current.isFile() || !sameIdentity(current, saved.identity)) throw changedFolder();
  } catch {
    throw changedFolder();
  }
}

/** Cleanup skips detected replacements and never hides the original failure. */
export async function cleanupFeedback(folder: CheckedFolder, path: string, identity?: Stats): Promise<void> {
  try {
    await assertSaveFolder(folder);
    if (identity && !sameIdentity(await lstat(path), identity)) return;
    await unlink(path);
  } catch {}
}

const timestamp = (time: number) => new Date(time).toISOString().replace(/[-:.]/g, "");

// Identity checks prevent wrong content from being printed or confirmed. Without openat, a same-user
// racer can still make recense create or remove its own wait-* names in another folder between checks.
export async function saveFeedback(folder: CheckedFolder, json: string, signal: AbortSignal): Promise<SavedFeedback> {
  let temporary: string | undefined;
  let file: FileHandle | undefined;
  let identity: Stats | undefined;
  let saved: SavedFeedback | undefined;
  try {
    await assertSaveFolder(folder);
    signal.throwIfAborted();
    let time = Date.now();
    const path = join(folder.path, `.wait-${timestamp(time)}-${randomUUID()}.partial`);
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporary = path;
    await assertSaveFolder(folder);
    await file.chmod(0o600);
    await file.writeFile(json);
    await file.sync();
    identity = await file.stat();
    for (;;) {
      signal.throwIfAborted();
      await assertSaveFolder(folder);
      const final = join(folder.path, `wait-${timestamp(time)}.json`);
      try {
        await link(temporary, final);
        saved = { path: final, identity };
        saved.identity = await file.stat();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        time++;
      }
    }
    await verifySavedFeedback(folder, saved);
    await folder.handle.sync();
    await assertSaveFolder(folder);
    await unlink(temporary);
    temporary = undefined;
    await verifySavedFeedback(folder, saved);
    signal.throwIfAborted();
    return saved;
  } catch (error) {
    if (saved) await cleanupFeedback(folder, saved.path, saved.identity);
    if (error instanceof CliError || error instanceof CliSignalExit) throw error;
    throw new CliError(`Could not save feedback in ${escapeReference(folder.path)}.`);
  } finally {
    if (temporary) await cleanupFeedback(folder, temporary, identity);
    await file?.close().catch(() => {});
  }
}
