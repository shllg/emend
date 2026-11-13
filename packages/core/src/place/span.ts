import { type DocSpanTarget, LIMITS, type Placement, type WriteupSpanTarget } from "@emend/contract";
import type { Block } from "../render/blocks.ts";
import { normalizeText } from "../render/normalize.ts";
import { firstTwoMatches } from "./search.ts";

type Span = Omit<WriteupSpanTarget, "kind">;
type Quote = Pick<Span, "quote" | "prefix" | "suffix">;
type Range = { start: number; end: number };

/** Offsets and the context limit are UTF-16 code units in the normalized block text. */
export function makeSpan(block: Block, start: number, end: number): Span {
  const text = normalizeText(block.text);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length ||
    end - start > LIMITS.quoteChars
  ) {
    throw new RangeError("Span offsets must select a nonempty quote within the normalized block and quote limit");
  }
  return {
    blockId: block.id,
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - LIMITS.prefixSuffixChars), start),
    suffix: text.slice(end, end + LIMITS.prefixSuffixChars),
  };
}

/** Two candidates suffice to prove ambiguity; include overlapping occurrences. */
export function spanCandidates(text: string, target: Quote, withContext = true): Range[] {
  const pattern = withContext ? target.prefix + target.quote + target.suffix : target.quote;
  const offset = withContext ? target.prefix.length : 0;
  return firstTwoMatches(text, pattern).map((start) => ({
    start: start + offset,
    end: start + offset + target.quote.length,
  }));
}

/** Shared search for block spans and topic parts, with identical normalization and fallback rules. */
export function placeTextSpan<B extends Pick<Block, "id" | "text"> & { kind?: Block["kind"] }>(
  blocks: readonly B[],
  target: Span,
): { status: "placed"; block: B; range: Range } | Extract<Placement, { status: "unplaced" }> {
  const placed = (block: B, range: Range) => ({ status: "placed" as const, block, range });
  const same = blocks.find((block) => block.id === target.blockId);
  if (same) {
    const text = normalizeText(same.text);
    if (same.kind === "diagram") return placed(same, { start: 0, end: text.length });
    const occurrences = spanCandidates(text, target, false);
    const candidates = occurrences.length === 1 ? occurrences : spanCandidates(text, target);
    if (candidates.length === 1 && candidates[0]) return placed(same, candidates[0]);
  }

  let result: ReturnType<typeof placed> | undefined;
  for (const block of blocks) {
    for (const range of spanCandidates(normalizeText(block.text), target)) {
      if (result) return { status: "unplaced", reason: "ambiguous" };
      result = placed(block, range);
    }
  }
  return result ?? { status: "unplaced", reason: "block-gone" };
}

export function placeSpan(blocks: Block[], target: WriteupSpanTarget | DocSpanTarget): Placement {
  const result = placeTextSpan(blocks, target);
  if (result.status === "unplaced") return result;
  const { block, range } = result;
  return {
    status: "placed",
    location:
      target.kind === "doc-span"
        ? { kind: target.kind, path: target.path, blockId: block.id, ...range }
        : { kind: target.kind, blockId: block.id, ...range },
  };
}
