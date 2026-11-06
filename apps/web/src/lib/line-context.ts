import { LIMITS, type SourceLinesTarget } from "@emend/contract";

export type LinesError = "too-many-lines" | "too-long" | "invalid-range";

/** Inclusive server line coordinates; nearest context on both sides shares one text budget. */
export function lineContext(
  all: string[],
  start: number,
  end: number,
): Omit<SourceLinesTarget, "kind" | "path"> | { error: LinesError } {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
    return { error: "invalid-range" };
  if (end - start + 1 > LIMITS.targetLines) return { error: "too-many-lines" };
  if (end > all.length) return { error: "invalid-range" };
  const lines = all.slice(start - 1, end);
  let chars = lines.reduce((sum, line) => sum + line.length, 0);
  if (chars > LIMITS.targetTextChars) return { error: "too-long" };
  const before: string[] = [],
    after: string[] = [];
  let beforeStopped = false,
    afterStopped = false;
  // Alternate outward so the nearest context on both sides gets the budget first.
  for (let distance = 1; distance <= LIMITS.diffContextLines; distance++) {
    const left = all[start - 1 - distance],
      right = all[end - 1 + distance];
    if (!beforeStopped) {
      if (left === undefined || left.length > LIMITS.contextLineChars || chars + left.length > LIMITS.targetTextChars)
        beforeStopped = true;
      else {
        before.unshift(left);
        chars += left.length;
      }
    }
    if (!afterStopped) {
      if (
        right === undefined ||
        right.length > LIMITS.contextLineChars ||
        chars + right.length > LIMITS.targetTextChars
      )
        afterStopped = true;
      else {
        after.push(right);
        chars += right.length;
      }
    }
  }
  return { start, end, lines, before, after };
}

export function linesErrorMessage(error: LinesError) {
  return error === "too-many-lines"
    ? "Select at most 1000 lines."
    : error === "too-long"
      ? "This selection is too long. Select fewer lines."
      : "Select valid lines.";
}
