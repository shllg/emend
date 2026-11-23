import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { CommandTable } from "./command.ts";
import { run } from "./proc.ts";
import { git, linkedTop, type Repo } from "./repo.ts";
import { commitSha, parseFlags, WtError } from "./validate.ts";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function unavailable(): WtError {
  return new WtError(
    69,
    process.env.EMEND_BIN
      ? "EMEND_BIN does not name an executable file."
      : "emend is not on PATH. Install emend, or set EMEND_BIN to its absolute path.",
  );
}

export function emendProgram(repo: Repo): string {
  const override = process.env.EMEND_BIN;
  if (override && !isAbsolute(override)) throw new WtError(2, "EMEND_BIN must be an absolute path.");
  const candidates = override
    ? [override]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(isAbsolute)
        .map((dir) => `${dir}${sep}emend`);
  const root = realpathSync.native(repo.mainRoot);
  for (const program of candidates) {
    let real: string;
    try {
      if (!statSync(program).isFile()) continue;
      accessSync(program, constants.X_OK);
      real = realpathSync.native(program);
    } catch {
      continue;
    }
    if (inside(root, real)) {
      throw new WtError(
        1,
        "The emend program lies inside this repository. bin/wt reads approvals only through an installed emend.",
      );
    }
    // Shims dispatch on the invoked name.
    return program;
  }
  throw unavailable();
}

/** Check the nearest existing directory too, since emend can create its state on first use. */
function realpathInside(root: string, path: string): boolean {
  let dir = path;
  for (;;) {
    try {
      return inside(root, realpathSync.native(dir));
    } catch (error) {
      const parent = dirname(dir);
      if (parent === dir || (error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      dir = parent;
    }
  }
}

export function assertEmendEnv(repo: Repo): void {
  const root = realpathSync.native(repo.mainRoot);
  for (const name of ["EMEND_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) {
    const path = process.env[name];
    if (!path || !isAbsolute(path)) continue;
    const resolved = resolve(path);
    if (
      inside(repo.mainRoot, resolved) ||
      realpathInside(root, resolved) ||
      (path !== resolved && realpathInside(root, path))
    ) {
      throw new WtError(
        1,
        `${name} points inside this repository. bin/wt reads approvals only from your own emend state.`,
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
  const unreadable = "emend returned a review list bin/wt cannot read.";
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
  const program = emendProgram(repo);
  assertEmendEnv(repo);
  const { code, stdout, stderr } = run(program, ["ls", "--json", "--head", sha], { cwd: homedir(), timeoutMs: 30_000 });
  if (code === 127) throw unavailable();
  if (code === 124) throw new WtError(69, "emend did not answer within 30 seconds.");
  if (code !== 0) {
    const usage = "Usage: emend ls [--json].";
    if (stdout.includes(usage) || stderr.includes(usage)) {
      const source = process.env.EMEND_BIN ? "in EMEND_BIN" : "on PATH";
      throw new WtError(
        69,
        `The emend ${source} is too old to report approvals; it needs 0.8.0 or later. Update it, or set EMEND_BIN.`,
      );
    }
    const first = stripVTControlCharacters(stderr.split("\n", 1)[0] ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");
    throw new WtError(69, `emend ls failed: ${first.slice(0, 200)}`);
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
    const { flags } = parseFlags(args, { head: "string" });
    const top = linkedTop(repo);
    if (!repo.callerBranch) throw new WtError(2, "HEAD is detached. Check out a branch first.");
    const sha = typeof flags.head === "string" ? flags.head : git(repo, ["rev-parse", "HEAD"], { cwd: top });
    const result = readApproval(repo, repo.callerBranch, sha);
    if (!result.ok) {
      process.stdout.write(`not approved: ${result.reason}\n`);
      return 1;
    }
    process.stdout.write(`approved ${sha} review ${result.reviewId} revision ${result.revision}\n`);
  },
};
