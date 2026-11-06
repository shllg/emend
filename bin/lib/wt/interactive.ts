import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Command, CommandTable } from "./command.ts";
import { commands as issueCommands } from "./issues.ts";
import { run } from "./proc.ts";
import { readRegistry } from "./registry.ts";
import { gitTry, type Repo } from "./repo.ts";
import { commands as taskCommands } from "./tasks.ts";
import { branchName } from "./validate.ts";
import { terminal, commands as worktreeCommands } from "./worktree.ts";

export type MenuAction = "setup" | "list" | "cleanup" | "issues" | "tasks" | "gc";

const ACTIONS: ReadonlyArray<[MenuAction, string]> = [
  ["setup", "create a worktree"],
  ["list", "show the worktrees"],
  ["cleanup", "remove a finished worktree"],
  ["issues", "show the ready issue queue"],
  ["tasks", "show the task queue"],
  ["gc", "report orphans (no changes)"],
];

/** fzf is looked up on PATH without running it, so a menu never costs an extra fzf call. */
function fzfAvailable(): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, "fzf"), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

/** The menu, wizard and picker run only on a terminal with fzf. */
export function canInteract(): boolean {
  return terminal.isTTY() && fzfAvailable();
}

interface FzfResult {
  query: string;
  pick: string | null;
}

/**
 * Runs fzf over `lines`. Returns null when the user cancels or fzf fails. With `printQuery` a typed query
 * comes back even when nothing matched (fzf exit 1).
 */
function fzf(cwd: string, lines: string[], args: string[], printQuery: boolean): FzfResult | null {
  const r = run("fzf", [...args, ...(printQuery ? ["--print-query"] : [])], {
    cwd,
    input: `${lines.join("\n")}\n`,
    tty: true,
  });
  if (r.code !== 0 && !(printQuery && r.code === 1)) return null;
  const out = r.stdout.split("\n");
  if (printQuery) {
    const pick = (out[1] ?? "").trim();
    return { query: (out[0] ?? "").trim(), pick: pick === "" ? null : pick };
  }
  const pick = (out[0] ?? "").trim();
  return pick === "" ? null : { query: "", pick };
}

const COMMON = ["--height=60%", "--reverse", "--no-multi"];

/** The action menu. Null when there is no terminal or fzf, or the user cancelled. */
export function menu(repo?: Repo): MenuAction | null {
  if (!canInteract()) return null;
  const lines = ACTIONS.map(([name, text]) => `${name}\t${text}`);
  const res = fzf(repo?.mainRoot ?? process.cwd(), lines, [...COMMON, "--prompt", "wt > ", "--delimiter", "\t"], false);
  const name = res?.pick?.split("\t")[0];
  return ACTIONS.find(([a]) => a === name)?.[0] ?? null;
}

/** Local branches, then origin branches that have no local twin. `main` and the caller's branch are left out. */
export function branchChoices(repo: Repo, includeMain: boolean): string[] {
  const skip = new Set<string>(includeMain ? [] : ["main", "origin/main"]);
  if (!includeMain && repo.callerBranch) {
    skip.add(repo.callerBranch);
    skip.add(`origin/${repo.callerBranch}`);
  }
  const local = gitTry(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).stdout.split("\n");
  const remote = gitTry(repo, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"]).stdout.split("\n");
  const localSet = new Set(local);
  const out: string[] = [];
  // A branch name is agent-written. One with a control character (C0, DEL or C1) never reaches the terminal, and
  // one that bin/wt would refuse (a leading dash, for instance) never reaches the preview's git call. `main` and
  // `origin/main` stay when the wizard offers them as sources.
  const plain = (b: string, name: string) => {
    if (/\p{Cc}/u.test(b)) return false;
    if (b === "main" || b === "origin/main") return true;
    try {
      branchName(name);
      return true;
    } catch {
      return false;
    }
  };
  for (const b of local) if (b !== "" && !skip.has(b) && plain(b, b)) out.push(b);
  for (const b of remote) {
    if (b === "" || b === "origin" || b === "origin/HEAD" || skip.has(b) || !plain(b, b.slice("origin/".length)))
      continue;
    if (localSet.has(b.slice("origin/".length))) continue;
    out.push(b);
  }
  return out;
}

export const PREVIEW =
  "git -c core.fsmonitor=false -c submodule.recurse=false log --oneline --graph --decorate -n 40 --end-of-options {} --";

/**
 * Asks for a branch (pick an existing one or type a new name) and, for a new name, a source ref.
 * An existing pick wins over the typed query. Null when cancelled or when there is no terminal or fzf.
 */
export function setupWizard(repo: Repo): { branch: string; from?: string } | null {
  if (!canInteract()) return null;
  const first = fzf(
    repo.mainRoot,
    branchChoices(repo, false),
    [...COMMON, "--prompt", "branch (type a new name or pick) > ", "--preview", PREVIEW],
    true,
  );
  if (!first) return null;
  if (first.pick) return { branch: first.pick.replace(/^origin\//, "") };
  if (first.query === "") return null;

  const sources = [
    "main",
    "origin/main",
    ...branchChoices(repo, true).filter((b) => b !== "main" && b !== "origin/main"),
  ];
  const second = fzf(repo.mainRoot, sources, [...COMMON, "--prompt", "start from > ", "--preview", PREVIEW], false);
  if (!second?.pick) return null;
  return { branch: first.query, from: second.pick };
}

/** Asks which registered worktree to clean up. Returns its branch, or null. */
export function cleanupPicker(repo: Repo): string | null {
  if (!canInteract()) return null;
  const entries = Object.entries(readRegistry(repo).worktrees);
  if (entries.length === 0) {
    process.stdout.write("No worktrees.\n");
    return null;
  }
  const lines = entries.map(([branch, e]) => `${branch}\t${e.path}`);
  const res = fzf(
    repo.mainRoot,
    lines,
    [
      ...COMMON,
      "--prompt",
      "cleanup > ",
      "--delimiter",
      "\t",
      "--with-nth",
      "1",
      "--preview",
      "git -c core.fsmonitor=false -c submodule.recurse=false -c status.submoduleSummary=false -C {2} status --short --branch --ignore-submodules=all",
    ],
    false,
  );
  const branch = res?.pick?.split("\t")[0];
  return branch && Object.hasOwn(readRegistry(repo).worktrees, branch) ? branch : null;
}

const menuCommand: Command = async ({ repo }) => {
  const list = worktreeCommands.list as Command;
  if (!canInteract()) return await list({ repo, args: [] });
  const choice = menu(repo);
  if (!choice) return 0;
  const table: CommandTable =
    choice === "issues" ? issueCommands : choice === "tasks" ? taskCommands : worktreeCommands;
  return await (table[choice] as Command)({ repo, args: [] });
};

export const commands: CommandTable = { menu: menuCommand };
