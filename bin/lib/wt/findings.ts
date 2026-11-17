import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { checkText } from "../../../scripts/check-public.ts";
import type { CommandTable } from "./command.ts";
import { run, runBytes } from "./proc.ts";
import { stateDir, withStateLock } from "./registry.ts";
import { GIT_BASE, type Repo } from "./repo.ts";
import { branchName, commitSha, parseFlags, readFileBytes, readTextFile, WtError } from "./validate.ts";

const KINDS = ["bug", "defect", "test", "docs", "ux", "react-perf", "react-style", "architecture", "security"] as const;
const STATES = ["open", "claimed", "fixed", "dismissed", "stale"] as const;
const INPUT_KEYS = ["title", "detail", "path", "line", "kind", "severity", "size", "source"];
const ID = /^f-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const CONTROLS = /\p{Cc}/u;

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
  claim?: { branch: string; worktree: string; at: string };
  resolution?: { at: string; commit?: string; reason?: string };
}

export interface FindingFilters {
  state?: string;
  kind?: string;
  path?: string;
}

export type FindingResolution = { fixed: string } | { dismissed: string } | { stale: true };

function invalid(field: string): never {
  throw new WtError(2, `Invalid finding ${field}.`);
}

function storageError(): never {
  throw new WtError(1, "Finding storage is unreadable, corrupt or symlinked. Nothing was changed.");
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
  if (typeof value !== "string" || !ID.test(value)) invalid("id");
  return value;
}

function timestamp(value: unknown): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    invalid("timestamp");
}

