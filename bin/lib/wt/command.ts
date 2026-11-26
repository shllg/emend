import type { Repo } from "./repo.ts";
import { WtError } from "./validate.ts";

/** What main.ts and findings-main.ts hand to a subcommand. `args` excludes the subcommand name. */
export interface Ctx {
  repo: Repo;
  args: string[];
}

/** A subcommand returns an exit code, or nothing for 0. A WtError thrown from it sets the exit code. */
export type Command = (ctx: Ctx) => number | undefined | Promise<number | undefined>;

/** The shape a module exports as `commands` for dispatch from main.ts or findings-main.ts. */
export type CommandTable = Record<string, Command>;

export const EXIT_CODES = `Exit codes: 0 done, 1 failed or unconfirmed, 2 invalid input, 3 already exists,
69 dependency, remote or slot unavailable, 124 herdr or herdr desktop timeout.`;

export async function runMain(program: string, main: (argv: string[]) => Promise<number>): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof WtError) {
      process.stderr.write(`${e.message}\n`);
      process.exitCode = e.code;
    } else {
      process.stderr.write(`${program} failed unexpectedly: ${e instanceof Error ? e.message : "unknown error"}\n`);
      process.exitCode = 1;
    }
  }
}
