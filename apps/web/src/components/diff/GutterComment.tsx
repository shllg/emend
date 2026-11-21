import type { GetHoveredLineResult, SelectedLineRange } from "@pierre/diffs";
import { useState } from "react";
import { useReadOnlyReview } from "../../lib/read-only-review.ts";
import { Tooltip } from "../ui/Tooltip.tsx";

export function GutterComment({
  getHoveredLine,
  onSelect,
}: {
  getHoveredLine: () => GetHoveredLineResult<"diff"> | undefined;
  onSelect: (range: SelectedLineRange) => void;
}) {
  const readOnly = useReadOnlyReview();
  const [line, setLine] = useState<number>();
  if (readOnly) return null;
  return (
    <Tooltip content={`Comment on line ${line ?? ""} · drag to select lines`}>
      <button
        type="button"
        tabIndex={-1}
        className="em-diff-comment"
        aria-label={line === undefined ? "Comment on line" : `Comment on line ${line}`}
        onPointerEnter={() => setLine(getHoveredLine()?.lineNumber)}
        onPointerDownCapture={(event) => {
          // The slot lives in the number cell. Do not also start a number drag.
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          const hovered = getHoveredLine();
          if (hovered) onSelect({ start: hovered.lineNumber, end: hovered.lineNumber, side: hovered.side });
        }}
      >
        +
      </button>
    </Tooltip>
  );
}
