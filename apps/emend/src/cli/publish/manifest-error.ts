import type { PublishManifest } from "@emend/contract";
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
  const topic = issue.path[0] === "topics" && typeof issue.path[1] === "number";
  if (
    (topic && field === "slug") ||
    (review && issue.path[2] === "topics" && typeof field === "number") ||
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

export function manifestError(issues: readonly ManifestIssue[]): string {
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
