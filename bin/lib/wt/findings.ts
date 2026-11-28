import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { checkText } from "../../../scripts/check-public.ts";
import type { CommandTable } from "./command.ts";
import { renderTriagePage } from "./findings-page.ts";
import { findingAnchor, findingLines, sha256 } from "./findings-source.ts";
import { run, runBytes } from "./proc.ts";
import { isFindingId, stateDir, withStateLock } from "./registry.ts";
import { GIT_BASE, type Repo } from "./repo.ts";
import { branchName, commitSha, parseFlags, readFileBytes, readTextFile, WtError } from "./validate.ts";

const KINDS = ["bug", "defect", "test", "docs", "ux", "react-perf", "react-style", "architecture", "security"] as const;
const STATES = ["open", "claimed", "fixed", "dismissed", "stale"] as const;
const PRIORITIES = ["P0", "P1", "P2"] as const;
const INPUT_KEYS = ["title", "detail", "path", "line", "kind", "severity", "size", "source"];
const HASH = /^[0-9a-f]{64}$/;
const CONTROLS = /\p{Cc}/u;
const BLOB = /^[0-9a-f]{40}$/;
type Store = "findings" | "groom";

export interface FindingInput {
  title: string;
  detail: string;
  path: string;
  line: number;
  kind: (typeof KINDS)[number];
  rule?: string;
  severity: "high" | "medium" | "low";
  size: "small" | "large";
  source: { kind: "review"; branch: string; round: string } | { kind: "groom"; pass: string };
}

export interface Finding extends FindingInput {
  version: 1;
  id: string;
  fingerprint: string;
  commit: string;
  anchor: string;
  state: (typeof STATES)[number];
  createdAt: string;
  approval?: { priority: (typeof PRIORITIES)[number]; at: string };
  claim?: { branch: string; worktree: string; at: string };
  resolution?: { at: string; commit?: string; reason?: string };
}

export interface FindingFilters {
  state?: string;
  triage?: string;
  kind?: string;
  path?: string;
}

export type BundleFinding = Omit<FindingInput, "source"> & Pick<Finding, "id" | "commit" | "createdAt">;

export type FindingResolution = { fixed: string } | { dismissed: string } | { stale: true };
type ClaimOwner = { branch: string; worktree: string };

function invalid(field: string): never {
  throw new WtError(2, `Invalid finding ${field}.`);
}

function storageError(store: Store = "findings"): never {
  const label = store === "groom" ? "Groom" : "Finding";
  throw new WtError(1, `${label} storage is unreadable, corrupt or symlinked. Nothing was changed.`);
}

function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("object");
  if (required.some((key) => !Object.hasOwn(value, key))) invalid("fields");
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid("fields");
  return value as Record<string, unknown>;
}

function checkedText(value: unknown, field: string, max: number, multiline = false): string {
  if (typeof value !== "string") invalid(field);
  const length = [...value].length;
  if (length < 1 || length > max || /\p{Cf}/u.test(value)) invalid(field);
  if (CONTROLS.test(multiline ? value.replace(/[\n\t]/g, "") : value)) invalid(field);
  if (!multiline && /[\u2028\u2029]/u.test(value)) invalid(field);
  publicText(value, field);
  return value;
}

function publicText(value: string, field: string): void {
  const hit = checkText(value, field, { terms: [], allowed: [], notes: [] }, { lineExemptions: false })[0];
  if (hit) throw new WtError(2, hit);
}

function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) invalid(field);
  return value as T;
}

function inputPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    [...value].length > 300 ||
    value.includes("\\") ||
    CONTROLS.test(value) ||
    /[\p{Cf}\u2028\u2029]/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    invalid("path");
  publicText(value, "path");
  return value;
}

function validInputPath(value: unknown): value is string {
  try {
    inputPath(value);
    return true;
  } catch {
    return false;
  }
}

function sourceTag(value: unknown, field: string): string {
  const tag = checkedText(value, field, 40);
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(tag)) invalid(field);
  return tag;
}

function checkedBranch(value: unknown): string {
  return branchName(checkedText(value, "source branch", 63));
}

