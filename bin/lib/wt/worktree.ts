import {
  chmodSync,
  closeSync,
  constants,
  type Dirent,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isatty } from "node:tty";
import { pathToFileURL } from "node:url";
import type { Command, CommandTable } from "./command.ts";
import { closeWorkspace, herdrLocatedAgents } from "./herdr.ts";
import { run } from "./proc.ts";
import { allocatePort, busyPorts, readRegistry, type WorktreeEntry, withRegistry } from "./registry.ts";
import {
  assertNoGitlinks,
  assertNoGitlinksInRef,
  assertRefFormat,
  fetchOrigin,
  git,
  gitTry,
  listGitWorktrees,
  type Repo,
  refExists,
} from "./repo.ts";
import { hasTerminal, readTerminalLine } from "./terminal.ts";
import { branchName, commitSha, parseFlags, refName, taskNumber, WtError } from "./validate.ts";

// ---------------------------------------------------------------------------------------------
// Output and terminal access. Tests may replace the terminal.

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

// The terminal check is friction against agents, not proof that the owner is present.
export const terminal = {
  isTTY(): boolean {
    return isatty(0) && isatty(1) && hasTerminal();
  },
  readLine(prompt: string): string {
    try {
      return readTerminalLine(prompt);
    } catch {
      throw new WtError(2, "--discard needs a terminal. Nothing was removed.");
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Setup

/** `fix/inbox` -> `fix--inbox`. */
export function worktreeDirName(branch: string): string {
  return branch.replaceAll("/", "--");
}

export interface SetupOptions {
  branch: string;
  from?: string;
  task?: string;
  mode?: "github" | "local";
  /** Ports with a listener, from busyPorts(), taken before the lock. Default: none. */
  busy?: ReadonlySet<number>;
}

export interface SetupResult {
  path: string;
  branch: string;
  port: number;
  emendHome: string;
}

function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Makes `dir` a real directory (never a symlink): creates it when absent, tightens its mode when asked. */
function ensureRealDir(dir: string, mode?: number): void {
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (st === null) mkdirSync(dir, { mode: mode ?? 0o755 });
  else if (!st.isDirectory()) throw new Error("a path that must be a plain directory is not one");
  if (mode !== undefined) chmodSync(dir, mode);
}

/** Creates `file` exclusively and never through a symlink (O_EXCL, O_NOFOLLOW). Returns after writing. */
function createNew(file: string, data: string | Buffer, mode: number): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeSync(fd, Buffer.from(data));
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

/** Writes `.wt/worktree.json`, `.wt/.gitignore` and `.wt/home`. Refuses a symlink anywhere on the way. */
export function writeWtFiles(entry: WorktreeEntry, branch: string): string {
  const wt = join(entry.path, ".wt");
  const emendHome = join(wt, "home");
  ensureRealDir(wt, 0o700);
  ensureRealDir(emendHome, 0o700);
  // .wt holds this checkout's private state; ignore it even where the repository's .gitignore does not.
  createNew(join(wt, ".gitignore"), "*\n", 0o600);
  const info = { branch, port: entry.port, emendHome, task: entry.task, mode: entry.mode };
  createNew(join(wt, "worktree.json"), `${JSON.stringify(info, null, 2)}\n`, 0o600);
  return emendHome;
}

/** The gitignored files a new worktree needs (such as the MCP server registration) are listed in this file. */
const INCLUDE_FILE = ".worktreeinclude";

/** A path from git, made safe to print on one line. */
function shown(p: string): string {
  return p.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
}

/**
 * The files `<main>/.worktreeinclude` selects: untracked files that match its patterns (gitignore syntax) and
 * that the repository's own ignore rules also ignore. Git does the matching. Empty when the file is missing.
 */
function worktreeIncludePaths(repo: Repo, note: (what: string, why: string) => void): string[] {
  const list = join(repo.mainRoot, INCLUDE_FILE);
  try {
    if (!lstatSync(list).isFile()) {
      note(INCLUDE_FILE, "it is not a regular file");
      return [];
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") note(INCLUDE_FILE, "it could not be read");
    return [];
  }
  const matched = gitTry(repo, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${list}`]);
  if (matched.code !== 0) {
    note(INCLUDE_FILE, "git could not match it");
    return [];
  }
  const candidates = matched.stdout.split("\0").filter((p) => p !== "");
  if (candidates.length === 0) return [];
  const ignored = gitTry(repo, ["check-ignore", "-z", "--stdin"], { input: `${candidates.join("\0")}\0` });
  if (ignored.code === 1) return [];
  if (ignored.code !== 0) {
    note(INCLUDE_FILE, "git could not check which files are ignored");
    return [];
  }
  return ignored.stdout.split("\0").filter((p) => p !== "");
}

/** Reads a regular file below `root` (every parent a real directory, the file not a symlink) with its mode. */
function readSource(root: string, parts: string[]): { data: Buffer; mode: number } | string {
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    try {
      if (!lstatSync(dir).isDirectory()) return "a parent folder in the main checkout is not a plain directory";
    } catch {
      return "a parent folder in the main checkout could not be read";
    }
  }
  let fd: number | null = null;
  try {
    fd = openSync(join(dir, parts[parts.length - 1] as string), constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) return "the main checkout's file is not a regular file";
    return { data: readFileSync(fd), mode: st.mode & 0o7777 };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ELOOP" ? "the main checkout's file is a symlink" : "the main checkout's file could not be read";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Copies the gitignored files that `<main>/.worktreeinclude` lists into a new worktree, with their mode.
 * Paths that are empty, absolute, hold `..`, or lie under `.git/` or `.wt/` are skipped. So are symlinked sources
 * and folders, and an existing target is kept. Each skip is one stderr line. A failure here never fails setup.
 */
export function copyLocalFiles(repo: Repo, worktree: string): void {
  const note = (what: string, why: string) => process.stderr.write(`Skipped ${shown(what)}: ${why}.\n`);
  let paths: string[];
  try {
    paths = worktreeIncludePaths(repo, note);
  } catch {
    note(INCLUDE_FILE, "it could not be processed");
    return;
  }
  for (const rel of paths) {
    try {
      const parts = rel.split("/");
      if (rel === "" || isAbsolute(rel) || parts.some((p) => p === "" || p === "." || p === "..")) {
        note(rel, "the path is not a plain relative path");
        continue;
      }
      if (parts[0] === ".git" || parts[0] === ".wt") {
        note(rel, `${parts[0]} is not copied`);
        continue;
      }
      const target = join(worktree, ...parts);
      if (!target.startsWith(worktree + sep)) {
        note(rel, "the destination lies outside the worktree");
        continue;
      }
      const source = readSource(repo.mainRoot, parts);
      if (typeof source === "string") {
        note(rel, source);
        continue;
      }
      let dir = worktree;
      let blocked = false;
      for (const part of parts.slice(0, -1)) {
        dir = join(dir, part);
        try {
          ensureRealDir(dir);
        } catch {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        note(rel, "a parent folder in the worktree is not a plain directory");
        continue;
      }
      try {
        createNew(target, source.data, source.mode);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") note(rel, "the worktree already has it");
        else throw e;
      }
    } catch {
      note(rel, "it could not be copied");
    }
  }
}

let beforeWorktreeAdd: ((branch: string) => void) | null = null;

/** Test seam: runs just before `git worktree add`, to simulate a ref that moves after it was checked. */
export function setBeforeWorktreeAddHookForTests(hook: ((branch: string) => void) | null): void {
  beforeWorktreeAdd = hook;
}

/** True when the caller stands in a linked worktree rather than the main checkout (or outside any). */
function fromLinkedWorktree(repo: Repo): boolean {
  return repo.callerTop !== null && repo.callerTop !== repo.mainRoot;
}

/** Creates a worktree for `branch` with a port and a private EMEND_HOME. Exit 3 when the branch or directory is taken. */
export function setup(repo: Repo, o: SetupOptions): SetupResult {
  const branch = branchName(o.branch);
  const from = o.from === undefined ? undefined : refName(o.from);
  const task = o.task === undefined ? null : taskNumber(o.task);
  const mode = o.mode ?? "github";
  if (mode !== "github" && mode !== "local") throw new WtError(2, "Invalid mode.");
  assertRefFormat(repo, branch);

  const path = join(repo.worktreesDir, worktreeDirName(branch));
  const localExists = refExists(repo, `refs/heads/${branch}`);
  let originExists = false;
  if (!localExists) {
    fetchOrigin(repo);
    originExists = refExists(repo, `refs/remotes/origin/${branch}`);
  }
  if ((localExists || originExists) && from !== undefined) {
    throw new WtError(2, "--from applies only to a new branch. Nothing was created.");
  }
  if ((localExists || originExists) && fromLinkedWorktree(repo)) {
    throw new WtError(
      2,
      "From a worktree, bin/wt setup creates only new branches; run it from the main checkout to check out an existing one. Nothing was created.",
    );
  }
  // The owner lands work on local main and pushes later, so a new branch starts from local main.
  const start = from ?? "refs/heads/main";
  if (!localExists && !originExists && !refExists(repo, start)) {
    throw new WtError(2, "The source ref was not found. Nothing was created.");
  }
  // The ref that gets checked out: a gitlink in it must never be checked out, and neither may a tracked .wt.
  const checkedOut = localExists ? `refs/heads/${branch}` : originExists ? `refs/remotes/origin/${branch}` : start;
  // Resolve once: the checks and `worktree add` must see the same commit even if a fetch moves the ref meanwhile.
  const resolved = gitTry(repo, ["rev-parse", "--verify", "--quiet", `${checkedOut}^{commit}`]);
  if (resolved.code !== 0 || !/^[0-9a-f]{40,64}$/.test(resolved.stdout)) {
    throw new WtError(2, "The source ref was not found. Nothing was created.");
  }
  const sha = resolved.stdout;
  if (gitTry(repo, ["ls-tree", `${sha}^{tree}`, "--", ".wt"]).stdout !== "") {
    throw new WtError(2, "The ref tracks a .wt entry, which bin/wt keeps for its own state. Nothing was created.");
  }
  if (localExists || originExists || from !== undefined) {
    try {
      assertNoGitlinksInRef(repo, sha);
    } catch (e) {
      throw e instanceof WtError ? new WtError(e.code, `${e.message} Nothing was created.`) : e;
    }
  }

  const outcome = withRegistry(repo, (r) => {
    if (Object.hasOwn(r.worktrees, branch)) {
      throw new WtError(3, "A worktree is already registered for this branch. Nothing was created.");
    }
    if (listGitWorktrees(repo).some((w) => w.branch === branch)) {
      throw new WtError(3, "This branch is already checked out in another worktree. Nothing was created.");
    }
    if (pathExists(path)) {
      throw new WtError(3, "The worktree directory already exists. Nothing was created.");
    }
    const port = allocatePort(r, o.busy ?? new Set());
    mkdirSync(repo.worktreesDir, { recursive: true });
    beforeWorktreeAdd?.(branch);
    const add = ["worktree", "add", "--quiet"];
    if (localExists) add.push(path, branch);
    else add.push("--no-track", "-b", branch, path, sha);
    git(repo, add);
    if (localExists) {
      // The branch is checked out by name: it must still be the commit that was checked.
      const head = gitTry(repo, ["rev-parse", "HEAD"], { cwd: path });
      if (head.code !== 0 || head.stdout !== sha) {
        gitTry(repo, ["worktree", "remove", "--force", "--", path]);
        throw new WtError(
          1,
          "The branch moved while the worktree was being created, so it was removed. Nothing was created.",
        );
      }
    } else if (originExists) {
      git(repo, ["branch", "--quiet", `--set-upstream-to=origin/${branch}`, branch]);
    }

    const entry: WorktreeEntry = { path, port, task, mode, createdAt: new Date().toISOString() };
    r.worktrees[branch] = entry;
    try {
      return { entry, emendHome: writeWtFiles(entry, branch), failure: null as WtError | null };
    } catch (e) {
      const why = e instanceof Error ? e.message : "unknown error";
      const failure = new WtError(
        1,
        `The worktree exists at ${path} but its .wt files could not be written (${why}). ` +
          `Registered with port ${port}. Remove it with: bin/wt cleanup ${branch}`,
      );
      return { entry, emendHome: join(path, ".wt", "home"), failure };
    }
  });
  if (outcome.failure) throw outcome.failure;
  copyLocalFiles(repo, path);
  return { path, branch, port: outcome.entry.port, emendHome: outcome.emendHome };
}

// ---------------------------------------------------------------------------------------------
// List

export interface ListRow {
  branch: string;
  path: string;
  task: string | null;
  port: number;
  mode: "github" | "local";
  /** Commits on the branch that its base lacks (local main for a local-mode entry, origin/main otherwise), or null when unknown. */
  ahead: number | null;
  /** Commits on its base that the branch lacks, or null when unknown. */
  behind: number | null;
  dirty: boolean | null;
  pr: { number: number; state: string } | null;
  /** herdr status of an agent working inside the worktree, or null. */
  agent: string | null;
  /** The registry lists the worktree but its directory is gone. */
  missing: boolean;
}

function isInside(dir: string, p: string): boolean {
  let real = p;
  try {
    real = realpathSync(p);
  } catch {
    real = resolve(p);
  }
  return real === dir || real.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** True when `branch` is a name bin/wt itself could have created. Names from the registry or git output pass through this before git or gh sees them. */
function plainBranch(branch: string): boolean {
  try {
    branchName(branch);
    return true;
  } catch {
    return false;
  }
}

function lookupPr(repo: Repo, branch: string): { number: number; state: string } | null {
  if (!plainBranch(branch)) return null;
  const r = run("gh", ["pr", "view", branch, "--json", "number,state"], { cwd: repo.mainRoot, timeoutMs: 15_000 });
  if (r.code !== 0) return null;
  try {
    const data = JSON.parse(r.stdout) as { number?: unknown; state?: unknown };
    if (typeof data.number === "number" && typeof data.state === "string") {
      return { number: data.number, state: data.state };
    }
  } catch {
    // not JSON: no PR information
  }
  return null;
}

/** One row per registered worktree. gh and herdr are optional: without them their columns are null. */
export function list(repo: Repo): ListRow[] {
  const reg = readRegistry(repo);
  const agents = herdrLocatedAgents();
  const rows: ListRow[] = [];
  for (const [branch, entry] of Object.entries(reg.worktrees)) {
    const missing = !existsSync(entry.path);
    let ahead: number | null = null;
    let behind: number | null = null;
    const counts = gitTry(repo, [
      "rev-list",
      "--left-right",
      "--count",
      `${entry.mode === "local" ? "refs/heads/main" : "refs/remotes/origin/main"}...refs/heads/${branch}`,
    ]);
    if (counts.code === 0) {
      const [b, a] = counts.stdout.split(/\s+/).map(Number);
      if (Number.isInteger(a) && Number.isInteger(b)) {
        ahead = a as number;
        behind = b as number;
      }
    }
    let dirty: boolean | null = null;
    if (!missing) {
      const st = gitTry(repo, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all"], {
        cwd: entry.path,
      });
      if (st.code === 0) dirty = st.stdout.trim() !== "";
    }
    const inside = agents?.filter((a) => a.location !== null && isInside(entry.path, a.location)) ?? [];
    rows.push({
      branch,
      path: entry.path,
      task: entry.task,
      port: entry.port,
      mode: entry.mode,
      ahead,
      behind,
      dirty,
      pr: lookupPr(repo, branch),
      agent: inside[0]?.status ?? null,
      missing,
    });
  }
  return rows;
}

export function formatList(rows: ListRow[]): string {
  if (rows.length === 0) return "No worktrees.";
  const head = ["BRANCH", "TASK", "PORT", "AHEAD/BEHIND", "DIRTY", "PR", "AGENT"];
  // Branch names, the PR state and the agent status come from outside: no control character (C0, DEL, C1) shows.
  const safe = (s: string) => s.replace(/\p{Cc}/gu, "?");
  const body = rows.map((r) =>
    [
      r.missing ? `${r.branch} (missing)` : r.branch,
      r.task ?? "-",
      String(r.port),
      r.ahead === null || r.behind === null ? "-" : `+${r.ahead}/-${r.behind}`,
      r.dirty === null ? "-" : r.dirty ? "yes" : "no",
      r.pr ? `#${r.pr.number} ${r.pr.state}` : "-",
      r.agent ?? "-",
    ].map(safe),
  );
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] as string).length)));
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();
  return [fmt(head), ...body.map(fmt)].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Safety guard

