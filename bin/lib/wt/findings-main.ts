import { type CommandTable, EXIT_CODES, runMain } from "./command.ts";
import { commands as registryCommands } from "./findings.ts";
import { run } from "./proc.ts";
import { assertNoLocalHooksPath, type Repo, resolveRepo } from "./repo.ts";
import { WtError } from "./validate.ts";

const commands: CommandTable = {
  ...registryCommands,
  spawn: async (ctx) => (await import("./herdr.ts")).spawnFindingsCommand(ctx),
};

const HELP = `bin/findings: the local findings registry

Registry:
  add --file <file>                                record a local finding (3 when already recorded)
  list [--state <s>] [--kind <k>] [--path <p>] [--json]
  show <id>
  release <id>...
  resolve <id> (--fixed <sha> | --dismissed <reason> | --stale)

Fixer:
  spawn <id,id> --slug <slug> [--model <m>] [--effort <e>]
                                                   start a fixer worktree and its agent

Groomer:
  groom next [--count N]                           the files the groomer reads next (JSON; N from 1 to 50, default 5)
  groom visited <path> --blob <sha> --findings N   record a groom visit (2 when the blob is not HEAD's)

${EXIT_CODES}
`;

async function main([sub, ...args]: string[]): Promise<number> {
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  const command = Object.hasOwn(commands, sub) ? commands[sub] : undefined;
  if (!command) throw new WtError(2, "Unknown subcommand. Run bin/findings help.");

  const cwd = process.cwd();
  let repo: Repo;
  try {
    repo = resolveRepo(cwd);
  } catch (e) {
    if (run("git", ["--version"], { cwd, gitNoLazyFetch: true }).code === 127)
      throw new WtError(69, "Git is unavailable.");
    throw e;
  }
  assertNoLocalHooksPath(repo);
  return (await command({ repo, args })) ?? 0;
}

await runMain("bin/findings", main);
