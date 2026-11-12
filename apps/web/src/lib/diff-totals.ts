import type { FileView, RevisionView } from "@emend/contract";
import { diffGroups } from "./diff-groups.ts";

type Counts = NonNullable<FileView["counts"]>;
export type LineTotal = Counts & { uncounted: number };

const uncountedFiles = (files: FileView[]) =>
  files.filter((file) => file.role === "diff" && !file.flag && !file.counts).length;

export function lineTotals(files: FileView[]): LineTotal | null {
  const total = sumCounts(files.filter((file) => file.role === "diff").map((file) => file.counts));
  return total && { ...total, uncounted: uncountedFiles(files) };
}

/** Sum the same groups the diff and Files tab show, including Other files. */
export function reviewLineTotals(revision: RevisionView): LineTotal | null {
  const groups = [...diffGroups(revision).values()].map(({ files }) => ({ files, total: lineTotals(files) }));
  const total = sumCounts(groups.map(({ total }) => total));
  // A wholly uncounted topic has no visible total but still makes the review partial.
  return (
    total && {
      ...total,
      uncounted: groups.reduce((sum, group) => sum + (group.total?.uncounted ?? uncountedFiles(group.files)), 0),
    }
  );
}

function sumCounts(counts: (Counts | null | undefined)[]): Counts | null {
  let total: Counts | null = null;
  for (const count of counts) {
    if (!count) continue;
    total ??= { additions: 0, deletions: 0 };
    total.additions += count.additions;
    total.deletions += count.deletions;
  }
  return total;
}
