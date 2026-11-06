import { checkPublic, PublicCheckError, type PublicResult } from "../../../scripts/check-public.ts";
import type { Repo } from "./repo.ts";
import { WtError } from "./validate.ts";

export function requirePublic(check: () => PublicResult): void {
  let result: PublicResult;
  try {
    result = check();
  } catch (error) {
    throw new WtError(
      error instanceof PublicCheckError && error.code === 69 ? 69 : 1,
      error instanceof PublicCheckError
        ? error.message
        : "check:public: could not complete the check; nothing was published.",
    );
  }
  for (const note of result.notes) process.stderr.write(`${note}\n`);
  if (result.hits.length > 0) throw new WtError(1, result.hits.join("\n"));
}

export function requirePublicText(repo: Repo, fields: Record<string, string | undefined>): void {
  requirePublic(() =>
    checkPublic({
      cwd: repo.mainRoot,
      root: repo.mainRoot,
      requireTerms: true,
      texts: Object.entries(fields).flatMap(([field, text]) => (text === undefined ? [] : [{ field, text }])),
    }),
  );
}
