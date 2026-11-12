import { plural } from "../../lib/count.ts";
import type { LineTotal } from "../../lib/diff-totals.ts";

export function LineTotals({ counts }: { counts: LineTotal | null }) {
  if (!counts) return null;
  const additions = counts.additions.toLocaleString("en-US");
  const deletions = counts.deletions.toLocaleString("en-US");
  const missing = counts.uncounted > 0 ? `${counts.uncounted} ${plural(counts.uncounted, "file")} not counted` : null;
  return (
    <span
      className="inline-flex shrink-0 gap-1.5 text-12 font-mono tabular-nums font-stretch-mono"
      title={missing ? `Partial: ${missing}` : undefined}
    >
      <span className="sr-only">
        {missing && "At least "}
        {additions} {plural(counts.additions, "line")} added, {deletions} {plural(counts.deletions, "line")} removed
        {missing && `; ${missing}`}
      </span>
      {missing && (
        <span aria-hidden="true" className="text-fg-3">
          ≥
        </span>
      )}
      <span aria-hidden="true" className="text-diff-add-fg">
        +{additions}
      </span>
      <span aria-hidden="true" className="text-diff-del-fg">
        −{deletions}
      </span>
    </span>
  );
}
