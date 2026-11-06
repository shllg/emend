import { type FileView, LinesTarget } from "@emend/contract";
import { splitLines } from "../../../../../packages/core/src/place/linemap.ts";
import { type LinesError, lineContext } from "../../lib/line-context.ts";

export type { LinesError } from "../../lib/line-context.ts";
export function linesTarget(
  file: FileView,
  side: "old" | "new",
  start: number,
  end: number,
  text: string,
): LinesTarget | { error: LinesError } {
  const context = lineContext(splitLines(text), start, end);
  if ("error" in context) return context;
  return LinesTarget.parse({
    kind: "lines",
    path: side === "old" ? (file.oldPath ?? file.path) : file.path,
    side,
    ...context,
  });
}
