/**
 * A snooze is in effect while snoozed_at is set and its end time is absent or still ahead.
 * Pure on purpose: the agent-side take reads it, and must not import reviewer table code.
 */
export function snoozeInEffect(
  review: { snoozedAt: number | null; snoozedUntil: number | null },
  now: number,
): boolean {
  return review.snoozedAt !== null && (review.snoozedUntil === null || review.snoozedUntil > now);
}
