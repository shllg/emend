import { type FileFlag, type FileStatus, OTHER_TOPIC, type TopicMeta } from "@emend/contract";
import { structuredPatch } from "diff";

export const DOWNLOAD_DIFF_CONTEXT = 4;
export const DOWNLOAD_DIFF_LINES = 100_000;
export const DOWNLOAD_DIFF_BYTES = 32 * 1024 * 1024;
export type DownloadDiffFile = {
  path: string;
  oldPath: string | null;
  status: FileStatus | null;
  flag: FileFlag | null;
  topic: string | null;
  order: number;
  hasOld: boolean;
  hasNew: boolean;
  additions: number | null;
  deletions: number | null;
};
export type DownloadDiffHunk = { oldStart: number; newStart: number; lines: string[] };

export function downloadDiffGroups(topics: TopicMeta[], files: DownloadDiffFile[]) {
  const groups = new Map<string, { slug: string; title: string; files: number[] }>();
  for (const topic of topics.toSorted((a, b) => a.importance - b.importance))
    if (topic.slug !== OTHER_TOPIC.slug) groups.set(topic.slug, { slug: topic.slug, title: topic.title, files: [] });
  const other = { ...OTHER_TOPIC, files: [] as number[] };
  const ordered = files.map((file, index) => ({ file, index })).sort((a, b) => a.file.order - b.file.order);
  for (const { file, index } of ordered) (groups.get(file.topic ?? "") ?? other).files.push(index);
  return [...groups.values(), other].filter((group) => group.files.length > 0);
}

export function downloadDiffHunks(
  old: string,
  next: string,
  timeoutMs: number,
  maxLines: number,
): DownloadDiffHunk[] | null | "too-long" {
  const patch = structuredPatch("", "", old, next, undefined, undefined, {
    context: DOWNLOAD_DIFF_CONTEXT,
    timeout: timeoutMs,
  });
  if (!patch) return null;
  const hunks: DownloadDiffHunk[] = [];
  let lines = 0;
  for (const hunk of patch.hunks) {
    lines += hunk.lines.length;
    if (lines > maxLines) return "too-long";
    // Match jsdiff's unified headers for a side with no lines.
    hunks.push({
      oldStart: hunk.oldStart - (hunk.oldLines === 0 ? 1 : 0),
      newStart: hunk.newStart - (hunk.newLines === 0 ? 1 : 0),
      lines: hunk.lines,
    });
  }
  return hunks;
}
