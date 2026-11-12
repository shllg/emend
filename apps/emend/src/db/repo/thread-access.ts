import { and, desc, eq, sql } from "drizzle-orm";
import type { Principal } from "../../server/auth/principal.ts";
import { ApiError } from "../../server/http/errors.ts";
import type { Queries } from "../client.ts";
import { comments, reviews, revisions, threads } from "../schema.ts";

export async function requireReview(
  ownerId: string,
  q: Queries,
  reviewId: string,
  principal?: Principal,
  mutation = true,
  nested = false,
  /** Only restore, delete for good and the settling of an already-claimed delivery reach a binned review. */
  allowBinned = false,
) {
  const review = await q
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.ownerId, ownerId),
        eq(reviews.id, reviewId),
        principal?.kind === "agent" ? eq(reviews.originInstanceId, principal.instanceId ?? "") : undefined,
      ),
    )
    .get();
  if (!review) throw new ApiError(nested ? "not_found" : "unknown_review");
  if (mutation && review.movedToUrl) throw new ApiError("review_moved");
  if (review.binnedAt !== null && !allowBinned) throw new ApiError("review_in_bin");
  return review;
}
export async function newestRevision(ownerId: string, q: Queries, reviewId: string) {
  const revision = await q
    .select()
    .from(revisions)
    .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId)))
    .orderBy(desc(revisions.seq))
    .get();
  if (!revision) throw new ApiError("invalid_target");
  return revision;
}
export async function requireThread(ownerId: string, q: Queries, threadId: string) {
  const thread = await q
    .select()
    .from(threads)
    .where(and(eq(threads.ownerId, ownerId), eq(threads.id, threadId)))
    .get();
  if (!thread) throw new ApiError("not_found");
  await requireReview(ownerId, q, thread.reviewId);
  return thread;
}
export async function requireComment(ownerId: string, q: Queries, commentId: string, principal?: Principal) {
  const comment = await q
    .select()
    .from(comments)
    .where(and(eq(comments.ownerId, ownerId), eq(comments.id, commentId)))
    .get();
  if (!comment) throw new ApiError("not_found");
  await requireReview(ownerId, q, comment.reviewId, principal, true, true);
  return comment;
}
export async function eventInfo(ownerId: string, q: Queries, reviewId: string, threadId: string, commentId?: string) {
  return {
    reviewId,
    threadId,
    revision: (await newestRevision(ownerId, q, reviewId)).seq,
    ...(commentId ? { commentId } : {}),
  };
}

// Durable insertion order is independent of wall-clock adjustments.
export const commentOrder = sql<number>`comments.rowid`;
