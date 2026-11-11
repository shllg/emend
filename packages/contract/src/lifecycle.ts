import { z } from "zod";

/** Exactly one end condition. A new revision always ends a snooze early. */
export const SnoozeRequest = z.union([
  z.strictObject({ until: z.iso.datetime() }),
  z.strictObject({ untilRevision: z.literal(true) }),
]);
export type SnoozeRequest = z.infer<typeof SnoozeRequest>;

export const RetireRequest = z.strictObject({ discardUnsent: z.boolean().optional() });
export type RetireRequest = z.infer<typeof RetireRequest>;

/** A snooze may end at most this many days out. */
export const MAX_SNOOZE_DAYS = 366;
/** Default hours an approved review stays in Active after approval. */
export const APPROVED_ACTIVE_HOURS = 12;
/** Capabilities feature that announces snooze, retire, reopen and delete. */
export const REVIEW_LIFECYCLE_FEATURE = "review-lifecycle";
