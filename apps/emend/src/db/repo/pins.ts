import { LIMITS } from "@emend/contract";
import { and, count, eq, isNull } from "drizzle-orm";
import { ApiError } from "../../server/http/errors.ts";
import type { Db } from "../client.ts";
import { reviewPins, reviews } from "../schema.ts";
import { requireReview } from "./thread-access.ts";

export function setReviewPin(ownerId: string, db: Db, reviewId: string, pinned: boolean, now: number) {
  return db.transaction(async (q) => {
    await requireReview(ownerId, q, reviewId);
    const ownedPin = and(eq(reviewPins.ownerId, ownerId), eq(reviewPins.reviewId, reviewId));
    if (!pinned) {
      await q.delete(reviewPins).where(ownedPin);
    } else {
      const existing = await q.select({ reviewId: reviewPins.reviewId }).from(reviewPins).where(ownedPin).get();
      if (!existing) {
        const total = await q
          .select({ count: count() })
          .from(reviewPins)
          .innerJoin(reviews, and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewPins.reviewId)))
          .where(and(eq(reviewPins.ownerId, ownerId), isNull(reviews.movedToUrl)))
          .get();
        if ((total?.count ?? 0) >= LIMITS.pins) throw new ApiError("invalid_state", "pin_limit");
      }
      await q.insert(reviewPins).values({ ownerId, reviewId, createdAt: now }).onConflictDoNothing();
    }
  });
}