function claimTarget(value: unknown): { branch: string; worktree: string } {
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
  // Local worktrees may live under a real home path; only secret shapes are refused here.
  const hits = checkText(worktree, "claim worktree", { terms: [], allowed: [], notes: [] }, { lineExemptions: false });
  const hit = hits.find((hit) => hit === "claim worktree: secret shape");
  if (hit) throw new WtError(2, hit);
  return { branch, worktree };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprint(input: FindingInput, anchor: string): string {
  return sha256([input.path, input.kind, input.rule ?? "", anchor].join("\n"));
}

function parseStored(value: unknown, id: string): Finding {
  const data = object(
    value,
    [...INPUT_KEYS, "version", "id", "fingerprint", "commit", "anchor", "state", "createdAt"],
    ["rule", "claim", "resolution"],
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
function storageDirectory(repo: Repo, create = false): boolean {
  try {
    if (!lstatSync(repo.commonDir).isDirectory()) storageError();
    for (const path of [stateDir(repo), findingsDir(repo)]) {
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
      if (!entry.isDirectory()) storageError();
      if (create) chmodSync(path, 0o700);
    }
    return true;
  } catch {
    return storageError();
  }
}

function readFinding(repo: Repo, id: string): Finding {
  if (!storageDirectory(repo)) throw new WtError(1, "Unknown finding.");
  try {
    return parseStored(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(readFileBytes(join(findingsDir(repo), `${id}.json`))),
      ),
      id,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new WtError(1, "Unknown finding.");
    return storageError();
  }
}

function stageFinding(repo: Repo, id: string, content: string | Buffer, temps: Set<string>): string {
  const temp = join(findingsDir(repo), `.${id}.${randomBytes(12).toString("hex")}.tmp`);
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
      const temp = stageFinding(repo, finding.id, `${JSON.stringify(finding, null, 2)}\n`, temps);
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
          const temp = stageFinding(repo, record.id, record.previous, temps);
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
    if (!restored) throw new WtError(1, "Some findings may have changed; run `bin/wt findings list`.");
    storageError();
  }
}

function mutate<T>(repo: Repo, fn: () => T): T {
  // Check the findings folder before even writing a lock in its parent.
  storageDirectory(repo);
  try {
    return withStateLock(repo, "findings", fn);
  } catch (e) {
    if (e instanceof WtError) throw e;
    return storageError();
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
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob.stdout);
    } catch {
      invalid("path: expected UTF-8");
    }
    const lines = text === "" ? [] : text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    const line = lines[input.line - 1];
    if (line === undefined) invalid("line");
    const anchor = sha256(line.trim());
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

export function listFindings(
  repo: Repo,
  filters: FindingFilters = {},
  onSkipped?: (message: string) => void,
): (Finding & { orphaned: boolean })[] {
  if (filters.state !== undefined) choice(filters.state, STATES, "state");
  if (filters.kind !== undefined) choice(filters.kind, KINDS, "kind");
  if (filters.path !== undefined) inputPath(filters.path);
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
    if (!ID.test(id)) {
      onSkipped?.("Skipped a finding file with an invalid name.");
      continue;
    }
    try {
      findings.push(readFinding(repo, id));
    } catch {
      // A bad record is skippable; an unsafe storage directory still fails the call.
      storageDirectory(repo);
      onSkipped?.(`Skipped unreadable finding ${id}.`);
    }
  }
  return findings
    .filter(
      (finding) =>
        (filters.state === undefined || finding.state === filters.state) &&
        (filters.kind === undefined || finding.kind === filters.kind) &&
        (filters.path === undefined || finding.path === filters.path || finding.path.startsWith(`${filters.path}/`)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(withOrphaned);
}

function checkedIds(ids: string[]): string[] {
  if (ids.length === 0) invalid("ids");
  return [...new Set(ids.map(findingId))];
}

export function claimFindings(repo: Repo, ids: string[], target: { branch: string; worktree: string }): void {
  const validIds = checkedIds(ids);
  const claim = { ...claimTarget(target), at: new Date().toISOString() };
  mutate(repo, () => {
    const findings = validIds.map((id) => readFinding(repo, id));
    if (findings.some((finding) => finding.state !== "open" || finding.kind === "security" || finding.size === "large"))
      throw new WtError(1, "Only open, small, non-security findings can be claimed. Nothing was changed.");
    writeFindings(
      repo,
      findings.map((finding) => ({ ...finding, state: "claimed", claim })),
    );
  });
}

export function releaseFindings(repo: Repo, ids: string[]): void {
  const validIds = checkedIds(ids);
  mutate(repo, () => {
    const findings = validIds.map((id) => readFinding(repo, id));
    if (findings.some((finding) => finding.state !== "claimed"))
      throw new WtError(1, "Only claimed findings can be released. Nothing was changed.");
    writeFindings(
      repo,
      findings.map((finding) => {
        delete finding.claim;
        return { ...finding, state: "open" };
      }),
    );
  });
}

export function resolveFinding(repo: Repo, id: string, value: FindingResolution): void {
  findingId(id);
  const resolution = object(value, [], ["fixed", "dismissed", "stale"]);
  if (Object.keys(resolution).length !== 1) invalid("resolution");
  let state: "fixed" | "dismissed" | "stale";
  const detail: NonNullable<Finding["resolution"]> = { at: new Date().toISOString() };
  if (Object.hasOwn(resolution, "fixed")) {
    state = "fixed";
    detail.commit = commitSha(resolution.fixed as string);
  } else if (Object.hasOwn(resolution, "dismissed")) {
    state = "dismissed";
    detail.reason = checkedText(resolution.dismissed, "dismissal reason", 200);
  } else {
    state = "stale";
    if (resolution.stale !== true) invalid("resolution");
  }
  mutate(repo, () => {
    const finding = readFinding(repo, id);
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

function options(args: string[], spec: Parameters<typeof parseFlags>[1], max = 0) {
  try {
    return parseFlags(args, spec, max);
  } catch {
    throw new WtError(2, "Invalid findings options.");
  }
}

export const commands: CommandTable = {
  findings({ repo, args }) {
    const [action, ...rest] = args;
    if (action === "add") {
      const { flags } = options(rest, { file: "string" });
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
    }
    if (action === "list") {
      const { flags } = options(rest, { state: "string", kind: "string", path: "string", json: "boolean" });
      const findings = listFindings(
        repo,
        {
          state: flags.state as string | undefined,
          kind: flags.kind as string | undefined,
          path: flags.path as string | undefined,
        },
        (message) => process.stderr.write(`${message}\n`),
      );
      if (flags.json) process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
      else
        for (const finding of findings)
          process.stdout.write(
            `${finding.id}\t${finding.state}${finding.orphaned ? " orphaned" : ""}\t${finding.kind}\t${finding.severity}\t${finding.path}:${finding.line}\t${finding.title}\n`,
          );
      return 0;
    }
    if (action === "show" || action === "release" || action === "resolve") {
      const spec: Parameters<typeof parseFlags>[1] =
        action === "resolve" ? { fixed: "string", dismissed: "string", stale: "boolean" } : {};
      const { flags, positionals } = options(rest, spec, action === "release" ? rest.length : 1);
      const ids = checkedIds(positionals);
      const id = ids[0] as string;
      if (action === "show") process.stdout.write(`${JSON.stringify(showFinding(repo, id), null, 2)}\n`);
      else if (action === "release") releaseFindings(repo, ids);
      else resolveFinding(repo, id, flags as FindingResolution);
      return 0;
    }
    throw new WtError(2, "Unknown findings action. Run bin/wt help.");
  },
};
