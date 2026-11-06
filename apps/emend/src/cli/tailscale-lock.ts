import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StateFolderWriteError, stateAccessError } from "../state/files.ts";
import { escapeReference } from "./escape.ts";
import { CliError } from "./http.ts";

export interface TailscaleLockOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}
const retryMs = 50;

/**
 * Serializes every Tailscale Serve route change between emend processes. Waiting is
 * asynchronous, so the event loop keeps running while another emend holds the lock.
 */
export async function lockTailscaleServe(
  stateDir: string,
  {
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    timeoutMs = 15_000,
  } = {},
): Promise<() => void> {
  const path = resolve(stateDir, "tailscale-serve.lock");
  const deadline = now() + timeoutMs;
  for (;;) {
    let db: DatabaseSync | undefined;
    try {
      // Serve creates the state folder; the lock must not create it. Never unlink
      // the file: every process must lock the same inode, including after a crash.
      try {
        statSync(stateDir);
      } catch (error) {
        // Without a state folder there is no marker and no other emend to exclude.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return () => {};
        throw error;
      }
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
      if (!(error instanceof Error && "errcode" in error && error.errcode === 5))
        throw new CliError(
          `could not use the lock file ${escapeReference(path)}. If no emend server or emend stop is running, including one started with sudo, remove that file and try again.`,
        );
      const left = deadline - now();
      if (left <= 0) throw new CliError("another emend is changing the Tailscale Serve route; try again.");
      await sleep(Math.min(retryMs, left));
      continue;
    }
    const held = db;
    return () => {
      try {
        held.exec("ROLLBACK");
      } catch {
        // Closing still releases the lock; preserve the caller's own result.
      } finally {
        try {
          held.close();
        } catch {}
      }
    };
  }
}
