import type { Command, CommandTable } from "./command.ts";
import { type RunResult, run } from "./proc.ts";
import { fetchOrigin, gitTry, type Repo } from "./repo.ts";
import { branchName, commitSha, oneLine, parseFlags, prNumber, textArg, WtError } from "./validate.ts";

// ---------------------------------------------------------------------------------------------
// gh plumbing

const GH_TIMEOUT_MS = 90_000;
const NO_OPEN_PR = "No open pull request for this branch.";

/** Runs gh in the main checkout (every gh call targets the same repository from there). */
function ghTry(repo: Repo, args: string[], input?: string): RunResult {
  return run("gh", args, { cwd: repo.mainRoot, input, timeoutMs: GH_TIMEOUT_MS });
}

/** Maps a failed gh call to an exit code: 69 for a missing tool, no login or no network, 1 otherwise. */
function ghFailure(r: RunResult, what: string): never {
  const err = r.stderr;
  if (r.code === 127) throw new WtError(69, "gh is not installed or not runnable.");
  if (r.code === 124) throw new WtError(69, `${what} timed out.`);
  if (r.code === 4 || /not logged in|gh auth login|bad credentials|http 401|authentication/i.test(err)) {
    throw new WtError(69, "gh is not logged in. The owner must run gh auth login.");
  }
  if (/error connecting|could not resolve host|network is unreachable|dial tcp|i\/o timeout/i.test(err)) {
    throw new WtError(69, "GitHub is not reachable.");
  }
  const first = err.trim().split("\n")[0] ?? "";
  throw new WtError(1, `${what} failed${first ? `: ${first}` : ` (exit ${r.code})`}`);
}

function gh(repo: Repo, args: string[], what: string, input?: string): string {
  const r = ghTry(repo, args, input);
  if (r.code !== 0) ghFailure(r, what);
  return r.stdout;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new WtError(1, `${what} returned output bin/wt could not read.`);
  }
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new WtError(1, `${what} returned output bin/wt could not read.`);
  }
  return v as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Free text

// ---------------------------------------------------------------------------------------------
// fetch and push

export function fetch(repo: Repo): void {
  fetchOrigin(repo);
}

/**
 * The git push argument list: a full refspec (no DWIM resolution to a tag), no tags followed.
 * A force push names the local branch as its source, so a pre-push guard can check the update against
 * that branch's reflog; a plain push sends the resolved commit id.
 * `--force-if-includes` goes with `--force-with-lease`, never alone.
 */
export function pushArgs(sha: string, branch: string, forceWithLease: boolean): string[] {
  const args = ["push", "-u", "--no-follow-tags"];
  if (forceWithLease) args.push("--force-with-lease", "--force-if-includes");
  const source = forceWithLease ? `refs/heads/${branch}` : sha;
  args.push("origin", `${source}:refs/heads/${branch}`);
  return args;
}

export function push(repo: Repo, top: string, o: { forceWithLease: boolean; beforePush?: () => void }): void {
  const head = gitTry(repo, ["symbolic-ref", "--quiet", "HEAD"], { cwd: top });
  if (head.code !== 0 || head.stdout === "") throw new WtError(2, "HEAD is detached. Nothing was pushed.");
  if (!head.stdout.startsWith("refs/heads/")) throw new WtError(2, "HEAD is not a local branch. Nothing was pushed.");
  const branch = branchName(head.stdout.slice("refs/heads/".length));
  // HEAD is resolved once. A plain push sends that commit id. A lease push sends the branch, so it first
  // checks that the branch still points at that commit. Git reads the branch once when the push starts, so
  // a commit made after that read cannot go out; one that lands between the check and the read would.
  const sha = gitTry(repo, ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: top });
  if (sha.code !== 0 || !/^[0-9a-f]{40}$/.test(sha.stdout)) {
    throw new WtError(1, "Could not resolve HEAD. Nothing was pushed.");
  }
  o.beforePush?.();
  if (o.forceWithLease) {
    const current = gitTry(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: top });
    if (current.code !== 0 || current.stdout !== sha.stdout) {
      throw new WtError(1, "The branch moved after HEAD was resolved. Nothing was pushed.");
    }
  }
  const r = gitTry(repo, pushArgs(sha.stdout, branch, o.forceWithLease), { cwd: top });
  if (r.code !== 0) {
    if (
      /could not resolve|unable to access|could not read from remote|connection (timed out|refused|reset)|network is unreachable/i.test(
        r.stderr,
      )
    ) {
      throw new WtError(69, "Could not reach origin. Nothing was pushed.");
    }
    throw new WtError(1, `git push failed: ${r.stderr.trim().split("\n").slice(-1)[0] || `exit ${r.code}`}`);
  }
  // `-u` does nothing for a plain push's commit id source, so set the upstream here (the push updated origin/<branch>).
  gitTry(repo, ["branch", "--set-upstream-to", `origin/${branch}`, branch], { cwd: top });
}

