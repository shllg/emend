import type { PublishManifest } from "@recense/contract";
import { escapeReference } from "../escape.ts";

type ManifestIssue = NonNullable<ReturnType<typeof PublishManifest.safeParse>["error"]>["issues"][number];

function expectedForm(issue: ManifestIssue): string {
  if (issue.code === "custom") {
    return issue.message === "base and head must be supplied together" ? "required" : issue.message;
  }
  if (issue.input === undefined) return "required";
  const field = issue.path.at(-1);
  if (issue.path.length === 1 && field === "base") return "a full commit hash";
  if (issue.path.length === 1 && field === "head") return "a full commit hash or worktree";
  const review = issue.path[0] === "writeup" && issue.path[1] === "review";
  if (review && field === "level") return "skim, topics or everything";
  const newInRevision = issue.path[0] === "writeup" && issue.path[1] === "newInRevision";
  if (newInRevision && typeof issue.path[2] === "number" && field === "section")
    return "overview, tldr, whyItMatters, checked, notChecked, outOfScope, whereToLook, context, deviations, decisions or glossary";
  const needsYou = issue.path[0] === "writeup" && issue.path[1] === "needsYou";
  if (needsYou && typeof issue.path[2] === "number" && field === "kind")
    return "decide, accept, confirm-drift or answer";
  const checked = issue.path[0] === "writeup" && issue.path[1] === "checked";
  if (checked && typeof issue.path[2] === "number" && field === "kind") return "ran, read or reasoned";
  if (
    (checked || needsYou || newInRevision) &&
    issue.path.length === 2 &&
    issue.code === "too_big" &&
    issue.origin === "array"
  )
    return `at most ${issue.maximum} items`;
  const topic = issue.path[0] === "topics" && typeof issue.path[1] === "number";
  if (
    (topic && field === "slug") ||
    (review && issue.path[2] === "topics" && typeof field === "number") ||
    ((needsYou || newInRevision) && typeof issue.path[2] === "number" && field === "topic") ||
    (issue.path[0] === "files" && field === "topic") ||
    (issue.code === "invalid_key" && issue.path[0] === "writeup" && issue.path[1] === "topics")
  )
    return "topic slug: lowercase letters, digits and -, at most 64";
  if (topic && field === "scope") return "one word, at most 32 characters";
  if (topic && field === "door") return "one-way or two-way";
  if (topic && field === "attention") return "critical, review or skim";
  if (topic && field === "importance") return "a number from 0 to 100";
  if (issue.code === "too_big" && issue.origin === "string") return `at most ${issue.maximum} characters`;
  // Zod's type diagnostic includes the received type; expose only the expected form.
  return issue.message.replace(/, received[\s\S]*$/, "");
}

export function manifestError(manifestIssues: readonly ManifestIssue[]): string {
  const issues = manifestIssues.flatMap<ManifestIssue>((issue) => {
    if (
      issue.code === "invalid_union" &&
      issue.path.length === 2 &&
      issue.path[0] === "writeup" &&
      issue.path[1] === "checked"
    ) {
      // Checked is Markdown first, then a list. Branch issue paths are relative to the union.
      if (typeof issue.input !== "string" && !Array.isArray(issue.input))
        return [{ ...issue, message: "Markdown or a list of { kind, text } items" }];
      const branch = issue.errors[Array.isArray(issue.input) ? 1 : 0];
      if (branch) return branch.map((inner) => ({ ...inner, path: [...issue.path, ...inner.path] }));
    }
    return [issue];
  });
  const details = issues.slice(0, 3).map((issue) => {
    const path =
      issue.path
        .map((part) => {
          const escaped = escapeReference(String(part));
          return escaped.length > 64 ? `${escaped.slice(0, 64)}…` : escaped;
        })
        .join(".") || "manifest";
    return `${path} (${escapeReference(expectedForm(issue))})`;
  });
  if (issues.length > 3) details.push(`and ${issues.length - 3} more`);
  return `invalid publish manifest: ${details.join("; ")}`;
}
