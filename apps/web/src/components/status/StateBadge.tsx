import type { ReviewState } from "@emend/contract";
import { BellOff, CheckCheck, CircleCheck, CircleDot } from "lucide-react";
import { wakeHasPassed, wakeTime } from "../../lib/time.ts";
import { Icon } from "../ui/Icon.tsx";
import { cn } from "../ui/utils.ts";

const baseClasses = "inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-11 leading-none";
const pillClasses = "h-5 rounded-full pr-[7px] pl-[5px] font-semibold tracking-[.01em]";

const states = {
  open: { icon: CircleDot, label: "Open", pill: "bg-state-open-bg text-state-open-fg", inline: "text-state-open-fg" },
  approved: {
    icon: CircleCheck,
    label: "Approved",
    pill: "bg-state-approved-bg text-state-approved-fg",
    inline: "text-success-fg",
  },
  settled: {
    icon: CheckCheck,
    label: "Retired",
    pill: "bg-state-settled-bg text-state-settled-fg inset-ring-1 inset-ring-line-1",
    inline: "text-fg-3",
  },
};

export function StateBadge({
  state,
  revision,
  variant = "pill",
}: {
  state: ReviewState;
  revision?: number;
  variant?: "pill" | "inline";
}) {
  const entry = states[state];
  return (
    <span className={cn(baseClasses, variant === "pill" ? [pillClasses, entry.pill] : ["font-medium", entry.inline])}>
      <Icon icon={entry.icon} size={variant === "pill" ? 12 : 11} strokeWidth={2} />
      {entry.label}
      {state === "approved" && revision != null ? ` · rev ${revision}` : ""}
    </span>
  );
}

/** Shows when a snoozed review will wake, or that it is waking up. */
export function SnoozeBadge({ until, now }: { until: string | null; now: number }) {
  return (
    <span className={cn(baseClasses, pillClasses, "bg-state-snoozed-bg text-state-snoozed-fg")}>
      <Icon icon={BellOff} size={12} strokeWidth={2} />
      {!until
        ? "Snoozed until it changes"
        : wakeHasPassed(until, now)
          ? "Waking up"
          : `Snoozed until ${wakeTime(until, now)}`}
    </span>
  );
}
