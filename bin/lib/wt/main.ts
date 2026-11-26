import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type CommandTable, EXIT_CODES, runMain } from "./command.ts";
import { assertNoLocalHooksPath, resolveRepo } from "./repo.ts";
import { WtError } from "./validate.ts";

/**
 * Which module owns which subcommand. Each module exports `commands: CommandTable`. A module that does not
 * exist yet is skipped, so adding a subcommand needs only its module to export the entry. Adding a name here
 * is needed only for a new subcommand name.
 */
const OWNERS: Record<string, string> = {
  setup: "worktree.ts",
  list: "worktree.ts",
  status: "worktree.ts",
  cleanup: "worktree.ts",
  gc: "worktree.ts",
  issues: "issues.ts",
  issue: "issues.ts",
  spawn: "herdr.ts",
  notify: "herdr.ts",
  agents: "herdr.ts",
  agent: "herdr.ts",
  repo: "github.ts",
  fetch: "github.ts",
  push: "github.ts",
  pr: "github.ts",
  approval: "approval.ts",
  rebase: "history.ts",
  restack: "history.ts",
  land: "history.ts",
  "sync-main": "history.ts",
  digest: "history.ts",
};

const HELP = `bin/wt: worktrees and the pull request lifecycle

Local:
  setup [<branch>] [--from <ref>] [--issue <n>]
                                               create a worktree with a port and an RECENSE_HOME;
                                                   copies the gitignored files .worktreeinclude lists
  approval [--head <sha>]                          recense's approval on this worktree's branch
  approval --branch <name> --head <sha>            check a branch and head from the main checkout
  list [--json]  (alias: status)                   one row per worktree
                                                   JSON pr: {number,state}, "?" (lookup skipped), or null (no PR)
  cleanup [--discard] [--close-workspace] [<branch|path>]
  gc [--prune]                                     report or remove orphans
  repo                                            print origin's GitHub owner/name

herdr / herdr desktop:
  spawn --issue <n> [--mode github] [--model <m>] [--effort <e>]
  notify ...
  agents [--json]                                  agents in registered worktrees, from both backends
  agent read <target> [--lines N]                   registered worker output (1..400 lines, default 80)
  agent prompt <target> --issue <n>                 send a hashed message reference to that issue's worker
                                                   target: herdr agent name or hc address (never hc name)

Remote:
  issues [--json]                                  the ready GitHub issue queue
  issue show <n> [--taken]                         print the approved issue snapshot; --taken allows claimed issues
  issue check                                     validate the current issue against its snapshot
  fetch
  push [--force-with-lease] [--accept-new-markers (owner only)]
  pr number [--branch <b>] [--state open|merged]
  pr create (--title <text> | --title-file <path>) (--body <text> | --body-file <path>) [--draft]
  pr edit [--pr <n>] [--title <text> | --title-file <path>] [--body <text> | --body-file <path>]
  pr merge [--pr <n>] --match-head <sha> [--approved-head <sha>] (--subject <text> | --subject-file <path>)
           (--body <text> | --body-file <path>)
                                                   a fixer's merge prints FIXED <id> for each claim it records as fixed

History:
  rebase  restack  sync-main  digest
  land --match-head <sha> [--approved-head <sha>] (--subject <text> | --subject-file <path>)
       (--body <text> | --body-file <path>)

pr merge, land and approval ask recense for the approval: recense on PATH, or the absolute path in RECENSE_BIN.

No arguments: an action menu on a terminal with fzf, otherwise "list".
${EXIT_CODES}
`;

function fail(code: 1 | 2 | 69, message: string): never {
  throw new WtError(code, message);
}

async function loadTable(file: string): Promise<CommandTable | null> {
  const path = join(import.meta.dirname, file);
  if (!existsSync(path)) return null;
  const mod = (await import(pathToFileURL(path).href)) as { commands?: CommandTable };
  return mod.commands ?? null;
}

async function main(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (sub !== undefined && !Object.hasOwn(OWNERS, sub)) {
    fail(2, "Unknown subcommand. Run bin/wt help.");
  }

  const repo = resolveRepo(process.cwd());
  assertNoLocalHooksPath(repo);

  if (sub === undefined) {
    const interactive =
      process.stdin.isTTY === true && process.stdout.isTTY === true ? await loadTable("interactive.ts") : null;
    const table = interactive?.menu ? interactive : await loadTable("worktree.ts");
    const command = table?.[interactive?.menu ? "menu" : "list"];
    if (!command) fail(1, "bin/wt could not load its list command.");
    return (await command({ repo, args: [] })) ?? 0;
  }

  const owner = OWNERS[sub] as string;
  const command = (await loadTable(owner))?.[sub];
  if (!command) fail(2, "This subcommand is not available in this build.");
  return (await command({ repo, args: argv.slice(1) })) ?? 0;
}

await runMain("bin/wt", main);
