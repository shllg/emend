import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type RunBytesResult, type RunResult, run, runBytes } from "./proc.ts";
import { WtError } from "./validate.ts";

export interface Repo {
  /** The main checkout: the parent of the shared git directory. */
  mainRoot: string;
  /** The shared git directory (`<mainRoot>/.git`). */
  commonDir: string;
  /** `<mainRoot>/.claude/worktrees`. */
  worktreesDir: string;
  /** The working tree root the caller stands in (the main checkout or a linked worktree), or null. */
  callerTop: string | null;
  /** The branch checked out there, or null for a detached HEAD or no working tree. */
  callerBranch: string | null;
}

/**
 * Settings on every git call: no filesystem monitor hook, and no work in submodules. The repository under
 * review is agent-written, so nothing configured there may run.
 * Output bin/wt parses or applies never carries color from the user's config.
 */
export const GIT_BASE = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "push.recurseSubmodules=no",
  "-c",
  "status.submoduleSummary=false",
  "-c",
  "diff.ignoreSubmodules=all",
  // a configured diff.submodule=diff would run a child diff inside an agent-written nested repository
  "-c",
  "diff.submodule=short",
  "-c",
  "color.ui=never",
  "-c",
  "color.advice=never",
  "-c",
  "color.branch=never",
  "-c",
  "color.diff=never",
  "-c",
  "color.grep=never",
  "-c",
  "color.interactive=never",
  "-c",
  "color.push=never",
  "-c",
  "color.remote=never",
  "-c",
  "color.showBranch=never",
  "-c",
  "color.status=never",
  "-c",
  "color.transport=never",
];

function rawGit(args: string[], cwd: string, input?: string, timeoutMs?: number): RunResult {
  return run("git", [...GIT_BASE, ...args], { cwd, input, timeoutMs });
}

const WORKTREE_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