// ---------------------------------------------------------------------------------------------
// Pull request lookup

const BASE_FIELDS = "number,state,headRefName,isCrossRepository";

interface Pr {
  number: number;
  data: Record<string, unknown>;
}

function toPr(data: Record<string, unknown>): Pr {
  const n = data.number;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new WtError(1, "gh returned a pull request number bin/wt does not accept.");
  }
  return { number: n, data };
}

function callerBranch(repo: Repo): string {
  if (!repo.callerBranch) throw new WtError(2, "HEAD is detached: there is no branch to find a pull request for.");
  const b = branchName(repo.callerBranch);
  // gh reads an all-digit argument as a pull request number, not as a branch.
  if (/^[0-9]+$/.test(b)) throw new WtError(2, "Invalid branch name.");
  return b;
}

/** The open PR whose head is `branch` in this repository, or null. */
function openPrForBranch(repo: Repo, branch: string, extraFields: string[] = []): Pr | null {
  const fields = [BASE_FIELDS, ...extraFields].join(",");
  const r = ghTry(repo, ["pr", "view", branch, "--json", fields]);
  if (r.code !== 0) {
    if (/no pull requests? found/i.test(r.stderr)) return null;
    ghFailure(r, "gh pr view");
  }
  const data = asObject(parseJson(r.stdout, "gh pr view"), "gh pr view");
  if (data.state !== "OPEN" || data.headRefName !== branch || data.isCrossRepository === true) return null;
  return toPr(data);
}

function requireOpenPr(repo: Repo, extraFields: string[] = []): Pr {
  const pr = openPrForBranch(repo, callerBranch(repo), extraFields);
  if (!pr) throw new WtError(1, NO_OPEN_PR);
  return pr;
}

/**
 * The PR a command acts on. Without `prArg`: the caller branch's open PR. With it: from any checkout, only
 * for an open PR into main whose head is in this repository (exit 1 else).
 */
function resolvePr(repo: Repo, prArg: string | undefined, extraFields: string[] = []): Pr {
  if (prArg === undefined) return requireOpenPr(repo, extraFields);
  const n = prNumber(prArg);
  const fields = [BASE_FIELDS, "baseRefName", ...extraFields].join(",");
  const r = ghTry(repo, ["pr", "view", String(n), "--json", fields]);
  if (r.code !== 0) {
    if (/no pull requests? found|could not resolve to a pullrequest/i.test(r.stderr)) {
      throw new WtError(1, "That pull request does not exist.");
    }
    ghFailure(r, "gh pr view");
  }
  const data = asObject(parseJson(r.stdout, "gh pr view"), "gh pr view");
  if (data.number !== n) throw new WtError(1, "gh returned a different pull request than the one asked for.");
  if (data.state !== "OPEN") throw new WtError(1, NO_OPEN_PR);
  if (data.baseRefName !== "main") throw new WtError(1, "The pull request does not target main.");
  if (data.isCrossRepository !== false) throw new WtError(1, "The pull request comes from a fork.");
  return toPr(data);
}

// ---------------------------------------------------------------------------------------------
// pr subcommands. Each returns the text for stdout (possibly empty).

export function prCreate(repo: Repo, o: { title: string; body: string; draft: boolean }): string {
  const branch = callerBranch(repo);
  const title = oneLine(o.title, "title");
  fetchOrigin(repo);
  requireNoUnpushedMain(repo, "HEAD", repo.callerTop ?? repo.mainRoot, "Nothing was created.");
  if (openPrForBranch(repo, branch)) throw new WtError(3, "An open pull request already exists for this branch.");
  const args = ["pr", "create", "--head", branch, "--base", "main", `--title=${title}`];
  if (o.draft) args.push("--draft");
  return gh(repo, [...args, "--body-file", "-"], "gh pr create", o.body);
}