/** `detail` names what failed where the name alone is not enough (the agent of "agent-unknown"). */
export type GuardResult = { ok: true } | { ok: false; failed: string; detail?: string };

const IN_PROGRESS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
];

function portListening(port: number): boolean {
  if (!Number.isInteger(port)) return false;
  const script =
    'const s=require("node:net").connect({host:"127.0.0.1",port:Number(process.argv[1])});' +
    "s.setTimeout(500);s.on('connect',()=>process.exit(0));s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));";
  return run(process.execPath, ["-e", script, String(port)], { cwd: "/", timeoutMs: 5000 }).code === 0;
}

function containedInMergedPr(repo: Repo, branch: string, path: string): boolean {
  if (!plainBranch(branch)) return false;
  const gh = run("gh", ["pr", "view", branch, "--json", "number,state,headRefOid"], {
    cwd: repo.mainRoot,
    timeoutMs: 30_000,
  });
  if (gh.code !== 0) return false;
  let data: { number?: unknown; state?: unknown; headRefOid?: unknown };
  try {
    data = JSON.parse(gh.stdout);
  } catch {
    return false;
  }
  if (data.state !== "MERGED" || typeof data.number !== "number" || !Number.isInteger(data.number)) return false;
  if (data.number < 1 || data.number > 9_999_999) return false;
  let head: string;
  try {
    head = commitSha(String(data.headRefOid));
  } catch {
    return false;
  }
  const ref = `refs/wt-pr/${data.number}`;
  const fetched = gitTry(repo, ["fetch", "--quiet", "origin", `+refs/pull/${data.number}/head:${ref}`]);
  if (fetched.code !== 0) return false;
  try {
    if (gitTry(repo, ["rev-parse", "--verify", ref]).stdout !== head) return false;
    return gitTry(repo, ["merge-base", "--is-ancestor", "HEAD", ref], { cwd: path }).code === 0;
  } finally {
    gitTry(repo, ["update-ref", "-d", ref]);
  }
}

