import {
  type BinQuery,
  BinView,
  LIMITS,
  MAX_SNOOZE_DAYS,
  type RetireRequest,
  type SnoozeRequest,
} from "@emend/contract";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { ApiError } from "../../server/http/errors.ts";
import type { Db, Queries } from "../client.ts";
import {
  agentNotes,
  agentWaiters,
  changedBlocks,
  comments,
  deliveries,
  docAssets,
  files,
  instances,
  placements,
  repos,
  reviews,
  reviewTombstones,
  revisions,
  sends,
  threads,
  topics,
  viewedFiles,
  writeups,
} from "../schema.ts";
import { newestRevision, requireReview } from "./thread-access.ts";

const DAY_MS = 86_400_000;

async function requireOpen(ownerId: string, q: Queries, reviewId: string) {
  const review = await requireReview(ownerId, q, reviewId);
  if (review.state !== "open") throw new ApiError("invalid_state");
  return review;
}

const touch = (ownerId: string, q: Queries, reviewId: string, set: Partial<typeof reviews.$inferInsert>) =>
  q
    .update(reviews)
    .set(set)
    .where(and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewId)));

export function snoozeReview(ownerId: string, db: Db, reviewId: string, request: SnoozeRequest, now: number) {
  let until: number | null = null;
  if ("until" in request) {
    until = Date.parse(request.until);
    if (!(until > now) || until > now + MAX_SNOOZE_DAYS * DAY_MS) throw new ApiError("invalid_request");
  }
  return db.transaction(async (q) => {
    await requireOpen(ownerId, q, reviewId);
    await touch(ownerId, q, reviewId, { snoozedAt: now, snoozedUntil: until });
    return (await newestRevision(ownerId, q, reviewId)).seq;
  });
}

export function unsnoozeReview(ownerId: string, db: Db, reviewId: string, now: number) {
  return db.transaction(async (q) => {
    await requireReview(ownerId, q, reviewId);
    // The review is active again as of now, so it sorts as just updated.
    await touch(ownerId, q, reviewId, { snoozedAt: null, snoozedUntil: null, updatedAt: now });
    return (await newestRevision(ownerId, q, reviewId)).seq;
  });
}

export function retireReview(ownerId: string, db: Db, reviewId: string, request: RetireRequest, now: number) {
  return db.transaction(async (q) => {
    await requireOpen(ownerId, q, reviewId);
    const unsent = and(
      eq(comments.ownerId, ownerId),
      eq(comments.reviewId, reviewId),
      eq(comments.author, "user"),
      isNull(comments.sendId),
    );
    const total = (await q.select({ n: count() }).from(comments).where(unsent).get())?.n ?? 0;
    if (total) {
      if (!request.discardUnsent) throw new ApiError("unsent_comments");
      const touched = (await q.select({ id: comments.threadId }).from(comments).where(unsent)).map((row) => row.id);
      await q.delete(comments).where(unsent);
      // A thread whose only comments were unsent goes with them, placements first.
      const kept = q
        .select({ id: comments.threadId })
        .from(comments)
        .where(and(eq(comments.ownerId, ownerId), eq(comments.reviewId, reviewId)));
      const emptyIds = (
        await q
          .select({ id: threads.id })
          .from(threads)
          .where(
            and(
              eq(threads.ownerId, ownerId),
              eq(threads.reviewId, reviewId),
              inArray(threads.id, touched),
              notInArray(threads.id, kept),
            ),
          )
      ).map((row) => row.id);
      if (emptyIds.length) {
        await q
          .delete(placements)
          .where(
            and(
              eq(placements.ownerId, ownerId),
              eq(placements.reviewId, reviewId),
              inArray(placements.threadId, emptyIds),
            ),
          );
        await q.delete(threads).where(and(eq(threads.ownerId, ownerId), inArray(threads.id, emptyIds)));
      }
    }
    await touch(ownerId, q, reviewId, { state: "settled", snoozedAt: null, snoozedUntil: null, updatedAt: now });
    return (await newestRevision(ownerId, q, reviewId)).seq;
  });
}

