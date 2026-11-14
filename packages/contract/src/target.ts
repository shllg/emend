import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { FilePath, TopicSlug } from "./review.ts";

export const BlockId = z
  .string()
  .max(LIMITS.pathChars)
  .regex(
    /^(?:overview|tldr|review|checked|notChecked|outOfScope|whereToLook|context|decisions|glossary|t-[a-z0-9][a-z0-9-]{0,63}-(?:why|example|body)|doc-[0-9a-f]{8})-[0-9a-f]{8}(?:-(?:[2-9]|[1-9][0-9]+))?$/,
  );
export type BlockId = z.infer<typeof BlockId>;

const span = {
  quote: z.string().min(1).max(LIMITS.quoteChars),
  prefix: z.string().max(LIMITS.prefixSuffixChars),
  suffix: z.string().max(LIMITS.prefixSuffixChars),
};

export const WriteupSpanTarget = z.object({ kind: z.literal("writeup-span"), blockId: BlockId, ...span });
export type WriteupSpanTarget = z.infer<typeof WriteupSpanTarget>;

export const DocSpanTarget = z.object({ kind: z.literal("doc-span"), path: FilePath, blockId: BlockId, ...span });
export type DocSpanTarget = z.infer<typeof DocSpanTarget>;

export const HtmlSpanTarget = z.object({ kind: z.literal("html-span"), path: FilePath, ...span });
export type HtmlSpanTarget = z.infer<typeof HtmlSpanTarget>;

const lineFields = {
  path: FilePath,
  start: z.int().positive(),
  end: z.int().positive(),
  lines: z.array(z.string().max(LIMITS.targetTextChars)).max(LIMITS.targetLines),
  before: z.array(z.string().max(LIMITS.contextLineChars)).max(LIMITS.diffContextLines),
  after: z.array(z.string().max(LIMITS.contextLineChars)).max(LIMITS.diffContextLines),
};
function refineLines(target: z.infer<z.ZodObject<typeof lineFields>>, ctx: z.RefinementCtx) {
  if (target.end < target.start) {
    ctx.addIssue({ code: "custom", path: ["end"], message: "end must be at least start" });
  }
  if (target.lines.length !== target.end - target.start + 1) {
    ctx.addIssue({ code: "custom", path: ["lines"], message: "lines must match the inclusive range length" });
  }
  const textChars = [target.lines, target.before, target.after].reduce(
    (total, lines) => total + lines.reduce((chars, line) => chars + line.length, 0),
    0,
  );
  if (textChars > LIMITS.targetTextChars) {
    ctx.addIssue({ code: "custom", path: ["lines"], message: "target text exceeds the combined character limit" });
  }
}
export const LinesTarget = z
  .object({ kind: z.literal("lines"), side: z.enum(["old", "new"]), ...lineFields })
  .superRefine(refineLines);
export type LinesTarget = z.infer<typeof LinesTarget>;
export const SourceLinesTarget = z.object({ kind: z.literal("source-lines"), ...lineFields }).superRefine(refineLines);
export type SourceLinesTarget = z.infer<typeof SourceLinesTarget>;

export const FileTarget = z.object({ kind: z.literal("file"), path: FilePath });
export type FileTarget = z.infer<typeof FileTarget>;

export const TopicPart = z.enum(["title", "summary"]);
export type TopicPart = z.infer<typeof TopicPart>;

export const TopicTarget = z
  .object({
    kind: z.literal("topic"),
    slug: TopicSlug,
    part: TopicPart.optional(),
    quote: span.quote.optional(),
    prefix: span.prefix.optional(),
    suffix: span.suffix.optional(),
  })
  .superRefine((target, ctx) => {
    const fields = [target.part, target.quote, target.prefix, target.suffix];
    if (fields.some((value) => value !== undefined) && fields.some((value) => value === undefined)) {
      ctx.addIssue({ code: "custom", message: "part, quote, prefix and suffix must all be present or absent" });
    }
  });
export type TopicTarget = z.infer<typeof TopicTarget>;

export const ReviewTarget = z.object({ kind: z.literal("review") });
export type ReviewTarget = z.infer<typeof ReviewTarget>;

export const Target = z.discriminatedUnion("kind", [
  WriteupSpanTarget,
  DocSpanTarget,
  HtmlSpanTarget,
  LinesTarget,
  SourceLinesTarget,
  FileTarget,
  TopicTarget,
  ReviewTarget,
]);
export type Target = z.infer<typeof Target>;