function containedInMain(repo: Repo, entry: WorktreeEntry): boolean {
  if (!entry.landedAs) return false;
  let landed: string;
  try {
    landed = commitSha(entry.landedAs);
  } catch {
    return false;
  }
  const mine = gitTry(repo, ["rev-parse", "--verify", "HEAD^{tree}"], { cwd: entry.path });
  const theirs = gitTry(repo, ["rev-parse", "--verify", `${landed}^{tree}`]);
  if (mine.code !== 0 || theirs.code !== 0 || mine.stdout !== theirs.stdout) return false;
  return gitTry(repo, ["merge-base", "--is-ancestor", landed, "refs/heads/main"]).code === 0;
}

function runGuard(repo: Repo, branch: string, skip: ReadonlySet<string>): GuardResult {
  const entry = readRegistry(repo).worktrees[branch];
  if (!entry) return { ok: false, failed: "not-registered" };
  return guardEntry(repo, branch, entry, skip);
}

function guardEntry(repo: Repo, branch: string, entry: WorktreeEntry, skip: ReadonlySet<string>): GuardResult {
  const path = entry.path;
  if (!existsSync(path)) return { ok: false, failed: "missing" };
  const fail = (failed: string, detail?: string): GuardResult =>
    detail === undefined ? { ok: false, failed } : { ok: false, failed, detail };

  // A gitlink makes git look into a repository the agent wrote; refuse before any status or diff runs.
  try {
    assertNoGitlinks(repo, path);
  } catch {
    return fail("gitlink");
  }

  if (!skip.has("not-clean")) {
    const st = gitTry(repo, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all"], {
      cwd: path,
    });
    if (st.code !== 0 || st.stdout.trim() !== "") return fail("not-clean");
  }

  const attached = gitTry(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path });
  if (attached.code !== 0 || attached.stdout !== branch) return fail("branch-mismatch");

  if (!skip.has("unmerged")) {
    const inMain = ["refs/remotes/origin/main", "refs/heads/main"].some(
      (ref) => gitTry(repo, ["merge-base", "--is-ancestor", "HEAD", ref], { cwd: path }).code === 0,
    );
    if (!inMain && !containedInMergedPr(repo, branch, path) && !containedInMain(repo, entry)) {
      return fail("unmerged");
    }
  }

  const gitDir = gitTry(repo, ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: path });
  if (gitDir.code !== 0) return fail("operation-in-progress");
  if (IN_PROGRESS.some((name) => existsSync(join(gitDir.stdout, name)))) return fail("operation-in-progress");

  const real = realpathSync(path);
  if (listGitWorktrees(repo).some((w) => w.path !== real && w.path.startsWith(real + sep))) {
    return fail("nested-worktree");
  }

  if (portListening(entry.port)) return fail("port-listening");

  const agents = herdrLocatedAgents();
  if (agents) {
    // From the main checkout no pane is skipped. From a linked worktree, only the caller's own pane is: the one
    // named by HERDR_PANE_ID whose location lies inside the caller's own worktree.
    const mine = process.env.HERDR_PANE_ID;
    const own = repo.callerTop !== null && repo.callerTop !== repo.mainRoot ? repo.callerTop : null;
    for (const a of agents) {
      if (own !== null && mine && a.paneId === mine && a.location !== null && isInside(own, a.location)) continue;
      if (a.status === "idle" || a.status === "done") continue;
      // An agent that works somewhere unknown may work in this worktree: fail closed.
      if (a.location === null) return fail("agent-unknown", a.name ?? a.paneId ?? "unnamed");
      if (isInside(real, a.location)) return fail("agent-active");
    }
  }
  return { ok: true };
}