function parseInput(value: unknown): FindingInput {
  const data = object(value, INPUT_KEYS, ["rule"]);
  const source = object(data.source, ["kind"], ["branch", "round", "pass"]);
  let parsedSource: FindingInput["source"];
  if (source.kind === "review") {
    object(source, ["kind", "branch", "round"]);
    parsedSource = {
      kind: "review",
      branch: checkedBranch(source.branch),
      round: sourceTag(source.round, "source round"),
    };
  } else if (source.kind === "groom") {
    object(source, ["kind", "pass"]);
    parsedSource = { kind: "groom", pass: sourceTag(source.pass, "source pass") };
  } else invalid("source kind");
  publicText(parsedSource.kind, "source kind");
  const result: FindingInput = {
    title: checkedText(data.title, "title", 120),
    detail: checkedText(data.detail, "detail", 4000, true),
    path: inputPath(data.path),
    line: data.line as number,
    kind: choice(data.kind, KINDS, "kind"),
    severity: choice(data.severity, ["high", "medium", "low"], "severity"),
    size: choice(data.size, ["small", "large"], "size"),
    source: parsedSource,
  };
  if (!Number.isSafeInteger(result.line) || result.line < 1) invalid("line");
  if (Object.hasOwn(data, "rule")) {
    result.rule = checkedText(data.rule, "rule", 80);
    if (!/^[a-z0-9-]+$/.test(result.rule)) invalid("rule");
  }
  return result;
}

function findingId(value: string): string {
  if (!isFindingId(value)) invalid("id");
  return value;
}

function timestamp(value: unknown): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    invalid("timestamp");
}

function claimTarget(value: unknown): ClaimOwner {
  const data = object(value, ["branch", "worktree"]);
  const branch = checkedBranch(data.branch);
  const worktree = data.worktree;
  if (
    typeof worktree !== "string" ||
    worktree.length < 1 ||
    [...worktree].length > 4096 ||
    !isAbsolute(worktree) ||
    CONTROLS.test(worktree) ||
    /[\p{Cf}\u2028\u2029]/u.test(worktree)
  )
    invalid("worktree");
  // Local worktrees may live under a real home path; refuse every other check-public hit.
  const hits = checkText(worktree, "claim worktree", { terms: [], allowed: [], notes: [] }, { lineExemptions: false });
  const hit = hits.find((hit) => hit !== "claim worktree: real home path");
  if (hit) throw new WtError(2, hit);
  return { branch, worktree };
}

function fingerprint(input: FindingInput, anchor: string): string {
  return sha256([input.path, input.kind, input.rule ?? "", anchor].join("\n"));
}

function parseStored(value: unknown, id: string): Finding {
  const data = object(
    value,
    [...INPUT_KEYS, "version", "id", "fingerprint", "commit", "anchor", "state", "createdAt"],
    ["rule", "approval", "claim", "resolution"],
  );
  const input = parseInput(
    Object.fromEntries(
      [...INPUT_KEYS, "rule"].filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]),
    ),
  );
  if (data.version !== 1 || data.id !== id || typeof data.anchor !== "string" || !HASH.test(data.anchor))
    invalid("record");
  if (data.fingerprint !== fingerprint(input, data.anchor) || id !== `f-${String(data.fingerprint).slice(0, 12)}`)
    invalid("fingerprint");
  commitSha(data.commit as string);
  timestamp(data.createdAt);
  if (Object.hasOwn(data, "approval")) {
    const approval = object(data.approval, ["priority", "at"]);
    choice(approval.priority, PRIORITIES, "priority");
    timestamp(approval.at);
  }
  const state = choice(data.state, STATES, "state");
  if (state === "claimed") {
    const claim = object(data.claim, ["branch", "worktree", "at"]);
    claimTarget({ branch: claim.branch, worktree: claim.worktree });
    timestamp(claim.at);
  } else if (Object.hasOwn(data, "claim")) invalid("claim");
  if (state === "fixed" || state === "dismissed" || state === "stale") {
    const resolution = object(
      data.resolution,
      state === "fixed" ? ["at", "commit"] : state === "dismissed" ? ["at", "reason"] : ["at"],
    );
    timestamp(resolution.at);
    if (state === "fixed") commitSha(resolution.commit as string);
    if (state === "dismissed") checkedText(resolution.reason, "dismissal reason", 200);
  } else if (Object.hasOwn(data, "resolution")) invalid("resolution");
  return data as unknown as Finding;
}

export function findingsDir(repo: Repo): string {
  return join(stateDir(repo), "findings");
}

