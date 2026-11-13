import type { FileView, Target, TopicMeta } from "@emend/contract";
import { FileCode, FileText, ListTree, MessageSquare, TextSelect } from "lucide-react";
import { plural } from "../../lib/count.ts";
import { rankedTopics } from "../../lib/topics.ts";
export type DiffTarget = Extract<Target, { kind: "lines" | "file" | "topic" }>;
export function isDiffTarget(target: Target): target is DiffTarget {
  return target.kind === "lines" || target.kind === "file" || target.kind === "topic";
}
export type FileLocation = { kind: string; path?: string; side?: string };
export function resolveFile(files: FileView[], target: FileLocation) {
  const matches = files.filter((file) => {
    if (file.role !== "diff") return false;
    if (target.kind === "file") return target.path === file.path;
    if (target.kind !== "lines") return false;
    return target.side === "old"
      ? file.hasOld && file.status !== "added" && target.path === (file.oldPath ?? file.path)
      : target.side === "new" && file.hasNew && target.path === file.path;
  });
  return matches.length === 1 ? matches[0] : undefined;
}
export const WRITEUP_SECTION_NAMES = {
  overview: "Overview",
  tldr: "TL;DR",
  outOfScope: "Out of scope",
  whereToLook: "Where to look",
  context: "Context",
  decisions: "Decisions",
  glossary: "Glossary",
};
export function targetLabel(target: Target, topics: TopicMeta[] = []) {
  switch (target.kind) {
    case "writeup-span": {
      const slug = /^t-(.+)-(?:why|example|body)-[\da-f]{8}(?:-\d+)?$/.exec(target.blockId)?.[1];
      const topic = topics.find((topic) => topic.slug === slug);
      const section =
        topic?.title ??
        Object.entries(WRITEUP_SECTION_NAMES).find(([key]) => target.blockId.startsWith(`${key}-`))?.[1];
      return { label: section ? `Writeup · ${section}` : "Writeup", icon: TextSelect };
    }
    case "doc-span":
    case "html-span":
      return { label: target.path, icon: TextSelect };
    case "source-lines":
    case "lines":
      return {
        label: `${target.path} · ${plural(target.end - target.start + 1, "line")} ${target.start === target.end ? target.start : `${target.start}–${target.end}`}${target.kind === "source-lines" ? " (source)" : target.side === "old" ? " (old)" : ""}`,
        icon: FileCode,
      };
    case "file":
      return { label: target.path, icon: FileText };
    case "topic": {
      const topic = topics.find((topic) => topic.slug === target.slug);
      const rank = rankedTopics(topics).find((entry) => entry.topic.slug === target.slug)?.rank;
      return {
        label: `Topic${rank ? ` ${String(rank).padStart(2, "0")}` : ""} · ${topic?.title ?? target.slug}`,
        icon: ListTree,
      };
    }
    case "review":
      return { label: "Whole review", icon: MessageSquare };
  }
}
