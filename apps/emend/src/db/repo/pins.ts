import { LIMITS, placePin, type ReviewPinPlaceRequest } from "@emend/contract";
import { and, asc, count, eq, isNull, max } from "drizzle-orm";
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
        const last = await q
          .select({ position: max(reviewPins.position) })
          .from(reviewPins)
          .where(eq(reviewPins.ownerId, ownerId))
          .get();
        await q.insert(reviewPins).values({ ownerId, reviewId, createdAt: now, position: (last?.position ?? 0) + 1 });
      }
    }
  });
}

export function placeReviewPin(ownerId: string, db: Db, reviewId: string, place: ReviewPinPlaceRequest) {
  return db.transaction(async (q) => {
    await requireReview(ownerId, q, reviewId);
    const rows = await q
      .select({
        reviewId: reviewPins.reviewId,
        position: reviewPins.position,
        binnedAt: reviews.binnedAt,
        movedToUrl: reviews.movedToUrl,
      })
      .from(reviewPins)
      .innerJoin(reviews, and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewPins.reviewId)))
      .where(eq(reviewPins.ownerId, ownerId))
      .orderBy(asc(reviewPins.position), asc(reviewPins.createdAt), asc(reviewPins.reviewId))
      .all();
    const anchorId = "before" in place ? place.before : place.after;
    const anchor = rows.find((row) => row.reviewId === anchorId);
    if (!anchor || anchor.binnedAt !== null || anchor.movedToUrl !== null)
      throw new ApiError("invalid_state", "pin_changed");
    const order = placePin(
      rows.map((row) => row.reviewId),
      reviewId,
      place,
    );
    if (!order) throw new ApiError("invalid_state", "pin_changed");
    if (anchorId === reviewId) return;
    const positions = new Map(rows.map((row) => [row.reviewId, row.position]));
    for (const [index, id] of order.entries()) {
      const position = index + 1;
      if (positions.get(id) === position) continue;
      await q
        .update(reviewPins)
        .set({ position })
        .where(and(eq(reviewPins.ownerId, ownerId), eq(reviewPins.reviewId, id)));
    }
  });
}
