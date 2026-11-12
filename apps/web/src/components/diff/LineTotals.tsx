import type { FileView } from "@emend/contract";
import { plural } from "../../lib/count.ts";

export function LineTotals({ counts }: { counts: FileView["counts"] | null }) {
  if (!counts) return null;
  const additions = counts.additions.toLocaleString("en-US");
  const deletions = counts.deletions.toLocaleString("en-US");
  return (
    <span className="inline-flex shrink-0 gap-1.5 text-12 font-mono tabular-nums font-stretch-mono">
      <span className="sr-only">
        {additions} {plural(counts.additions, "line")} added, {deletions} {plural(counts.deletions, "line")} removed
      </span>
      <span aria-hidden="true" className="text-diff-add-fg">
        +{additions}
      </span>
      <span aria-hidden="true" className="text-diff-del-fg">
        −{deletions}
      </span>
    </span>
  );
}
