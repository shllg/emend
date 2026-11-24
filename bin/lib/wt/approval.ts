import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandTable } from "./command.ts";
import { repoDiagnostic } from "./diagnostics.ts";
import { run } from "./proc.ts";
import { git, linkedTop, listGitWorktrees, type Repo } from "./repo.ts";
import { branchName, commitSha, parseFlags, WtError } from "./validate.ts";

function worktreeRoots(repo: Repo): string[] {
  try {
    const roots = new Set([repo.mainRoot, ...listGitWorktrees(repo).map((worktree) => worktree.path)]);
    for (const path of [...roots]) {
      try {
        roots.add(realpathSync.native(path));
      } catch (error) {
        // A missing worktree still owns its listed path until Git prunes it.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }
    return [...roots];
  } catch {
    throw new WtError(69, "Could not determine this repository's worktree paths. bin/wt cannot check the approval.");
  }
}

function inside(roots: string[], path: string): boolean {
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
}

function unavailable(): WtError {
  return new WtError(
    69,
    process.env.RECENSE_BIN
      ? "RECENSE_BIN does not name an executable file."
      : "recense is not on PATH. Install recense, or set RECENSE_BIN to its absolute path.",
  );
}

export function recenseProgram(roots: string[]): string {
  const override = process.env.RECENSE_BIN;
  if (override && !isAbsolute(override)) throw new WtError(2, "RECENSE_BIN must be an absolute path.");
  const candidates = override
    ? [override]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(isAbsolute)
        .map((dir) => `${dir}${sep}recense`);
  for (const program of candidates) {
    let real: string;
    try {
      if (!statSync(program).isFile()) continue;
      accessSync(program, constants.X_OK);
      real = realpathSync.native(program);
    } catch {
      continue;
    }
    // This catches a recense copy in the repository. A wrapper can still dispatch elsewhere.
    if (inside(roots, program) || inside(roots, real)) {
      throw new WtError(
        69,
        "The recense program lies inside this repository. bin/wt reads approvals only through an installed recense.",
      );
    }
    // Shims dispatch on the invoked name.
    return program;
  }
  throw unavailable();
}

/** Check the nearest existing directory too, since recense can create its state on first use. */
function realpathInside(roots: string[], path: string): boolean {
  let dir = path;
  for (;;) {
    try {
      const real = realpathSync.native(dir);
      // A still-listed worktree may be among the missing directories below this ancestor.
      return inside(roots, real) || (dir !== path && inside(roots, resolve(real, relative(dir, path))));
    } catch (error) {
      const parent = dirname(dir);
      if (parent === dir || (error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      dir = parent;
    }
  }
}

export function assertRecenseEnv(roots: string[]): void {
  // Mirror stateDir and configDir in apps/recense/src/state/paths.ts.
  const home = homedir();
  const { XDG_DATA_HOME, XDG_CONFIG_HOME } = process.env;
  // The command also honours EMEND_HOME, the name before the rename, when RECENSE_HOME is unset.
  const homeName = process.env.RECENSE_HOME ? "RECENSE_HOME" : "EMEND_HOME";
  const RECENSE_HOME = process.env.RECENSE_HOME || process.env.EMEND_HOME;
  if (RECENSE_HOME && !isAbsolute(RECENSE_HOME)) throw new WtError(69, `${homeName} must be an absolute path.`);
  const dataHome = XDG_DATA_HOME && isAbsolute(XDG_DATA_HOME) ? XDG_DATA_HOME : join(home, ".local", "share");
  const configHome = XDG_CONFIG_HOME && isAbsolute(XDG_CONFIG_HOME) ? XDG_CONFIG_HOME : join(home, ".config");
  const state =
    RECENSE_HOME ||
    (process.platform === "darwin"
      ? join(home, "Library", "Application Support", "recense")
      : join(dataHome, "recense"));
  // recense moves the folders of the name before the rename into the new places on its first start, so a
  // link inside the repository at an old name would end up there. Check them as well.
  const legacyState =
    process.platform === "darwin" ? join(home, "Library", "Application Support", "emend") : join(dataHome, "emend");
  const folders: [string, string][] = [
    ["home", home],
    ["state", state],
    ["config", join(configHome, "recense")],
    ["old config", join(configHome, "emend")],
    ...(RECENSE_HOME ? [] : ([["old state", legacyState]] as [string, string][])),
  ];
  for (const [name, path] of folders) {
    const resolved = resolve(path);
    if (
      inside(roots, resolved) ||
      realpathInside(roots, resolved) ||
      (path !== resolved && realpathInside(roots, path))
    ) {
      throw new WtError(
        69,
        `recense's ${name} folder lies inside this repository. bin/wt reads approvals only from your own recense state.`,
      );
    }
  }
}

interface Revision {
  revision: number;
  head: string | null;
}

interface Review {
  id: string;
  state: string;
  branch: string | null;
  approved: Revision | null;
  newest: Revision | null;
}

const UUID =
  /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is Revision | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.revision === "number" &&
      Number.isSafeInteger(value.revision) &&
      value.revision > 0 &&
      (value.head === null || typeof value.head === "string"))
  );
}

function isReview(value: unknown): value is Review {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    UUID.test(value.id) &&
    (value.branch === null || typeof value.branch === "string") &&
    typeof value.state === "string" &&
    isRevision(value.newest) &&
    isRevision(value.approved)
  );
}

