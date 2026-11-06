import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandTable } from "./command.ts";
import { withRegistry } from "./registry.ts";
import { assertNoGitlinks, fetchOrigin, git, gitBytes, gitTry, listGitWorktrees, type Repo } from "./repo.ts";
import { oneLine as checkOneLine, commitSha, parseFlags, refName, textArg, WtError } from "./validate.ts";

export type Onto = "origin/main" | "main";

export interface RebaseResult {
  result: "up-to-date" | "rebased" | "restacked";
  conflicts: string[];
  /** Backup refs written by this call (none for "up-to-date"). */
  backups: string[];
}

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

/** History-changing git calls run with repository hooks switched off: no hook of the reviewed repo runs. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

/** Each pin keeps one config key from changing the rebase's steps, the commits it replays, their messages, the refs it moves or how a pick resolves. */
const REBASE_PINS = [
  "-c",
  "rebase.instructionFormat=%s", // Keep formats from adding todo lines.
  "-c",
  "core.commentChar=#", // Also overrides core.commentString so todo lines stay uncommented.
  "-c",
  "core.abbrev=no", // Full todo ids keep refs from standing in for commits.
  "-c",
  "commit.cleanup=verbatim", // Keep replayed messages byte for byte.
  "-c",
  "i18n.commitEncoding=UTF-8", // Keep message bytes without an encoding header.
  "-c",
  "i18n.logOutputEncoding=UTF-8", // Git builds the todo in the log encoding; subjects must not become extra todo lines.
  "-c",
  "notes.rewrite.rebase=false", // Leave notes refs unchanged.
  "-c",
  "rerere.enabled=false", // Keep conflicts even when an rr-cache directory already exists.
  // Git's merge defaults keep config from changing how a pick resolves.
  "-c",
  "merge.renames=true",
  "-c",
  "merge.renameLimit=7000", // Git's default merge rename limit.
  "-c",
  "merge.directoryRenames=conflict",
  "-c",
  "merge.renormalize=false",
];

function hg(repo: Repo, top: string, args: string[], input?: string): string {
  return git(repo, [...NO_HOOKS, ...args], { cwd: top, input });
}

function hgTry(repo: Repo, top: string, args: string[], input?: string) {
  return gitTry(repo, [...NO_HOOKS, ...args], { cwd: top, input });
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

/** The last non-empty line of git's output, or `fallback`. */
function lastLine(text: string, fallback: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return oneLine(lines[lines.length - 1] ?? fallback);
}

/** The branch checked out in `top`. Exit 1 for a detached HEAD or `main`: bin/wt never rewrites those. */
function currentBranch(repo: Repo, top: string): string {
  const r = gitTry(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: top });
  if (r.code !== 0 || r.stdout === "") throw new WtError(1, "HEAD is detached. Check out a branch first.");
  if (r.stdout === "main") throw new WtError(1, "This changes history and never runs on main.");
  return r.stdout;
}

function operationInProgress(repo: Repo, top: string): boolean {
  const dir = gitTry(repo, ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: top });
  return dir.code !== 0 || dir.stdout === "" || IN_PROGRESS.some((name) => existsSync(join(dir.stdout, name)));
}

/** Exit 1 unless the tree is clean (untracked files included) and no operation is in progress. */
function assertClean(repo: Repo, top: string): void {
  const st = gitTry(repo, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all"], {
    cwd: top,
  });
  if (st.code !== 0) throw new WtError(1, "Could not read the working tree state. Nothing was changed.");
  if (st.stdout.trim() !== "") {
    throw new WtError(1, "The working tree is not clean (untracked files count). Commit or remove them first.");
  }
  if (operationInProgress(repo, top)) {
    throw new WtError(1, "A git operation is in progress. Finish or abort it first.");
  }
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[-:]/g, "");
}

