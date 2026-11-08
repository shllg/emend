import { isatty } from "node:tty";
import {
  checkPublicChange,
  checkPublicPush,
  PublicCheckError,
  type PushDestination,
  readPushDestination,
  readPushRemote,
} from "../../../scripts/check-public.ts";
import type { Command, CommandTable } from "./command.ts";
import { localDiagnostic, repoDiagnostic } from "./diagnostics.ts";
import { htmlEntityNames, legacyEntities, legacyEntityNames, namedEntities } from "./entities.ts";
import { checkIssue, githubRepository, originRepository } from "./issues.ts";
import { type RunResult, run } from "./proc.ts";
import { requirePublic, requirePublicText } from "./public.ts";
import { fetchOrigin, gitTry, type Repo, requireGlobalIdentity } from "./repo.ts";
import { hasTerminal, readTerminalLine } from "./terminal.ts";
import {
  branchName,
  commitSha,
  issueFromBranch,
  oneLine,
  parseFlags,
  prNumber,
  textArg,
  WtError,
  worktreeIssue,
} from "./validate.ts";

export { pushDiagnostic } from "./diagnostics.ts";

// ---------------------------------------------------------------------------------------------
// gh plumbing

const GH_TIMEOUT_MS = 90_000;
const NO_OPEN_PR = "No open pull request for this branch.";

/** Pin GitHub calls to origin and github.com, never gh defaults or caller overrides. */
function ghTry(repo: Repo, args: string[], input?: string, identity?: string): RunResult {
  const pinned =
    args[0] === "pr"
      ? [...args, "--repo", `github.com/${identity ?? originRepository(repo).nameWithOwner}`]
      : args[0] === "api"
        ? [...args, "--hostname", "github.com"]
        : args;
  return run("gh", pinned, { cwd: repo.mainRoot, input, timeoutMs: GH_TIMEOUT_MS });
}

/** Maps a failed gh call to an exit code: 69 for a missing tool, no login or no network, 1 otherwise. */
function ghFailure(repo: Repo, r: RunResult, what: string): never {
  const err = r.stderr;
  if (r.code === 127) throw new WtError(69, "gh is not installed or not runnable.");
  if (r.code === 124) throw new WtError(69, `${what} timed out.`);
  if (r.code === 4 || /not logged in|gh auth login|bad credentials|http 401|authentication/i.test(err)) {
    throw new WtError(69, "gh is not logged in. The owner must run gh auth login.");
  }
  if (/error connecting|could not resolve host|network is unreachable|dial tcp|i\/o timeout/i.test(err)) {
    throw new WtError(69, "GitHub is not reachable.");
  }
  const first = repoDiagnostic(repo, err).split("\n")[0] ?? "";
  throw new WtError(1, `${what} failed${first ? `: ${first}` : ` (exit ${r.code})`}`);
}

export function gh(repo: Repo, args: string[], what: string, input?: string): string {
  const r = ghTry(repo, args, input);
  if (r.code !== 0) ghFailure(repo, r, what);
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
// fetch and push

export function fetch(repo: Repo): void {
  fetchOrigin(repo);
}

/** Push the checked local branch, with a lease pinned to origin's advertised branch tip. */
export function pushArgs(branch: string, forceWithLease: boolean, expected = ""): string[] {
  const args = ["push", "-u", "--no-follow-tags"];
  if (forceWithLease) args.push(`--force-with-lease=refs/heads/${branch}:${expected}`);
  args.push("--", "origin", `refs/heads/${branch}:refs/heads/${branch}`);
  return args;
}

/** The tracking ref or origin's advertised branch must confirm the checked commit after a push. */
export function requireCheckedPush(checked: string, received: RunResult): void {
  if (received.code !== 0 || !/^[0-9a-f]{40,64}$/.test(received.stdout)) {
    throw new WtError(1, "Could not confirm what origin received. Check the branch on GitHub.");
  }
  if (received.stdout !== checked) {
    throw new WtError(1, "origin received a commit other than the checked one. Check the branch on GitHub.");
  }
}

/** Preserve the force-if-includes guard: the advertised tip must have been integrated on this branch. */
function requireIntegrated(repo: Repo, top: string, branch: string, expected: string): void {
  if (!expected) return;
  const pins = ["--no-replace-objects", "-c", "i18n.logOutputEncoding=UTF-8"];
  const reflog = gitTry(
    repo,
    [...pins, "reflog", "show", "--no-show-signature", "--format=%H", `refs/heads/${branch}`],
    { cwd: top },
  );
  if (reflog.code !== 0)
    throw new WtError(1, `git reflog failed: ${localDiagnostic(reflog.stderr) || `exit ${reflog.code}`}`);
  for (const sha of new Set(reflog.stdout.split("\n").filter(Boolean))) {
    const result = gitTry(repo, [...pins, "merge-base", "--is-ancestor", expected, sha], { cwd: top });
    if (result.code === 0) return;
    if (result.code !== 1)
      throw new WtError(1, `git merge-base failed: ${localDiagnostic(result.stderr) || `exit ${result.code}`}`);
  }
  throw new WtError(1, "The destination branch has changes that were never integrated. Nothing was pushed.");
}

const MARKER_TERMINAL_MESSAGE = "--accept-new-markers needs an interactive terminal: the owner runs it there.";
// This terminal check is friction against agents, not proof that the owner is present.
export const markerTerminal = {
  stdinTTY: () => isatty(0),
  stderrTTY: () => isatty(2),
  available: hasTerminal,
  readLine(prompt: string): string {
    try {
      return readTerminalLine(prompt);
    } catch {
      throw new WtError(1, MARKER_TERMINAL_MESSAGE);
    }
  },
};

export function push(
  repo: Repo,
  top: string,
  o: { forceWithLease: boolean; acceptNewMarkers?: boolean; beforePush?: () => void },
): void {
  if (o.acceptNewMarkers && (!markerTerminal.stdinTTY() || !markerTerminal.stderrTTY() || !markerTerminal.available()))
    throw new WtError(1, MARKER_TERMINAL_MESSAGE);
  requireGlobalIdentity(repo, top);
  const head = gitTry(repo, ["symbolic-ref", "--quiet", "HEAD"], { cwd: top });
  if (head.code !== 0 || head.stdout === "") throw new WtError(2, "HEAD is detached. Nothing was pushed.");
  if (!head.stdout.startsWith("refs/heads/")) throw new WtError(2, "HEAD is not a local branch. Nothing was pushed.");
  const branch = branchName(head.stdout.slice("refs/heads/".length));
  requirePublicText(repo, { branch });
  // Resolve HEAD once and recheck the branch immediately before either kind of push.
  const sha = gitTry(repo, ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: top });
  if (sha.code !== 0 || !/^[0-9a-f]{40}$/.test(sha.stdout)) {
    throw new WtError(1, "Could not resolve HEAD. Nothing was pushed.");
  }
  let destination: PushDestination | undefined;
  let markerCount = 0;
  requirePublic(() => {
    destination = readPushDestination(top);
    const result = checkPublicPush(top, sha.stdout, { root: repo.mainRoot, requireTerms: true, destination, branch });
    markerCount = result.newMarkers?.length ?? 0;
    if (markerCount && !o.acceptNewMarkers)
      result.hits.push("Only the owner may push new allow markers. Nothing was pushed.");
    return result;
  });
  if (
    o.acceptNewMarkers &&
    markerTerminal.readLine(
      "Only the owner may approve new allow markers. Type the number of new allow marker notes printed above to push: ",
    ) !== String(markerCount)
  )
    throw new WtError(1, "The new allow marker count was not confirmed. Nothing was pushed.");
  if (!destination) throw new WtError(69, "check:public: could not read destination refs");
  const checkedUrl = destination.url;
  const expected = destination.refs.get(`refs/heads/${branch}`) ?? "";
  if (o.forceWithLease) requireIntegrated(repo, top, branch, expected);
  o.beforePush?.();
  requirePublic(() => {
    if (readPushRemote(top).url !== checkedUrl) {
      throw new PublicCheckError(1, "origin changed after the check. Nothing was pushed.");
    }
    return { hits: [], notes: [] };
  });
  // A commit can still land between this recheck and git push's own ref read.
  // The post-push tracking-ref check detects whether origin received a different commit.
  const current = gitTry(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: top });
  if (current.code !== 0 || current.stdout !== sha.stdout) {
    throw new WtError(1, "The branch moved after HEAD was resolved. Nothing was pushed.");
  }
  const r = gitTry(repo, pushArgs(branch, o.forceWithLease, expected), { cwd: top });
  if (r.code !== 0) {
    const unreachable =
      /could not resolve|unable to access|could not read from remote|connection (timed out|refused|reset)|network is unreachable/i.test(
        r.stderr,
      );
    const diagnostic = repoDiagnostic(repo, r.stderr);
    throw new WtError(
      unreachable ? 69 : 1,
      `git push failed: could not publish the checked commit.${diagnostic ? `\n${diagnostic}` : ""}`,
    );
  }
  let received = gitTry(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: top });
  if (received.code === 1 && received.stdout === "" && received.stderr === "") {
    const ref = `refs/heads/${branch}`;
    const advertised = gitTry(repo, ["ls-remote", "--quiet", "--", "origin", ref], { cwd: top });
    const fields = advertised.stdout.split("\t");
    received = { ...advertised, stdout: fields.length === 2 && fields[1] === ref ? (fields[0] ?? "") : "" };
  }
  requireCheckedPush(sha.stdout, received);
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