/**
 * Checks, in order, naming the first that fails: registered, directory present, clean (untracked files
 * included), attached to the registered branch, every commit in origin/main, in local main, in the merged PR head
 * or landed on main, no operation in progress, no nested worktree, no listener on the port, and no other
 * herdr agent active inside it.
 */
export function safetyGuard(repo: Repo, branch: string): GuardResult {
  return runGuard(repo, branch, new Set());
}

// ---------------------------------------------------------------------------------------------
// Cleanup

function isSameDir(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

function resolveTarget(repo: Repo, target: string): string {
  const reg = readRegistry(repo);
  if (Object.hasOwn(reg.worktrees, target)) return target;
  const abs = resolve(process.cwd(), target);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    // keep the absolute path
  }
  for (const [branch, entry] of Object.entries(reg.worktrees)) {
    if (entry.path === abs || entry.path === real) return branch;
  }
  throw new WtError(2, "No worktree managed by bin/wt matches that target.");
}

/**
 * Removes a registered worktree after the safety guard, frees its port and registry entry, and deletes the
 * local branch (best effort). `discard` needs a terminal and the typed branch name, skips only the clean and
 * containment checks, and never the agent and listener checks. `closeWorkspace` closes the herdr workspace
 * linked to the removed worktree, as the very last step.
 */
