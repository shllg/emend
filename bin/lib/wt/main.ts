import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandTable } from "./command.ts";
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
  tasks: "tasks.ts",
  issues: "issues.ts",
  issue: "issues.ts",
  spawn: "herdr.ts",
  notify: "herdr.ts",
  fetch: "github.ts",
  push: "github.ts",
  pr: "github.ts",
  rebase: "history.ts",
  restack: "history.ts",
  land: "history.ts",
  "sync-main": "history.ts",
  digest: "history.ts",
};

const HELP = `bin/wt: worktrees and the pull request lifecycle

Local:
  setup [<branch>] [--from <ref>] [--task <NNN> | --issue <n>]
                                               create a worktree with a port and an EMEND_HOME;
                                                   copies the gitignored files .worktreeinclude lists
  list [--json]  (alias: status)                   one row per worktree
  cleanup [--discard] [--close-workspace] [<branch|path>]
  tasks [--json]                                   the task queue
  gc [--prune]                                     report or remove orphans

herdr:
  spawn --brief <text> | --brief-file <path> --slug <slug> [--mode github|local] [--model <m>] [--effort <e>]
  spawn --issue <n> [--mode github] [--model <m>] [--effort <e>]
  notify ...

Remote:
  issues [--json]                                  the ready GitHub issue queue
  issue show <n> [--taken]                         print the approved issue snapshot; --taken allows claimed issues
  issue check                                     validate the current issue against its snapshot
  fetch
  push [--force-with-lease] [--accept-new-markers (owner only)]
  pr number [--branch <b>] [--state open|merged]
  pr create (--title <text> | --title-file <path>) (--body <text> | --body-file <path>) [--draft]
  pr edit [--pr <n>] [--title <text> | --title-file <path>] [--body <text> | --body-file <path>]
  pr merge [--pr <n>] --match-head <sha> (--subject <text> | --subject-file <path>)
           (--body <text> | --body-file <path>)

History:
  rebase  restack  sync-main  digest
  land --match-head <sha> (--subject <text> | --subject-file <path>)
       (--body <text> | --body-file <path>)

No arguments: an action menu on a terminal with fzf, otherwise "list".
Exit codes: 0 done, 1 failed or unconfirmed, 2 invalid input, 3 already exists,
69 dependency, remote or slot unavailable, 124 herdr timeout.
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

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof WtError) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = e.code;
  } else {
    process.stderr.write(`bin/wt failed unexpectedly: ${e instanceof Error ? e.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