/** Writes refs/wt-backup/<name>/<UTC time> pointing at `sha` and returns the ref name. */
function writeBackup(repo: Repo, name: string, sha: string): string {
  const base = `refs/wt-backup/${name}/${timestamp()}`;
  let ref = base;
  for (let i = 2; gitTry(repo, ["rev-parse", "--verify", "--quiet", ref]).code === 0; i++) ref = `${base}-${i}`;
  git(repo, ["update-ref", ref, sha]);
  return ref;
}

function requireRef(repo: Repo, top: string, ref: string): string {
  const r = gitTry(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: top });
  if (r.code !== 0) throw new WtError(1, `Reference ${ref} does not exist here.`);
  return r.stdout;
}

function isAncestor(repo: Repo, top: string, ancestor: string, of: string): boolean {
  return gitTry(repo, ["merge-base", "--is-ancestor", ancestor, of], { cwd: top }).code === 0;
}

// ---------------------------------------------------------------------------------------------
// restack, rebase

function unmergedPaths(repo: Repo, top: string): string[] {
  const out = git(repo, ["ls-files", "--unmerged", "-z"], { cwd: top });
  const paths = new Set<string>();
  for (const entry of out.split("\0")) {
    if (entry !== "") paths.add(entry.slice(entry.indexOf("\t") + 1));
  }
  return [...paths];
}

/**
 * Replays the branch's whole change on `onto` without leaving an operation in progress: HEAD ends at `onto`,
 * the index equals HEAD, and the working tree holds the change, with conflict markers where it did not apply.
 */
export function restack(repo: Repo, top: string, onto: Onto): { conflicts: string[]; backups: string[] } {
  const branch = currentBranch(repo, top);
  assertNoGitlinks(repo, top);
  assertClean(repo, top);
  if (onto === "origin/main") fetchOrigin(repo);
  const target = requireRef(repo, top, onto);
  const old = requireRef(repo, top, "HEAD");
  const backup = writeBackup(repo, branch, old);
  return { ...replay(repo, top, old, target, backup), backups: [backup] };
}

/** The caller has already written the backup ref `backup` for `old`. */
function replay(repo: Repo, top: string, old: string, target: string, backup: string): { conflicts: string[] } {
  const mb = gitTry(repo, ["merge-base", target, old], { cwd: top });
  if (mb.code !== 0 || mb.stdout === "") {
    throw new WtError(1, `The branch and its target share no history. The branch is unchanged. backup: ${backup}`);
  }

  // Use plumbing so the user's and the repo's diff settings do not shape the patch.
  // The pins cover what plumbing still reads.
  const patch = gitBytes(
    repo,
    [
      "-c",
      "diff.suppressBlankEmpty=false",
      "diff-tree",
      "-p",
      "--binary",
      "--no-color",
      "--unified=3",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--find-renames",
      "-l1000",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      mb.stdout,
      old,
    ],
    { cwd: top },
  );
  if (patch.code !== 0) {
    throw new WtError(
      1,
      `The change could not be read: ${oneLine(patch.stderr)}. The branch is unchanged. backup: ${backup}`,
    );
  }
  hg(repo, top, ["reset", "--hard", "--quiet", target]);
  const hasChange =
    gitTry(repo, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", mb.stdout, old], {
      cwd: top,
    }).code !== 0;
  if (!hasChange) return { conflicts: [] };
  const applied = gitBytes(
    repo,
    [
      ...NO_HOOKS,
      "-c",
      "apply.ignoreWhitespace=no",
      "-c",
      "rerere.enabled=false", // The restack also leaves conflicts as conflicts.
      "apply",
      "--3way",
      "--whitespace=nowarn",
    ],
    { cwd: top, input: patch.stdout },
  );
  const conflicts = unmergedPaths(repo, top);
  if (applied.code !== 0 && conflicts.length === 0) {
    // Nothing usable was written. Put the branch back exactly as it was.
    hg(repo, top, ["reset", "--hard", "--quiet", old]);
    throw new WtError(
      1,
      `The change could not be replayed: ${oneLine(applied.stderr)}. The branch is unchanged. backup: ${backup}`,
    );
  }
  hg(repo, top, ["reset", "--quiet"]);
  return { conflicts };
}

