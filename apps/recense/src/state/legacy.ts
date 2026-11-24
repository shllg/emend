import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readlinkSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath, homeOverride, inside, namedConfigDir, namedStateDir, stateDir } from "./paths.ts";

type Env = Record<string, string | undefined>;

/** Process ids that hold any of the files open, or `unknown` when this platform cannot say. */
export type HolderProbe = (files: string[], platform: string) => number[] | "unknown";

const DATABASE_SUFFIXES = ["-wal", "-shm", ""] as const;

/** A process of the name before the rename still holds the old database; nothing was moved. */
export class LegacyStateInUseError extends Error {
  readonly folder: string;
  readonly pids: number[];
  constructor(folder: string, pids: number[]) {
    super(
      `an old emend process (${pids.map((pid) => `pid ${pid}`).join(", ")}) still uses ${folder}. Stop it first (recense stop, or stop the emend service), then run recense again. Nothing was moved.`,
    );
    this.folder = folder;
    this.pids = pids;
  }
}

/** This platform cannot tell whether an old process holds the database, so nothing was moved. */
export class LegacyStateUnverifiableError extends Error {
  readonly folder: string;
  constructor(folder: string) {
    super(
      `recense cannot check on this system whether an old emend process still uses ${folder}. Stop every emend command and server, then rename emend.db, emend.db-wal and emend.db-shm in that folder to recense.db, recense.db-wal and recense.db-shm yourself. Nothing was moved.`,
    );
    this.folder = folder;
  }
}

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    // A folder that cannot be read is the state code's to report, with its own message, not a reason to refuse here.
    if (["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
      return false;
    throw error;
  }
};

