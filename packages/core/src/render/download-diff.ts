import { type FileFlag, type FileStatus, OTHER_TOPIC, type TopicMeta } from "@recense/contract";
import { structuredPatch } from "diff";

export const DOWNLOAD_DIFF_CONTEXT = 4;
export const DOWNLOAD_DIFF_REVEAL_CONTEXT = 3;
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
export type DownloadDiffReveal = { side: "old" | "new"; start: number; end: number };

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
  reveal: DownloadDiffReveal[] = [],
): DownloadDiffHunk[] | null | "too-long" {
  const patch = structuredPatch("", "", old, next, undefined, undefined, {
    context: Number.MAX_SAFE_INTEGER,
    timeout: timeoutMs,
  });
  if (!patch) return null;
  const hunks: DownloadDiffHunk[] = [];
  let lineCount = 0;
  for (const full of patch.hunks) {
    const visible = new Uint8Array(full.lines.length);
    // Context before changes, counting unchanged lines only; markers consume no context.
    let context = 0;
    for (let index = full.lines.length - 1; index >= 0; index--) {
      const line = full.lines[index];
      if (line?.startsWith("+") || line?.startsWith("-")) {
        visible[index] = 1;
        context = DOWNLOAD_DIFF_CONTEXT;
      } else if (line?.startsWith(" ") && context > 0) {
        visible[index] = 1;
        context--;
      }
    }
    let oldLine = full.oldStart;
    let newLine = full.newStart;
    let hunk: DownloadDiffHunk | undefined;
    let hasOld = false;
    let hasNew = false;
    context = 0;
    for (const [index, line] of full.lines.entries()) {
      const oldBefore = oldLine - 1;
      const newBefore = newLine - 1;
      const oldNumber = line.startsWith("-") || line.startsWith(" ") ? oldLine++ : undefined;
      const newNumber = line.startsWith("+") || line.startsWith(" ") ? newLine++ : undefined;
      if (line.startsWith("+") || line.startsWith("-")) context = DOWNLOAD_DIFF_CONTEXT;
      else if (line.startsWith(" ")) {
        if (
          context > 0 ||
          reveal.some((range) => {
            const number = range.side === "old" ? oldNumber : newNumber;
            return (
              number !== undefined &&
              number >= range.start - DOWNLOAD_DIFF_REVEAL_CONTEXT &&
              number <= range.end + DOWNLOAD_DIFF_REVEAL_CONTEXT
            );
          })
        )
          visible[index] = 1;
        if (context > 0) context--;
      } else if (line.startsWith("\\")) visible[index] = visible[index - 1] ?? 0;
      if (!visible[index]) {
        hunk = undefined;
        continue;
      }
      if (++lineCount > maxLines) return "too-long";
      if (!hunk) {
        // A side with no lines names the last line before the hunk (zero at the start).
        hunk = { oldStart: oldBefore, newStart: newBefore, lines: [] };
        hunks.push(hunk);
        hasOld = false;
        hasNew = false;
      }
      if (oldNumber !== undefined && !hasOld) {
        hunk.oldStart = oldNumber;
        hasOld = true;
      }
      if (newNumber !== undefined && !hasNew) {
        hunk.newStart = newNumber;
        hasNew = true;
      }
      hunk.lines.push(line);
    }
  }
  return hunks;
}
