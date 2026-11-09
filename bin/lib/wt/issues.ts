import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Command, CommandTable } from "./command.ts";
import { gh } from "./github.ts";
import { BLANK_GLYPHS, hiddenMarkdownReason } from "./markdown.ts";
import { type Registry, readRegistry } from "./registry.ts";
import { gitTry, type Repo } from "./repo.ts";
import {
  BRANCH_PREFIX,
  issueFromBranch,
  issueNumber,
  parseFlags,
  readFileBytes,
  readWtJson,
  WtError,
  worktreeIssue,
} from "./validate.ts";

const FIELDS = `number title body url state createdAt author { login } lastEditedAt
  labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
  blockedBy(first: 100) { nodes { number state } pageInfo { hasNextPage } }
  userContentEdits(first: 50) { nodes { editedAt editor { login } } pageInfo { hasNextPage } }
  timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT, RENAMED_TITLE_EVENT], last: 50) {
    pageInfo { hasPreviousPage }
    nodes {
      __typename
      ... on LabeledEvent { createdAt label { id name } actor { login } }
      ... on UnlabeledEvent { createdAt label { id name } actor { login } }
      ... on RenamedTitleEvent { createdAt actor { login } }
    }
  }`;
const QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner owner { login } label(name: "ready") { id updatedAt }
    issues(states: [OPEN], labels: ["ready"], first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor } nodes { ${FIELDS} }
    }
  }
}`;
const SINGLE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner owner { login } label(name: "ready") { id updatedAt } issue(number: $number) { ${FIELDS} }
  }
}`;
const PR_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner owner { login }
    pullRequests(states: [OPEN], first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { number headRefName isCrossRepository
        closingIssuesReferences(first: 100) {
          nodes { number repository { nameWithOwner } } pageInfo { hasNextPage }
        }
      }
    }
  }
}`;

export interface IssueRow {
  number: number;
  title: string | null;
  url: string;
  kind: "bug" | "feature" | "improvement" | "-";
  priority: "P0" | "P1" | "P2";
  status: "untrusted" | "blocked" | "taken" | "pickable";
  reason: string | null;
  blockedBy: { number: number; state: "OPEN" | "CLOSED" }[];
  branch: string | null;
}
export interface PickedIssue extends IssueRow {
  title: string;
  titleOwned: boolean;
  body: string;
  readyAt: string;
  fetchedAt: string;
}

export function tidy(s: string, max = 200): string {
  return s
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .trim()
    .slice(0, max);
}
function unavailable(): never {
  throw new WtError(69, "GitHub returned incomplete issue queue data.");
}
function object(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) unavailable();
  return v as Record<string, unknown>;
}
function string(v: unknown): string {
  if (typeof v !== "string") unavailable();
  return v;
}
function number(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) unavailable();
  return v;
}
function date(v: unknown): number {
  const n = Date.parse(string(v));
  if (!Number.isFinite(n)) unavailable();
  return n;
}
function connection(v: unknown, direction: "hasNextPage" | "hasPreviousPage") {
  const c = object(v);
  const more = object(c.pageInfo)[direction];
  if (typeof more !== "boolean" || !Array.isArray(c.nodes)) unavailable();
  return { nodes: c.nodes.map(object), more };
}
function nodes(v: unknown): Record<string, unknown>[] {
  const c = connection(v, "hasNextPage");
  if (c.more) unavailable();
  return c.nodes;
}
function remoteJson(repo: Repo, args: string[]): unknown {
  try {
    return JSON.parse(gh(repo, args, "GitHub issue queue"));
  } catch (e) {
    if (e instanceof WtError) throw new WtError(69, tidy(e.message));
    return unavailable();
  }
}

/** Only github.com SSH and HTTPS origins establish a repository identity. */
export function githubRepository(url: string): { owner: string; nameWithOwner: string } {
  const match =
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com(?::22)?\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/i.exec(
      url,
    );
  const name = match?.[2]?.replace(/\.git$/i, "");
  if (!match?.[1] || !name) throw new WtError(2, "origin must identify a github.com repository (SSH or HTTPS).");
  return { owner: match[1], nameWithOwner: `${match[1]}/${name}` };
}

/** The checkout origin is the only source of GitHub repository identity. */
export function originRepository(repo: Repo): { owner: string; nameWithOwner: string } {
  const remote = gitTry(repo, ["remote", "get-url", "origin"]);
  if (remote.code !== 0) throw new WtError(2, "Could not read git origin's repository identity.");
  return githubRepository(remote.stdout);
}

/** gh placeholders can resolve a different repository (for example GH_REPO). Never trust that identity. */
function repository(repo: Repo, query: string, variables: string[]): Record<string, unknown> {
  const expected = originRepository(repo);
  const response = object(
    remoteJson(repo, [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${expected.owner}`,
      "-f",
      `name=${expected.nameWithOwner.slice(expected.owner.length + 1)}`,
      ...variables.flatMap((v) => [v.startsWith("number=") ? "-F" : "-f", v]),
    ]),
  );
  if (response.errors !== undefined) unavailable();
  const data = object(object(response.data).repository);
  if (string(data.nameWithOwner).toLowerCase() !== expected.nameWithOwner.toLowerCase()) {
    throw new WtError(
      2,
      "Repository mismatch: gh resolved a repository different from git origin. Nothing was created.",
    );
  }
  if (string(object(data.owner).login).toLowerCase() !== expected.owner.toLowerCase()) unavailable();
  return data;
}
function pages(
  repo: Repo,
  query: string,
  field: string,
): { data: Record<string, unknown>; owner: string; name: string; label: unknown }[] {
  const out: { data: Record<string, unknown>; owner: string; name: string; label: unknown }[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const r = repository(repo, query, cursor === null ? [] : [`cursor=${cursor}`]);
    const c = connection(r[field], "hasNextPage");
    for (const data of c.nodes)
      out.push({ data, owner: string(object(r.owner).login), name: string(r.nameWithOwner), label: r.label });
    if (!c.more) return out;
    cursor = string(object(object(r[field]).pageInfo).endCursor);
    if (!cursor || seen.has(cursor)) unavailable();
    seen.add(cursor);
  }
}

