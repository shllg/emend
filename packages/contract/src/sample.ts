import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { RevisionView } from "./views.ts";

/** This non-UUID can never identify a stored review. */
export const SAMPLE_REVIEW_ID = "theme-sample";

export const SampleView = z.object({
  revision: RevisionView,
  fileTexts: z.record(
    z.uuid(),
    z.object({
      old: z.string().max(LIMITS.diffSideBytes),
      new: z.string().max(LIMITS.diffSideBytes),
    }),
  ),
});
export type SampleView = z.infer<typeof SampleView>;
