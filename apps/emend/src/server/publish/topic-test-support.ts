import type { Placement } from "@emend/contract";

export const topicQuote = {
  kind: "topic",
  slug: "synthetic",
  part: "title",
  quote: "cache",
  prefix: "remove the ",
  suffix: " entirely.",
} as const;

const original = "remove the cache entirely.";
const changed = "Do not remove the cache entirely.";
const placed = (part: "title" | "summary"): Placement => ({
  status: "placed",
  location: { kind: "topic", slug: topicQuote.slug, part, start: 11, end: 16 },
});
const ambiguous: Placement = { status: "unplaced", reason: "ambiguous" };

/** Duplicate context, recovery, a move, and another unplaced revision after the move. */
export const topicQuoteHistory: { title: string; summary: string; placement: Placement }[] = [
  { title: original, summary: `Previous proposal: ${original}`, placement: placed("title") },
  { title: changed, summary: `Previous proposal: ${original}`, placement: ambiguous },
  { title: original, summary: `Previous proposal: ${original}`, placement: placed("title") },
  { title: "Increase cache capacity.", summary: original, placement: placed("summary") },
  { title: original, summary: original, placement: placed("summary") },
  { title: original, summary: changed, placement: ambiguous },
  { title: original, summary: original, placement: placed("summary") },
  { title: "Increase cache capacity.", summary: "Details", placement: { status: "unplaced", reason: "block-gone" } },
];
