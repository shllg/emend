import type { FileView, RevisionView } from "@emend/contract";
import type { DiffCounts } from "../components/diff/presentation.ts";
import { diffGroups } from "./diff-groups.ts";

type Counts = NonNullable<FileView["counts"]>;
export type LineTotal = Counts & { uncounted: number };

const uncountedFiles = (files: FileView[], parsed?: ReadonlyMap<string, DiffCounts>) =>
  files.filter((file) => file.role === "diff" && !file.flag && !(file.counts ?? parsed?.get(file.id))).length;

export function lineTotals(files: FileView[], parsed?: ReadonlyMap<string, DiffCounts>): LineTotal | null {
  const total = sumCounts(
    files.filter((file) => file.role === "diff" && !file.flag).map((file) => file.counts ?? parsed?.get(file.id)),
  );
  return total && { ...total, uncounted: uncountedFiles(files, parsed) };
}

/** Sum the same groups the diff and Files tab show, including Other files. */
export function reviewLineTotals(revision: RevisionView, parsed?: ReadonlyMap<string, DiffCounts>): LineTotal | null {
  const groups = [...diffGroups(revision).values()].map(({ files }) => ({ files, total: lineTotals(files, parsed) }));
  const total = sumCounts(groups.map(({ total }) => total));
  // A wholly uncounted topic has no visible total but still makes the review partial.
  return (
    total && {
      ...total,
      uncounted: groups.reduce(
        (sum, group) => sum + (group.total?.uncounted ?? uncountedFiles(group.files, parsed)),
        0,
      ),
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
