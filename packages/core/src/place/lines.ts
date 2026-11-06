import type { LinesTarget, Placement, SourceLinesTarget } from "@emend/contract";
import { lineMap, splitLines } from "./linemap.ts";
import { firstTwoMatches } from "./search.ts";

/** A present side always carries its text; an absent side has neither text nor hash. */
export type FileSides = ({ oldText: string; oldHash?: string } | { oldText?: never; oldHash?: never }) &
  ({ newText: string; newHash?: string } | { newText?: never; newHash?: never });
type LastLines = { start: number; end: number; sides: FileSides };

function matches(lines: string[], start: number, quote: string[]): boolean {
  return (
    start >= 0 && start + quote.length <= lines.length && quote.every((line, index) => lines[start + index] === line)
  );
}

export function placeLines(
  target: LinesTarget | SourceLinesTarget,
  last: LastLines,
  next: FileSides | null,
): Placement {
  if (next === null) return { status: "unplaced", reason: "file-gone" };
  const side = target.kind === "lines" ? target.side : "new";
  const hashKey = side === "old" ? "oldHash" : "newHash";
  const textKey = side === "old" ? "oldText" : "newText";
  const previousText = last.sides[textKey];
  const nextText = next[textKey];
  if (nextText === undefined) return { status: "unplaced", reason: "file-gone" };
  const lines = splitLines(nextText);
  const placed = (start: number): Placement => {
    const range = { path: target.path, start, end: start + target.lines.length - 1 };
    return {
      status: "placed",
      location:
        target.kind === "lines" ? { kind: "lines", side: target.side, ...range } : { kind: "source-lines", ...range },
    };
  };
  const validRange = last.start > 0 && last.end - last.start + 1 === target.lines.length;

  // Tier 0: even equal hashes must read the quote back from the new side.
  if (
    validRange &&
    last.sides[hashKey] !== undefined &&
    last.sides[hashKey] === next[hashKey] &&
    matches(lines, last.start - 1, target.lines)
  )
    return placed(last.start);

  // Tier 1: every quoted line must survive, in order, without an insertion inside the range.
  if (validRange && previousText !== undefined) {
    const map = lineMap(previousText, nextText);
    const start = map(last.start);
    if (
      start !== null &&
      target.lines.every((_, index) => map(last.start + index) === start + index) &&
      matches(lines, start - 1, target.lines)
    )
      return placed(start);
  }

  // Tier 2: exact line-by-line context, including whatever was available at the file edges.
  const sequence = [...target.before, ...target.lines, ...target.after];
  const found = firstTwoMatches(lines, sequence);
  if (found.length > 1) return { status: "unplaced", reason: "ambiguous" };
  const start = found[0];
  return start === undefined ? { status: "unplaced", reason: "lines-gone" } : placed(start + target.before.length + 1);
}
