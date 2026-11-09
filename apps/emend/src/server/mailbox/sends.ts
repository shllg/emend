import { randomUUID } from "node:crypto";
import { DEFAULT_MODE, LIMITS, type SendRequest } from "@emend/contract";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { newestRevision, requireReview } from "../../db/repo/thread-access.ts";
import { comments, reviews, sends, threads } from "../../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { commentTargetReserve, envelopeBytes, jsonBytes } from "./payload.ts";

export function createSend(ownerId: string, db: Db, reviewId: string, request: SendRequest, now: number) {
  return db.transaction(async (q) => {
    const review = await requireReview(ownerId, q, reviewId);
    // A retired review is done; the reviewer reopens it before sending again.
    if (review.state === "settled") throw new ApiError("invalid_state");
    const newest = await newestRevision(ownerId, q, reviewId);
    if (request.revision !== newest.seq) throw new ApiError("stale_revision");
    const unsent = and(
      eq(comments.ownerId, ownerId),
      eq(comments.reviewId, reviewId),
      eq(comments.author, "user"),
      isNull(comments.sendId),
    );
    const total = (await q.select({ count: count() }).from(comments).where(unsent).get())?.count ?? 0;
    if (request.kind === "approve" && total) throw new ApiError("unsent_comments");
    if (request.kind === "go" && !total && !request.instruction?.trim()) throw new ApiError("empty_send");
    if (total > LIMITS.commentsPerHandoff) throw new ApiError("too_large");
    if (request.kind === "go") {
      let bytes = envelopeBytes + (request.instruction?.trim() ? jsonBytes(request.instruction) + 1 : 0);
      const pending = await q
        .select({ threadId: threads.id, body: comments.body, target: threads.target })
        .from(comments)
        .innerJoin(
          threads,
          and(eq(threads.ownerId, ownerId), eq(threads.reviewId, reviewId), eq(threads.id, comments.threadId)),
        )
        .where(unsent);
      const targetReserves = new Map<string, number>();
      for (const comment of pending) {
        let targetBytes = targetReserves.get(comment.threadId);
        if (targetBytes === undefined) {
          targetBytes = commentTargetReserve(comment.target);
          targetReserves.set(comment.threadId, targetBytes);
        }
        bytes += targetBytes + jsonBytes(comment.body) - 2;
        if (bytes > LIMITS.handoffBytes) throw new ApiError("too_large");
      }
    }
    const sendId = randomUUID();
    await q.insert(sends).values({
      id: sendId,
      ownerId,
      reviewId,
      revisionId: newest.id,
      kind: request.kind,
      mode: request.kind === "go" ? (request.mode ?? DEFAULT_MODE) : null,
      instruction: request.kind === "go" && request.instruction?.trim() ? request.instruction : null,
      createdAt: now,
    });
    if (request.kind === "go") {
      await q.update(comments).set({ sendId }).where(unsent);
      await q
        .update(threads)
        .set({ state: "sent", updatedAt: now })
        .where(
          and(
            eq(threads.ownerId, ownerId),
            eq(threads.reviewId, reviewId),
            inArray(
              threads.id,
              q
                .select({ id: comments.threadId })
                .from(comments)
                .where(
                  and(eq(comments.ownerId, ownerId), eq(comments.reviewId, reviewId), eq(comments.sendId, sendId)),
                ),
            ),
          ),
        );
    } else {
      await q
        .update(reviews)
        .set({ state: "approved", approvedRevision: newest.id, approvedAt: now, updatedAt: now })
        .where(and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewId)));
    }
    return { reviewId, revision: newest.seq, sendId };
  });
}
