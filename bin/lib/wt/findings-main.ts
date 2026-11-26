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
  list [--state <s>] [--kind <k>] [--path <p>] [--triage approved|untriaged] [--json]
                                                   untriaged means open with no approval. approved means an approval in any state.
  page                                             write the main checkout's triage page (JSON)
  show <id>
  approve <id>... --priority P0|P1|P2              approve open findings from the main checkout
  skip <id>...                                     dismiss untriaged findings from the main checkout
  release <id>...
  resolve <id> (--fixed <sha> | --dismissed <reason> | --stale)
                                                   --fixed runs only from the main checkout

Fixer:
  spawn <id,id> --slug <slug> [--model <m>] [--effort <e>]
                                                   start a fixer for approved findings
  A fixer's merge prints FIXED <id> for each claim it records as fixed.

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