/** Aborts an unfinished rebase back to `old`; reports a finished wrong result without changing it. */
export function checkRebased(
  repo: Repo,
  top: string,
  branch: string,
  target: string,
  old: string,
  backup: string,
): void {
  if (operationInProgress(repo, top)) {
    const why = "a git operation is still in progress";
    const aborted = hgTry(repo, top, [...REBASE_PINS, "rebase", "--abort"]);
    const attached = gitTry(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: top });
    const head = gitTry(repo, ["rev-parse", "--verify", "HEAD"], { cwd: top });
    if (
      aborted.code === 0 &&
      !operationInProgress(repo, top) &&
      attached.code === 0 &&
      attached.stdout === branch &&
      head.code === 0 &&
      head.stdout === old
    ) {
      throw new WtError(
        1,
        `The rebase exited 0 but did not finish: ${why}. It was aborted and the branch is unchanged. backup: ${backup}`,
      );
    }
    throw new WtError(
      1,
      `The rebase exited 0 but did not finish: ${why}, and it could not be aborted. The repository is mid-rebase: do not continue it by hand. backup: ${backup}`,
    );
  }

  let why: string | undefined;
  const head = gitTry(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: top });
  if (head.code !== 0 || head.stdout !== branch) why = `HEAD is not attached to ${branch}`;
  else if (!isAncestor(repo, top, target, "HEAD")) why = "the target is not an ancestor of HEAD";
  if (why !== undefined) {
    throw new WtError(
      1,
      `The rebase exited 0 with a wrong result: ${why}. The branch may already be rewritten; the backup ref holds the old tip. backup: ${backup}`,
    );
  }
}

export function rebase(repo: Repo, top: string, onto: Onto): RebaseResult {
  const branch = currentBranch(repo, top);
  assertNoGitlinks(repo, top);
  assertClean(repo, top);
  if (onto === "origin/main") fetchOrigin(repo);
  const target = requireRef(repo, top, onto);
  const old = requireRef(repo, top, "HEAD");
  if (isAncestor(repo, top, target, old)) return { result: "up-to-date", conflicts: [], backups: [] };

  const backup = writeBackup(repo, branch, old);
  // Use the merge backend and ort, with flags and pins controlling the steps, commits replayed,
  // their messages and how each pick resolves.
  const r = hgTry(repo, top, [
    ...REBASE_PINS,
    "rebase",
    "--merge",
    "--strategy=ort",
    "--reapply-cherry-picks", // Do not skip commits by a whitespace-insensitive patch match.
    "--empty=drop", // Drop commits that become empty.
    "--no-autostash",
    "--no-autosquash",
    "--no-fork-point",
    "--no-update-refs",
    "--no-rebase-merges",
    target,
  ]);
  if (r.code === 0) {
    checkRebased(repo, top, branch, target, old, backup);
    return { result: "rebased", conflicts: [], backups: [backup] };
  }

  // Only a content conflict leads to a restack. Read the index before the abort removes the evidence.
  const conflicted = gitTry(repo, ["ls-files", "--unmerged", "-z"], { cwd: top }).stdout !== "";
  if (operationInProgress(repo, top)) hgTry(repo, top, [...REBASE_PINS, "rebase", "--abort"]);
  const head = gitTry(repo, ["rev-parse", "--verify", "HEAD"], { cwd: top }).stdout;
  if (operationInProgress(repo, top) || head !== old) {
    throw new WtError(
      1,
      `The rebase failed and could not be aborted cleanly. The backup ref holds the old tip. backup: ${backup}`,
    );
  }
  if (!conflicted) {
    const why = lastLine(r.stderr || r.stdout, `git exited ${r.code}`);
    throw new WtError(1, `The rebase failed: ${why}. The branch is unchanged. backup: ${backup}`);
  }
  return { result: "restacked", conflicts: replay(repo, top, old, target, backup).conflicts, backups: [backup] };
}

// ---------------------------------------------------------------------------------------------
// sync-main, land

export type SyncResult = { result: "fast-forwarded" | "up-to-date" | "refused"; reason?: string };

