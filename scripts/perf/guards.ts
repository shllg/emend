import { lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, type Stats, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { assertOutputFolder, inside } from "../screenshots/safety.ts";

export function cacheHome(
  parent: Record<string, string | undefined> = process.env,
  parentHome = homedir(),
): string {
  return parent.XDG_CACHE_HOME && isAbsolute(parent.XDG_CACHE_HOME) ? parent.XDG_CACHE_HOME : join(parentHome, ".cache");
}

export function refParent(
  parent: Record<string, string | undefined> = process.env,
  parentHome = homedir(),
): string {
  return join(cacheHome(parent, parentHome), "recense-perf");
}

export function pidNamespace(platform = process.platform, readlink: (path: string) => string = readlinkSync): string | null | undefined {
  if (platform !== "linux") return null;
  try {
    return readlink("/proc/self/ns/pid");
  } catch {
    return undefined;
  }
}

export function writeRefMarker(folder: string, keep: boolean, pid = process.pid, host = hostname(), pidns = pidNamespace()): void {
  writeFileSync(join(folder, ".recense-perf-ref"), JSON.stringify({ pid, host, pidns: pidns === undefined ? false : pidns, keep }), { flag: "wx", mode: 0o600 });
}

export function processAlive(pid: number, kill = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

/** The caller guards the canonical parent before sweeping; uncertain entries stay. */
export function removeStaleRefExports(
  parent: string,
  options: {
    uid: number;
    host?: string;
    pidns?: string | null | undefined;
    alive?: (pid: number) => boolean;
    log?: (line: string) => void;
  },
  remove: typeof rmSync = rmSync,
): void {
  const { uid, host = hostname(), alive = processAlive, log = console.log } = options;
  const pidns = "pidns" in options ? options.pidns : pidNamespace();
  if (typeof pidns !== "string" && pidns !== null) return;
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.length !== 10 || !/^ref-[A-Za-z0-9]{6}$/.test(name)) continue;
    const folder = join(parent, name);
    let pid: number;
    try {
      const entry = lstatSync(folder);
      if (entry.isSymbolicLink() || !entry.isDirectory() || entry.uid !== uid) continue;
      const markerPath = join(folder, ".recense-perf-ref");
      const markerStat = lstatSync(markerPath);
      if (markerStat.isSymbolicLink() || !markerStat.isFile()) continue;
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (!marker || typeof marker !== "object" || !Number.isInteger(marker.pid) || marker.pid <= 0
        || typeof marker.host !== "string" || marker.host !== host || marker.pidns !== pidns || marker.keep === true) continue;
      pid = marker.pid;
      if (pid === process.pid || alive(pid)) continue;
    } catch {
      // Missing, unreadable or invalid markers cannot prove that the run is gone.
      continue;
    }
    try {
      remove(folder, { recursive: true, force: true });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "unknown";
      log(`- warning: could not remove leftover ref export ${folder} (${code})`);
      continue;
    }
    log(`- removed a leftover ref export of an earlier run (pid ${pid})`);
  }
}

/** Node can resolve modules from node_modules in any ancestor of the export. */
export function assertPrivateAncestors(
  folder: string,
  uid: number,
  stat: (path: string) => Pick<Stats, "isDirectory" | "isSymbolicLink" | "uid" | "mode"> = lstatSync,
): void {
  if (!isAbsolute(folder)) throw new Error("The ref folder must be absolute");
  for (let path = folder; ; path = dirname(path)) {
    const entry = stat(path);
    let reason: string | undefined;
    if (entry.isSymbolicLink()) reason = "is a symbolic link";
    else if (!entry.isDirectory()) reason = "is not a directory";
    else if (entry.uid !== uid && entry.uid !== 0) reason = "is owned by another user, who could add modules that Node would load";
    else if ((entry.mode & 0o022) !== 0) reason = "is writable by its group or by others, who could add modules that Node would load";
    if (reason) throw new Error(`${path === folder ? "The ref folder" : "The ref folder's parent"} ${path} ${reason}`);
    if (dirname(path) === path) return;
  }
}

/** Prevent pnpm from finding a workspace in an ancestor of a ref export. */
export function assertWorkspaceRoot(folder: string): void {
  for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
    let regular = false;
    try {
      regular = lstatSync(join(folder, file)).isFile();
    } catch {
      // A missing or unreadable entry cannot establish the export's workspace root.
    }
    if (!regular) throw new Error(`The ref has no pnpm workspace root of its own: ${file} is missing or not a regular file`);
  }
}

// Output intentionally lives in .wt/perf; only ref exports must be outside the checkout.
export function assertRefFolder(
  folder: string,
  checkout: string,
  parent: string,
  states: readonly string[],
  canonicalize: (path: string) => string,
): void {
  if (!isAbsolute(parent)) throw new Error("The ref parent folder must be absolute");
  if (![folder, checkout].every(isAbsolute)) throw new Error("Ref paths must be absolute");
  assertOutputFolder(parent, states, canonicalize, "ref parent");
  assertOutputFolder(folder, states, canonicalize, "ref");
  const path = canonicalize(folder),
    repo = canonicalize(checkout);
  if (!inside(canonicalize(parent), path)) throw new Error("Ref folder must be inside the ref parent folder");
  if (path === repo || inside(repo, path) || inside(path, repo)) throw new Error("Ref folder overlaps the checkout");
}
export { assertOutputFolder } from "../screenshots/safety.ts";
