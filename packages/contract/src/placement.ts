import { z } from "zod";
import { FilePath, TopicSlug } from "./review.ts";
import { BlockId, FileTarget, ReviewTarget, TopicPart } from "./target.ts";

export const UnplacedReason = z.enum([
  "block-gone",
  "ambiguous",
  "topic-gone",
  "file-gone",
  "lines-gone",
  "not-placed",
]);
export type UnplacedReason = z.infer<typeof UnplacedReason>;

const spanRange = z
  .object({ start: z.int().nonnegative(), end: z.int().positive() })
  .refine((range) => range.end > range.start, { path: ["end"], message: "span end must be after start" });

export const PlacementLocation = z.discriminatedUnion("kind", [
  spanRange.safeExtend({ kind: z.literal("writeup-span"), blockId: BlockId }),
  spanRange.safeExtend({ kind: z.literal("doc-span"), path: FilePath, blockId: BlockId }),
  spanRange.safeExtend({ kind: z.literal("html-span"), path: FilePath }),
  z
    .object({
      kind: z.literal("lines"),
      path: FilePath,
      side: z.enum(["old", "new"]),
      start: z.int().positive(),
      end: z.int().positive(),
    })
    .refine((range) => range.end >= range.start, { path: ["end"], message: "line end must be at least start" }),
  z
    .object({ kind: z.literal("source-lines"), path: FilePath, start: z.int().positive(), end: z.int().positive() })
    .refine((range) => range.end >= range.start, { path: ["end"], message: "line end must be at least start" }),
  FileTarget,
  z
    .object({
      kind: z.literal("topic"),
      slug: TopicSlug,
      part: TopicPart.optional(),
      start: z.int().nonnegative().optional(),
      end: z.int().positive().optional(),
    })
    .superRefine((location, ctx) => {
      const fields = [location.part, location.start, location.end];
      if (fields.some((value) => value !== undefined) && fields.some((value) => value === undefined)) {
        ctx.addIssue({ code: "custom", message: "part, start and end must all be present or absent" });
      }
      if (location.start !== undefined && location.end !== undefined && location.end <= location.start) {
        ctx.addIssue({ code: "custom", path: ["end"], message: "span end must be after start" });
      }
    }),
  ReviewTarget,
]);
export type PlacementLocation = z.infer<typeof PlacementLocation>;

export const Placement = z.discriminatedUnion("status", [
  z.object({ status: z.literal("placed"), location: PlacementLocation }),
  z.object({ status: z.literal("unplaced"), reason: UnplacedReason }),
]);
export type Placement = z.infer<typeof Placement>;