/** Moves local main to `target` when that is a fast-forward. Never stashes, resets or switches branches. */
function moveMain(repo: Repo, target: string): SyncResult {
  if (gitTry(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main"]).code !== 0) {
    return { result: "refused", reason: "there is no local main branch" };
  }
  if (isAncestor(repo, repo.mainRoot, target, "refs/heads/main")) return { result: "up-to-date" };
  const checkedOut = listGitWorktrees(repo).find((w) => w.branch === "main");
  const r = checkedOut
    ? hgTry(repo, checkedOut.path, ["merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", target])
    : hgTry(repo, repo.mainRoot, ["fetch", "--quiet", ".", `${target}:refs/heads/main`]);
  if (r.code !== 0) return { result: "refused", reason: oneLine(r.stderr || r.stdout) || `git exited ${r.code}` };
  return { result: "fast-forwarded" };
}

export function syncMain(repo: Repo): SyncResult {
  fetchOrigin(repo);
  if (gitTry(repo, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]).code !== 0) {
    return { result: "refused", reason: "origin/main does not exist" };
  }
  return moveMain(repo, "refs/remotes/origin/main");
}

function checkMessage(subject: string, body: string): string {
  if (subject.trim() === "") throw new WtError(2, "The subject must be 1 to 72 characters.");
  checkOneLine(subject, "subject");
  const text = body.replace(/\r\n/g, "\n").trim();
  return text === "" ? `${subject}\n` : `${subject}\n\n${text}\n`;
}

/**
 * Squashes the branch into one signed commit on top of local main and moves main there. Never pushes.
 * `matchHead` is the approved head commit: the tree that lands is that commit's tree, never a later HEAD.
 */