type PrState = "OPEN" | "MERGED" | "CLOSED";

/** Optional worktree lookups can report a skipped privacy check without exposing the name. */
export class PrLookupPrivacyError extends WtError {}

/**
 * Exact, fully paginated lookup. Search-backed `pr list` can lag and match head prefixes.
 * Supplying localHead selects a worktree's PR; otherwise ambiguous matches are refused.
 */
export function prForBranch(
  repo: Repo,
  branch: string,
  states: readonly PrState[] = ["OPEN"],
  extraFields: string[] = [],
  timeoutMs = GH_TIMEOUT_MS,
  localHead?: string | null,
  repository?: ReturnType<typeof originRepository>,
): Pr | null {
  branchName(branch);
  try {
    requirePublicText(repo, { branch });
  } catch (error) {
    if (error instanceof WtError) throw new PrLookupPrivacyError(error.code, error.message);
    throw error;
  }
  const fields = [BASE_FIELDS, ...extraFields, ...(localHead === undefined ? [] : ["headRefOid"])].join(",");
  const identity = repository ?? originRepository(repo);
  const name = identity.nameWithOwner.slice(identity.owner.length + 1);
  const query = `query($owner: String!, $name: String!, $head: String!, $cursor: String) {
    viewer { login }
    repository(owner: $owner, name: $name) { nameWithOwner
      pullRequests(headRefName: $head, states: [${states.join(", ")}], first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${fields.replaceAll(",", " ")} author { login } }
      }
    }
  }`;
  const matches: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const what = "gh api pull requests";
    const result = run(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${identity.owner}`,
        "-f",
        `name=${name}`,
        "-f",
        `head=${branch}`,
        ...(cursor === null ? [] : ["-f", `cursor=${cursor}`]),
        "--hostname",
        "github.com",
      ],
      { cwd: repo.mainRoot, timeoutMs },
    );
    if (result.code !== 0) ghFailure(repo, result, what);
    const response = asObject(parseJson(result.stdout, what), what);
    if (response.errors !== undefined)
      throw new WtError(1, "Could not read a complete pull request list for this branch.");
    const data = asObject(response.data, what);
    const viewer = asObject(data.viewer, what).login;
    const repository = asObject(data.repository, what);
    if (
      typeof viewer !== "string" ||
      !viewer ||
      typeof repository.nameWithOwner !== "string" ||
      repository.nameWithOwner.toLowerCase() !== identity.nameWithOwner.toLowerCase()
    )
      throw new WtError(1, "Could not verify the pull request repository or author.");
    const connection = asObject(repository.pullRequests, what);
    const page = asObject(connection.pageInfo, what);
    if (!Array.isArray(connection.nodes) || typeof page.hasNextPage !== "boolean")
      throw new WtError(1, "Could not read a complete pull request list for this branch.");
    for (const node of connection.nodes) {
      const pr = asObject(node, what);
      if (pr.isCrossRepository === true) continue;
      if (pr.isCrossRepository !== false || typeof pr.headRefName !== "string" || typeof pr.state !== "string")
        throw new WtError(1, "gh api pull requests returned output bin/wt could not read.");
      if (pr.author === null) continue;
      const login = asObject(pr.author, what).login;
      if (typeof login !== "string") throw new WtError(1, "Could not read the pull request author.");
      if (
        login.toLowerCase() === viewer.toLowerCase() &&
        pr.headRefName === branch &&
        states.some((s) => s === pr.state)
      )
        matches.push(pr);
    }
    if (page.hasNextPage === false) break;
    if (typeof page.endCursor !== "string" || !page.endCursor || seen.has(page.endCursor))
      throw new WtError(1, "Could not read a complete pull request list for this branch.");
    cursor = page.endCursor;
    seen.add(cursor);
  }
  if (localHead !== undefined) {
    // Reused worktree branches prefer their tip, then a current PR, then the newest historical PR.
    const prs = matches.map(toPr).sort((a, b) => b.number - a.number);
    return (
      prs.find((pr) => localHead !== null && pr.data.headRefOid === localHead) ??
      prs.find((pr) => pr.data.state === "OPEN") ??
      prs[0] ??
      null
    );
  }
  if (matches.length > 1) {
    const kind = states.length === 1 ? `${states[0]?.toLowerCase()} ` : "";
    throw new WtError(1, `More than one ${kind}pull request matches this branch.`);
  }
  return matches[0] ? toPr(matches[0]) : null;
}

function requireOpenPr(repo: Repo, extraFields: string[] = [], identity?: ReturnType<typeof originRepository>): Pr {
  const pr = prForBranch(repo, callerBranch(repo), ["OPEN"], extraFields, GH_TIMEOUT_MS, undefined, identity);
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
    ghFailure(repo, r, "gh pr view");
  }
  const data = asObject(parseJson(r.stdout, "gh pr view"), "gh pr view");
  if (data.number !== n) throw new WtError(1, "gh returned a different pull request than the one asked for.");
  if (data.state !== "OPEN") throw new WtError(1, NO_OPEN_PR);
  if (data.baseRefName !== "main") throw new WtError(1, "The pull request does not target main.");
  if (data.isCrossRepository !== false) throw new WtError(1, "The pull request comes from a fork.");
  return toPr(data);
}

const CLOSING_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    mergeQueue(branch: "main") { id }
    pullRequest(number: $number) {
      body createdAt lastEditedAt
      closingIssuesReferences(first: 20) {
        nodes { number repository { nameWithOwner } }
        pageInfo { hasNextPage }
      }
    }
  }
}`;
const CLOSING_MISMATCH = "GitHub's closing issues do not match this branch. Fix the PR body with bin/wt pr edit.";
// GitHub documents no parsing bound; field reports range from seconds to over an hour.
// The window compares the local clock with GitHub's timestamps and narrows the race.
// The post-merge check covers only the PR's closing set; the squash message rests on the pre-merge text scan.
const CLOSING_SETTLE_MS = 10 * 60 * 1000;

interface ClosingState {
  pr: Record<string, unknown>;
  repository: string;
  mergeQueue: unknown;
  issues: { number: number; repository: string }[];
}

/** Read the body and parsed closing set together, pinned to the original repository through a merge. */
function readGithubClosing(repo: Repo, number: number, identity?: ReturnType<typeof originRepository>): ClosingState {
  function refuse(): never {
    throw new WtError(1, CLOSING_MISMATCH);
  }
  let expected: string;
  try {
    expected = (identity ?? originRepository(repo)).nameWithOwner.toLowerCase();
  } catch {
    refuse();
  }
  const what = "GitHub closing issues query";
  const result = gh(
    repo,
    [
      "api",
      "graphql",
      "-f",
      `query=${CLOSING_QUERY}`,
      "-f",
      `owner=${expected.split("/")[0]}`,
      "-f",
      `name=${expected.split("/")[1]}`,
      "-F",
      `number=${number}`,
    ],
    what,
  );
  const response = asObject(parseJson(result, what), what);
  if (response.errors !== undefined) refuse();
  const repository = asObject(asObject(response.data, what).repository, what);
  if (typeof repository.nameWithOwner !== "string" || repository.nameWithOwner.toLowerCase() !== expected) refuse();
  const pr = asObject(repository.pullRequest, what);
  const connection = asObject(pr.closingIssuesReferences, what);
  if (asObject(connection.pageInfo, what).hasNextPage !== false || !Array.isArray(connection.nodes)) refuse();
  if (connection.nodes.length > 20) refuse();
  const issues: ClosingState["issues"] = [];
  for (const node of connection.nodes) {
    const ref = asObject(node, what);
    const owner = asObject(ref.repository, what).nameWithOwner;
    if (
      typeof ref.number !== "number" ||
      !Number.isSafeInteger(ref.number) ||
      ref.number <= 0 ||
      typeof owner !== "string" ||
      !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu.test(owner)
    )
      refuse();
    issues.push({ number: ref.number, repository: owner });
  }
  return { pr, repository: expected, mergeQueue: repository.mergeQueue, issues };
}

function foreignClosingIssues(closing: ClosingState, branch: string): string[] {
  const issue = issueFromBranch(branch);
  return closing.issues
    .filter((ref) => ref.number !== issue || ref.repository.toLowerCase() !== closing.repository)
    .map((ref) => `${ref.repository}#${ref.number}`);
}

/** GitHub's parsed closing set is authoritative. Creation/editing may precede its own-issue link. */
function githubClosingGuard(
  repo: Repo,
  branch: string,
  number: number,
  requireOwn: boolean,
  identity?: ReturnType<typeof originRepository>,
  now: () => number = Date.now,
): Record<string, unknown> {
  const closing = readGithubClosing(repo, number, identity);
  if (foreignClosingIssues(closing, branch).length) throw new WtError(1, CLOSING_MISMATCH);
  if (requireOwn) {
    // GitHub returns null for no queue or one the token cannot see, so refusal relies on token visibility.
    // The QUEUED path still stops the workflow if the merge is queued after submission.
    if (closing.mergeQueue === undefined)
      throw new WtError(1, "Could not read the repository's merge queue. Nothing was merged.");
    if (closing.mergeQueue !== null) throw new WtError(1, "Merge queues are not supported. Nothing was merged.");
    requireSettledClosing(closing.pr, now);
    if (issueFromBranch(branch) !== null && closing.issues.length === 0) throw new WtError(1, CLOSING_MISMATCH);
  }
  return closing.pr;
}

function requireSettledClosing(pr: Record<string, unknown>, now: () => number): void {
  const edited = pr.lastEditedAt ?? pr.createdAt;
  const time = typeof edited === "string" ? Date.parse(edited) : Number.NaN;
  const retry = time + CLOSING_SETTLE_MS;
  if (!Number.isFinite(retry) || !Number.isFinite(new Date(retry).getTime()))
    throw new WtError(1, "Could not read when the pull request body last changed. Nothing was merged.");
  if (now() < retry)
    throw new WtError(
      1,
      `GitHub may not have parsed the body yet. Retry at ${new Date(retry).toISOString()} (UTC). Nothing was merged.`,
    );
}

// ---------------------------------------------------------------------------------------------
// pr subcommands. Each returns the text for stdout (possibly empty).

export function prCreate(repo: Repo, o: { title: string; body: string; draft: boolean }): string {
  const branch = callerBranch(repo);
  const title = oneLine(o.title, "title");
  requirePublicText(repo, { title, body: o.body, branch });
  closingGuard(repo, branch, o.body);
  closingGuard(repo, branch, `${title}\n\n${o.body}`, false);
  fetchOrigin(repo);
  requireNoUnpushedMain(repo, "HEAD", repo.callerTop ?? repo.mainRoot, "Nothing was created.");
  if (prForBranch(repo, branch)) throw new WtError(3, "An open pull request already exists for this branch.");
  const args = ["pr", "create", "--head", branch, "--base", "main", `--title=${title}`];
  if (o.draft) args.push("--draft");
  const out = gh(repo, [...args, "--body-file", "-"], "gh pr create", o.body);
  const printed = /^https:\/\/github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/iu.exec(out.trim());
  if (!printed?.[1] || !printed[2])
    throw new WtError(
      1,
      "Pull request creation succeeded, but gh did not print a valid PR URL. Check it before retrying.",
    );
  if (originRepository(repo).nameWithOwner.toLowerCase() !== printed[1].toLowerCase())
    throw new WtError(1, "Pull request creation returned a URL for a different repository. Check it before retrying.");
  const number = prNumber(printed[2]);
  let confirmed: Pr | null;
  try {
    confirmed = prForBranch(repo, branch);
  } catch (error) {
    const detail = error instanceof WtError ? ` ${error.message}` : "";
    throw new WtError(
      1,
      `Pull request #${number} was created, but its exact branch lookup could not confirm it. Check it before retrying.${detail}`,
    );
  }
  if (confirmed?.number !== number)
    throw new WtError(
      1,
      `Pull request #${number} was created, but its exact branch lookup could not confirm it. Check it before retrying.`,
    );
  githubClosingGuard(repo, branch, number, false);
  return out;
}

const MARKS = "[*_~]{0,3}";
const REPOSITORY = "[a-z0-9_.-]+/[a-z0-9_.-]+";
const GITHUB_URL = String.raw`(?:https?://(?:www\.)?|www\.)github\.com/`;
const ISSUE_URL = `${GITHUB_URL}${REPOSITORY}/issues/[0-9]+(?![A-Za-z0-9])/?`;
const REFERENCE_PARTS = new RegExp(
  `^${MARKS}(?:(#)|(GH-)|(${REPOSITORY})#|${GITHUB_URL}(${REPOSITORY})/issues/)([0-9]+)/?${MARKS}$`,
  "iu",
);
const CLOSING_WORDS = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"];
const KEYWORD = `(?<![A-Za-z0-9])(?:${CLOSING_WORDS.join("|")})(?![A-Za-z0-9])`;
interface ClosingOperand {
  end: number;
  reference: RegExpExecArray | null;
  indirect: boolean;
  ranges: [number, number][];
}

/** Pair delimiters once; malformed or nested links must not make us repeatedly search a suffix. */
function closingDelimiters(text: string, escapedParentheses = false): Map<number, number> {
  const ends = new Map<number, number>();
  const squares: number[] = [];
  const parentheses: number[] = [];
  // For each offset and quote state, remember the next unquoted >. This also handles
  // a valid anchor after unrelated malformed HTML without rescanning tag-sized suffixes.
  const plain = new Int32Array(text.length + 1).fill(-1);
  const single = new Int32Array(text.length + 1).fill(-1);
  const double = new Int32Array(text.length + 1).fill(-1);
  for (let i = text.length - 1; i >= 0; i--) {
    const char = text[i];
    const outside = plain[i + 1] ?? -1;
    const inSingle = single[i + 1] ?? -1;
    const inDouble = double[i + 1] ?? -1;
    plain[i] = char === ">" ? i : char === "'" ? inSingle : char === '"' ? inDouble : outside;
    single[i] = char === "'" ? outside : inSingle;
    double[i] = char === '"' ? outside : inDouble;
  }
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    const angleEnd = plain[i + 1] ?? -1;
    if (char === "<" && angleEnd !== -1) ends.set(i, angleEnd);
    if (char === "[") squares.push(i);
    const pairParenthesis = !escapedParentheses || !escaped;
    if (char === "(" && pairParenthesis) parentheses.push(i);
    const stack = char === "]" ? squares : char === ")" && pairParenthesis ? parentheses : null;
    if (stack) {
      const start = stack.pop();
      if (start !== undefined) ends.set(start, i);
    }
    escaped = char === "\\" && !escaped;
  }
  return ends;
}

/** Strip inline markup without repeatedly searching nested links or quoted HTML tags. */
function closingWithoutMarkup(text: string, dropReferences: boolean): string {
  // Definition-shaped lines and reference labels may be literal. Scan both choices.
  if (dropReferences) text = text.replace(/^[ \t]{0,3}\[[^\]\r\n]+\]:[^\r\n]*/gmu, "");
  // A backslash-escaped parenthesis belongs to the destination, not its delimiters.
  const ends = closingDelimiters(text, true);
  const plain: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end === -1) break;
      // Skip the whole comment, so every searched character is visited at most once.
      i = end + 2;
      continue;
    }
    const char = text[i] as string;
    const tagEnd = char === "<" ? ends.get(i) : undefined;
    const destinationEnd =
      char === "]" && (text[i + 1] === "(" || (dropReferences && text[i + 1] === "[")) ? ends.get(i + 1) : undefined;
    if (tagEnd !== undefined) i = tagEnd;
    else if (destinationEnd !== undefined) i = destinationEnd;
    else if (!"*_~`[]".includes(char)) {
      plain.push(char);
    }
  }
  return plain.join("");
}

