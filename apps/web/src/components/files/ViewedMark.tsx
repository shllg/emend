import type { FileView } from "@emend/contract";
import { Check } from "lucide-react";
import { Icon } from "../ui/Icon.tsx";

export function ViewedMark({
  state,
  viewedOn,
  label,
  showLabel = false,
  disabled,
  onToggle,
}: {
  state?: FileView["viewed"];
  viewedOn?: number;
  label: string;
  showLabel?: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const viewed = state === "viewed",
    stale = state === "stale";
  const staleLabel = `Viewed in revision ${viewedOn ?? "unknown"}; this revision differs. Mark ${label} as viewed`;
  return (
    <button
      type="button"
      className="em-viewed-mark"
      aria-pressed={viewed}
      aria-label={stale ? staleLabel : `${viewed ? "Unmark" : "Mark"} ${label} as viewed`}
      title={stale ? staleLabel : viewed ? "Viewed. Click to unmark" : "Mark as viewed"}
      data-stale={stale || undefined}
      disabled={disabled}
      onClick={onToggle}
    >
      {stale ? <span className="em-viewed-mark__stale">changed</span> : null}
      <span className="em-viewed-mark__box" aria-hidden="true">
        {viewed ? <Icon icon={Check} size={11} /> : null}
      </span>
      {showLabel ? <span className="em-viewed-mark__label">Viewed</span> : null}
    </button>
  );
}