function parseReviews(stdout: string): Review[] {
  const unreadable = "recense returned a review list bin/wt cannot read.";
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    throw new WtError(69, unreadable);
  }
  if (!isRecord(list) || !Array.isArray(list.items) || list.items.length > 1000 || !list.items.every(isReview)) {
    throw new WtError(69, unreadable);
  }
  return list.items;
}

type Approval = { ok: true; reviewId: string; revision: number } | { ok: false; reason: string };

export function readApproval(repo: Repo, branch: string, sha: string): Approval {
  commitSha(sha);
  const roots = worktreeRoots(repo);
  const program = recenseProgram(roots);
  assertRecenseEnv(roots);
  const { code, stdout, stderr } = run(program, ["ls", "--json", "--head", sha], { cwd: homedir(), timeoutMs: 30_000 });
  if (code === 127) throw unavailable();
  if (code === 124) throw new WtError(69, "recense did not answer within 30 seconds.");
  if (code !== 0) {
    const usage = "Usage: recense ls [--json].";
    if (stdout.includes(usage) || stderr.includes(usage)) {
      const source = process.env.RECENSE_BIN ? "in RECENSE_BIN" : "on PATH";
      throw new WtError(
        69,
        `The recense ${source} is too old to report approvals; it needs 0.8.0 or later. Update it, or set RECENSE_BIN.`,
      );
    }
    const first = repoDiagnostic(repo, stderr).split("\n", 1)[0] ?? "";
    throw new WtError(69, `recense ls failed: ${first.slice(0, 200).replaceAll("\t", " ")}`);
  }

  const matches = parseReviews(stdout).filter((r) => r.approved?.head === sha || r.newest?.head === sha);
  const onBranch = matches.filter((r) => r.branch === branch);
  for (const { id, state, approved, newest } of onBranch) {
    if (state === "approved" && approved?.head === sha && newest?.revision === approved.revision) {
      return { ok: true, reviewId: id, revision: approved.revision };
    }
  }
  if (
    onBranch.some(({ approved, newest }) => approved?.head === sha && newest && newest.revision > approved.revision)
  ) {
    return { ok: false, reason: "a newer revision was published after the approval" };
  }
  if (onBranch.some((r) => r.newest?.head === sha)) return { ok: false, reason: "published, not approved" };
  if (matches.length && !onBranch.length)
    return { ok: false, reason: "the review of this commit names another branch" };
  return { ok: false, reason: "no review of this commit" };
}

export const commands: CommandTable = {
  approval: ({ repo, args }) => {
    const { flags } = parseFlags(args, { branch: "string", head: "string" });
    let branch: string;
    let sha: string;
    if (repo.callerTop === repo.mainRoot) {
      if (typeof flags.branch !== "string" || typeof flags.head !== "string") {
        throw new WtError(2, "In the main checkout, run bin/wt approval --branch <name> --head <sha>.");
      }
      branch = branchName(flags.branch);
      sha = flags.head;
    } else {
      const top = linkedTop(repo);
      if (flags.branch !== undefined) throw new WtError(2, "--branch is only for the main checkout.");
      if (!repo.callerBranch) throw new WtError(2, "HEAD is detached. Check out a branch first.");
      branch = repo.callerBranch;
      sha = typeof flags.head === "string" ? flags.head : git(repo, ["rev-parse", "HEAD"], { cwd: top });
    }
    const result = readApproval(repo, branch, sha);
    if (!result.ok) {
      process.stdout.write(`not approved: ${result.reason}\n`);
      return 1;
    }
    process.stdout.write(`approved ${sha} review ${result.reviewId} revision ${result.revision}\n`);
  },
};