export function land(
  repo: Repo,
  top: string,
  subject: string,
  body: string,
  matchHead: string,
): { commit: string; backups: string[] } {
  const branch = currentBranch(repo, top);
  const approved = commitSha(matchHead);
  const head = requireRef(repo, top, "HEAD");
  if (head !== approved) throw new WtError(1, "HEAD is not the approved head commit.");
  const message = checkMessage(subject, body);
  assertNoGitlinks(repo, top);
  assertClean(repo, top);
  const main = requireRef(repo, top, "refs/heads/main");
  if (!isAncestor(repo, top, main, head)) {
    throw new WtError(1, "main is not an ancestor of this branch. Rebase onto main first.");
  }
  const tree = git(repo, ["rev-parse", "--verify", `${head}^{tree}`], { cwd: top });
  if (tree === git(repo, ["rev-parse", "--verify", `${main}^{tree}`], { cwd: top })) {
    throw new WtError(1, "There is nothing to land: the branch tree equals main.");
  }
  const backups = [writeBackup(repo, branch, head), writeBackup(repo, "main", main)];
  const names = backups.join(" ");
  const made = hgTry(repo, top, ["commit-tree", "-S", tree, "-p", main], message);
  const commit = made.stdout.trim();
  if (made.code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    const why = lastLine(made.stderr, `exit ${made.code}`);
    throw new WtError(1, `git did not make the commit: ${why}. Nothing was changed. backup: ${names}`);
  }
  // Record the commit before main moves. The safety guard needs landedAs to be an ancestor of main, so an
  // early record can never make a cleanup delete work that did not land.
  try {
    withRegistry(repo, (r) => {
      const entry = r.worktrees[branch];
      if (entry) entry.landedAs = commit;
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : "unknown error";
    throw new WtError(1, `Could not record the landed commit: ${why} main did not move. backup: ${names}`);
  }
  const moved = moveMain(repo, commit);
  if (moved.result === "refused") {
    throw new WtError(
      1,
      `main did not move: ${moved.reason ?? "refused"}. landedAs points at the unlanded commit ${commit}; the next land replaces it. backup: ${names}`,
    );
  }
  return { commit, backups };
}

// ---------------------------------------------------------------------------------------------
// digest

/**
 * A hash of the change itself: the diff from the merge base to `head` with three lines of context, hunk
 * headers reduced to `@@` plus their function-context text (no line numbers) and blob ids removed. File paths and mode lines stay. A pure
 * line shift keeps it; a changed line, or the same change at another place or in another file, changes it.
 */
export function changeDigest(repo: Repo, base: string, head: string): string {
  const cwd = repo.callerTop ?? repo.mainRoot;
  const diff = git(
    repo,
    [
      "diff",
      "--unified=3",
      "--binary",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      "--diff-algorithm=myers",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `${base}...${head}`,
      "--",
    ],
    { cwd },
  );
  const kept = diff
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .map((line) => (line.startsWith("@@ ") ? line.replace(/^@@ [^@]*@@/, "@@") : line));
  return createHash("sha256").update(kept.join("\n")).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Commands

function linkedTop(repo: Repo): string {
  if (repo.callerTop === null || repo.callerTop === repo.mainRoot) {
    throw new WtError(2, "Run this from inside a linked worktree.");
  }
  return repo.callerTop;
}

function ontoFlag(value: string | boolean | undefined): Onto {
  if (value === undefined) return "origin/main";
  if (value === "origin/main" || value === "main") return value;
  throw new WtError(2, "--onto must be origin/main or main.");
}

/** Replaces C0 controls, DEL and C1 controls (U+0080 to U+009F): a path must not steer a terminal. */
function printable(path: string): string {
  let out = "";
  for (const ch of path) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? "?" : ch;
  }
  return out;
}

export function conflictLines(conflicts: string[]): string {
  return conflicts.map((p) => `conflict: ${printable(p)}\n`).join("");
}

function backupLines(backups: string[]): string {
  return backups.map((b) => `backup: ${b}\n`).join("");
}

export const commands: CommandTable = {
  rebase: ({ repo, args }) => {
    const { flags } = parseFlags(args, { onto: "string" });
    const r = rebase(repo, linkedTop(repo), ontoFlag(flags.onto));
    process.stdout.write(`${r.result}\n${backupLines(r.backups)}${conflictLines(r.conflicts)}`);
  },
  restack: ({ repo, args }) => {
    const { flags } = parseFlags(args, { onto: "string" });
    const r = restack(repo, linkedTop(repo), ontoFlag(flags.onto));
    process.stdout.write(`restacked\n${backupLines(r.backups)}${conflictLines(r.conflicts)}`);
  },
  land: ({ repo, args }) => {
    const { flags } = parseFlags(args, {
      "match-head": "string",
      subject: "string",
      body: "string",
      "body-file": "string",
    });
    const matchHead = flags["match-head"];
    const subjectText = flags.subject;
    if (typeof matchHead !== "string" || typeof subjectText !== "string") {
      throw new WtError(2, "land needs --match-head, --subject and --body or --body-file.");
    }
    commitSha(matchHead);
    const body = textArg(
      typeof flags.body === "string" ? flags.body : undefined,
      typeof flags["body-file"] === "string" ? flags["body-file"] : undefined,
      "body",
      true,
    ) as string;
    const top = linkedTop(repo);
    const { commit, backups } = land(repo, top, subjectText.trim(), body, matchHead);
    process.stdout.write(`${backupLines(backups)}landed ${commit}\n`);
  },
  "sync-main": ({ repo, args }) => {
    parseFlags(args, {});
    const r = syncMain(repo);
    if (r.result === "refused") {
      process.stdout.write(`refused: ${r.reason ?? "git refused"}\n`);
      return 1;
    }
    process.stdout.write(`${r.result}\n`);
  },
  digest: ({ repo, args }) => {
    const { flags } = parseFlags(args, { base: "string", head: "string" });
    const base = flags.base === undefined ? "origin/main" : refName(String(flags.base));
    const head = flags.head === undefined ? "HEAD" : refName(String(flags.head));
    if (repo.callerTop === null) throw new WtError(2, "Run this from inside a worktree.");
    process.stdout.write(`${changeDigest(repo, base, head)}\n`);
  },
};