function closingReference(text: string): RegExpExecArray | null {
  const value = text.trim();
  return REFERENCE_PARTS.exec(value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1).trim() : value);
}

/** Read one operand at a known position; charge field scans even when raw keywords nest links. */
function closingOperand(
  text: string,
  at: number,
  ends: Map<number, number>,
  plain: Map<number, ClosingOperand>,
  inspect: (size: number) => void,
): ClosingOperand | null {
  const end = ends.get(at);
  if (text[at] === "[" && end !== undefined) {
    const destinationEnd = ends.get(end + 1);
    if (text[end + 1] === "[" && destinationEnd !== undefined)
      return { end: destinationEnd + 1, reference: null, indirect: true, ranges: [] };
    if (text[end + 1] === "(" && destinationEnd !== undefined) {
      inspect(destinationEnd - at);
      const label = closingReference(text.slice(at + 1, end));
      const destination = closingReference(text.slice(end + 2, destinationEnd));
      return {
        end: destinationEnd + 1,
        reference: label ?? (destination?.[4] !== undefined ? destination : null),
        indirect: false,
        ranges: [
          [at + 1, end],
          [end + 2, destinationEnd],
        ],
      };
    }
  }
  if (text[at] === "<" && end !== undefined) {
    if (/^a$/iu.test(text[at + 1] ?? "") && (at + 2 === end || /\s/u.test(text[at + 2] ?? ""))) {
      inspect(end - at);
      const contents = text.slice(at + 1, end);
      const ranges: [number, number][] = [];
      for (const href of contents.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu)) {
        const start = at + 1 + href.index + href[0].indexOf("=") + 1;
        // Include the attribute quotes and whitespace; the reference index scans the entire range.
        ranges.push([start, at + 1 + href.index + href[0].length]);
      }
      return { end: end + 1, reference: null, indirect: false, ranges };
    }
    const url = new RegExp(`${ISSUE_URL}>`, "iyu");
    url.lastIndex = at + 1;
    const match = url.exec(text);
    if (match && at + match[0].length === end)
      return {
        end: end + 1,
        reference: REFERENCE_PARTS.exec(text.slice(at + 1, end)),
        indirect: false,
        ranges: [[at + 1, end]],
      };
  }
  return plain.get(at) ?? null;
}

