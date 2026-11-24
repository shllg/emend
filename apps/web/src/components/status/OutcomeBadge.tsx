import type { Outcome } from "@recense/contract";
import { Ban, Check, MessageSquare, Pause } from "lucide-react";
import { Icon } from "../ui/Icon.tsx";

const outcomes = {
  fixed: { icon: Check, label: "Fixed", colors: "bg-outcome-fixed-bg text-outcome-fixed-fg" },
  explained: { icon: MessageSquare, label: "Explained", colors: "bg-outcome-explained-bg text-outcome-explained-fg" },
  held: { icon: Pause, label: "Held", colors: "bg-outcome-held-bg text-outcome-held-fg" },
  declined: { icon: Ban, label: "Declined", colors: "bg-outcome-declined-bg text-outcome-declined-fg" },
};
export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const { icon, label, colors } = outcomes[outcome];
  return (
    <span
      className={`inline-flex h-[1.25rem] shrink-0 items-center gap-1 whitespace-nowrap rounded-sm pr-[7px] pl-[5px] text-11 font-semibold leading-none ${colors}`}
    >
      <Icon icon={icon} size={12} strokeWidth={2.25} />
      {label}
    </span>
  );
}