export function prEdit(repo: Repo, o: { pr?: string; title?: string; body?: string }): string {
  if (o.title === undefined && o.body === undefined) {
    throw new WtError(2, "Nothing to change: give --title, --body or --body-file.");
  }
  const title = o.title === undefined ? null : oneLine(o.title, "title");
  const pr = resolvePr(repo, o.pr);
  const args = ["pr", "edit", String(pr.number)];
  if (title !== null) args.push(`--title=${title}`);
  if (o.body === undefined) return gh(repo, args, "gh pr edit");
  return gh(repo, [...args, "--body-file", "-"], "gh pr edit", o.body);
}

const LOCAL_MAIN_MESSAGE = "This branch holds commits of local main that origin/main lacks. Push main first.";

/**
 * Exit 1 when `head` is built on commits of local main that origin/main lacks: a squash merge would carry them
 * into origin/main and local main would diverge. Reads refs only; it never pushes main. Skipped without a local main.
 */
function requireNoUnpushedMain(repo: Repo, head: string, cwd: string, outcome: string): void {
  if (gitTry(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main"], { cwd }).code !== 0) return;
  const mb = gitTry(repo, ["merge-base", head, "refs/heads/main"], { cwd });
  const ok =
    mb.code === 0 &&
    mb.stdout !== "" &&
    gitTry(repo, ["merge-base", "--is-ancestor", mb.stdout, "refs/remotes/origin/main"], { cwd }).code === 0;
  if (!ok) throw new WtError(1, `${LOCAL_MAIN_MESSAGE} ${outcome}`);
}

/** The PR head, fetched as a temporary ref, must be the reviewed commit; then the unpushed-main check runs on it. */
function checkMergeBase(repo: Repo, n: number, sha: string): void {
  fetchOrigin(repo);
  const ref = `refs/wt-pr-merge/${n}`;
  const fetched = gitTry(repo, ["fetch", "--quiet", "origin", `+refs/pull/${n}/head:${ref}`]);
  if (fetched.code !== 0) throw new WtError(69, "Could not fetch the pull request head. Nothing was merged.");
  try {
    if (gitTry(repo, ["rev-parse", "--verify", ref]).stdout !== sha) {
      throw new WtError(1, "The pull request head is not the reviewed commit. Nothing was merged.");
    }
    requireNoUnpushedMain(repo, sha, repo.mainRoot, "Nothing was merged.");
  } finally {
    gitTry(repo, ["update-ref", "-d", ref]);
  }
}

/** Deletes only the remote head branch. The local branch is never touched; a failure is one stderr line. */
function deleteRemoteBranch(repo: Repo, head: unknown, mergedHead: string): void {
  const keep = (why: string) => process.stderr.write(`remote branch kept: ${why}\n`);
  let branch: string;
  try {
    branch = branchName(String(head));
  } catch {
    keep("the head branch name is not one bin/wt deletes");
    return;
  }
  // The lease keeps a branch that moved after the merge: only the merged head is deleted.
  const r = gitTry(repo, [
    "push",
    `--force-with-lease=refs/heads/${branch}:${mergedHead}`,
    "origin",
    "--delete",
    `refs/heads/${branch}`,
  ]);
  if (r.code !== 0) keep(r.stderr.trim().split("\n").slice(-1)[0] || `git exited ${r.code}`);
}

/**
 * Squash-merges the PR. Requires base `main`, a same-repository head, state OPEN and a head commit equal to
 * `matchHead`. Returns `MERGED <mergeCommit>` or `QUEUED`.
 */
export function prMerge(repo: Repo, o: { pr?: string; matchHead: string; subject: string; body: string }): string {
  const sha = commitSha(o.matchHead);
  const subject = oneLine(o.subject, "subject");
  const n = o.pr !== undefined ? prNumber(o.pr) : requireOpenPr(repo).number;
  const r = ghTry(repo, [
    "pr",
    "view",
    String(n),
    "--json",
    "number,baseRefName,headRefName,isCrossRepository,state,headRefOid",
  ]);
  if (r.code !== 0) {
    if (/no pull requests? found|could not resolve to a pullrequest/i.test(r.stderr))
      throw new WtError(1, "That pull request does not exist.");
    ghFailure(r, "gh pr view");
  }
  const pr = asObject(parseJson(r.stdout, "gh pr view"), "gh pr view");
  if (pr.baseRefName !== "main") throw new WtError(1, "The pull request does not target main. Nothing was merged.");
  if (pr.isCrossRepository !== false) throw new WtError(1, "The pull request comes from a fork. Nothing was merged.");
  if (pr.state !== "OPEN") throw new WtError(1, "The pull request is not open. Nothing was merged.");
  if (pr.headRefOid !== sha)
    throw new WtError(1, "The pull request head is not the reviewed commit. Nothing was merged.");

  checkMergeBase(repo, n, sha);

  const merge = ghTry(
    repo,
    ["pr", "merge", String(n), "--squash", "--match-head-commit", sha, `--subject=${subject}`, "--body-file", "-"],
    o.body,
  );
  // gh can fail after the merge succeeded (for example when the merge is queued or the read races), so read the state back.
  const after = ghTry(repo, ["pr", "view", String(n), "--json", "state,mergeCommit"]);
  if (after.code !== 0) {
    if (merge.code !== 0) ghFailure(merge, "gh pr merge");
    throw new WtError(
      1,
      "gh pr merge succeeded, but the pull request could not be read back. The merge may have happened: check with gh pr view.",
    );
  }
  const state = asObject(parseJson(after.stdout, "gh pr view"), "gh pr view");
  if (state.state === "MERGED") {
    const oid =
      typeof state.mergeCommit === "object" && state.mergeCommit !== null
        ? (state.mergeCommit as Record<string, unknown>).oid
        : undefined;
    if (typeof oid !== "string" || !/^[0-9a-f]{40}$/.test(oid))
      throw new WtError(1, "The pull request is merged, but its merge commit could not be read.");
    deleteRemoteBranch(repo, pr.headRefName, sha);
    return `MERGED ${oid}`;
  }
  if (merge.code !== 0) ghFailure(merge, "gh pr merge");
  if (state.state === "OPEN") return "QUEUED";
  throw new WtError(1, "The pull request was closed without a merge.");
}

// ---------------------------------------------------------------------------------------------
// Commands

function print(text: string): void {
  if (text !== "") process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function need(v: string | boolean | undefined): string {
  if (typeof v !== "string") throw new WtError(2, "A required option is missing.");
  return v;
}

const fetchCommand: Command = ({ repo, args }) => {
  parseFlags(args, {}, 0);
  fetch(repo);
};

const pushCommand: Command = ({ repo, args }) => {
  const { flags } = parseFlags(args, { "force-with-lease": "boolean" }, 0);
  if (!repo.callerTop) throw new WtError(2, "Run this inside a checkout.");
  push(repo, repo.callerTop, { forceWithLease: flags["force-with-lease"] === true });
};

const prCommand: Command = ({ repo, args }) => {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "create": {
      const { flags } = parseFlags(rest, { title: "string", body: "string", "body-file": "string", draft: "boolean" });
      print(
        prCreate(repo, {
          title: need(flags.title),
          body: textArg(str(flags.body), str(flags["body-file"]), "body", true) as string,
          draft: flags.draft === true,
        }),
      );
      return;
    }
    case "edit": {
      const { flags } = parseFlags(rest, { pr: "string", title: "string", body: "string", "body-file": "string" });
      print(
        prEdit(repo, {
          pr: str(flags.pr),
          title: str(flags.title),
          body: textArg(str(flags.body), str(flags["body-file"]), "body", false) ?? undefined,
        }),
      );
      return;
    }
    case "merge": {
      const { flags } = parseFlags(rest, {
        pr: "string",
        "match-head": "string",
        subject: "string",
        body: "string",
        "body-file": "string",
      });
      print(
        prMerge(repo, {
          pr: str(flags.pr),
          matchHead: need(flags["match-head"]),
          subject: need(flags.subject),
          body: textArg(str(flags.body), str(flags["body-file"]), "body", true) as string,
        }),
      );
      return;
    }
    default:
      throw new WtError(2, "Unknown pr subcommand. Use create, edit or merge.");
  }
};

export const commands: CommandTable = {
  fetch: fetchCommand,
  push: pushCommand,
  pr: prCommand,
};
