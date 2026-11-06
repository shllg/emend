import { SourceLinesTarget } from "@emend/contract";
import { type LinesError, lineContext } from "../../lib/line-context.ts";

/** Token rows already use core splitLines coordinates; never split their text a second time. */
export function sourceLinesTarget(
  path: string,
  lines: string[],
  start: number,
  end: number,
): SourceLinesTarget | { error: LinesError } {
  const context = lineContext(lines, start, end);
  if ("error" in context) return context;
  return SourceLinesTarget.parse({ kind: "source-lines", path, ...context });
}
