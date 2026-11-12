import { ImportBundle, importRowCount, LIMITS } from "@emend/contract";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Queries } from "../../db/client.ts";
import {
  agentNotes,
  comments,
  deliveries,
  docAssets,
  files,
  repos,
  reviews,
  revisions,
  sends,
  threads,
  topics,
  writeups,
} from "../../db/schema.ts";
import { noteView } from "../../server/publish/notes.ts";
import { CliError } from "../http.ts";

const iso = (time: number) => new Date(time).toISOString();
const dates = <T extends { createdAt: number; updatedAt: number }>(row: T) => ({
  ...row,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

/** Count and serialize exactly what will be sent, before uploading any blobs. */
export function prepareBundle(input: ImportBundle): { bundle: ImportBundle; json: string } {
  if (
    input.revisions.length > LIMITS.importRevisions ||
    input.threads.length > LIMITS.importThreads ||
    input.comments.length > LIMITS.importComments ||
    input.sends.length > LIMITS.importSends ||
    input.deliveries.length > LIMITS.importDeliveries ||
    importRowCount(input) > LIMITS.importRows
  )
    throw new CliError("too large");
  const bundle = ImportBundle.parse(input);
  const json = JSON.stringify(bundle);
  if (Buffer.byteLength(json, "utf8") > LIMITS.publishJsonBytes) throw new CliError("too large");
  return { bundle, json };
}

export async function snapshot(
  q: Queries,
  ownerId: string,
  instanceId: string,
  reviewId: string,
  movedToUrl: string,
  now: number,
  hubHasBin: boolean,
) {
  const where = and(eq(reviews.ownerId, ownerId), eq(reviews.originInstanceId, instanceId), eq(reviews.id, reviewId));
  const review = await q.select().from(reviews).where(where).get();
  if (!review || (review.movedToUrl && review.movedToUrl !== movedToUrl)) return { kind: "skipped" as const };
  // Recheck under the writer lock: binning can race registration and earlier copies, even on a resend.
  if (!hubHasBin && review.binnedAt !== null) return { kind: "skipped" as const };
  const resend = review.movedToUrl === movedToUrl;
  const live = await q
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.ownerId, ownerId),
        eq(deliveries.reviewId, reviewId),
        isNull(deliveries.confirmedAt),
        gt(deliveries.leaseUntil, now),
      ),
    )
    .get();
  if (live) return { kind: "live" as const };
  // The caller holds the writer transaction through the marker and snapshot.
  if (!resend) await q.update(reviews).set({ movedToUrl }).where(where);
  const revisionIds = q
    .select({ id: revisions.id })
    .from(revisions)
    .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId)));
  const repo = review.repoId
    ? await q
        .select({ key: repos.key, name: repos.name })
        .from(repos)
        .where(and(eq(repos.ownerId, ownerId), eq(repos.id, review.repoId)))
        .get()
    : null;
  const revisionRows = await q
    .select()
    .from(revisions)
    .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId)))
    .orderBy(asc(revisions.seq));
  const topicRows = await q
    .select()
    .from(topics)
    .where(and(eq(topics.ownerId, ownerId), inArray(topics.revisionId, revisionIds)))
    .orderBy(sql`${topics}.rowid`);
  const fileRows = await q
    .select()
    .from(files)
    .where(and(eq(files.ownerId, ownerId), inArray(files.revisionId, revisionIds)))
    .orderBy(sql`${files}.rowid`);
  // Export every revision of this review, probing notes only for those revisions' file IDs.
  const noteRows = await q
    .select({ note: agentNotes })
    .from(agentNotes)
    .where(
      and(
        eq(agentNotes.ownerId, ownerId),
        inArray(
          agentNotes.fileId,
          q
            .select({ id: files.id })
            .from(files)
            .where(and(eq(files.ownerId, ownerId), inArray(files.revisionId, revisionIds))),
        ),
      ),
    )
    .orderBy(agentNotes.fileId, agentNotes.ord);
  const assetRows = await q
    .select()
    .from(docAssets)
    .where(and(eq(docAssets.ownerId, ownerId), inArray(docAssets.revisionId, revisionIds)))
    .orderBy(sql`${docAssets}.rowid`);
  const writeupRows = await q
    .select()
    .from(writeups)
    .where(and(eq(writeups.ownerId, ownerId), inArray(writeups.revisionId, revisionIds)))
    .orderBy(sql`${writeups}.rowid`);
  const threadRows = await q
    .select()
    .from(threads)
    .where(and(eq(threads.ownerId, ownerId), eq(threads.reviewId, reviewId)))
    .orderBy(sql`${threads}.rowid`);
  const commentRows = await q
    .select()
    .from(comments)
    .where(and(eq(comments.ownerId, ownerId), eq(comments.reviewId, reviewId)))
    .orderBy(sql`${comments}.rowid`);
  const sendRows = await q
    .select()
    .from(sends)
    .where(and(eq(sends.ownerId, ownerId), eq(sends.reviewId, reviewId)))
    .orderBy(sql`${sends}.rowid`);
  const deliveryRows = await q
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.ownerId, ownerId), eq(deliveries.reviewId, reviewId)))
    .orderBy(sql`${deliveries}.rowid`);
  const prepared = prepareBundle({
    review: {
      ...dates(review),
      repo: repo ?? null,
      project: review.project,
      binnedAt: review.binnedAt === null ? null : iso(review.binnedAt),
    },
    revisions: revisionRows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    topics: topicRows.map((t) => ({
      ...t,
      attention: t.attention ?? undefined,
      door: t.door ?? undefined,
      blastRadius:
        t.blastScope === null || t.blastNote === null ? undefined : { scope: t.blastScope, note: t.blastNote },
    })),
    files: fileRows.map(({ headings: _headings, ...file }) => ({
      ...file,
      ...(file.role === "doc" && file.mediaType === "text/plain" ? { view: "source" } : {}),
    })),
    agentNotes: noteRows.map(({ note }) => ({ ...noteView(note), fileId: note.fileId, ord: note.ord })),
    docAssets: assetRows,
    writeups: writeupRows,
    threads: threadRows.map(dates),
    comments: commentRows.map(dates),
    sends: sendRows.map((s) => ({
      ...s,
      createdAt: iso(s.createdAt),
      setAsideAt: s.setAsideAt === null ? null : iso(s.setAsideAt),
    })),
    // A closed delivery has no Send, and the import contract refuses a delivery without one.
    deliveries: deliveryRows
      .filter((d) => sendRows.some((s) => s.deliveryId === d.id))
      .map((d) => ({
        ...d,
        createdAt: iso(d.createdAt),
        leaseUntil: iso(d.leaseUntil),
        confirmedAt: d.confirmedAt === null ? null : iso(d.confirmedAt),
      })),
  });
  return { kind: "bundle" as const, resend, ...prepared };
}
