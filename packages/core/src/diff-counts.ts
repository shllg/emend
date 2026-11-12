import { diffLines } from "diff";

export const DIFF_COUNT_TIMEOUT_MS = 2000;

/** Keep jsdiff's default line options in sync with the app's per-file patch counts. */
export function diffLineCounts(
  old: string,
  next: string,
  options?: { timeout?: number },
): { additions: number; deletions: number } | null {
  const parts =
    options?.timeout === undefined ? diffLines(old, next) : diffLines(old, next, { timeout: options.timeout });
  if (!parts) return null;
  let additions = 0;
  let deletions = 0;
  for (const part of parts) {
    if (part.added) additions += part.count;
    if (part.removed) deletions += part.count;
  }
  return { additions, deletions };
}
