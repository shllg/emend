import { closeSync, constants, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command, CommandTable } from "./command.ts";
import { issueSlug, issueSnapshot, issueSnapshotText, type PickedIssue, pickIssue } from "./issues.ts";
import { run } from "./proc.ts";
import { allocatePort, busyPorts, readRegistry } from "./registry.ts";
import { fetchOrigin, gitTry, listGitWorktrees, type Repo, refExists } from "./repo.ts";
import { releaseReservation, reserveTask } from "./tasks.ts";
import {
  BRANCH_PREFIX,
  branchName,
  slug as checkSlug,
  type Exit,
  issueNumber,
  parseFlags,
  requireIssueBranch,
  TASK_BRANCH_PREFIX,
  textArg,
  WtError,
} from "./validate.ts";
import { type SetupResult, setup, worktreeDirName } from "./worktree.ts";

// ---------------------------------------------------------------------------------------------
// Agent list

export interface AgentInfo {
  name: string | null;
  /** idle, working, blocked, done, unknown, or whatever herdr reports, lower-cased. */
  status: string;
  cwd: string | null;
  paneId: string | null;
  workspaceId: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

const HERDR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/** An id from a herdr reply that goes into argv: it must not be readable as an option. Null when it is not one. */
function herdrId(v: unknown): string | null {
  const s = str(v);
  return s !== null && HERDR_ID_RE.test(s) ? s : null;
}

function first(...vals: unknown[]): string | null {
  for (const v of vals) {
    const s = str(v);
    if (s !== null) return s;
  }
  return null;
}

/** Text from herdr is shown on a terminal: printable ASCII only (so no C0, DEL or C1 control character), capped. */
function ascii(s: string, max: number): string {
  return s.replace(/[^\x20-\x7e]/g, "?").slice(0, max);
}

/**
 * Reads the agent list out of `herdr agent list`. Confirmed shape: `{result: {type: "agent_list", agents:
 * [{name, pane_id, agent_status, ...}]}}`. The working directory of an agent is not part of anything
 * confirmed; `cwd` (or a pane's `cwd`) is read when present, and `workspace_id` likewise. A bare array and a
 * bare `{agents}` are accepted too. Returns null when no list is found. Names and statuses are printable ASCII.
 */
export function parseAgents(json: unknown): AgentInfo[] | null {
  let list: unknown = json;
  if (isRecord(list) && "result" in list) list = list.result;
  if (isRecord(list) && Array.isArray(list.agents)) list = list.agents;
  if (!Array.isArray(list)) return null;
  const out: AgentInfo[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const pane = isRecord(item.pane) ? item.pane : {};
    const name = str(item.name);
    out.push({
      name: name === null ? null : ascii(name, 64),
      status: ascii((first(item.agent_status, item.status) ?? "unknown").toLowerCase(), 20),
      cwd: first(item.cwd, pane.cwd),
      paneId: first(item.pane_id, pane.pane_id),
      workspaceId: first(item.workspace_id, pane.workspace_id),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Calling herdr

/** $HERDR_BIN_PATH when it is set and absolute, otherwise `herdr` from PATH. */
function herdrBin(): string {
  const p = process.env.HERDR_BIN_PATH;
  return p !== undefined && isAbsolute(p) ? p : "herdr";
}

/** A herdr error reply. `code` is the exit code bin/wt uses; `herdrCode` is herdr's own error code. */
export class HerdrError extends WtError {
  herdrCode: string;
  constructor(code: Exit, herdrCode: string, message: string) {
    super(code, message);
    this.name = "HerdrError";
    this.herdrCode = herdrCode;
  }
}

/** Text from herdr is shown on a terminal: one line, printable, capped. */
function tidy(s: string, max = 200): string {
  return ascii(s, max);
}

function errorFrom(text: string): { code: string; message: string } | null {
  try {
    const data: unknown = JSON.parse(text);
    if (isRecord(data) && isRecord(data.error)) {
      return {
        code: typeof data.error.code === "string" ? tidy(data.error.code, 64) : "unknown",
        message: typeof data.error.message === "string" ? tidy(data.error.message) : "No explanation",
      };
    }
  } catch {
    // not JSON
  }
  return null;
}

function mapHerdrError(code: string, message: string): HerdrError {
  switch (code) {
    case "timeout":
    case "agent_prompt_stalled":
      return new HerdrError(124, code, `herdr ${code}: ${message}; outcome unconfirmed.`);
    case "server_not_running":
    case "server_unavailable":
    case "server_binary_stale":
      return new HerdrError(69, code, `herdr ${code}: ${message}`);
    default:
      return new HerdrError(1, code, `herdr ${code}: ${message}`);
  }
}

/**
 * Runs `herdr <args>`, expects exactly one JSON object whose `result.type` is `expectedType` (any type when
 * null) and returns `result`. An error reply becomes a HerdrError with the exit code from the plan:
 * timeout and agent_prompt_stalled 124; server_not_running, server_unavailable and server_binary_stale 69;
 * any other code 1. A missing herdr is 69; a reply that is not valid JSON is 1 and unconfirmed.
 */
export function herdrCall(args: string[], expectedType: string | null, timeoutMs = 20_000): Record<string, unknown> {
  const r = run(herdrBin(), args, { cwd: "/", timeoutMs });
  if (r.code === 127) throw new WtError(69, "herdr is unavailable.");
  if (r.code === 124) throw new WtError(124, "herdr did not answer in time; outcome unconfirmed.");
  if (r.code !== 0) {
    const err = errorFrom(r.stderr) ?? errorFrom(r.stdout);
    if (err) throw mapHerdrError(err.code, err.message);
    throw new WtError(1, `herdr exited ${r.code}; outcome unconfirmed.`);
  }
  let data: unknown;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new WtError(1, "herdr returned no valid JSON object; outcome unconfirmed.");
  }
  if (!isRecord(data) || !isRecord(data.result)) {
    throw new WtError(1, "herdr returned no valid JSON object; outcome unconfirmed.");
  }
  if (expectedType !== null && data.result.type !== expectedType) {
    throw new WtError(1, `Unexpected herdr response; expected ${expectedType}.`);
  }
  return data.result;
}

export interface LocatedAgent extends AgentInfo {
  /** The directory the agent works in: its own `cwd`, else the checkout path of its workspace, else null. */
  location: string | null;
}

/**
 * Every agent with its location. `agent list` is not confirmed to carry a working directory, so an agent
 * without `cwd` is placed through its workspace (`workspace_id`, or the part of a pane id such as `w1:p1`
 * before the colon) and `herdr workspace list` (`worktree.checkout_path`). Null when herdr does not answer.
 * An agent that stays at null has no determinable location.
 */
export function herdrLocatedAgents(): LocatedAgent[] | null {
  const agents = herdrAgents();
  if (agents === null) return null;
  const byWorkspace = new Map<string, string>();
  if (agents.some((a) => a.cwd === null)) {
    try {
      const listed = herdrCall(["workspace", "list"], null, 5000);
      for (const w of Array.isArray(listed.workspaces) ? listed.workspaces : []) {
        if (!isRecord(w) || !isRecord(w.worktree)) continue;
        const id = first(w.workspace_id, w.id);
        const checkout = str(w.worktree.checkout_path);
        if (id !== null && checkout !== null) byWorkspace.set(id, checkout);
      }
    } catch {
      // no workspace list: agents without a cwd stay unlocated
    }
  }
  return agents.map((a) => {
    if (a.cwd !== null) return { ...a, location: a.cwd };
    const workspace = a.workspaceId ?? /^([^:]+):/.exec(a.paneId ?? "")?.[1] ?? null;
    return { ...a, location: workspace === null ? null : (byWorkspace.get(workspace) ?? null) };
  });
}

/** Every agent herdr knows, or null when herdr is missing or does not answer. Never throws. */
export function herdrAgents(): AgentInfo[] | null {
  const r = run(herdrBin(), ["agent", "list"], { cwd: "/", timeoutMs: 5000 });
  if (r.code !== 0) return null;
  try {
    return parseAgents(JSON.parse(r.stdout));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Notify

export type NotifyKind = "question" | "review-ready" | "merged" | "blocked";

const NOTIFY_TEXT: Record<NotifyKind, [string, string]> = {
  question: ["your answer is needed", "A question waits in this session"],
  "review-ready": ["review ready", "The emend review waits for you"],
  merged: ["merged", "The change is merged; this workspace closes"],
  blocked: ["blocked", "This session stopped and needs you"],
};

function isNotifyKind(s: string): s is NotifyKind {
  return Object.hasOwn(NOTIFY_TEXT, s);
}

function plainName(branch: string): boolean {
  try {
    branchName(branch);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shows a herdr notification titled with the branch. Outside herdr (no HERDR_ENV=1, no herdr binary) and
 * when herdr refuses, it does nothing: a notification is a courtesy, never a failure. `branch` defaults to the
 * caller's branch.
 */
export function notify(repo: Repo, kind: NotifyKind, branch: string | null = repo.callerBranch): void {
  if (process.env.HERDR_ENV !== "1") return;
  const [title, body] = NOTIFY_TEXT[kind];
  // The title is an argument of herdr: a branch name that bin/wt would refuse (a leading dash) is not used.
  const name = branch !== null && (branch === "main" || plainName(branch)) ? branch : "session";
  run(herdrBin(), ["notification", "show", `${tidy(name, 80)}: ${title}`, "--body", body], {
    cwd: "/",
    timeoutMs: 10_000,
  });
}

// ---------------------------------------------------------------------------------------------
// Close a workspace

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function samePath(a: string, b: string): boolean {
  return a === b || resolve(a) === resolve(b);
}

/**
 * Closes the herdr workspace of a removed worktree: the one workspace from `herdr workspace list` whose
 * `worktree.is_linked_worktree` is true and whose `checkout_path` equals `worktreePath`. It sends the
 * "merged" notification first unless `notifyMerged` is false. Zero or several matches close nothing and say so. Call it last: closing the
 * workspace can end the caller's own session.
 */
export function closeWorkspace(
  repo: Repo,
  worktreePath: string,
  branch?: string,
  o: { notifyMerged?: boolean } = {},
): void {
  if (process.env.HERDR_ENV !== "1") {
    say("Not inside herdr: no workspace was closed.");
    return;
  }
  let listed: Record<string, unknown>;
  try {
    listed = herdrCall(["workspace", "list"], null);
  } catch (e) {
    say(`No workspace was closed: herdr did not list its workspaces${e instanceof WtError ? ` (${e.message})` : ""}.`);
    return;
  }
  const workspaces = Array.isArray(listed.workspaces) ? listed.workspaces : [];
  const matches: { id: string; label: string }[] = [];
  for (const w of workspaces) {
    if (!isRecord(w) || !isRecord(w.worktree)) continue;
    const checkout = str(w.worktree.checkout_path);
    const id = herdrId(w.workspace_id) ?? herdrId(w.id);
    if (
      w.worktree.is_linked_worktree === true &&
      checkout !== null &&
      id !== null &&
      samePath(checkout, worktreePath)
    ) {
      matches.push({ id, label: first(w.label) ?? id });
    }
  }
  const only = matches[0];
  if (matches.length !== 1 || only === undefined) {
    say(
      matches.length === 0
        ? "No herdr workspace is linked to the removed worktree; none was closed."
        : "Several herdr workspaces match the removed worktree; none was closed.",
    );
    return;
  }
  // A discarded worktree was not merged; its caller passes notifyMerged: false and the workspace closes quietly.
  if (o.notifyMerged !== false) notify(repo, "merged", branch ?? repo.callerBranch);
  say(`Closing herdr workspace ${tidy(only.label, 80)} (${tidy(only.id, 64)}).`);
  try {
    herdrCall(["workspace", "close", only.id], null);
  } catch (e) {
    throw new WtError(
      e instanceof WtError ? e.code : 1,
      `The worktree is removed, but herdr did not close its workspace${e instanceof WtError ? ` (${e.message})` : ""}.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Spawn

export type SpawnOptions = {
  mode: "github" | "local";
  model?: string;
  effort?: string;
} & ({ brief: string; slug: string; issue?: never } | { issue: number; brief?: never; slug?: never });

export interface SpawnResult {
  number: string;
  slug: string;
  branch: string;
  agent: string;
  path: string;
  port: number;
  emendHome: string;
  taskFile: string;
  issue?: { number: number; url: string };
  workspaceId: string;
  workspaceLabel: string;
  /** What herdr reported after the prompt: the agent works or waits for an answer. */
  state: "working" | "blocked";
}

const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export interface SpawnClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const spawnClock: SpawnClock = { now: () => performance.now(), sleep };

/** A new pane can still be running shell startup commands. Wait at most 30s, then let agent start report failures. */
export async function waitForShell(pane: string, clock: SpawnClock = spawnClock): Promise<void> {
  const deadline = clock.now() + 30_000;
  while (clock.now() < deadline) {
    try {
      const result = herdrCall(
        ["pane", "process-info", "--pane", pane],
        null,
        Math.max(1, Math.ceil(Math.min(5000, deadline - clock.now()))),
      );
      const info = result.process_info;
      if (isRecord(info) && typeof info.shell_pid === "number" && info.shell_pid > 0) {
        const foreground = info.foreground_processes;
        if (
          Array.isArray(foreground) &&
          foreground.length === 1 &&
          isRecord(foreground[0]) &&
          foreground[0].pid === info.shell_pid
        )
          return;
      }
    } catch {
      // Missing or unreadable process information cannot prove the shell is idle. agent start remains authoritative.
    }
    const remaining = deadline - clock.now();
    if (remaining > 0) await clock.sleep(Math.min(250, remaining));
  }
  process.stderr.write("Timed out waiting for the pane shell; continuing to agent start.\n");
}

/** `wt-` + the branch lowercased, every run outside [a-z0-9_-] replaced by `-`, ends trimmed, 29 characters at most. */
export function agentName(branch: string): string {
  const normalized = branch
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized === "") throw new WtError(2, "The branch has no usable agent name.");
  const name = `wt-${normalized.slice(0, 29)}`;
  if (!AGENT_NAME_RE.test(name)) throw new WtError(2, "The branch has no usable agent name.");
  return name;
}

export function spawnPrompt(taskFile: string, mode: "github" | "local"): string {
  const answer = mode === "local" ? "Land locally after an emend review." : "Open a ready PR and finalize it.";
  return `/loop /e-work ${taskFile} Closing answer from /e-spawn: ${answer}`;
}

/** Quotes a word for a shell command line shown to the owner; plain words stay as they are. */
function quote(s: string): string {
  if (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** Fills `id: NNN` and the `# NNN — ` heading of the brief with the reserved number. */
function fillBrief(text: string, number: string): string {
  return text.replace(/^id:[ \t]*NNN[ \t]*$/m, `id: ${number}`).replace(/^# NNN — /m, `# ${number} — `);
}

const ID_LINE_RE = /^id:[ \t]*NNN[ \t]*$/m;

/** Creates `dir/name` exclusively, never following a symlink. `dir` must be a real directory. */
function writeNew(dir: string, name: string, text: string, mode: number): void {
  if (!lstatSync(dir).isDirectory()) throw new Error("not a plain directory");
  const fd = openSync(
    join(dir, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

export function writeIssueSnapshot(dir: string, issue: PickedIssue): void {
  writeNew(dir, "issue.md", issueSnapshotText(issue), 0o600);
  writeNew(dir, "issue.json", `${JSON.stringify(issueSnapshot(issue), null, 2)}\n`, 0o600);
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o755 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

function nothingCreated(e: unknown): WtError {
  if (e instanceof WtError) {
    return e.message.includes("Nothing was created.") ? e : new WtError(e.code, `${e.message} Nothing was created.`);
  }
  return new WtError(1, "bin/wt failed unexpectedly. Nothing was created.");
}

type Stage = "task-files" | "opening" | "already_open" | "starting" | "not_ready" | "mismatch" | "prompting";

/**
 * Starts a Claude session on a task or ready issue. Tasks reserve a number and write a task file;
 * issues write an approved title and body snapshot plus their URL to the brief. Both set up from local main,
 * open a workspace, wait for its shell, start the agent and send the prompt.
 * Before setup a failure releases the reservation. After setup a failure prints what exists and the cleanup
 * command and changes nothing else: no cleanup, no release, no retry, and a prompt is never sent twice.
 * The worktree's EMEND_HOME and port are returned and printed but never given to the started session.
 */
export async function spawn(repo: Repo, o: SpawnOptions, clock: SpawnClock = spawnClock): Promise<SpawnResult> {
  // ---- preflight: nothing exists yet
  let briefText = "";
  let issue: PickedIssue | undefined;
  let busy: Set<number>;
  let agents: AgentInfo[];
  let slugValue: string;
  try {
    if (o.issue !== undefined && (o.brief !== undefined || o.slug !== undefined))
      throw new WtError(2, "Give an issue or a brief and slug, not both.");
    if (o.issue !== undefined && o.mode === "local")
      throw new WtError(2, "A local landing does not close the issue; use the github mode.");
    if (o.mode !== "github" && o.mode !== "local") throw new WtError(2, "Invalid mode.");
    if (o.model !== undefined && !MODEL_RE.test(o.model)) throw new WtError(2, "Invalid model.");
    if (o.effort !== undefined && !EFFORTS.has(o.effort)) throw new WtError(2, "Invalid effort.");
    if (process.env.HERDR_ENV !== "1") throw new WtError(69, "Run inside a herdr pane (HERDR_ENV=1).");
    if (repo.callerTop !== repo.mainRoot) throw new WtError(2, "Run spawn from the main checkout.");
    if (o.issue !== undefined) {
      issue = pickIssue(repo, o.issue);
      slugValue = issueSlug(issue.titleOwned ? issue.title : "issue", issue.number);
      briefText = `${issue.url}\n`;
    } else {
      slugValue = checkSlug(o.slug);
      briefText = o.brief;
      if (!ID_LINE_RE.test(briefText)) throw new WtError(2, "The brief needs the line 'id: NNN'.");
    }
    const listed = parseAgents(herdrCall(["agent", "list"], "agent_list"));
    if (listed === null) throw new WtError(1, "Invalid herdr agent list.");
    agents = listed;
    if (!issue) fetchOrigin(repo);
    busy = await busyPorts();
    allocatePort(readRegistry(repo), busy);
  } catch (e) {
    throw nothingCreated(e);
  }

  // ---- reserve, then check the names the number decides
  let number: string;
  try {
    number = issue
      ? String(issue.number)
      : reserveTask(repo, slugValue, (n) => `${TASK_BRANCH_PREFIX}${n}-${slugValue}`);
  } catch (e) {
    throw nothingCreated(e);
  }
  const branch = `${issue ? BRANCH_PREFIX : TASK_BRANCH_PREFIX}${number}-${slugValue}`;
  const taskFile = issue ? "" : `tasks/${number}-${slugValue}.md`;
  const release = () => {
    if (!issue) releaseQuietly(repo, number);
  };
  const agent = (() => {
    try {
      requireIssueBranch(branch, issue?.number);
      return agentName(branch);
    } catch (e) {
      release();
      throw nothingCreated(e);
    }
  })();
  try {
    if (
      refExists(repo, `refs/heads/${branch}`) ||
      (!issue && refExists(repo, `refs/remotes/origin/${branch}`)) ||
      Object.hasOwn(readRegistry(repo).worktrees, branch) ||
      listGitWorktrees(repo).some((w) => w.branch === branch)
    ) {
      throw new WtError(3, "The branch already exists locally or has a worktree.");
    }
    const remote = gitTry(repo, ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
    if (remote.code === 0) throw new WtError(3, "The branch already exists on origin.");
    if (remote.code !== 2) throw new WtError(69, "Could not reach origin to check the branch.");
    if (agents.some((a) => a.name === agent)) throw new WtError(3, "A herdr agent with that name already exists.");
  } catch (e) {
    release();
    throw nothingCreated(e);
  }

  // Refresh after all asynchronous preflight work, immediately before setup. No issue comments are read.
  if (issue) {
    try {
      issue = pickIssue(repo, issue.number);
      briefText = `${issue.url}\n`;
    } catch (e) {
      throw nothingCreated(e);
    }
  }

  // ---- setup: from here on something may exist
  let wt: SetupResult;
  try {
    wt = setup(repo, { branch, task: issue ? undefined : number, issue, mode: o.mode, busy });
  } catch (e) {
    const exists =
      Object.hasOwn(readRegistry(repo).worktrees, branch) ||
      refExists(repo, `refs/heads/${branch}`) ||
      listGitWorktrees(repo).some((w) => w.branch === branch);
    if (!exists) {
      release();
      throw nothingCreated(e);
    }
    throw new WtError(
      e instanceof WtError ? e.code : 1,
      `${e instanceof WtError ? e.message : "Setup failed unexpectedly."}\n${existsReport(repo, branch, join(repo.worktreesDir, worktreeDirName(branch)), issue ? null : number)}`,
    );
  }

  const prompt = spawnPrompt(issue ? `#${issue.number}` : taskFile, o.mode);
  let stage: Stage = "task-files";
  let workspaceId = "";
  let workspaceLabel = "";
  let agentStatus = "unknown";

  const failure = (cause: unknown): WtError => {
    const code: Exit = cause instanceof WtError ? cause.code : 1;
    const herdrCode = cause instanceof HerdrError ? cause.herdrCode : "";
    const why = cause instanceof WtError ? cause.message : "Unexpected failure.";
    const where = `herdr workspace ${workspaceLabel} (${workspaceId})`;
    const promptCmd = `${quote(herdrBin())} agent prompt ${quote(agent)} ${quote(prompt)} --wait --until working --until blocked`;
    let lines: string[];
    switch (stage) {
      case "task-files":
        lines = [`Setup succeeded, but the task files could not be written (${why}). No herdr workspace was opened.`];
        break;
      case "opening":
        lines = [`${why}`, "No herdr workspace was confirmed by this run."];
        break;
      case "already_open":
        lines = [`The worktree already had ${where}; this run started no agent there.`];
        break;
      case "starting":
        if (herdrCode === "agent_not_ready") {
          lines = [
            `Claude agent ${agent} is waiting at a startup prompt in ${where}; no prompt was sent. Open that workspace, answer it, then send the prompt: ${promptCmd}`,
          ];
        } else if (
          [
            "agent_pane_not_found",
            "agent_name_taken",
            "agent_pane_busy",
            "invalid_agent_name",
            "invalid_agent_argument",
            "invalid_agent_timeout",
            "unsupported_agent_kind",
          ].includes(herdrCode)
        ) {
          lines = [
            `${why}`,
            `herdr refused to start Claude agent ${agent} (${herdrCode}); no agent was started in ${where}.`,
          ];
        } else {
          lines = [
            `${why}`,
            `herdr may have started Claude agent ${agent} in ${where}; no prompt was sent. Open that workspace and check it before any teardown. Once the agent is idle or done, send the prompt: ${promptCmd}`,
          ];
        }
        break;
      case "not_ready":
        lines = [
          `herdr has not confirmed Claude agent ${agent} ready for input (status: ${agentStatus}) in ${where}; no prompt was sent. Open that workspace and check it; once it accepts input, send the prompt: ${promptCmd}`,
        ];
        break;
      case "mismatch":
        lines = [
          `herdr reported a different agent or pane than requested; no prompt was sent. Open ${where} and inspect it before any teardown.`,
        ];
        break;
      case "prompting":
        if (herdrCode === "agent_blocked") {
          lines = [
            `Claude agent ${agent} is waiting for an answer in ${where}; herdr sent no input. Answer it there, then send the prompt: ${promptCmd}`,
          ];
        } else {
          lines = [
            `${why}`,
            `Claude agent ${agent} is running in ${where}; the prompt may have been delivered. Do not resend the prompt; open that workspace to check.`,
          ];
        }
        break;
    }
    if (stage !== "task-files" && stage !== "opening") {
      lines.push("To stop the agent, open that workspace and exit Claude (/exit) before any teardown.");
    }
    lines.push(existsReport(repo, branch, wt.path, issue ? null : number));
    return new WtError(code, lines.join("\n"));
  };

  // ---- task file and brief
  try {
    if (!issue) {
      const tasksDir = join(wt.path, "tasks");
      ensureDir(tasksDir);
      writeNew(tasksDir, `${number}-${slugValue}.md`, fillBrief(briefText, number), 0o644);
    }
    writeNew(join(wt.path, ".wt"), "brief.md", issue ? briefText : fillBrief(briefText, number), 0o600);
  } catch (e) {
    throw failure(e instanceof WtError ? e : new WtError(1, e instanceof Error ? e.message : "write failed"));
  }

  // ---- herdr: open, start, prompt
  stage = "opening";
  let pane: string;
  try {
    const opened = herdrCall(
      ["worktree", "open", "--cwd", repo.mainRoot, "--path", wt.path, "--no-focus"],
      "worktree_opened",
    );
    const ws = opened.workspace;
    const root = opened.root_pane;
    const id = isRecord(ws) ? herdrId(ws.workspace_id) : null;
    const label = isRecord(ws) ? str(ws.label) : null;
    const paneId = isRecord(root) ? herdrId(root.pane_id) : null;
    if (typeof opened.already_open !== "boolean" || id === null || label === null || paneId === null) {
      throw new WtError(1, "Invalid herdr worktree response.");
    }
    workspaceId = tidy(id, 64);
    workspaceLabel = tidy(label, 80);
    pane = paneId;
    if (opened.already_open) {
      stage = "already_open";
      throw new WtError(3, "The worktree already has a herdr workspace; no agent was started.");
    }
  } catch (e) {
    throw failure(e);
  }

  stage = "starting";
  const claudeArgs = ["--permission-mode", "auto", "--name", branch];
  if (o.model !== undefined) claudeArgs.push("--model", o.model);
  if (o.effort !== undefined) claudeArgs.push("--effort", o.effort);
  try {
    await waitForShell(pane, clock);
    const started = herdrCall(
      ["agent", "start", agent, "--kind", "claude", "--pane", pane, "--timeout", "120000", "--", ...claudeArgs],
      "agent_started",
      150_000,
    );
    const a = started.agent;
    if (!isRecord(a) || a.pane_id !== pane || !(a.name === null || a.name === undefined || a.name === agent)) {
      stage = "mismatch";
      throw new WtError(1, "herdr did not confirm this agent in the selected pane; no prompt was sent.");
    }
    agentStatus = tidy(typeof a.agent_status === "string" ? a.agent_status : "unknown", 20);
    if (!((a.agent_status === "idle" || a.agent_status === "done") && a.interactive_ready !== false)) {
      stage = "not_ready";
      throw new WtError(1, "herdr did not confirm this agent ready in the selected pane; no prompt was sent.");
    }
  } catch (e) {
    throw failure(e);
  }

  stage = "prompting";
  let state: "working" | "blocked";
  try {
    // One attempt. The prompt may have arrived even when this call fails, so it is never repeated.
    const prompted = herdrCall(
      ["agent", "prompt", agent, prompt, "--wait", "--until", "working", "--until", "blocked", "--timeout", "60000"],
      "agent_prompted",
      90_000,
    );
    const status = isRecord(prompted.agent) ? prompted.agent.agent_status : undefined;
    if (status !== "working" && status !== "blocked") {
      throw new WtError(
        1,
        `Claude agent ${agent} has state ${tidy(typeof status === "string" ? status : "unknown", 20)}; work is unconfirmed.`,
      );
    }
    state = status;
  } catch (e) {
    throw failure(e);
  }

  return {
    number,
    slug: slugValue,
    branch,
    agent,
    path: wt.path,
    port: wt.port,
    emendHome: wt.emendHome,
    taskFile,
    issue: issue ? { number: issue.number, url: issue.url } : undefined,
    workspaceId,
    workspaceLabel,
    state,
  };
}

function releaseQuietly(repo: Repo, number: string): void {
  try {
    releaseReservation(repo, number);
  } catch {
    // keep the original failure
  }
}

/** What exists after setup and the one command that removes it. Never run automatically. */
function existsReport(repo: Repo, branch: string, path: string, number: string | null): string {
  return [
    `Branch ${branch} and its worktree ${path} exist${number === null ? "" : `; task number ${number} stays reserved`}. No automatic cleanup was performed.`,
    `Optional teardown: ${quote(join(repo.mainRoot, "bin", "wt"))} cleanup ${branch}`,
    "This does not close the herdr workspace.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Commands

const spawnCommand: Command = async ({ repo, args }) => {
  const { flags } = parseFlags(args, {
    brief: "string",
    "brief-file": "string",
    slug: "string",
    issue: "string",
    mode: "string",
    model: "string",
    effort: "string",
  });
  const usage =
    "Usage: bin/wt spawn (--issue <n> | (--brief <text> | --brief-file <path>) --slug <slug>) [--mode github|local] [--model <m>] [--effort <e>] (--mode local requires a brief)";
  let source: { issue: number } | { brief: string; slug: string };
  if (typeof flags.issue === "string") {
    if (flags.brief !== undefined || flags["brief-file"] !== undefined || flags.slug !== undefined) {
      throw new WtError(2, "--issue is mutually exclusive with --brief, --brief-file and --slug. Nothing was created.");
    }
    source = { issue: issueNumber(flags.issue) };
  } else {
    if (typeof flags.slug !== "string") throw new WtError(2, usage);
    const brief = textArg(
      typeof flags.brief === "string" ? flags.brief : undefined,
      typeof flags["brief-file"] === "string" ? flags["brief-file"] : undefined,
      "brief",
      true,
    );
    if (brief === null) throw new WtError(2, usage);
    source = { brief, slug: flags.slug };
  }
  const mode = flags.mode ?? "github";
  if (mode !== "github" && mode !== "local") throw new WtError(2, "Invalid mode. Nothing was created.");
  const r = await spawn(repo, {
    ...source,
    mode,
    model: typeof flags.model === "string" ? flags.model : undefined,
    effort: typeof flags.effort === "string" ? flags.effort : undefined,
  });
  say(r.issue ? `Issue: #${r.issue.number} ${r.issue.url}` : `Task: ${r.taskFile}`);
  say(`Branch: ${r.branch}`);
  say(`Port: ${r.port}`);
  say(`Worktree: ${r.path}`);
  say(`EMEND_HOME: ${r.emendHome}`);
  if (r.state === "blocked") {
    say(
      `Claude agent ${r.agent} started and is waiting for an answer in herdr workspace ${r.workspaceLabel} (${r.workspaceId}).`,
    );
  } else {
    say(`Claude agent ${r.agent} is working on ${r.branch} in herdr workspace ${r.workspaceLabel} (${r.workspaceId}).`);
  }
  return 0;
};

const notifyCommand: Command = ({ repo, args }) => {
  const { positionals } = parseFlags(args, {}, 1);
  const kind = positionals[0];
  if (kind === undefined || !isNotifyKind(kind)) {
    throw new WtError(2, "Usage: bin/wt notify <question|review-ready|merged|blocked>");
  }
  notify(repo, kind);
  return 0;
};

export const commands: CommandTable = { spawn: spawnCommand, notify: notifyCommand };
