import { constants } from "node:fs";
import { open, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { ensurePrivateDir, syncDirectory } from "../../state/files.ts";
import { CliError } from "../http.ts";

export const keptBackups = 3;
const backupName = /^emend-[0-9A-Za-z.+-]{1,64}-(\d{8}T\d{9}Z)\.db$/;

export function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "");
}

export async function databaseExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Copy `emend.db` into `<state>/backups`. The copy comes from a read-only connection, so it works
 * while the server runs and includes the write-ahead log. A failure leaves no partial file.
 */
export async function backupDatabase(stateDir: string, version: string, now: Date): Promise<string> {
  const folder = join(stateDir, "backups");
  const target = join(folder, `emend-${version}-${backupStamp(now)}.db`);
  const partial = `${target}.partial`;
  let created = false;
  try {
    const folderExisted = await stat(folder).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    ensurePrivateDir(folder, stateDir);
    const file = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    await file.close();
    const source = new DatabaseSync(join(stateDir, "emend.db"), { readOnly: true });
    try {
      await backup(source, partial);
    } finally {
      source.close();
    }
    const written = await open(partial, "r+");
    try {
      await written.sync();
    } finally {
      await written.close();
    }
    await rename(partial, target);
    syncDirectory(folder);
    if (!folderExisted) syncDirectory(stateDir);
    return target;
  } catch {
    if (created) await unlink(partial).catch(() => {});
    throw new CliError("could not back up the database; nothing was changed.");
  }
}

/** Keep this run's backup even when the clock went backward, then the newest older backups. */
export async function pruneBackups(stateDir: string, current?: string, keep = keptBackups): Promise<void> {
  const folder = join(stateDir, "backups");
  const found = (await readdir(folder))
    .map((name) => ({ name, stamp: backupName.exec(name)?.[1] }))
    .filter((entry): entry is { name: string; stamp: string } => entry.stamp !== undefined)
    .sort((a, b) => (a.stamp === b.stamp ? b.name.localeCompare(a.name) : b.stamp.localeCompare(a.stamp)));
  const older = found.filter((entry) => entry.name !== (current === undefined ? undefined : basename(current)));
  for (const entry of older.slice(current === undefined ? keep : keep - 1)) await unlink(join(folder, entry.name));
}