export function reopenReview(ownerId: string, db: Db, reviewId: string, now: number) {
  return db.transaction(async (q) => {
    const review = await requireReview(ownerId, q, reviewId);
    if (review.state !== "settled") throw new ApiError("invalid_state");
    await touch(ownerId, q, reviewId, { state: "open", approvedAt: null, updatedAt: now });
    return (await newestRevision(ownerId, q, reviewId)).seq;
  });
}

/** Move a review to the bin. Only binned_at changes: nothing else of the review is touched. */
export function binReview(ownerId: string, db: Db, reviewId: string, now: number) {
  return db.transaction(async (q) => {
    // requireReview answers review_in_bin for a review that is already binned.
    await requireReview(ownerId, q, reviewId);
    await touch(ownerId, q, reviewId, { binnedAt: now });
    return (await newestRevision(ownerId, q, reviewId)).seq;
  });
}

/** Take a review out of the bin. Only binned_at changes, so it returns to the list and place it had. */
export function restoreReview(ownerId: string, db: Db, reviewId: string) {
  return db.transaction(async (q) => {
    const review = await requireReview(ownerId, q, reviewId, undefined, true, false, true);
    if (review.binnedAt === null) throw new ApiError("invalid_state");
    await touch(ownerId, q, reviewId, { binnedAt: null });
    return (await newestRevision(ownerId, q, reviewId)).seq;
  });
}

/** One page of the owner's live binned reviews, newest first (ties by id); total counts them all. */
export function listBin(ownerId: string, db: Db, cursor: BinQuery = {}): Promise<BinView> {
  return db.read(async (q) => {
    const binned = and(eq(reviews.ownerId, ownerId), isNotNull(reviews.binnedAt), isNull(reviews.movedToUrl));
    const after =
      cursor.beforeAt && cursor.beforeId
        ? or(
            lt(reviews.binnedAt, Date.parse(cursor.beforeAt)),
            and(eq(reviews.binnedAt, Date.parse(cursor.beforeAt)), gt(reviews.id, cursor.beforeId)),
          )
        : undefined;
    const rows = await q
      .select({ id: reviews.id, title: reviews.title, machine: instances.name, binnedAt: reviews.binnedAt })
      .from(reviews)
      .innerJoin(instances, eq(instances.id, reviews.originInstanceId))
      .where(and(binned, after))
      .orderBy(desc(reviews.binnedAt), asc(reviews.id))
      .limit(LIMITS.binItems + 1)
      .all();
    const total = (await q.select({ n: count() }).from(reviews).where(binned).get())?.n ?? 0;
    return BinView.parse({
      items: rows.slice(0, LIMITS.binItems).map((row) => ({
        id: row.id,
        title: row.title,
        machine: row.machine,
        binnedAt: new Date(row.binnedAt as number).toISOString(),
      })),
      total,
      more: rows.length > LIMITS.binItems,
    });
  });
}

/** The ids of the owner's live reviews binned no later than the confirmed cutoff. */
export function binnedIds(ownerId: string, db: Db, upTo: number) {
  return db.read(async (q) =>
    (
      await q
        .select({ id: reviews.id })
        .from(reviews)
        .where(and(eq(reviews.ownerId, ownerId), lte(reviews.binnedAt, upTo), isNull(reviews.movedToUrl)))
        .orderBy(asc(reviews.id))
    ).map((row) => row.id),
  );
}

/**
 * Delete one review and everything under it in one transaction; return the blobs it may have freed.
 * A binned review can be deleted. With `onlyBinned`, a review that is not (or no longer) in the bin
 * stays, and the call answers null. An optional cutoff also leaves a review binned later alone.
 */