function refuseLayout(): never {
  throw new WtError(69, "The repository layout is not the one bin/wt trusts. Nothing was changed.");
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isRealDirectory(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Checks that `top` is a linked worktree of `mainRoot` by its files alone, with no git call: `<top>/.git` is
 * a regular file naming `<mainRoot>/.git/worktrees/<id>`, that directory is real, its `commondir` leads back
 * to `<mainRoot>/.git` and its `gitdir` file names `<top>/.git`. Exit 69 otherwise.
 */
function isLinkedWorktreeOf(mainRoot: string, top: string): boolean {
  const common = join(mainRoot, ".git");
  const gitFile = join(top, ".git");
  try {
    if (!lstatSync(gitFile).isFile()) return false;
    const m = /^gitdir: (.+)\n$/.exec(readFileSync(gitFile, "utf8"));
    if (!m) return false;
    const gitdir = m[1] as string;
    const id = basename(gitdir);
    if (!WORKTREE_ID_RE.test(id) || gitdir !== join(common, "worktrees", id)) return false;
    if (realpathOrNull(gitdir) !== gitdir || !isRealDirectory(gitdir)) return false;
    const commondir = readFileSync(join(gitdir, "commondir"), "utf8").trim();
    if (realpathOrNull(resolve(gitdir, commondir)) !== common) return false;
    return readFileSync(join(gitdir, "gitdir"), "utf8").trim() === gitFile;
  } catch {
    return false;
  }
}

/**
 * Resolves the repository of `cwd`. Always acts on the main checkout, also from a linked worktree.
 */
export function resolveRepo(cwd: string): Repo {
  const common = rawGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (common.code !== 0 || common.stdout.trim() === "") {
    throw new WtError(1, "This is not inside a git repository.");
  }
  const commonDir = realpathOrNull(common.stdout.trim());
  if (commonDir === null) return refuseLayout();
  if (basename(commonDir) !== ".git") {
    throw new WtError(1, "This repository layout is not supported: the git directory is not <checkout>/.git.");
  }
  const mainRoot = dirname(commonDir);
  if (!isRealDirectory(commonDir)) return refuseLayout();
  const top = rawGit(["rev-parse", "--show-toplevel"], cwd);
  let callerTop: string | null = null;
  if (top.code === 0 && top.stdout.trim() !== "") {
    const real = realpathOrNull(top.stdout.trim());
    if (real === null) return refuseLayout();
    if (real !== mainRoot) {
      const listed = rawGit(["worktree", "list", "--porcelain"], mainRoot);
      const known =
        listed.code === 0 &&
        listed.stdout
          .split("\n")
          .filter((l) => l.startsWith("worktree "))
          .some((l) => realpathOrNull(l.slice("worktree ".length)) === real);
      if (!known) return refuseLayout();
      if (!isLinkedWorktreeOf(mainRoot, real)) return refuseLayout();
    }
    callerTop = real;
  }
  let callerBranch: string | null = null;
  if (callerTop) {
    const head = rawGit(["symbolic-ref", "--quiet", "--short", "HEAD"], callerTop);
    if (head.code === 0 && head.stdout.trim() !== "") callerBranch = head.stdout.trim();
  }
  return { mainRoot, commonDir, worktreesDir: join(mainRoot, ".claude", "worktrees"), callerTop, callerBranch };
}

/** Runs git (never through a shell) and returns stdout without its final newline. Throws WtError(1). */
export function git(repo: Repo, args: string[], opts: { cwd?: string; input?: string } = {}): string {
  const r = gitTry(repo, args, opts);
  if (r.code !== 0) {
    throw new WtError(1, `git ${args[0] ?? ""} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  return r.stdout;
}

/** Like git(), but returns the exit code and output instead of throwing. */
export function gitTry(repo: Repo, args: string[], opts: { cwd?: string; input?: string } = {}): RunResult {
  const r = rawGit(args, opts.cwd ?? repo.mainRoot, opts.input);
  return { ...r, stdout: r.stdout.replace(/\n$/, "") };
}

/** Runs git with byte input and output, returning failures without throwing. */
export function gitBytes(repo: Repo, args: string[], opts: { cwd?: string; input?: Buffer } = {}): RunBytesResult {
  return runBytes("git", [...GIT_BASE, ...args], { cwd: opts.cwd ?? repo.mainRoot, input: opts.input });
}

const GITLINK_MESSAGE = "A gitlink (submodule) entry is in HEAD or the index; bin/wt refuses it.";

function hasGitlink(output: string): boolean {
  return output.split("\n").some((l) => l.startsWith("160000 "));
}

/** Exit 1 when `git ls-files --stage` or `git ls-tree -r HEAD` in `top` lists a gitlink (mode 160000). */
export function assertNoGitlinks(repo: Repo, top: string): void {
  const index = gitTry(repo, ["ls-files", "--stage"], { cwd: top });
  if (index.code !== 0) throw new WtError(1, "The index could not be read, so bin/wt refuses to go on.");
  if (hasGitlink(index.stdout)) throw new WtError(1, GITLINK_MESSAGE);
  const head = gitTry(repo, ["ls-tree", "-r", "HEAD"], { cwd: top });
  if (head.code === 0 && hasGitlink(head.stdout)) throw new WtError(1, GITLINK_MESSAGE);
}

/** Exit 1 when the tree of `ref` holds a gitlink. For a branch that has no working tree yet. */
export function assertNoGitlinksInRef(repo: Repo, ref: string): void {
  const r = gitTry(repo, ["ls-tree", "-r", `${ref}^{tree}`]);
  if (r.code === 0 && hasGitlink(r.stdout)) throw new WtError(1, GITLINK_MESSAGE);
}

/** Exit 69 when core.hooksPath is set for this repository or worktree: repository hooks would run. */
export function assertNoLocalHooksPath(repo: Repo): void {
  for (const scope of ["--local", "--worktree"]) {
    const r = rawGit(["config", scope, "--get", "core.hooksPath"], repo.mainRoot);
    if (r.code === 0) {
      throw new WtError(69, "core.hooksPath is set for this repository, so bin/wt will not run. Nothing was changed.");
    }
  }
}

export function refExists(repo: Repo, ref: string): boolean {
  return gitTry(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code === 0;
}

export function assertRefFormat(repo: Repo, branch: string): void {
  if (gitTry(repo, ["check-ref-format", "--branch", branch]).code !== 0) {
    throw new WtError(2, "Invalid branch name.");
  }
}

/** `git fetch origin`. Exit 69 when the remote cannot be reached. */
export function fetchOrigin(repo: Repo): void {
  const r = rawGit(["fetch", "--quiet", "origin"], repo.mainRoot, undefined, 120_000);
  if (r.code !== 0) {
    throw new WtError(69, `Could not fetch from origin: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
}

export interface WorktreeRef {
  path: string;
  /** Short branch name, or null for a detached HEAD. */
  branch: string | null;
  bare: boolean;
  locked: boolean;
}

/** `git worktree list --porcelain`, including the main checkout. Paths are resolved. */
export function listGitWorktrees(repo: Repo): WorktreeRef[] {
  const out = git(repo, ["worktree", "list", "--porcelain"]);
  const result: WorktreeRef[] = [];
  let cur: WorktreeRef | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: resolve(line.slice("worktree ".length)), branch: null, bare: false, locked: false };
      result.push(cur);
    } else if (cur && line.startsWith("branch refs/heads/")) {
      cur.branch = line.slice("branch refs/heads/".length);
    } else if (cur && line === "bare") {
      cur.bare = true;
    } else if (cur && (line === "locked" || line.startsWith("locked "))) {
      cur.locked = true;
    }
  }
  return result;
}