interface Claim {
  branch: string;
  reason: string;
  issue?: number;
}
/** Preserve the first claim's precedence, including both metadata and branch-number claims. */
export function indexClaims(claims: Iterable<Claim>): ReadonlyMap<number, Claim> {
  const index = new Map<number, Claim>();
  for (const claim of claims) {
    const branchIssue = issueFromBranch(claim.branch);
    for (const n of [claim.issue, branchIssue]) {
      if (n !== undefined && n !== null && !index.has(n)) index.set(n, claim);
    }
  }
  return index;
}
/** Used again under the setup lock. Tracking refs deliberately do not participate. */
export function branchClaims(repo: Repo, registry: Registry = readRegistry(repo), ownBranch?: string): Claim[] {
  const local = gitTry(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
  const remote = gitTry(repo, ["ls-remote", "--heads", "origin"]);
  if (local.code !== 0 || remote.code !== 0) throw new WtError(69, "Could not read local and live origin branches.");
  const claims: Claim[] = [];
  for (const ref of local.stdout.split("\n").filter(Boolean)) {
    if (!ref.startsWith("refs/heads/")) unavailable();
    claims.push({ branch: ref.slice(11), reason: "local branch" });
  }
  for (const line of remote.stdout.split("\n").filter(Boolean)) {
    const match = /^[0-9a-f]{40,64}\trefs\/heads\/(.+)$/.exec(line);
    if (!match) unavailable();
    claims.push({ branch: match[1] as string, reason: "origin branch" });
  }
  const registered: Claim[] = [];
  for (const [branch, entry] of Object.entries(registry.worktrees)) {
    if (branch === ownBranch && entry.path === repo.callerTop) continue;
    registered.push({ branch, issue: entry.issue, reason: "registered worktree" });
  }
  return registered.reverse().concat(claims.filter((c) => c.branch !== ownBranch));
}
function takenClaims(repo: Repo, ownBranch?: string): ReadonlyMap<number, Claim> {
  const claims = branchClaims(repo, readRegistry(repo), ownBranch);
  for (const { data: pr, name } of pages(repo, PR_QUERY, "pullRequests")) {
    if (pr.isCrossRepository === true) continue;
    if (pr.isCrossRepository !== false) unavailable();
    const branch = string(pr.headRefName);
    const reason = `open PR #${number(pr.number)}`;
    const refs = nodes(pr.closingIssuesReferences);
    if (branch === ownBranch) continue;
    claims.push({ branch, reason });
    for (const ref of refs) {
      if (string(object(ref.repository).nameWithOwner).toLowerCase() === name.toLowerCase())
        claims.push({ branch, reason, issue: number(ref.number) });
    }
  }
  return indexClaims(claims);
}
function ownerActor(value: unknown, owner: string): boolean {
  // An organization owner never matches a user actor, so organization-owned repositories fail closed.
  return value !== null && string(object(value).login).toLowerCase() === owner.toLowerCase();
}
/** With older entries omitted, coverage must reach strictly before the interval's start, including ties. */
function covers(more: boolean, times: number[], ready: number): boolean {
  return !more || (times.length > 0 && Math.min(...times) < ready);
}
/**
 * Require the current ready label and its latest application by the repository owner, strictly after
 * the label's last update. Timeline and edit history must cover ready, and a non-null lastEditedAt must agree
 * with the first (newest) recorded body version. Refuse ready removals and non-owner body edits at or
 * after approval. Approval must strictly follow every body version and rename, including the owner's.
 * Saving a revision, such as ticking a checkbox, does not prove the owner wrote every part of the body.
 * Title ownership is separate: require complete rename history and an owner as the latest title writer.
 * Missing/deleted actors are not owners.
 * Open/ready status, invisible text, blockers and claims are checked separately by evaluateIssue.
 */
function trust(
  data: Record<string, unknown>,
  owner: string,
  readyLabel: unknown,
): { readyAt: string | null; reason: string | null; titleOwned: boolean } {
  const timeline = connection(data.timelineItems, "hasPreviousPage");
  const edits = connection(data.userContentEdits, "hasNextPage");
  const events = timeline.nodes
    .map((e) => {
      if (!["LabeledEvent", "UnlabeledEvent", "RenamedTitleEvent"].includes(string(e.__typename))) unavailable();
      if (e.__typename !== "RenamedTitleEvent") string(object(e.label).id);
      return { e, time: date(e.createdAt) };
    })
    .sort((a, b) => a.time - b.time);
  const rename = events.filter(({ e }) => e.__typename === "RenamedTitleEvent").at(-1);
  const titleOwned = !timeline.more && ownerActor(rename ? rename.e.actor : data.author, owner);
  if (readyLabel === null) return { readyAt: null, reason: "ready label is missing", titleOwned };
  const label = object(readyLabel);
  const labelId = string(label.id);
  const latest = events.filter(({ e }) => e.__typename === "LabeledEvent" && object(e.label).id === labelId).at(-1);
  if (!latest) return { readyAt: null, reason: "no owner ready event found", titleOwned };
  const readyAt = string(latest.e.createdAt);
  const refuse = (reason: string) => ({ readyAt, reason, titleOwned });
  if (date(label.updatedAt) >= latest.time) return refuse("ready label changed after approval");
  if (!ownerActor(latest.e.actor, owner)) return refuse("ready was not added by the repository owner");
  if (
    !covers(
      timeline.more,
      events.map((e) => e.time),
      latest.time,
    )
  )
    return refuse("timeline is truncated around ready");
  const unedited = data.lastEditedAt === null;
  if (unedited && (edits.nodes.length !== 0 || edits.more))
    return refuse("body edit history is inconsistent with lastEditedAt");
  // Never-edited bodies have no history nodes. After an edit, GitHub returns newest first,
  // with the original version included when the connection is complete.
  const versions = unedited ? [{ editedAt: data.createdAt, editor: data.author }] : edits.nodes;
  const changes = versions.map((e) => ({ e, time: date(e.editedAt) }));
  if (changes.some((change, i) => i > 0 && change.time > (changes[i - 1]?.time ?? -Infinity)))
    return refuse("body edit history is not newest first");
  if (
    !covers(
      edits.more,
      changes.map((e) => e.time),
      latest.time,
    )
  )
    return refuse("body edit history is truncated around ready");
  const newest = changes[0];
  if (!newest || (data.lastEditedAt !== null && newest.time !== date(data.lastEditedAt)))
    return refuse("last edit is missing from the body edit history");
  if (
    !covers(
      edits.more,
      changes.map(({ time }) => time),
      newest.time,
    )
  )
    return refuse("body edit history is truncated around the newest version");
  for (const { e, time } of changes) {
    if (time >= latest.time && !ownerActor(e.editor, owner))
      return refuse("body edited after ready by someone other than the owner");
  }
  for (const { e, time } of events) {
    if (time < latest.time) continue;
    if (e.__typename === "RenamedTitleEvent" && !ownerActor(e.actor, owner))
      return refuse("renamed after ready by someone other than the owner");
    if (e.__typename === "UnlabeledEvent" && object(e.label).id === labelId)
      return refuse("ready was removed after approval");
  }
  if (changes.some(({ e, time }) => time === newest.time && !ownerActor(e.editor, owner)))
    return refuse("current body was not written by the repository owner");
  if (newest.time >= latest.time) return refuse("ready must be strictly later than the newest body version");
  if (rename && rename.time >= latest.time) return refuse("ready must be strictly later than the last rename");
  return { readyAt, reason: null, titleOwned };
}

/** Check approved text for invisible instructions, with only contextual emoji exceptions. */
function hasInvisibleText(text: string): boolean {
  const chars = [...text.replaceAll("\r\n", "\n")];
  const pictographic = (index: number) => /\p{Extended_Pictographic}/u.test(chars[index] ?? "");
  return chars.some((char, i) => {
    if (char === "\u200d") {
      let before = chars[i - 1] === "\ufe0f" ? i - 2 : i - 1;
      // A skin tone belongs to the preceding pictograph, including its selector.
      if (/[\u{1f3fb}-\u{1f3ff}]/u.test(chars[before] ?? "")) {
        before--;
        if (chars[before] === "\ufe0f") before--;
      }
      return !pictographic(before) || !pictographic(i + 1);
    }
    if (char === "\ufe0f") {
      const keycap = /^[0-9#*]$/u.test(chars[i - 1] ?? "") && chars[i + 1] === "\u20e3";
      return !keycap && !pictographic(i - 1);
    }
    if (char === "\n" || char === "\t") return false;
    if (BLANK_GLYPHS.test(char)) return true;
    if (/\p{M}/u.test(char)) {
      // Keycaps also take # or * as a base. Other enclosing marks and marks
      // directly after an emoji selector can draw misleading boxes.
      const base = chars[i - 1] === "\ufe0f" ? i - 2 : i - 1;
      const keycap = char === "\u20e3" && /^[0-9#*]$/u.test(chars[base] ?? "");
      if (!keycap && /\p{Me}/u.test(char)) return true;
      if (!keycap && chars[i - 1] === "\ufe0f") return true;
      if (!keycap && !/[\p{L}\p{N}\p{M}]/u.test(chars[i - 1] ?? "")) return true;
    }
    // biome-ignore lint/suspicious/noMisleadingCharacterClass: these ranges reject individual selectors and tags
    return /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Co}\p{Cn}\p{Cc}\u2028\u2029\u{e0000}-\u{e007f}\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u.test(
      char,
    );
  });
}

/** The single eligibility decision for queue, spawn and check. Callers supply their own claim exemption. */
export function evaluateIssue(
  data: Record<string, unknown>,
  owner: string,
  claims: ReadonlyMap<number, Claim>,
  readyLabel: unknown,
  scanMarkdown: typeof hiddenMarkdownReason = hiddenMarkdownReason,
) {
  const labels = nodes(data.labels).map((l) => string(l.name));
  const approval = trust(data, owner, readyLabel);
  const title = string(data.title);
  const blockedBy = nodes(data.blockedBy).map((b): IssueRow["blockedBy"][number] => {
    if (b.state !== "OPEN" && b.state !== "CLOSED") unavailable();
    return { number: number(b.number), state: b.state };
  });
  const n = number(data.number);
  const taken = claims.get(n);
  const open = blockedBy.filter((b) => b.state === "OPEN");
  let reason = data.state !== "OPEN" || !labels.includes("ready") ? "not open and ready" : approval.reason;
  if (reason === null) {
    const body = string(data.body);
    const invisible = (approval.titleOwned && hasInvisibleText(title)) || hasInvisibleText(body);
    reason = invisible ? "invisible characters in the title or body" : scanMarkdown(body);
  }
  const row: IssueRow = {
    number: n,
    title: reason || !approval.titleOwned ? null : title,
    url: string(data.url),
    kind: labels.includes("bug")
      ? "bug"
      : labels.includes("feature")
        ? "feature"
        : labels.includes("improvement")
          ? "improvement"
          : "-",
    priority: labels.includes("P0") ? "P0" : labels.includes("P2") && !labels.includes("P1") ? "P2" : "P1",
    status: reason ? "untrusted" : open.length ? "blocked" : taken ? "taken" : "pickable",
    reason:
      reason ??
      (open.length
        ? `blocked by ${open.map((b) => `#${b.number}`).join(", ")}`
        : taken
          ? `${taken.reason} ${tidy(taken.branch)}`
          : null),
    blockedBy,
    branch: taken?.branch ?? null,
  };
  return { row, readyAt: approval.readyAt, titleOwned: approval.titleOwned };
}
export function scanIssues(repo: Repo): IssueRow[] {
  const fetched = pages(repo, QUERY, "issues");
  const claims = takenClaims(repo);
  return fetched
    .map(({ data, owner, label }) => ({
      row: evaluateIssue(data, owner, claims, label).row,
      createdAt: date(data.createdAt),
    }))
    .sort(
      (a, b) =>
        Number(b.row.kind === "bug") - Number(a.row.kind === "bug") ||
        a.row.priority.localeCompare(b.row.priority) ||
        a.createdAt - b.createdAt ||
        a.row.number - b.row.number,
    )
    .map(({ row }) => ({
      ...row,
      title: row.title === null ? null : tidy(row.title, Infinity),
      branch: row.branch === null ? null : tidy(row.branch, Infinity),
    }));
}
export function pickIssue(repo: Repo, n: number, ownBranch?: string, allowTaken = false): PickedIssue {
  issueNumber(String(n));
  const r = repository(repo, SINGLE_QUERY, [`number=${n}`]);
  if (r.issue === null) throw new WtError(2, `Issue #${n} is not open and ready.`);
  const data = object(r.issue);
  if (number(data.number) !== n) unavailable();
  const { row, readyAt, titleOwned } = evaluateIssue(
    data,
    string(object(r.owner).login),
    takenClaims(repo, ownBranch),
    r.label,
  );
  if (row.status !== "pickable" && !(allowTaken && row.status === "taken"))
    throw new WtError(row.status === "taken" ? 3 : 2, `Issue #${n} is ${row.status}: ${row.reason}.`);
  if (readyAt === null) unavailable();
  return {
    ...row,
    title: string(data.title),
    titleOwned,
    body: string(data.body),
    readyAt,
    fetchedAt: new Date().toISOString(),
  };
}
export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}
export function issueSnapshotText(issue: PickedIssue): string {
  const heading = issue.titleOwned
    ? `# ${tidy(issue.title, Infinity)}`
    : `# Issue ${issue.number}\nThe title is left out because the owner did not write it.`;
  return `${heading}\n${issue.url}\nThe issue body as its owner wrote it, in Markdown.\n\n${issue.body.replaceAll("\r\n", "\n")}`;
}
export function issueSnapshot(issue: PickedIssue) {
  return {
    number: issue.number,
    url: issue.url,
    title: issue.titleOwned ? issue.title : null,
    bodySha256: sha256(issue.body),
    titleSha256: sha256(issue.title),
    snapshotSha256: sha256(issueSnapshotText(issue)),
    readyAt: issue.readyAt,
    fetchedAt: issue.fetchedAt,
  };
}
export function checkIssue(repo: Repo): number {
  try {
    const n = issueFromBranch(repo.callerBranch ?? "");
    if (n === null || repo.callerBranch === `${BRANCH_PREFIX}${n}-` || !repo.callerTop)
      throw new Error("Run issue check inside an emend-<n>-<slug> issue worktree.");
    const metadata = worktreeIssue(repo.callerTop);
    if (metadata !== n) throw new Error("Worktree issue does not match the branch.");
    let snapshot: Record<string, unknown>;
    try {
      snapshot = readWtJson(repo.callerTop, "issue.json");
    } catch {
      throw new Error("Could not read .wt/issue.json.");
    }
    if (
      typeof snapshot.snapshotSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(snapshot.snapshotSha256) ||
      snapshot.number !== n ||
      (snapshot.title !== null && typeof snapshot.title !== "string") ||
      typeof snapshot.titleSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(snapshot.titleSha256) ||
      (typeof snapshot.title === "string" && snapshot.titleSha256 !== sha256(snapshot.title)) ||
      typeof snapshot.bodySha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(snapshot.bodySha256) ||
      typeof snapshot.url !== "string" ||
      typeof snapshot.readyAt !== "string" ||
      !Number.isFinite(Date.parse(snapshot.readyAt)) ||
      typeof snapshot.fetchedAt !== "string" ||
      !Number.isFinite(Date.parse(snapshot.fetchedAt))
    )
      throw new Error("Invalid issue snapshot.");
    let bytes: Uint8Array;
    try {
      bytes = readFileBytes(join(repo.callerTop, ".wt", "issue.md"));
    } catch {
      throw new Error("Could not read .wt/issue.md.");
    }
    if (sha256(bytes) !== snapshot.snapshotSha256) throw new Error(".wt/issue.md differs from the snapshot.");
    const live = pickIssue(repo, n, repo.callerBranch as string);
    if (live.url !== snapshot.url) throw new Error("Live issue URL differs from the snapshot.");
    if (sha256(live.title) !== snapshot.titleSha256) throw new Error("Live issue title differs from the snapshot.");
    if (sha256(live.body) !== snapshot.bodySha256) throw new Error("Live issue body differs from the snapshot.");
    if (!Buffer.from(bytes).equals(Buffer.from(issueSnapshotText(live))))
      throw new Error(".wt/issue.md differs from the live approved issue.");
    return n;
  } catch (e) {
    throw new WtError(
      e instanceof WtError && e.code === 69 ? 69 : 1,
      tidy(e instanceof Error ? e.message : "Issue check failed."),
    );
  }
}

/** First two to five ASCII words, bounded by the branch validator's 63-character limit. */
export function issueSlug(title: string, n: number): string {
  const words = title
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.slice(0, 5) ?? ["issue"];
  const max = 63 - BRANCH_PREFIX.length - String(n).length - 1;
  while (words.length > 2 && words.join("-").length > max) words.pop();
  if (words.join("-").length > max) {
    const perWord = Math.floor((max - words.length + 1) / words.length);
    return words.map((word) => word.slice(0, perWord)).join("-");
  }
  return words.join("-");
}
export function formatIssues(rows: IssueRow[]): string {
  return rows
    .map((r) =>
      r.status === "untrusted"
        ? `#${r.number}  ${r.status}${r.reason ? ` (${tidy(r.reason)})` : ""}`
        : `#${r.number}  ${r.kind}  ${r.priority}  ${r.status}${r.reason ? ` (${tidy(r.reason)})` : ""}  ${tidy(r.title ?? "", 120)}`,
    )
    .join("\n");
}
const issuesCommand: Command = ({ repo, args }) => {
  const { flags } = parseFlags(args, { json: "boolean" });
  const rows = scanIssues(repo);
  const out = flags.json
    ? JSON.stringify(
        rows.map((row) =>
          row.status === "untrusted"
            ? { number: row.number, status: row.status, reason: row.reason, title: null }
            : row,
        ),
        null,
        2,
      )
    : formatIssues(rows);
  if (out) process.stdout.write(`${out}\n`);
  return 0;
};
const issueCommand: Command = ({ repo, args }) => {
  const usage = "Usage: bin/wt issue check | show <n> [--taken]";
  if (args[0] === "show") {
    const { flags, positionals } = parseFlags(args.slice(1), { taken: "boolean" }, 1);
    if (positionals.length !== 1) throw new WtError(2, usage);
    const n = issueNumber(positionals[0] as string);
    let issue: PickedIssue;
    try {
      issue = pickIssue(repo, n, undefined, flags.taken === true);
    } catch (e) {
      if (e instanceof WtError && !e.message.includes("Nothing was created."))
        throw new WtError(e.code, `${e.message} Nothing was created.`);
      throw e;
    }
    process.stdout.write(issueSnapshotText(issue));
    return 0;
  }
  if (args.length !== 1 || args[0] !== "check") throw new WtError(2, usage);
  process.stdout.write(`ok #${checkIssue(repo)}\n`);
  return 0;
};
export const commands: CommandTable = { issues: issuesCommand, issue: issueCommand };