export function cleanup(repo: Repo, o: { target: string; closeWorkspace: boolean; discard: boolean }): void {
  const branch = resolveTarget(repo, o.target);
  const entry = readRegistry(repo).worktrees[branch] as WorktreeEntry;
  if (fromLinkedWorktree(repo) && !isSameDir(entry.path, repo.callerTop as string)) {
    throw new WtError(
      2,
      "From a worktree, bin/wt cleans up only its own worktree; run it from the main checkout for others.",
    );
  }

  if (!existsSync(entry.path)) {
    gitTry(repo, ["worktree", "prune"]);
    withRegistry(repo, (r) => {
      delete r.worktrees[branch];
    });
    say(
      `The directory was already gone. Removed the registry entry and freed port ${entry.port}. The branch was kept.`,
    );
    return;
  }

  if (o.discard && !terminal.isTTY()) {
    throw new WtError(2, "--discard needs a terminal. Nothing was removed.");
  }
  const skip = new Set(o.discard ? ["not-clean", "unmerged"] : []);
  const guard = runGuard(repo, branch, skip);
  if (!guard.ok) {
    const who = guard.detail === undefined ? "" : ` (${guard.detail.replace(/[^\x20-\x7e]/g, "?").slice(0, 64)})`;
    throw new WtError(1, `Cleanup refused: the check "${guard.failed}"${who} failed. Nothing was removed.`);
  }
  if (o.discard && terminal.readLine(`Type the branch name to discard ${branch}: `) !== branch) {
    throw new WtError(1, "Not confirmed. Nothing was removed.");
  }

  git(repo, ["worktree", "remove", ...(o.discard ? ["--force"] : []), "--", entry.path]);
  try {
    withRegistry(repo, (r) => {
      delete r.worktrees[branch];
    });
  } catch {
    throw new WtError(1, `The worktree was removed; run ${join(repo.mainRoot, "bin", "wt")} gc --prune.`);
  }
  const deleted = plainBranch(branch) && gitTry(repo, ["branch", "-D", "--", branch]).code === 0;
  say(`Removed ${entry.path}; port ${entry.port} is free.`);
  say(deleted ? `Deleted local branch ${branch}.` : `The local branch ${branch} was not deleted.`);
  // Last: closing the workspace can end the caller's own session.
  // A discarded worktree was not merged, so the workspace closes without the "merged" notification.
  if (o.closeWorkspace) closeWorkspace(repo, entry.path, branch, { notifyMerged: !o.discard });
}

