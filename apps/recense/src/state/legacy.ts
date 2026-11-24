import { lstatSync, readFileSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { homeOverride, namedConfigDir, namedStateDir } from "./paths.ts";

type Env = Record<string, string | undefined>;

/** The state folder of a server from before the rename is still in use; nothing was moved. */
export class LegacyStateInUseError extends Error {
  readonly folder: string;
  readonly pid: number;
  constructor(folder: string, pid: number) {
    super(
      `the emend server (process ${pid}) still uses ${folder}. Stop it first (emend stop, or stop the emend service), then run recense again. Nothing was moved.`,
    );
    this.folder = folder;
    this.pid = pid;
  }
}

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The pid the legacy folder's `server.json` names, or undefined when it names none. */
function recordedPid(folder: string): number | undefined {
  try {
    const record: unknown = JSON.parse(readFileSync(join(folder, "server.json"), "utf8"));
    if (record && typeof record === "object" && "pid" in record && typeof record.pid === "number") {
      return Number.isSafeInteger(record.pid) && record.pid > 0 ? record.pid : undefined;
    }
  } catch {
    // A missing or unreadable record names no process.
  }
  return undefined;
}

const insideTemporary = (path: string) => {
  const suffix = relative(tmpdir(), path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

/**
 * Moves the state and config folders of the name before the rename to the current names, once.
 *
 * The state folder moves only when neither RECENSE_HOME nor EMEND_HOME picks it. Each folder moves
 * only when the new one is missing and the old one is there, with one atomic rename inside the same
 * parent, so a later start finds nothing to do. It refuses, before moving anything, when the old
 * state folder's `server.json` names a live process. The old database file name moves with its
 * `-wal` and `-shm` files. Nothing is deleted. Returns the folders it moved.
 */
export function moveLegacyFolders(env: Env, platform: string, home: string): string[] {
  const pairs: [string, string][] = [];
  if (!homeOverride(env))
    pairs.push([namedStateDir("emend", env, platform, home), namedStateDir("recense", env, platform, home)]);
  pairs.push([namedConfigDir("emend", env, home), namedConfigDir("recense", env, home)]);
  // A test run never reaches a folder outside the temporary directory.
  const testing = Boolean(env.VITEST || process.env.VITEST);
  const due = pairs.filter(([from, to]) => (!testing || insideTemporary(to)) && exists(from) && !exists(to));
  const state = due.find(([from]) => from === namedStateDir("emend", env, platform, home));
  if (state) {
    const pid = recordedPid(state[0]);
    if (pid !== undefined && processAlive(pid)) throw new LegacyStateInUseError(state[0], pid);
  }
  for (const [from, to] of due) {
    renameSync(from, to);
    if (state && from === state[0]) {
      for (const suffix of ["", "-wal", "-shm"]) {
        const oldFile = join(to, `emend.db${suffix}`);
        const newFile = join(to, `recense.db${suffix}`);
        if (exists(oldFile) && !exists(newFile)) renameSync(oldFile, newFile);
      }
    }
  }
  return due.map(([, to]) => to);
}

/** Moves the old folders on the first start; returns a line that says why it could not, or undefined. */
export function moveLegacyState(env: Env, platform = process.platform, home = homedir()): string | undefined {
  try {
    moveLegacyFolders(env, platform, home);
  } catch (error) {
    if (error instanceof LegacyStateInUseError) return error.message;
    return `could not move the old emend folders to their recense names (${(error as NodeJS.ErrnoException).code ?? "error"}). Nothing was deleted.`;
  }
  return undefined;
}
