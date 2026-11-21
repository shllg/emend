import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { DocRootError, rootRules, validateDocRoot } from "../config.ts";
import { escapeReference } from "../escape.ts";
import type { GitRunner } from "../git.ts";
import { CliError } from "../http.ts";
import { worktreeRoot } from "./root.ts";

/** Find and validate the code root without loading the publish pipeline. */
export async function codeRoot(cwd: string, stateDir: string, git: GitRunner) {
  const worktree = await worktreeRoot(cwd);
  if (worktree) {
    try {
      await validateDocRoot(worktree, homedir(), stateDir);
    } catch (error) {
      if (error instanceof DocRootError)
        throw new CliError(
          `the repository at ${escapeReference(worktree)} ${rootRules[error.reason].publish}, so emend does not publish from it`,
        );
      throw error;
    }
    const configured = await realpath(
      (await git(cwd, ["rev-parse", "--show-toplevel"])).toString().replace(/\r?\n$/, ""),
    );
    if (configured !== worktree) throw new CliError("the repository's worktree is configured elsewhere");
  }
  const root = worktree ?? (await realpath(cwd));
  return { worktree, root };
}