// ---------------------------------------------------------------------------------------------
// gc

export interface GcItem {
  kind: "missing-directory" | "orphan-directory" | "stale-reservation" | "merged-branch";
  name: string;
  /**
   * found: reported only. removed/kept: after --prune. locked: a locked worktree, never touched.
   * unregistered: a directory without a registry entry, never removed by gc.
   */
  state: "found" | "removed" | "kept" | "locked" | "unregistered";
  why?: string;
}

export interface GcReport {
  items: GcItem[];
}

const RESERVATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let beforeBranchDelete: ((branch: string) => void) | null = null;

/** Test seam: runs between gc's scan and its locked re-check of a merged branch, to simulate a concurrent setup. */
export function setBeforeBranchDeleteHookForTests(hook: ((branch: string) => void) | null): void {
  beforeBranchDelete = hook;
}

/**
 * Reports registry entries without a directory, directories under .claude/worktrees without an entry
 * (Claude Code's own `worktree-*` branches excluded), reservations older than 24 hours whose branch does not
 * exist, and local branches merged into origin/main. With `prune` it removes them, running the safety guard
 * first wherever a worktree directory is involved. A locked worktree is reported and never touched.
 */
export function gc(repo: Repo, prune: boolean): GcReport {
  const items: GcItem[] = [];
  const reg = readRegistry(repo);
  const gitWts = listGitWorktrees(repo);
  const lockedPaths = new Set(gitWts.filter((w) => w.locked).map((w) => w.path));
  const wtByPath = new Map(gitWts.map((w) => [w.path, w]));
  const registeredPaths = new Set(Object.values(reg.worktrees).map((e) => e.path));

  // 1. Registry entries whose directory is gone.
  for (const [branch, entry] of Object.entries(reg.worktrees)) {
    if (existsSync(entry.path)) continue;
    const item: GcItem = { kind: "missing-directory", name: branch, state: "found" };
    items.push(item);
    if (lockedPaths.has(entry.path)) {
      item.state = "locked";
    } else if (prune) {
      gitTry(repo, ["worktree", "prune"]);
      withRegistry(repo, (r) => {
        if (r.worktrees[branch]?.path === entry.path && !existsSync(entry.path)) delete r.worktrees[branch];
      });
      item.state = "removed";
      item.why = "registry entry removed, branch kept";
    }
  }

  // 2. Directories under .claude/worktrees that no registry entry owns.
  let dirents: Dirent[] = [];
  try {
    dirents = readdirSync(repo.worktreesDir, { withFileTypes: true });
  } catch {
    // no worktrees directory
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const path = join(repo.worktreesDir, d.name);
    if (registeredPaths.has(path)) continue;
    const wt = wtByPath.get(path);
    if (wt?.branch?.startsWith("worktree-")) continue;
    const item: GcItem = { kind: "orphan-directory", name: d.name, state: "found" };
    items.push(item);
    if (lockedPaths.has(path)) {
      item.state = "locked";
      continue;
    }
    // A directory without a registry entry may belong to a setup or spawn that is running right now, so
    // gc never removes it, with or without --prune. The owner removes it by hand.
    item.state = "unregistered";
    item.why = wt ? "not registered; remove it by hand" : "not registered and not a worktree; remove it by hand";
  }

  // 3. Reservations older than 24 hours with no branch.
  const branchKnown = (b: string): boolean =>
    refExists(repo, `refs/heads/${b}`) ||
    refExists(repo, `refs/remotes/origin/${b}`) ||
    Object.hasOwn(reg.worktrees, b);
  for (const [number, res] of Object.entries(reg.reservations)) {
    const age = Date.now() - Date.parse(res.reservedAt);
    if (!(age > RESERVATION_MAX_AGE_MS) || branchKnown(res.branch)) continue;
    const item: GcItem = { kind: "stale-reservation", name: number, state: "found" };
    items.push(item);
    if (prune) {
      withRegistry(repo, (r) => {
        if (r.reservations[number]?.reservedAt === res.reservedAt) delete r.reservations[number];
      });
      item.state = "removed";
    }
  }

  // 4. Local branches merged into origin/main, unless something still uses them.
  const merged = gitTry(repo, ["branch", "--merged", "refs/remotes/origin/main", "--format=%(refname:short)"]);
  if (merged.code === 0) {
    const inUse = new Set<string>(["main"]);
    for (const w of gitWts) if (w.branch) inUse.add(w.branch);
    for (const b of Object.keys(reg.worktrees)) inUse.add(b);
    for (const res of Object.values(reg.reservations)) inUse.add(res.branch);
    if (repo.callerBranch) inUse.add(repo.callerBranch);
    for (const b of merged.stdout.split("\n")) {
      if (b === "" || inUse.has(b) || b.startsWith("worktree-")) continue;
      const item: GcItem = { kind: "merged-branch", name: b, state: "found" };
      items.push(item);
      if (!plainBranch(b)) {
        // Not a name bin/wt creates: report it, never hand it to git.
        item.state = "kept";
        item.why = "invalid-name";
        continue;
      }
      if (!prune) continue;
      beforeBranchDelete?.(b);
      // The lists above are a moment old. Under the registry lock, look again before deleting: a setup or
      // spawn that started since may have registered, reserved or checked out this branch.
      const outcome = withRegistry(repo, (r) => {
        if (Object.hasOwn(r.worktrees, b) || Object.values(r.reservations).some((res) => res.branch === b)) {
          return "in-use";
        }
        if (b === repo.callerBranch || listGitWorktrees(repo).some((w) => w.branch === b)) return "in-use";
        const stillMerged = gitTry(repo, [
          "merge-base",
          "--is-ancestor",
          `refs/heads/${b}`,
          "refs/remotes/origin/main",
        ]);
        if (stillMerged.code !== 0) return "in-use";
        return gitTry(repo, ["branch", "-D", "--", b]).code === 0 ? "removed" : "delete-failed";
      });
      if (outcome === "removed") {
        item.state = "removed";
      } else {
        item.state = "kept";
        item.why = outcome;
      }
    }
  }
  return { items };
}

