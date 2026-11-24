import type { RevisionView } from "@recense/contract";
import { diffGroups } from "./diff-groups.ts";

export type CodeFocus = { kind: "topic"; slug: string } | { kind: "file"; id: string };

export function sameCodeFocus(left?: CodeFocus, right?: CodeFocus) {
  if (!left || !right) return left === right;
  return left.kind === "topic"
    ? right.kind === "topic" && left.slug === right.slug
    : right.kind === "file" && left.id === right.id;
}

/** An absent result means the focus no longer has a diff in this revision. */
export function resolveCodeFocus(revision: Pick<RevisionView, "files" | "topics">, focus?: CodeFocus) {
  if (!focus) return undefined;
  if (focus.kind === "file") {
    const file = revision.files.find((file) => file.id === focus.id && file.role === "diff");
    return file ? { title: file.path } : undefined;
  }
  const group = diffGroups(revision).get(focus.slug);
  return group?.files.length ? { title: group.topic.title } : undefined;
}
