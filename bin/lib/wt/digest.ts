import { createHash } from "node:crypto";
import { git, type Repo } from "./repo.ts";

/**
 * A hash of the change itself: the diff from the merge base to `head` with three lines of context, hunk
 * headers reduced to `@@` plus their function-context text (no line numbers) and blob ids removed. File paths and mode lines stay. A pure
 * line shift keeps it; a changed line, or the same change at another place or in another file, changes it.
 */
export function changeDigest(repo: Repo, base: string, head: string): string {
  const cwd = repo.callerTop ?? repo.mainRoot;
  const diff = git(
    repo,
    [
      "--no-replace-objects",
      "diff",
      "--unified=3",
      "--binary",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      "--diff-algorithm=myers",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `${base}...${head}`,
      "--",
    ],
    { cwd },
  );
  const kept = diff
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .map((line) => (line.startsWith("@@ ") ? line.replace(/^@@ [^@]*@@/, "@@") : line));
  return createHash("sha256").update(kept.join("\n")).digest("hex");
}
