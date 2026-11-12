import type { FileView, RevisionView } from "@emend/contract";
import { diffGroups } from "./diff-groups.ts";

type Counts = NonNullable<FileView["counts"]>;

export function lineTotals(files: FileView[]): Counts | null {
  return sumCounts(files.filter((file) => file.role === "diff").map((file) => file.counts));
}

/** Sum the same groups the diff and Files tab show, including Other files. */
export function reviewLineTotals(revision: RevisionView): Counts | null {
  return sumCounts([...diffGroups(revision).values()].map(({ files }) => lineTotals(files)));
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
