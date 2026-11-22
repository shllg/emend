import { z } from "zod";

export const REVIEW_PINS_FEATURE = "review-pins";
export const REVIEW_PIN_ORDER_FEATURE = "review-pin-order";
export const ReviewPinRequest = z.strictObject({ pinned: z.boolean() });
export type ReviewPinRequest = z.infer<typeof ReviewPinRequest>;

export const ReviewPinPlaceRequest = z.union([
  z.strictObject({ before: z.uuid() }),
  z.strictObject({ after: z.uuid() }),
]);
export type ReviewPinPlaceRequest = z.infer<typeof ReviewPinPlaceRequest>;

/** Move a pin relative to another pin without changing the input order. */
export function placePin(order: readonly string[], reviewId: string, place: ReviewPinPlaceRequest): string[] | null {
  const anchor = "before" in place ? place.before : place.after;
  if (!order.includes(reviewId) || !order.includes(anchor)) return null;
  if (anchor === reviewId) return [...order];
  const next = order.filter((id) => id !== reviewId);
  next.splice(next.indexOf(anchor) + ("after" in place ? 1 : 0), 0, reviewId);
  return next;
}