/** Linux lists every open file of every process of this user; elsewhere a fixed system `lsof` answers. */
export const findHolders: HolderProbe = (files, platform) => {
  if (platform === "linux") {
    let names: string[];
    try {
      names = readdirSync("/proc");
    } catch {
      return "unknown";
    }
    const wanted = new Set(files);
    const holders: number[] = [];
    for (const name of names) {
      if (!/^[1-9][0-9]*$/.test(name)) continue;
      let links: string[];
      try {
        links = readdirSync(`/proc/${name}/fd`);
      } catch {
        // A process of another user, or one that just ended, holds nothing of this user's folder.
        continue;
      }
      for (const link of links) {
        try {
          if (wanted.has(readlinkSync(`/proc/${name}/fd/${link}`))) {
            holders.push(Number(name));
            break;
          }
        } catch {
          // The descriptor closed meanwhile.
        }
      }
    }
    return holders;
  }
  if (platform === "darwin") {
    try {
      const out = execFileSync("/usr/sbin/lsof", ["-t", "--", ...files], {
        encoding: "utf8",
        env: { PATH: "/usr/sbin:/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });
      return out
        .split("\n")
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    } catch (error) {
      // lsof exits 1 with no output when nothing holds the files.
      const { status, stdout } = error as { status?: number; stdout?: string };
      return status === 1 && !stdout ? [] : "unknown";
    }
  }
  return "unknown";
};

export interface LegacyMoveOptions {
  probe?: HolderProbe;
  /** Processes that are allowed to hold the old database, such as a service about to stop. */
  ignorePids?: number[];
}

interface Move {
  from: string;
  to: string;
}
export interface LegacyPlan {
  /** Whole folders to rename: the state folder and the config folder of a default run. */
  folders: Move[];
  /** The folder the old database files sit in before the folders move, and the one they sit in afterwards. */
  database?: { before: string; after: string };
  /** The old state folder the plan keeps an eye on: set when it moves and when it stays beside the new one. */
  note?: string;
}

/**
 * Works out what a start has to move, and checks that nothing holds the old database, without changing anything.
 *
 * A default run (neither RECENSE_HOME nor EMEND_HOME set) moves the old state and config folders to the new names,
 * each only when the new one is missing. Every run, with or without an override, renames `emend.db` and its
 * `-wal` and `-shm` files to `recense.db` in the state folder it resolved, when `recense.db` is missing. It throws
 * `LegacyStateInUseError` when a process holds the old files, and `LegacyStateUnverifiableError` when the platform
 * cannot tell.
 */
export function planLegacyMove(env: Env, platform: string, home: string, options: LegacyMoveOptions = {}): LegacyPlan {
  const plan: LegacyPlan = { folders: [] };
  let state: string;
  try {
    state = stateDir(env, platform, home);
  } catch {
    return plan;
  }
  const override = homeOverride(env);
  // A test run never reaches a folder outside the temporary directory, whatever links lead there.
  const testing = Boolean(env.VITEST || process.env.VITEST);
  const reachable = (path: string) => !testing || inside(canonicalPath(tmpdir()), canonicalPath(path));
  let databaseDir = state;
  if (!override) {
    const oldState = namedStateDir("emend", env, platform, home);
    const oldConfig = namedConfigDir("emend", env, home);
    const newConfig = namedConfigDir("recense", env, home);
    if (exists(oldState) && !exists(state) && reachable(state)) {
      plan.folders.push({ from: oldState, to: state });
      databaseDir = oldState;
    } else if (exists(oldState) && exists(state) && exists(join(oldState, "emend.db"))) {
      plan.note = `recense: ${oldState} still holds emend.db next to ${state}. recense uses ${state} and leaves the old folder alone; copy what you need from it, then remove it.`;
    }
    if (exists(oldConfig) && !exists(newConfig) && reachable(newConfig))
      plan.folders.push({ from: oldConfig, to: newConfig });
  }
  if (reachable(state) && exists(join(databaseDir, "emend.db")) && !exists(join(databaseDir, "recense.db"))) {
    plan.database = { before: databaseDir, after: state };
    const real = canonicalPath(databaseDir);
    const files = DATABASE_SUFFIXES.map((suffix) => join(real, `emend.db${suffix}`)).filter(exists);
    const holders = (options.probe ?? findHolders)(files, platform);
    if (holders === "unknown") throw new LegacyStateUnverifiableError(databaseDir);
    const blocking = holders.filter((pid) => !options.ignorePids?.includes(pid));
    if (blocking.length) throw new LegacyStateInUseError(databaseDir, blocking);
  }
  return plan;
}

/** A rename that another start already did counts as done; any other failure stays. */
function renameOnce(from: string, to: string) {
  try {
    renameSync(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && (exists(to) || !exists(from))) return;
    if ((code === "ENOTEMPTY" || code === "EEXIST") && exists(to)) return;
    throw error;
  }
}

/** Moves what a plan lists, in an order a crash or a second start can resume from. Nothing is deleted. */
export function applyLegacyPlan(plan: LegacyPlan): string[] {
  const moved: string[] = [];
  for (const { from, to } of plan.folders) {
    renameOnce(from, to);
    moved.push(to);
  }
  if (plan.database) {
    // The -wal and -shm files go first: a start that finds recense.db missing resumes from emend.db alone.
    for (const suffix of DATABASE_SUFFIXES)
      renameOnce(join(plan.database.after, `emend.db${suffix}`), join(plan.database.after, `recense.db${suffix}`));
    moved.push(join(plan.database.after, "recense.db"));
  }
  return moved;
}

export function moveLegacyFolders(env: Env, platform: string, home: string, options: LegacyMoveOptions = {}): string[] {
  return applyLegacyPlan(planLegacyMove(env, platform, home, options));
}

export interface LegacyMoveResult {
  /** Why nothing could move; the start stops with this line. */
  refusal?: string;
  /** A line for stderr when both state folders exist. */
  note?: string;
}

/** Moves the old folders and database on a start; returns a line that says why it could not, or undefined. */
export function moveLegacyState(
  env: Env,
  platform: string = process.platform,
  home = homedir(),
  options: LegacyMoveOptions = {},
): LegacyMoveResult {
  try {
    const plan = planLegacyMove(env, platform, home, options);
    applyLegacyPlan(plan);
    return plan.note === undefined ? {} : { note: plan.note };
  } catch (error) {
    if (error instanceof LegacyStateInUseError || error instanceof LegacyStateUnverifiableError)
      return { refusal: error.message };
    return {
      refusal: `could not move the old emend files to their recense names (${(error as NodeJS.ErrnoException).code ?? "error"}). Nothing was deleted.`,
    };
  }
}

/** The old state folder to stop a server in, when a server of the name before the rename still runs there. */
export function legacyServerFolder(
  env: Env,
  platform: string = process.platform,
  home = homedir(),
): string | undefined {
  if (homeOverride(env)) return undefined;
  try {
    const old = namedStateDir("emend", env, platform, home);
    return !exists(namedStateDir("recense", env, platform, home)) && exists(join(old, "server.json")) ? old : undefined;
  } catch {
    return undefined;
  }
}
