import { z } from "zod";
import { LIMITS } from "./limits.ts";

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
/** Capabilities feature that announces the review bin: bin, restore, list and empty. */
export const REVIEW_BIN_FEATURE = "review-bin";

/** One binned review: enough to recognise it and restore or delete it. */
export const BinItem = z.object({
  id: z.uuid(),
  title: z.string(),
  /** The name of the origin instance. */
  machine: z.string(),
  binnedAt: z.iso.datetime(),
});
export type BinItem = z.infer<typeof BinItem>;

export const BinView = z.object({
  items: z.array(BinItem).max(LIMITS.binItems),
  total: z.int().nonnegative(),
});
export type BinView = z.infer<typeof BinView>;