/** lstat each component before descending; reads never create a directory. */
function storageDirectory(repo: Repo, create = false, store: Store = "findings"): boolean {
  try {
    if (!lstatSync(repo.commonDir).isDirectory()) storageError(store);
    for (const path of [stateDir(repo), join(stateDir(repo), store)]) {
      let entry = lstatSync(path, { throwIfNoEntry: false });
      if (!entry) {
        if (!create) return false;
        try {
          mkdirSync(path, { mode: 0o700 });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        entry = lstatSync(path);
      }
      if (!entry.isDirectory()) storageError(store);
      if (create) chmodSync(path, 0o700);
    }
    return true;
  } catch {
    return storageError(store);
  }
}

function readFindingIfPresent(repo: Repo, id: string): Finding | undefined {
  if (!storageDirectory(repo)) return undefined;
  try {
    return parseStored(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(readFileBytes(join(findingsDir(repo), `${id}.json`))),
      ),
      id,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return storageError();
  }
}

function readFinding(repo: Repo, id: string, missingCode: 1 | 2 = 1): Finding {
  const finding = readFindingIfPresent(repo, id);
  if (!finding) throw new WtError(missingCode, "Unknown finding.");
  return finding;
}

function stageFile(directory: string, id: string, content: string | Buffer, temps: Set<string>): string {
  const temp = join(directory, `.${id}.${randomBytes(12).toString("hex")}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  temps.add(temp);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temp;
}

function replaceFile(directory: string, name: string, content: string): void {
  const temps = new Set<string>();
  try {
    const temp = stageFile(directory, name, content, temps);
    renameSync(temp, join(directory, name));
    temps.delete(temp);
  } finally {
    for (const temp of temps) unlinkSync(temp);
  }
}

function writeFindings(repo: Repo, findings: Finding[]): void {
  storageDirectory(repo, true);
  const temps = new Set<string>();
  const renamed: { id: string; path: string; previous: Buffer | null }[] = [];
  let failed = false;
  let restored = true;
  try {
    // Preserve the original bytes, including whitespace, for a failed batch's rollback.
    const staged = findings.map((finding) => {
      const path = join(findingsDir(repo), `${finding.id}.json`);
      const previous = lstatSync(path, { throwIfNoEntry: false }) ? readFileBytes(path) : null;
      const temp = stageFile(findingsDir(repo), finding.id, `${JSON.stringify(finding, null, 2)}\n`, temps);
      return { id: finding.id, path, previous, temp };
    });
    for (const record of staged) {
      renameSync(record.temp, record.path);
      temps.delete(record.temp);
      renamed.push(record);
    }
  } catch {
    failed = true;
    for (const record of renamed.reverse()) {
      try {
        if (record.previous === null) unlinkSync(record.path);
        else {
          const temp = stageFile(findingsDir(repo), record.id, record.previous, temps);
          renameSync(temp, record.path);
          temps.delete(temp);
        }
      } catch {
        restored = false;
      }
    }
  } finally {
    for (const temp of temps) {
      try {
        unlinkSync(temp);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          failed = true;
          restored = false;
        }
      }
    }
  }
  if (failed) {
    if (!restored) throw new WtError(1, "Some findings may have changed; run `bin/findings list`.");
    storageError();
  }
}

function mutate<T>(repo: Repo, fn: () => T, store: Store = "findings"): T {
  // Check the storage folder before even writing a lock in its parent.
  storageDirectory(repo, false, store);
  try {
    return withStateLock(repo, store, fn);
  } catch (e) {
    if (e instanceof WtError) throw e;
    return storageError(store);
  }
}

function gitOptions(repo: Repo) {
  return { cwd: repo.callerTop ?? process.cwd(), gitNoLazyFetch: true };
}

function gitResult(code: number, failureCode: 1 | 2, message: string): void {
  if (code === 127) throw new WtError(69, "Git is unavailable.");
  if (code !== 0) throw new WtError(failureCode, message);
}

function headCommit(repo: Repo): string {
  const result = run("git", [...GIT_BASE, "rev-parse", "HEAD"], gitOptions(repo));
  gitResult(result.code, 1, "Could not read HEAD.");
  return commitSha(result.stdout.trim());
}

export function addFinding(repo: Repo, value: unknown): { id: string; created: boolean } {
  const input = parseInput(value);
  return mutate(repo, () => {
    const commit = headCommit(repo);
    const tree = runBytes(
      "git",
      [...GIT_BASE, "--literal-pathspecs", "ls-tree", "-z", "--full-tree", commit, "--", input.path],
      gitOptions(repo),
    );
    gitResult(tree.code, 2, "Could not read finding path at HEAD.");
    const entry = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(tree.stdout.toString("utf8"));
    if (!entry || entry[3] !== input.path) invalid("path: expected a regular file tracked at HEAD");
    const blob = runBytes("git", [...GIT_BASE, "cat-file", "blob", entry[2] as string], gitOptions(repo));
    gitResult(blob.code, 2, "Could not read finding blob at HEAD.");
    let lines: string[];
    try {
      lines = findingLines(blob.stdout);
    } catch {
      invalid("path: expected UTF-8");
    }
    const line = lines[input.line - 1];
    if (line === undefined) invalid("line");
    const anchor = findingAnchor(line);
    const hash = fingerprint(input, anchor);
    const id = `f-${hash.slice(0, 12)}`;
    storageDirectory(repo, true);
    if (lstatSync(join(findingsDir(repo), `${id}.json`), { throwIfNoEntry: false })) {
      if (readFinding(repo, id).fingerprint !== hash) storageError();
      return { id, created: false };
    }
    writeFindings(repo, [
      {
        ...input,
        version: 1,
        id,
        fingerprint: hash,
        commit,
        anchor,
        state: "open",
        createdAt: new Date().toISOString(),
      },
    ]);
    return { id, created: true };
  });
}

function withOrphaned(finding: Finding): Finding & { orphaned: boolean } {
  let orphaned = false;
  if (finding.claim) {
    try {
      orphaned = !statSync(finding.claim.worktree).isDirectory();
    } catch (e) {
      if (!["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) storageError();
      orphaned = true;
    }
  }
  return { ...finding, orphaned };
}

export function showFinding(repo: Repo, id: string): Finding & { orphaned: boolean } {
  return withOrphaned(readFinding(repo, findingId(id)));
}

/** Read under the findings lock. Report each unreadable record skipped by the listing. */
function readStoredFindings(repo: Repo, onSkipped?: (message: string) => void): Finding[] {
  if (!storageDirectory(repo)) return [];
  let names: string[];
  try {
    names = readdirSync(findingsDir(repo));
  } catch {
    return storageError();
  }
  const findings: Finding[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!isFindingId(id)) {
      onSkipped?.("Skipped a finding file with an invalid name.");
      continue;
    }
    try {
      findings.push(readFinding(repo, id));
    } catch {
      storageDirectory(repo);
      onSkipped?.(`Skipped unreadable finding ${id}.`);
    }
  }
  return findings;
}

function triageStatus(finding: Finding): "approved" | "untriaged" | undefined {
  if (finding.approval) return "approved";
  if (finding.state === "open") return "untriaged";
}

export function listFindings(
  repo: Repo,
  filters: FindingFilters = {},
  onSkipped?: (message: string) => void,
): (Finding & { orphaned: boolean })[] {
  if (filters.state !== undefined) choice(filters.state, STATES, "state");
  if (filters.triage !== undefined) choice(filters.triage, ["approved", "untriaged"], "triage");
  if (filters.kind !== undefined) choice(filters.kind, KINDS, "kind");
  if (filters.path !== undefined) inputPath(filters.path);
  if (!storageDirectory(repo)) return [];
  const findings = withStateLock(repo, "findings", () => readStoredFindings(repo, onSkipped));
  return findings
    .filter(
      (finding) =>
        (filters.state === undefined || finding.state === filters.state) &&
        (filters.triage === undefined || filters.triage === triageStatus(finding)) &&
        (filters.kind === undefined || finding.kind === filters.kind) &&
        (filters.path === undefined || finding.path === filters.path || finding.path.startsWith(`${filters.path}/`)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(withOrphaned);
}

function writeTriagePage(repo: Repo): { page: string | null; key: string; findings: string[] } {
  if (repo.callerTop !== repo.mainRoot)
    throw new WtError(2, "Only the main checkout writes the triage page. Nothing was changed.");
  const key = `e-triage-${sha256(realpathSync(repo.mainRoot)).slice(0, 12)}`;
  const open = listFindings(repo, { state: "open" }, (message) => process.stderr.write(`${message}\n`));
  const directory = join(repo.mainRoot, ".wt");
  const folderError = "The main checkout's .wt must be a real folder. Nothing was changed.";
  const rendered = renderTriagePage(repo, open);
  if (rendered) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new WtError(2, folderError);
    }
  }
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry?.isDirectory() === false || (!entry && rendered)) throw new WtError(2, folderError);
  if (!rendered) return { page: null, key, findings: [] };
  replaceFile(directory, "triage.md", rendered.markdown);
  return { page: join(directory, "triage.md"), key, findings: rendered.ids };
}

export function checkedFindingIds(ids: string[]): string[] {
  if (ids.length === 0) invalid("ids");
  return [...new Set(ids.map(findingId))];
}

function triageIds(repo: Repo, ids: string[], action: "approves" | "skips"): string[] {
  if (repo.callerTop !== repo.mainRoot)
    throw new WtError(2, `Only the main checkout ${action} findings. Nothing was changed.`);
  const validIds = checkedFindingIds(ids);
  if (validIds.length !== ids.length) invalid("ids: duplicates");
  return validIds;
}

export function approveFindings(repo: Repo, ids: string[], priority: unknown): void {
  const validIds = triageIds(repo, ids, "approves");
  const checkedPriority = choice(priority, PRIORITIES, "priority");
  mutate(repo, () => {
    const approval = { priority: checkedPriority, at: new Date().toISOString() };
    const findings = validIds.map((id) => {
      const finding = readFinding(repo, id);
      if (finding.state !== "open") throw new WtError(1, `Finding ${id} is claimed or resolved. Nothing was changed.`);
      if (finding.kind === "security" || finding.size === "large")
        throw new WtError(2, "/e-fix does not take security or large findings. Nothing was changed.");
      return { ...finding, approval };
    });
    writeFindings(repo, findings);
  });
}

function skipFindings(repo: Repo, ids: string[]): void {
  const validIds = triageIds(repo, ids, "skips");
  mutate(repo, () => {
    const resolution = { at: new Date().toISOString(), reason: "skipped by the owner in triage" };
    const findings = validIds.map((id) => {
      const finding = readFinding(repo, id);
      if (finding.state !== "open" || finding.approval)
        throw new WtError(1, `Finding ${id} is claimed, resolved or approved. Nothing was changed.`);
      return { ...finding, state: "dismissed" as const, resolution };
    });
    writeFindings(repo, findings);
  });
}

function requireFindingApproval(finding: Finding): void {
  if (!finding.approval)
    throw new WtError(2, `Finding ${finding.id} is not approved for fixing. Run /e-triage first. Nothing was changed.`);
}

export function readBundleFindings(repo: Repo, ids: string[]): BundleFinding[] {
  return checkedFindingIds(ids).map((id) => {
    const finding = readFinding(repo, id, 2);
    if (finding.state !== "open") throw new WtError(3, `Finding ${id} is already claimed or resolved.`);
    if (finding.kind === "security" || finding.size === "large")
      throw new WtError(2, `Finding ${id} needs an issue. Only small, non-security findings can be bundled.`);
    requireFindingApproval(finding);
    return finding;
  });
}

export function claimFindings(repo: Repo, ids: string[], target: ClaimOwner): void {
  const validIds = checkedFindingIds(ids);
  const claim = { ...claimTarget(target), at: new Date().toISOString() };
  mutate(repo, () => {
    const findings = validIds.map((id) => readFinding(repo, id));
    if (findings.some((finding) => finding.state !== "open" || finding.kind === "security" || finding.size === "large"))
      throw new WtError(1, "Only open, small, non-security findings can be claimed. Nothing was changed.");
    for (const finding of findings) requireFindingApproval(finding);
    writeFindings(
      repo,
      findings.map((finding) => ({ ...finding, state: "claimed", claim })),
    );
  });
}

function refuseClaimOwner(): never {
  throw new WtError(1, "A worktree may only resolve or release findings it claimed. Nothing was changed.");
}

function callerOwner(repo: Repo): ClaimOwner | undefined {
  if (repo.callerTop === repo.mainRoot) return undefined;
  if (!repo.callerBranch || !repo.callerTop) return refuseClaimOwner();
  return { branch: repo.callerBranch, worktree: repo.callerTop };
}

/** Called under the findings lock, before writing any member of a batch. */
function findingToSettle(repo: Repo, id: string, owner?: ClaimOwner): Finding {
  if (!owner) return readFinding(repo, id);
  const finding = readFindingIfPresent(repo, id);
  if (finding?.state === "claimed" && finding.claim?.branch === owner.branch) {
    try {
      if (realpathSync(finding.claim.worktree) === realpathSync(owner.worktree)) return finding;
    } catch {
      // A missing or unreadable path cannot establish ownership.
    }
  }
  return refuseClaimOwner();
}

export function releaseFindings(repo: Repo, ids: string[], owner?: ClaimOwner): void {
  const validIds = checkedFindingIds(ids);
  mutate(repo, () => {
    const findings = validIds.map((id) => findingToSettle(repo, id, owner));
    if (findings.some((finding) => finding.state !== "claimed"))
      throw new WtError(1, "Only claimed findings can be released. Nothing was changed.");
    writeFindings(repo, findings.map(reopened));
  });
}

function reopened(finding: Finding): Finding {
  delete finding.claim;
  return { ...finding, state: "open" };
}

export function releaseOrphanedClaim(
  repo: Repo,
  id: string,
  seen: NonNullable<Finding["claim"]>,
  isLocked: (worktree: string) => boolean,
): boolean {
  findingId(id);
  return mutate(repo, () => {
    const finding = readFindingIfPresent(repo, id);
    const claim = finding?.claim;
    if (finding?.state !== "claimed" || !claim) return false;
    if (claim.branch !== seen.branch || claim.worktree !== seen.worktree || claim.at !== seen.at) return false;
    if (!withOrphaned(finding).orphaned || isLocked(claim.worktree)) return false;
    writeFindings(repo, [reopened(finding)]);
    return true;
  });
}

export function resolveMergedFindings(repo: Repo, ids: string[], target: ClaimOwner, commit: string): string[] {
  commitSha(commit);
  const owner = claimTarget(target);
  const validIds = checkedFindingIds(ids);
  return mutate(repo, () => {
    const findings = validIds
      .map((id) => readFinding(repo, id))
      .filter(
        (finding) =>
          finding.state === "claimed" &&
          finding.claim?.branch === owner.branch &&
          finding.claim.worktree === owner.worktree,
      );
    if (!findings.length) return [];
    const resolution = { at: new Date().toISOString(), commit };
    for (const finding of findings) {
      delete finding.claim;
      finding.state = "fixed";
      finding.resolution = resolution;
    }
    writeFindings(repo, findings);
    return findings.map((finding) => finding.id).sort();
  });
}

export function resolveFinding(repo: Repo, id: string, value: FindingResolution, owner?: ClaimOwner): void {
  findingId(id);
  const resolution = object(value, [], ["fixed", "dismissed", "stale"]);
  if (Object.keys(resolution).length !== 1) invalid("resolution");
  let state: "fixed" | "dismissed" | "stale";
  const detail: NonNullable<Finding["resolution"]> = { at: new Date().toISOString() };
  if (Object.hasOwn(resolution, "fixed")) {
    if (owner || repo.callerTop !== repo.mainRoot)
      throw new WtError(
        2,
        "A fixer's merge records its findings as fixed. A worktree cannot resolve a finding as fixed. Nothing was changed.",
      );
    state = "fixed";
    detail.commit = commitSha(resolution.fixed as string);
  } else if (Object.hasOwn(resolution, "dismissed")) {
    state = "dismissed";
    detail.reason = checkedText(resolution.dismissed, "dismissal reason", 200);
  } else {
    state = "stale";
    if (resolution.stale !== true) invalid("resolution");
  }
  const caller = owner ?? callerOwner(repo);
  mutate(repo, () => {
    const finding = findingToSettle(repo, id, caller);
    if (finding.state !== "open" && finding.state !== "claimed")
      throw new WtError(1, "The finding is already resolved.");
    if (detail.commit) {
      const result = run("git", [...GIT_BASE, "cat-file", "-t", detail.commit], gitOptions(repo));
      gitResult(result.code, 2, "The fixed commit does not exist.");
      if (result.stdout.trim() !== "commit") invalid("fixed commit");
    }
    delete finding.claim;
    writeFindings(repo, [{ ...finding, state, resolution: detail }]);
  });
}

interface GroomVisit {
  blob: string;
  at: string;
  findings: number;
}

function groomCandidates(repo: Repo): Map<string, string> {
  const opts = { cwd: repo.mainRoot, gitNoLazyFetch: true };
  const message = "Could not read HEAD of the main checkout.";
  const head = run("git", [...GIT_BASE, "rev-parse", "HEAD"], opts);
  gitResult(head.code, 1, message);
  const commit = head.stdout.trim();
  if (!BLOB.test(commit)) throw new WtError(1, message);
  const tree = runBytes("git", [...GIT_BASE, "ls-tree", "-r", "-z", "--full-tree", commit], opts);
  gitResult(tree.code, 1, message);
  const candidates = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (let start = 0; start < tree.stdout.length; ) {
    const end = tree.stdout.indexOf(0, start);
    if (end === -1) throw new WtError(1, message);
    const entry = tree.stdout.subarray(start, end);
    start = end + 1;
    const tab = entry.indexOf(9);
    if (tab === -1) throw new WtError(1, message);
    const header = /^(100644|100755) blob ([0-9a-f]{40})$/.exec(entry.subarray(0, tab).toString("ascii"));
    if (!header) continue;
    let path: string;
    try {
      path = decoder.decode(entry.subarray(tab + 1));
    } catch {
      continue;
    }
    if (!validInputPath(path) || path.startsWith("-") || path.includes("'")) continue;
    const parts = path.split("/");
    if (
      parts.at(-1) === "pnpm-lock.yaml" ||
      ["apps/recense/drizzle/", "docs/images/", "docs/vendor/"].some((prefix) => path.startsWith(prefix)) ||
      parts.slice(0, -1).includes("fixtures") ||
      /\.(png|jpg|jpeg|gif|webp|ico|svg|woff|woff2|ttf)$/i.test(path)
    )
      continue;
    candidates.set(path, header[2] as string);
  }
  return candidates;
}

function groomFindingsCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10000;
}

function readVisits(repo: Repo): Map<string, GroomVisit> {
  const visits = new Map<string, GroomVisit>();
  if (!storageDirectory(repo, false, "groom")) return visits;
  try {
    const path = join(stateDir(repo), "groom", "visits.json");
    if (!lstatSync(path, { throwIfNoEntry: false })) return visits;
    const data = object(JSON.parse(readTextFile(path)), ["version", "visits"]);
    if (data.version !== 1 || typeof data.visits !== "object" || data.visits === null || Array.isArray(data.visits))
      storageError("groom");
    for (const [path, value] of Object.entries(data.visits)) {
      const visit = object(value, ["blob", "at", "findings"]);
      if (
        !validInputPath(path) ||
        typeof visit.blob !== "string" ||
        visit.blob.length !== 40 ||
        !BLOB.test(visit.blob) ||
        !groomFindingsCount(visit.findings)
      )
        storageError("groom");
      timestamp(visit.at);
      visits.set(path, { blob: visit.blob, at: visit.at as string, findings: visit.findings });
    }
    return visits;
  } catch {
    return storageError("groom");
  }
}

function writeVisits(repo: Repo, visits: Map<string, GroomVisit>): void {
  const content = `${JSON.stringify({ version: 1, visits: Object.fromEntries(visits) }, null, 2)}\n`;
  // Never write a file that the bounded reader would refuse on the next pass.
  if (Buffer.byteLength(content) > 1024 * 1024) storageError("groom");
  storageDirectory(repo, true, "groom");
  try {
    replaceFile(join(stateDir(repo), "groom"), "visits.json", content);
  } catch {
    storageError("groom");
  }
}

function pruneVisits(visits: Map<string, GroomVisit>, candidates: Map<string, string>): boolean {
  let dropped = false;
  for (const path of visits.keys()) {
    if (candidates.has(path)) continue;
    visits.delete(path);
    dropped = true;
  }
  return dropped;
}

export function groomNext(
  repo: Repo,
  count: number,
): { path: string; blob: string; reason: "new" | "changed" | "oldest" }[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 50) throw new WtError(2, "Invalid groom count.");
  return mutate(
    repo,
    () => {
      const candidates = groomCandidates(repo);
      const visits = readVisits(repo);
      if (pruneVisits(visits, candidates)) writeVisits(repo, visits);
      const ranked = [...candidates].map(([path, blob]) => {
        const visit = visits.get(path);
        const reason = !visit ? "new" : visit.blob !== blob ? "changed" : "oldest";
        return { path, blob, reason, at: visit ? Date.parse(visit.at) : 0 } as const;
      });
      const priority = { new: 0, changed: 1, oldest: 2 };
      ranked.sort(
        (a, b) =>
          priority[a.reason] - priority[b.reason] || a.at - b.at || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      );
      return ranked.slice(0, count).map(({ path, blob, reason }) => ({ path, blob, reason }));
    },
    "groom",
  );
}

export function groomVisited(repo: Repo, path: string, blob: string, findings: number): void {
  if (!validInputPath(path)) throw new WtError(2, "Invalid groom path.");
  if (typeof blob !== "string" || blob.length !== 40 || !BLOB.test(blob)) throw new WtError(2, "Invalid groom blob.");
  if (!groomFindingsCount(findings)) throw new WtError(2, "Invalid groom findings count.");
  mutate(
    repo,
    () => {
      const candidates = groomCandidates(repo);
      if (!candidates.has(path)) throw new WtError(2, "The path is not a groom candidate at HEAD.");
      if (candidates.get(path) !== blob) throw new WtError(2, "The blob does not match HEAD for that path.");
      const visits = readVisits(repo);
      pruneVisits(visits, candidates);
      visits.set(path, { blob, at: new Date().toISOString(), findings });
      writeVisits(repo, visits);
    },
    "groom",
  );
}

function options(args: string[], spec: Parameters<typeof parseFlags>[1], max = 0, store: Store = "findings") {
  try {
    return parseFlags(args, spec, max);
  } catch {
    throw new WtError(2, `Invalid ${store} options.`);
  }
}

export const commands: CommandTable = {
  groom({ repo, args }) {
    const [action, ...rest] = args;
    if (action === "next") {
      const { flags } = options(rest, { count: "string" }, 0, "groom");
      const count = flags.count ?? "5";
      if (typeof count !== "string" || count.trim() !== count || !/^[1-9][0-9]*$/.test(count))
        throw new WtError(2, "Invalid groom count.");
      process.stdout.write(`${JSON.stringify(groomNext(repo, Number(count)), null, 2)}\n`);
      return 0;
    }
    if (action === "visited") {
      const { flags, positionals } = options(rest, { blob: "string", findings: "string" }, 1, "groom");
      if (positionals.length !== 1 || typeof flags.blob !== "string" || typeof flags.findings !== "string")
        throw new WtError(2, "Invalid groom options.");
      if (flags.findings.trim() !== flags.findings || !/^(0|[1-9][0-9]*)$/.test(flags.findings))
        throw new WtError(2, "Invalid groom findings count.");
      groomVisited(repo, positionals[0] as string, flags.blob, Number(flags.findings));
      return 0;
    }
    throw new WtError(2, "Unknown groom action. Run bin/findings help.");
  },
  add({ repo, args }) {
    const { flags } = options(args, { file: "string" });
    if (typeof flags.file !== "string") invalid("file option");
    let input: unknown;
    try {
      input = JSON.parse(readTextFile(flags.file));
    } catch {
      throw new WtError(2, "The finding file must be regular UTF-8 JSON of at most 1 MiB (no symlinks).");
    }
    const result = addFinding(repo, input);
    process.stdout.write(`${result.id}\n`);
    return result.created ? 0 : 3;
  },
  list({ repo, args }) {
    const { flags } = options(args, {
      state: "string",
      kind: "string",
      path: "string",
      triage: "string",
      json: "boolean",
    });
    const findings = listFindings(
      repo,
      {
        state: flags.state as string | undefined,
        triage: flags.triage as string | undefined,
        kind: flags.kind as string | undefined,
        path: flags.path as string | undefined,
      },
      (message) => process.stderr.write(`${message}\n`),
    );
    if (flags.json) process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    else
      for (const finding of findings)
        process.stdout.write(
          `${finding.id}\t${finding.state}${finding.orphaned ? " orphaned" : ""}\t${finding.approval?.priority ?? "-"}\t${finding.kind}\t${finding.severity}\t${finding.path}:${finding.line}\t${finding.title}\n`,
        );
    return 0;
  },
  page({ repo, args }) {
    options(args, {});
    process.stdout.write(`${JSON.stringify(writeTriagePage(repo))}\n`);
    return 0;
  },
  show({ repo, args }) {
    const { positionals } = options(args, {}, 1);
    const id = checkedFindingIds(positionals)[0] as string;
    process.stdout.write(`${JSON.stringify(showFinding(repo, id), null, 2)}\n`);
    return 0;
  },
  approve({ repo, args }) {
    const { flags, positionals } = options(args, { priority: "string" }, args.length);
    approveFindings(repo, positionals, flags.priority);
    return 0;
  },
  skip({ repo, args }) {
    const { positionals } = options(args, {}, args.length);
    skipFindings(repo, positionals);
    return 0;
  },
  release({ repo, args }) {
    const { positionals } = options(args, {}, args.length);
    releaseFindings(repo, checkedFindingIds(positionals), callerOwner(repo));
    return 0;
  },
  resolve({ repo, args }) {
    const { flags, positionals } = options(args, { fixed: "string", dismissed: "string", stale: "boolean" }, 1);
    const id = checkedFindingIds(positionals)[0] as string;
    resolveFinding(repo, id, flags as FindingResolution);
    return 0;
  },
};
