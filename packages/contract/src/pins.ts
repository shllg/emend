import { z } from "zod";

export const REVIEW_PINS_FEATURE = "review-pins";
export const ReviewPinRequest = z.strictObject({ pinned: z.boolean() });
export type ReviewPinRequest = z.infer<typeof ReviewPinRequest>;