export function deleteReview(
  ownerId: string,
  db: Db,
  reviewId: string,
  now: number,
  onlyBinned = false,
  upTo?: number,
) {
  return db.transaction(async (q) => {
    const review = await requireReview(ownerId, q, reviewId, undefined, true, false, true);
    if (onlyBinned && (review.binnedAt === null || (upTo !== undefined && review.binnedAt > upTo))) return null;
    const revision = (await newestRevision(ownerId, q, reviewId)).seq;
    const revisionIds = q
      .select({ id: revisions.id })
      .from(revisions)
      .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId)));
    const fileIds = q
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.ownerId, ownerId), inArray(files.revisionId, revisionIds)));
    const candidates = new Set<string>();
    const note = (...hashes: (string | null)[]) => {
      for (const hash of hashes) if (hash) candidates.add(hash);
    };
    for (const file of await q
      .select({ o: files.oldBlob, n: files.newBlob, r: files.renderedBlob })
      .from(files)
      .where(and(eq(files.ownerId, ownerId), inArray(files.revisionId, revisionIds))))
      note(file.o, file.n, file.r);
    for (const writeup of await q
      .select({ s: writeups.sourceBlob, r: writeups.renderedBlob })
      .from(writeups)
      .where(and(eq(writeups.ownerId, ownerId), inArray(writeups.revisionId, revisionIds))))
      note(writeup.s, writeup.r);
    for (const mark of await q
      .select({ o: viewedFiles.oldBlob, n: viewedFiles.newBlob })
      .from(viewedFiles)
      .where(and(eq(viewedFiles.ownerId, ownerId), eq(viewedFiles.reviewId, reviewId))))
      note(mark.o, mark.n);
    // Children first, honouring the composite foreign keys.
    await q.delete(placements).where(and(eq(placements.ownerId, ownerId), eq(placements.reviewId, reviewId)));
    await q.delete(comments).where(and(eq(comments.ownerId, ownerId), eq(comments.reviewId, reviewId)));
    await q.delete(sends).where(and(eq(sends.ownerId, ownerId), eq(sends.reviewId, reviewId)));
    await q.delete(deliveries).where(and(eq(deliveries.ownerId, ownerId), eq(deliveries.reviewId, reviewId)));
    await q.delete(threads).where(and(eq(threads.ownerId, ownerId), eq(threads.reviewId, reviewId)));
    await q.delete(viewedFiles).where(and(eq(viewedFiles.ownerId, ownerId), eq(viewedFiles.reviewId, reviewId)));
    await q.delete(agentWaiters).where(and(eq(agentWaiters.ownerId, ownerId), eq(agentWaiters.reviewId, reviewId)));
    await q.delete(docAssets).where(and(eq(docAssets.ownerId, ownerId), inArray(docAssets.revisionId, revisionIds)));
    await q.delete(agentNotes).where(and(eq(agentNotes.ownerId, ownerId), inArray(agentNotes.fileId, fileIds)));
    await q.delete(files).where(and(eq(files.ownerId, ownerId), inArray(files.revisionId, revisionIds)));
    await q.delete(topics).where(and(eq(topics.ownerId, ownerId), inArray(topics.revisionId, revisionIds)));
    await q.delete(writeups).where(and(eq(writeups.ownerId, ownerId), inArray(writeups.revisionId, revisionIds)));
    await q
      .delete(changedBlocks)
      .where(and(eq(changedBlocks.ownerId, ownerId), inArray(changedBlocks.revisionId, revisionIds)));
    await touch(ownerId, q, reviewId, { approvedRevision: null });
    await q.delete(revisions).where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId)));
    await q.delete(reviews).where(and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewId)));
    // Only reviews reference a repo. Drop it when this was its last review.
    if (review.repoId)
      await q.delete(repos).where(
        and(
          eq(repos.ownerId, ownerId),
          eq(repos.id, review.repoId),
          notExists(
            q
              .select({ one: sql`1` })
              .from(reviews)
              .where(and(eq(reviews.ownerId, ownerId), eq(reviews.repoId, review.repoId))),
          ),
        ),
      );
    await q.insert(reviewTombstones).values({ ownerId, reviewId, deletedAt: now });
    return { revision, candidates: [...candidates] };
  });
}
