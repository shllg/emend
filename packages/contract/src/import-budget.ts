import type { ImportBundle } from "./import.ts";

/** Known inserts, including derived placements; add generated blobs and changed blocks after rendering. */
export function importRowCount(bundle: ImportBundle): number {
  const sequences = new Map(bundle.revisions.map((r) => [r.id, r.seq]));
  let rows =
    1 +
    Number(bundle.review.repo !== null) +
    bundle.revisions.length +
    bundle.topics.length +
    bundle.files.length +
    (bundle.agentNotes?.length ?? 0) +
    (bundle.diffImages?.length ?? 0) +
    bundle.docAssets.length +
    bundle.writeups.length +
    bundle.threads.length +
    bundle.comments.length +
    bundle.sends.length +
    bundle.deliveries.filter((d) => d.confirmedAt !== null).length;
  for (const thread of bundle.threads)
    rows += bundle.revisions.length - (sequences.get(thread.createdRevisionId) ?? 0) + 1;
  return rows;
}
