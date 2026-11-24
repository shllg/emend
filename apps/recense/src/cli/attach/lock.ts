import { closeSync, existsSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureStateDir, StateFolderWriteError, stateAccessError } from "../../state/files.ts";
import { escapeReference } from "../escape.ts";
import { CliError } from "../http.ts";

export function lockAttach(stateDir: string): () => void {
  ensureStateDir(stateDir);
  const path = resolve(stateDir, "attach.lock");
  let db: DatabaseSync | undefined;
  try {
    // SQLite gives its journal the database file's permissions. Never unlink
    // this file: every copier must lock the same inode, including after a crash.
    // Opening and closing an existing file outside SQLite could drop another
    // connection's POSIX locks in this process.
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    db = new DatabaseSync(path, { timeout: 0 });
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    try {
      db?.close();
    } catch {}
    const mapped = stateAccessError(stateDir, error);
    if (mapped instanceof StateFolderWriteError) throw mapped;
    if (error instanceof Error && "errcode" in error && error.errcode === 5)
      throw new CliError("another recense attach is running. Nothing was changed.");
    throw new CliError(
      `could not use the lock file ${escapeReference(path)}. If no recense attach or detach is running, including one started with sudo, remove that file and try again.`,
    );
  }
  const held = db;
  return () => {
    try {
      held.exec("ROLLBACK");
    } catch {
      // Closing still releases the lock; preserve the command's own result.
    } finally {
      try {
        held.close();
      } catch {}
    }
  };
}