/** Prefix sums allow every consumed label/destination to be checked, even when ranges overlap. */
function closingReferenceIndex(text: string, own: (ref: RegExpExecArray) => boolean) {
  const plain = new Map<number, ClosingOperand>();
  const like = new Set<number>();
  const bareWords = new Set<number>();
  const any = new Uint32Array(text.length + 1);
  const bad = new Uint32Array(text.length + 1);
  const explicit = new Uint32Array(text.length + 1);
  const qualified: { at: number; ref: RegExpExecArray }[] = [];
  // Repeated number signs and Unicode dashes are ambiguous references, never accepted own refs.
  // Try a hash run only at its start; retrying at every hash would be quadratic without trailing digits.
  const tokens =
    /(?<!#)#+\s*[0-9]+\/?|GH\p{Dash_Punctuation}[0-9]+\/?|(?:https?:\/\/(?:www\.)?|www\.)?github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/issues\/[0-9]+\/?/giu;
  for (const token of text.matchAll(tokens)) {
    let start = token.index;
    let bareWord = false;
    if (token[0].startsWith("#")) {
      let i = start;
      while (i > 0 && /[a-z0-9_.-]/iu.test(text[i - 1] ?? "")) i--;
      if (i < start && text[i - 1] === "/") {
        const slash = --i;
        while (i > 0 && /[a-z0-9_.-]/iu.test(text[i - 1] ?? "")) i--;
        if (i < slash) start = i;
      } else if (i < start) {
        start = i;
        bareWord = true;
      }
    }
    const ref = REFERENCE_PARTS.exec(text.slice(start, token.index + token[0].length));
    const end = token.index + token[0].length;
    const digitEnd = end - Number(token[0].endsWith("/"));
    const complete = !/[a-z0-9]/iu.test(text[digitEnd] ?? "");
    like.add(start);
    like.add(token.index);
    // A bare word#n is ambiguous after a keyword, but is not a qualified issue reference.
    if (bareWord && !ref) bareWords.add(start);
    if (ref && complete) plain.set(start, { end, reference: ref, indirect: false, ranges: [] });
    // Underscores can be emphasis or part of a repository name. The main prefix consumes
    // at most three; index those alternatives once instead of probing a suffix per keyword.
    for (let offset = start; text[offset] === "_"; ) {
      offset++;
      like.add(offset);
      if (bareWord && !ref) bareWords.add(offset);
      if (complete && offset - start <= 3) {
        const reference = REFERENCE_PARTS.exec(text.slice(offset, end));
        if (reference) plain.set(offset, { end, reference, indirect: false, ranges: [] });
      }
    }
    any[token.index + 1] = 1;
    if (!ref || ref[2] !== undefined || !complete) bad[token.index + 1] = 1;
    else if (ref[3] !== undefined || ref[4] !== undefined) {
      explicit[token.index + 1] = 1;
      qualified.push({ at: token.index, ref });
    } else if (!own(ref)) bad[token.index + 1] = 1;
  }
  for (let i = 1; i <= text.length; i++) {
    any[i] = (any[i] ?? 0) + (any[i - 1] ?? 0);
    bad[i] = (bad[i] ?? 0) + (bad[i - 1] ?? 0);
    explicit[i] = (explicit[i] ?? 0) + (explicit[i - 1] ?? 0);
  }
  let foreign: Uint32Array | undefined;
  return {
    plain,
    like,
    bareWords,
    any: (start: number, end: number) => (any[end] ?? 0) > (any[start] ?? 0),
    bad: (start: number, end: number) => {
      if ((bad[end] ?? 0) > (bad[start] ?? 0)) return true;
      if ((explicit[end] ?? 0) === (explicit[start] ?? 0)) return false;
      // Resolve origin only when a consumed field actually contains a qualified reference.
      if (!foreign) {
        foreign = new Uint32Array(text.length + 1);
        for (const { at, ref } of qualified) if (!own(ref)) foreign[at + 1] = 1;
        for (let i = 1; i <= text.length; i++) foreign[i] = (foreign[i] ?? 0) + (foreign[i - 1] ?? 0);
      }
      return (foreign[end] ?? 0) > (foreign[start] ?? 0);
    },
  };
}

function closingPosition(text: string, at: number, afterReference: boolean): { at: number; joined: boolean } {
  let colon = false;
  let joined = false;
  while (at < text.length) {
    const char = String.fromCodePoint(text.codePointAt(at) as number);
    // Leave link openers for closingOperand; skip them only if they do not form a link.
    if (
      /[\s*_~`\\\p{Quotation_Mark}\p{Default_Ignorable_Code_Point}-]/u.test(char) ||
      (afterReference && /[,;&\])>]/u.test(char))
    ) {
      if (afterReference && /[,;&]/u.test(char)) joined = true;
      at += char.length;
    } else if (!afterReference && !colon && char === ":") {
      colon = true;
      at++;
    } else if (afterReference && /^(?:and|or)(?![a-z0-9])/iu.test(text.slice(at))) {
      joined = true;
      at += /^and/iu.test(text.slice(at)) ? 3 : 2;
    } else break;
  }
  return { at, joined };
}

const maxLegacyName = Math.max(...[...legacyEntityNames].map((name) => name.length));

/** Decode once; HTML also accepts legacy names and numeric references with unbounded digits and no semicolon. */
export function decodeClosingReferences(body: string, legacy = false): string {
  return body.replace(
    legacy
      ? /&#(?:([0-9]+)|[xX]([0-9a-fA-F]+));?|&([A-Za-z][A-Za-z0-9]*)(;?)/gu
      : /&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));|&([A-Za-z][A-Za-z0-9]*)(;?)/gu,
    (reference, decimal, hex, name: string | undefined, semicolon: string | undefined) => {
      if (name !== undefined) {
        if (semicolon && htmlEntityNames.has(name)) return namedEntities[name] ?? "\ufffd";
        if (legacy) {
          // Browser text uses the longest legacy prefix, even in an otherwise unknown name.
          // Bound probes by the longest known name, not by an untrusted token's length.
          for (let end = Math.min(name.length, maxLegacyName); end > 0; end--) {
            const prefix = name.slice(0, end);
            if (legacyEntityNames.has(prefix))
              return (legacyEntities[prefix] ?? "\ufffd") + name.slice(end) + (semicolon ?? "");
          }
        }
        return reference;
      }
      // Keep invalid-code-point handling in both readings; CommonMark keeps its digit/semicolon rules.
      const code = Number.parseInt(decimal ?? hex, decimal === undefined ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "\ufffd";
    },
  );
}

function normalizeClosingText(decoded: string): string {
  // Unicode canonical reordering can be quadratic on a long, out-of-order combining-mark run.
  // Decompose only one code point at a time until the run bound is known to hold.
  const compatibilityMarks = new Map<string, boolean>();
  let marks = 0;
  for (const point of decoded) {
    let mark = /\p{M}/u.test(point);
    if (!mark) {
      let compatible = compatibilityMarks.get(point);
      if (compatible === undefined) {
        compatible = /^\p{M}/u.test(point.normalize("NFKD"));
        compatibilityMarks.set(point, compatible);
      }
      mark = compatible;
    }
    marks = mark ? marks + 1 : 0;
    if (marks > 32) throw new WtError(2, "Text contains more than 32 consecutive combining marks.");
  }
  return decoded.normalize("NFKC");
}

/**
 * closingGuard is an early warning that runs before GitHub sees the text. It is not the boundary:
 * GitHub's own closing set (githubClosingGuard, closingIssuesReferences) is authoritative and runs
 * right before every merge, pinned to the head. Renderer differences in a PR body that the readings
 * miss are caught there. The squash message is guarded only by the raw reading: GitHub reads it as
 * plain text at merge time, and no API reports its closing set beforehand. Keep the readings cheap
 * and conservative; do not model CommonMark or HTML in full.
 */
export function closingGuard(repo: Repo, branch: string, body: string, requireOwn = true): void {
  const branchIssue = issueFromBranch(branch);
  const metadata = worktreeIssue(repo.callerTop ?? repo.mainRoot);
  if (/^emend-[0-9]+-/u.test(branch) && (branchIssue === null || metadata !== branchIssue))
    throw new WtError(2, "Worktree issue does not match the branch. Use spawn --issue to register an issue worktree.");
  const issue = metadata === branchIssue ? branchIssue : null;
  const normalized = new Map<string, string>();
  const normalize = (text: string): string => {
    let result = normalized.get(text);
    if (result === undefined) {
      result = normalizeClosingText(text);
      normalized.set(text, result);
    }
    return result;
  };
  const decoded = normalize(decodeClosingReferences(body));
  const html = normalize(decodeClosingReferences(body, true));
  const seen = new Set<string>();
  const scan = (text: string, own = false) => {
    text = text.replace(/\p{White_Space}/gu, " ");
    if (seen.has(text)) return;
    seen.add(text);
    scanClosingText(repo, issue, text, own);
  };
  // The required own-issue instruction still comes from the CommonMark reading.
  scan(decoded, requireOwn);
  // Commit text is literal; neither decoding nor normalization may erase its closing instructions.
  scan(body);
  scan(html);
  for (const source of new Set([body, decoded, html])) {
    for (const dropReferences of [false, true]) {
      const stripped = closingWithoutMarkup(source, dropReferences);
      // Strip raw markup before decoding, as well as stripping already-decoded markup.
      if (source === body) {
        scan(normalize(decodeClosingReferences(stripped)));
        scan(normalize(decodeClosingReferences(stripped, true)));
      }
      if (source === decoded || source === html) scan(stripped);
    }
  }
}

function scanClosingText(repo: Repo, issue: number | null, text: string, requireOwn: boolean): void {
  let origin: string | undefined;
  const own = (match: RegExpExecArray): boolean => {
    if (issue === null) return false;
    const explicit = match[3] ?? match[4];
    if (explicit !== undefined && origin === undefined) {
      origin = originRepository(repo).nameWithOwner.toLowerCase();
    }
    return (explicit === undefined || explicit.toLowerCase() === origin) && match[5] === String(issue);
  };
  const ends = closingDelimiters(text);
  const index = closingReferenceIndex(text, own);
  const operands = new Map<number, ClosingOperand | null>();
  let remaining = text.length * 4;
  const inspect = (size: number) => {
    // Raw keywords must all be checked, but nested operands can repeatedly cover the same fields.
    // Bound total field inspection by input size; ordinary links and reference chains have no length cap.
    remaining -= size;
    if (remaining < 0) throw new WtError(2, "Too many overlapping closing links. Reword the text.");
  };
  const read = (at: number): ClosingOperand | null => {
    if (!operands.has(at)) operands.set(at, closingOperand(text, at, ends, index.plain, inspect));
    return operands.get(at) ?? null;
  };
  const main: ClosingOperand[] = [];
  const pending: number[] = [];
  const prefix = new RegExp(`${MARKS}(?:\\s*${MARKS}:${MARKS})?\\s+${MARKS}`, "yu");
  // A consumed link never covers raw keywords: commit messages can close issues inside attributes too.
  for (const keyword of text.matchAll(new RegExp(KEYWORD, "giu"))) {
    const after = keyword.index + keyword[0].length;
    prefix.lastIndex = after;
    const match = prefix.exec(text);
    const operand = match ? read(after + match[0].length) : null;
    if (operand?.reference) {
      main.push(operand);
    } else {
      pending.push(after);
    }
  }
  if (issue === null && main.length) throw new WtError(2, "Only issue branches may close issues.");
  if (
    issue !== null &&
    requireOwn &&
    !main.some((operand) => operand.reference && own(operand.reference) && operand.reference[2] === undefined)
  )
    throw new WtError(2, `The PR body must close issue #${issue}: add "Closes #${issue}".`);
  if (main.some((operand) => operand.reference && !own(operand.reference)))
    throw new WtError(2, `The PR text must not close an issue other than #${issue}.`);
  const refuse = (): never => {
    throw new WtError(
      2,
      "Text after a closing keyword looks like an issue reference. Reword it or close only this branch's issue.",
    );
  };
  const check = (operand: ClosingOperand) => {
    if (operand.indirect || operand.ranges.some(([start, end]) => index.bad(start, end))) refuse();
    if (operand.reference && (operand.reference[2] !== undefined || !own(operand.reference))) refuse();
  };
  const visited = new Set<number>();
  const scan = (start: number, chain: boolean) => {
    let at = start;
    let joined = false;
    while (at < text.length) {
      const position = closingPosition(text, at, chain);
      at = position.at;
      joined ||= position.joined;
      if (visited.has(at)) return;
      visited.add(at);
      const operand = read(at);
      if (operand) {
        check(operand);
        if (!chain && !operand.reference && operand.ranges.some(([start, end]) => index.any(start, end))) {
          // An HTML anchor with an own-issue href is safe, but does not supply the required body instruction.
          if (text[at] !== "<") refuse();
        }
        if (!operand.reference) return;
        at = operand.end;
        chain = true;
        joined = false;
      } else if (text[at] === "[" || text[at] === "(" || text[at] === "<") at++;
      else {
        // Ordinary word fragments after a completed reference do not extend its closing instruction.
        // Keep the fail-closed check directly after a keyword or an explicit list separator.
        if (chain && !joined && index.bareWords.has(at)) return;
        if (index.like.has(at)) refuse();
        return;
      }
    }
  };
  for (const operand of main) {
    check(operand);
    scan(operand.end, true);
  }
  for (const at of pending) scan(at, false);
}

function validatedPrBranch(repo: Repo, head: unknown, prArg: string | undefined, outcome: string): string {
  const branch = head;
  if (typeof branch !== "string") throw new WtError(1, `Could not read the pull request head branch. ${outcome}`);
  try {
    branchName(branch);
  } catch {
    throw new WtError(1, `The pull request head branch is invalid. ${outcome}`);
  }
  if (branch !== repo.callerBranch && !(prArg !== undefined && repo.callerTop === repo.mainRoot))
    throw new WtError(1, `The pull request head branch does not match the caller's branch. ${outcome}`);
  return branch;
}

export function prEdit(repo: Repo, o: { pr?: string; title?: string; body?: string }): string {
  if (o.title === undefined && o.body === undefined) {
    throw new WtError(2, "Nothing to change: give --title, --title-file, --body or --body-file.");
  }
  const title = o.title === undefined ? null : oneLine(o.title, "title");
  requirePublicText(repo, { title: o.title, body: o.body, branch: repo.callerBranch ?? undefined });
  const pr = resolvePr(repo, o.pr, ["title", "body"]);
  const branch = validatedPrBranch(repo, pr.data.headRefName, o.pr, "Nothing was changed.");
  const body = o.body ?? prText(pr.data, "body");
  requirePublicText(repo, { title: title ?? prText(pr.data, "title"), body, branch });
  closingGuard(repo, branch, body);
  closingGuard(repo, branch, `${title ?? prText(pr.data, "title")}\n\n${body}`, false);
  const args = ["pr", "edit", String(pr.number)];
  if (title !== null) args.push(`--title=${title}`);
  if (o.body !== undefined) args.push("--body-file", "-");
  const out = gh(repo, args, "gh pr edit", o.body);
  // This read may precede GitHub parsing the edit; the merge re-reads under the settle window.
  githubClosingGuard(repo, branch, pr.number, false);
  return out;
}

function prText(pr: Record<string, unknown>, field: "title" | "body"): string {
  const text = pr[field];
  if (typeof text !== "string") throw new WtError(1, "Could not read the pull request text.");
  return text;
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
  try {
    const head = gitTry(repo, ["--no-replace-objects", "cat-file", "-t", sha]);
    if (head.code !== 0 || head.stdout !== "commit") {
      throw new WtError(1, "The reviewed head commit is not available locally. Nothing was merged.");
    }
    if (fetched.code !== 0) throw new WtError(69, "Could not fetch the pull request head. Nothing was merged.");
    if (gitTry(repo, ["rev-parse", "--verify", ref]).stdout !== sha) {
      throw new WtError(1, "The pull request head is not the reviewed commit. Nothing was merged.");
    }
    requireNoUnpushedMain(repo, sha, repo.mainRoot, "Nothing was merged.");
    const base = gitTry(repo, ["--no-replace-objects", "merge-base", "refs/remotes/origin/main", sha]);
    if (base.code !== 0 || !/^[0-9a-f]{40}$/.test(base.stdout)) {
      throw new WtError(1, "Could not resolve the pull request merge base. Nothing was merged.");
    }
    requirePublic(() =>
      checkPublicChange(repo.mainRoot, base.stdout, sha, { root: repo.mainRoot, requireTerms: true }),
    );
  } finally {
    gitTry(repo, ["update-ref", "-d", ref]);
  }
}

/** Deletes only the remote head branch. The local branch is never touched; a failure is one stderr line. */
function deleteRemoteBranch(repo: Repo, head: unknown, mergedHead: string, identity: string): void {
  const keep = (why: string) => process.stderr.write(`remote branch kept: ${why}\n`);
  let branch: string;
  try {
    branch = branchName(String(head));
  } catch {
    keep("the head branch name is not one bin/wt deletes");
    return;
  }
  let destination: ReturnType<typeof readPushRemote>;
  try {
    destination = readPushRemote(repo.mainRoot);
  } catch {
    keep("origin must have exactly one push destination equal to its fetch destination");
    return;
  }
  let repository: string;
  try {
    repository = githubRepository(destination.url).nameWithOwner;
  } catch {
    keep("origin's push destination is not a GitHub repository");
    return;
  }
  if (repository.toLowerCase() !== identity.toLowerCase()) {
    keep("origin no longer identifies the merged repository");
    return;
  }
  const advertised = gitTry(repo, ["ls-remote", "--quiet", "--", "origin", `refs/heads/${branch}`], {
    timeoutMs: 5000,
  });
  // GitHub may already have deleted it. An unreadable remote is not proof that the branch is gone.
  if (advertised.code === 0 && advertised.stdout === "") return;
  // The lease keeps a branch that moved after the merge: only the merged head is deleted.
  const r = gitTry(repo, [
    "push",
    `--force-with-lease=refs/heads/${branch}:${mergedHead}`,
    "origin",
    "--delete",
    `refs/heads/${branch}`,
  ]);
  if (r.code !== 0) keep(repoDiagnostic(repo, r.stderr).split("\n").slice(-1)[0] || `git exited ${r.code}`);
}

/**
 * Squash-merges the PR. Requires base `main`, a same-repository head, state OPEN and a head commit equal to
 * `matchHead`. Returns `MERGED <mergeCommit>`; uncertain outcomes print their state and throw a warning.
 */
export function prMerge(
  repo: Repo,
  o: { pr?: string; matchHead: string; subject: string; body: string },
  now: () => number = Date.now,
): string {
  const sha = commitSha(o.matchHead);
  const subject = oneLine(o.subject, "subject");
  requirePublicText(repo, { message: `${subject}\n\n${o.body}`, branch: repo.callerBranch ?? undefined });
  const identity = originRepository(repo);
  const n = o.pr !== undefined ? prNumber(o.pr) : requireOpenPr(repo, [], identity).number;
  const r = ghTry(
    repo,
    ["pr", "view", String(n), "--json", "number,baseRefName,headRefName,isCrossRepository,state,headRefOid,title,body"],
    undefined,
    identity.nameWithOwner,
  );
  if (r.code !== 0) {
    if (/no pull requests? found|could not resolve to a pullrequest/i.test(r.stderr))
      throw new WtError(1, "That pull request does not exist.");
    ghFailure(repo, r, "gh pr view");
  }
  const pr = asObject(parseJson(r.stdout, "gh pr view"), "gh pr view");
  if (pr.baseRefName !== "main") throw new WtError(1, "The pull request does not target main. Nothing was merged.");
  if (pr.isCrossRepository !== false) throw new WtError(1, "The pull request comes from a fork. Nothing was merged.");
  if (pr.state !== "OPEN") throw new WtError(1, "The pull request is not open. Nothing was merged.");
  if (pr.headRefOid !== sha)
    throw new WtError(1, "The pull request head is not the reviewed commit. Nothing was merged.");

  const branch = validatedPrBranch(repo, pr.headRefName, o.pr, "Nothing was merged.");
  requirePublicText(repo, { title: prText(pr, "title"), body: prText(pr, "body"), branch });
  const issue = issueFromBranch(branch);
  if (issue !== null && checkIssue(repo) !== issue)
    throw new WtError(1, "The checked issue does not match the pull request head. Nothing was merged.");
  closingGuard(repo, branch, `${prText(pr, "title")}\n\n${prText(pr, "body")}`, false);
  closingGuard(repo, branch, `${subject}\n\n${o.body}`, false);
  checkMergeBase(repo, n, sha);
  const closingPr = githubClosingGuard(repo, branch, n, true, identity, now);
  const closingBody = prText(closingPr, "body");
  requirePublicText(repo, { title: prText(pr, "title"), body: closingBody, branch });
  closingGuard(repo, branch, `${prText(pr, "title")}\n\n${closingBody}`, false);

  const merge = ghTry(
    repo,
    ["pr", "merge", String(n), "--squash", "--match-head-commit", sha, `--subject=${subject}`, "--body-file", "-"],
    o.body,
    identity.nameWithOwner,
  );
  // gh can fail after the merge succeeded (for example when the merge is queued or the read races), so read the state back.
  const after = ghTry(
    repo,
    ["pr", "view", String(n), "--json", "state,mergeCommit,headRefOid"],
    undefined,
    identity.nameWithOwner,
  );
  if (after.code !== 0) {
    if (merge.code !== 0) ghFailure(repo, merge, "gh pr merge");
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
    const warnings: string[] = [];
    if (typeof state.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(state.headRefOid))
      warnings.push("Warning: the merged head could not be read. Check the merged changes with the owner.");
    else if (state.headRefOid !== sha)
      warnings.push("Warning: the merged head is not the approved one. Check the merged changes with the owner.");
    else if (merge.code !== 0)
      warnings.push("Warning: gh pr merge reported an error, but the PR is merged. Check the result.");
    try {
      const closingAfter = readGithubClosing(repo, n, identity);
      if (closingAfter.pr.lastEditedAt !== closingPr.lastEditedAt)
        warnings.push(
          "Warning: the PR body was edited during the merge. Check its closed issues and reopen any foreign ones.",
        );
      const foreign = foreignClosingIssues(closingAfter, branch);
      if (foreign.length)
        warnings.push(`Warning: the merge may have closed ${foreign.join(", ")}. Check and reopen each issue.`);
    } catch {
      warnings.push(
        "Warning: the post-merge closing check could not run. Check the PR's closed issues and reopen any foreign ones.",
      );
    }
    if (warnings.length) {
      print(`MERGED ${oid}`);
      throw new WtError(1, warnings.join("\n"));
    }
    deleteRemoteBranch(repo, pr.headRefName, sha, identity.nameWithOwner);
    return `MERGED ${oid}`;
  }
  if (merge.code !== 0) ghFailure(repo, merge, "gh pr merge");
  if (state.state === "OPEN") {
    print("QUEUED");
    throw new WtError(
      1,
      "Warning: the eventual queued merge is not checked. The owner must check the PR's closed issues after it merges.",
    );
  }
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
  const { flags } = parseFlags(args, { "force-with-lease": "boolean", "accept-new-markers": "boolean" }, 0);
  if (!repo.callerTop) throw new WtError(2, "Run this inside a checkout.");
  push(repo, repo.callerTop, {
    forceWithLease: flags["force-with-lease"] === true,
    acceptNewMarkers: flags["accept-new-markers"] === true,
  });
};

const prCommand: Command = ({ repo, args }) => {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "number": {
      const { flags } = parseFlags(rest, { branch: "string", state: "string" });
      const state = str(flags.state) ?? "open";
      if (state !== "open" && state !== "merged") throw new WtError(2, "PR state must be open or merged.");
      const branch = str(flags.branch) ?? callerBranch(repo);
      const pr = prForBranch(repo, branch, [state === "open" ? "OPEN" : "MERGED"]);
      if (!pr) throw new WtError(1, `No ${state} pull request for this branch.`);
      print(String(pr.number));
      return;
    }
    case "create": {
      const { flags } = parseFlags(rest, {
        title: "string",
        "title-file": "string",
        body: "string",
        "body-file": "string",
        draft: "boolean",
      });
      print(
        prCreate(repo, {
          title: textArg(str(flags.title), str(flags["title-file"]), "title", true) as string,
          body: textArg(str(flags.body), str(flags["body-file"]), "body", true) as string,
          draft: flags.draft === true,
        }),
      );
      return;
    }
    case "edit": {
      const { flags } = parseFlags(rest, {
        pr: "string",
        title: "string",
        "title-file": "string",
        body: "string",
        "body-file": "string",
      });
      print(
        prEdit(repo, {
          pr: str(flags.pr),
          title: textArg(str(flags.title), str(flags["title-file"]), "title", false) ?? undefined,
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
        "subject-file": "string",
        body: "string",
        "body-file": "string",
      });
      print(
        prMerge(repo, {
          pr: str(flags.pr),
          matchHead: need(flags["match-head"]),
          subject: textArg(str(flags.subject), str(flags["subject-file"]), "subject", true) as string,
          body: textArg(str(flags.body), str(flags["body-file"]), "body", true) as string,
        }),
      );
      return;
    }
    default:
      throw new WtError(2, "Unknown pr subcommand. Use number, create, edit or merge.");
  }
};

const repoCommand: Command = ({ repo, args }) => {
  parseFlags(args, {}, 0);
  try {
    print(originRepository(repo).nameWithOwner);
  } catch (error) {
    if (error instanceof WtError) throw new WtError(69, error.message);
    throw error;
  }
};

export const commands: CommandTable = {
  repo: repoCommand,
  fetch: fetchCommand,
  push: pushCommand,
  pr: prCommand,
};
