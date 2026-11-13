import { type FileView, OTHER_TOPIC, type RevisionView, type TopicMeta } from "@emend/contract";
import type { FileOrder } from "./layout-store.ts";

const pathCollator = new Intl.Collator("en", { numeric: true });

/** Shared order for the diff and its Files table of contents. */
export function diffGroups(revision: Pick<RevisionView, "topics" | "files">) {
  const groups = new Map<string, { topic: TopicMeta; files: FileView[] }>();
  for (const topic of revision.topics.toSorted((a, b) => a.importance - b.importance))
    groups.set(topic.slug, { topic, files: [] });
  const other = groups.get(OTHER_TOPIC.slug) ?? { topic: { ...OTHER_TOPIC, importance: 0, summary: "" }, files: [] };
  other.topic = { ...other.topic, title: OTHER_TOPIC.title };
  groups.delete(OTHER_TOPIC.slug);
  for (const file of revision.files.filter((file) => file.role === "diff").toSorted((a, b) => a.order - b.order))
    (groups.get(file.topic ?? "") ?? other).files.push(file);
  if (other.files.length || revision.topics.some((topic) => topic.slug === OTHER_TOPIC.slug))
    groups.set(OTHER_TOPIC.slug, other);
  return groups;
}

export function pathOrder(files: FileView[]): FileView[] {
  return files.toSorted((a, b) => {
    const left = a.path.split("/");
    const right = b.path.split("/");
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const compared = pathCollator.compare(left[index] ?? "", right[index] ?? "");
      if (compared) return compared;
    }
    return left.length - right.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.order - b.order);
  });
}

export function diffFiles(revision: Pick<RevisionView, "topics" | "files">, order: FileOrder): FileView[] {
  return order === "path"
    ? pathOrder(revision.files.filter((file) => file.role === "diff"))
    : [...diffGroups(revision).values()].flatMap((group) => group.files);
}
