import { z } from "zod";
import { FilePath } from "./review.ts";
import { BlockId, FileTarget, ReviewTarget, TopicTarget } from "./target.ts";

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
  TopicTarget,
  ReviewTarget,
]);
export type PlacementLocation = z.infer<typeof PlacementLocation>;

export const Placement = z.discriminatedUnion("status", [
  z.object({ status: z.literal("placed"), location: PlacementLocation }),
  z.object({ status: z.literal("unplaced"), reason: UnplacedReason }),
]);
export type Placement = z.infer<typeof Placement>;