export function formatGc(report: GcReport, prune: boolean): string {
  if (report.items.length === 0) return "Nothing to clean up.";
  const show = (s: string) => s.replace(/[^\x20-\x7e]/g, "?");
  const lines = report.items.map(
    (i) => `${i.state.padEnd(8)} ${i.kind} ${show(i.name)}${i.why ? ` (${show(i.why)})` : ""}`,
  );
  if (!prune && report.items.some((i) => i.state === "found")) lines.push("Run bin/wt gc --prune to remove them.");
  if (report.items.some((i) => i.state === "unregistered")) {
    lines.push(
      "Directories without a registry entry are never removed by gc. Remove one by hand once you are sure no setup or spawn uses it.",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Commands

interface InteractiveModule {
  setupWizard?: (repo: Repo) => { branch: string; from?: string } | null;
  cleanupPicker?: (repo: Repo) => string | null;
}

/** The interactive module, loaded only on a terminal. Without one (or without fzf) the handlers fall back to usage errors. */
async function loadInteractive(): Promise<InteractiveModule | null> {
  if (!terminal.isTTY()) return null;
  const file = join(import.meta.dirname, "interactive.ts");
  if (!existsSync(file)) return null;
  return (await import(pathToFileURL(file).href)) as InteractiveModule;
}

const setupCommand: Command = async ({ repo, args }) => {
  const { flags, positionals } = parseFlags(args, { from: "string", task: "string" }, 1);
  let branch = positionals[0];
  let from = flags.from as string | undefined;
  if (branch === undefined) {
    const picked = (await loadInteractive())?.setupWizard?.(repo) ?? null;
    if (!picked) throw new WtError(2, "Usage: bin/wt setup <branch> [--from <ref>] [--task <NNN>]");
    branch = picked.branch;
    from = picked.from ?? from;
  }
  const busy = await busyPorts();
  const r = setup(repo, { branch, from, task: flags.task as string | undefined, busy });
  say(`worktree: ${r.path}`);
  say(`branch: ${r.branch}`);
  say(`port: ${r.port}`);
  say(`EMEND_HOME: ${r.emendHome}`);
  say(`next: cd ${r.path} && pnpm install --frozen-lockfile`);
  return 0;
};

const listCommand: Command = ({ repo, args }) => {
  const { flags } = parseFlags(args, { json: "boolean" });
  const rows = list(repo);
  say(flags.json ? JSON.stringify(rows, null, 2) : formatList(rows));
  return 0;
};

const cleanupCommand: Command = async ({ repo, args }) => {
  const { flags, positionals } = parseFlags(args, { discard: "boolean", "close-workspace": "boolean" }, 1);
  let target = positionals[0];
  if (target === undefined) {
    target = (await loadInteractive())?.cleanupPicker?.(repo) ?? undefined;
    if (target === undefined)
      throw new WtError(2, "Usage: bin/wt cleanup [--discard] [--close-workspace] <branch|path>");
  }
  cleanup(repo, { target, closeWorkspace: flags["close-workspace"] === true, discard: flags.discard === true });
  return 0;
};

const gcCommand: Command = ({ repo, args }) => {
  const { flags } = parseFlags(args, { prune: "boolean" });
  const prune = flags.prune === true;
  say(formatGc(gc(repo, prune), prune));
  return 0;
};

export const commands: CommandTable = {
  gc: gcCommand,
  setup: setupCommand,
  list: listCommand,
  status: listCommand,
  cleanup: cleanupCommand,
};
