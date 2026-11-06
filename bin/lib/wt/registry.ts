import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import net from "node:net";
import { join } from "node:path";
import type { Repo } from "./repo.ts";
import { WtError } from "./validate.ts";

export const PORT_MIN = 3637;
export const PORT_MAX = 3656;

let rangeOverride: { min: number; max: number } | null = null;

/**
 * Test seam for in-process tests: replaces the port range, so a test never depends on the owner's worktree
 * servers (which hold ports in 3637 to 3656) being absent. Production code never calls this, and the range
 * never comes from an environment variable. Null restores the real range.
 */
export function setPortRangeForTests(range: { min: number; max: number } | null): void {
  rangeOverride = range;
}

/** The ports bin/wt hands out: 3637 to 3656 unless a test replaced them. */
export function portRange(): { min: number; max: number } {
  return rangeOverride ?? { min: PORT_MIN, max: PORT_MAX };
}
const LOCK_WAIT_MS = 30_000;
const REAP_STALE_MS = 10_000;

export interface WorktreeEntry {
  path: string;
  port: number;
  task: string | null;
  issue?: number;
  mode: "github" | "local";
  createdAt: string;
  /** Commit that landed this branch on local main (set by `land`). */
  landedAs?: string;
}

export interface Registry {
  version: 1;
  worktrees: Record<string, WorktreeEntry>;
  reservations: Record<string, { branch: string; slug: string; reservedAt: string }>;
}

export function emptyRegistry(): Registry {
  return { version: 1, worktrees: {}, reservations: {} };
}

function stateDir(repo: Repo): string {
  return join(repo.commonDir, "emend-wt");
}

export function registryPath(repo: Repo): string {
  return join(stateDir(repo), "registry.json");
}

export function lockPath(repo: Repo): string {
  return join(stateDir(repo), "lock");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockPid(path: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Removes the lock when its holder is dead. Serialized through a `.reap` directory so two reapers cannot race. */
function reapIfStale(path: string): boolean {
  const pid = readLockPid(path);
  if (pid === null) return false;
  if (pidAlive(pid)) return false;
  const reap = `${path}.reap`;
  try {
    mkdirSync(reap);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    try {
      if (Date.now() - statSync(reap).mtimeMs > REAP_STALE_MS) rmdirSync(reap);
    } catch {
      // another reaper finished; the caller retries
    }
    return false;
  }
  try {
    if (readLockPid(path) === pid) unlinkSync(path);
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmdirSync(reap);
    } catch {
      // already gone
    }
  }
}

function acquireLock(path: string): () => void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      try {
        linkSync(tmp, path); // exclusive create: fails with EEXIST, and the pid is in the file when it appears
        return () => {
          if (readLockPid(path) === process.pid) {
            try {
              unlinkSync(path);
            } catch {
              // already gone
            }
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      if (reapIfStale(path)) continue;
      if (Date.now() >= deadline) {
        throw new WtError(69, "Another bin/wt call holds the registry lock. Try again in a moment.");
      }
      sleepSync(25);
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRegistry(text: string): Registry {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new WtError(1, "The worktree registry is not valid JSON. Nothing was changed; ask the owner to repair it.");
  }
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.worktrees) || !isRecord(data.reservations)) {
    throw new WtError(1, "The worktree registry has an unexpected shape. Nothing was changed.");
  }
  return data as unknown as Registry;
}

/** Reads the registry without the lock. Writes are atomic renames, so a read sees a whole file. Read-only use. */
export function readRegistry(repo: Repo): Registry {
  try {
    return parseRegistry(readFileSync(registryPath(repo), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw e;
  }
}

function writeRegistryFile(repo: Repo, registry: Registry): void {
  const final = registryPath(repo);
  const tmp = `${final}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(registry, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, final);
}

let held = false;
let afterLockHook: (() => void) | null = null;

/** Test seam: runs right after withRegistry took the lock, before it reads. Production code never calls this. */
export function setAfterLockHookForTests(hook: (() => void) | null): void {
  afterLockHook = hook;
}

/**
 * Takes the registry lock, reads the registry, runs `fn`, writes the result atomically when it changed,
 * and releases the lock. When `fn` throws, nothing is written. `fn` is synchronous and must not call
 * withRegistry again.
 */
export function withRegistry<T>(repo: Repo, fn: (r: Registry) => T): T {
  if (held) throw new Error("withRegistry is not re-entrant");
  const dir = stateDir(repo);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const release = acquireLock(lockPath(repo));
  held = true;
  try {
    afterLockHook?.();
    const registry = readRegistry(repo);
    const before = JSON.stringify(registry);
    const result = fn(registry);
    if (JSON.stringify(registry) !== before) writeRegistryFile(repo, registry);
    return result;
  } finally {
    held = false;
    release();
  }
}

/** Ports 3637 to 3656 with a listener on 127.0.0.1. Take this before the lock: it waits on the network. */
export async function busyPorts(): Promise<Set<number>> {
  const probe = (port: number) =>
    new Promise<number | null>((done) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const finish = (busy: boolean) => {
        socket.destroy();
        done(busy ? port : null);
      };
      socket.setTimeout(200);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
  const ports: number[] = [];
  const { min, max } = portRange();
  for (let p = min; p <= max; p++) ports.push(p);
  const found = await Promise.all(ports.map(probe));
  return new Set(found.filter((p): p is number => p !== null));
}

/** The lowest port in 3637..3656 that no registry entry uses and no listener holds. Exit 69 when none is free. */
export function allocatePort(r: Registry, busy: ReadonlySet<number>): number {
  const used = new Set(Object.values(r.worktrees).map((w) => w.port));
  const { min, max } = portRange();
  for (let p = min; p <= max; p++) {
    if (!used.has(p) && !busy.has(p)) return p;
  }
  throw new WtError(69, `No free port in ${min}-${max}. Nothing was created.`);
}
