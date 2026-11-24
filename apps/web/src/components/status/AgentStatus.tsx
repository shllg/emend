import type { InboxItem } from "@recense/contract";
import { Check } from "lucide-react";
import { relativeTime } from "../../lib/time.ts";
import { Icon } from "../ui/Icon.tsx";
import { cn } from "../ui/utils.ts";

export type AgentStatusKey = "approved" | "waiting" | "pending" | "pickedUp";

/** The one state a review shows, by priority: approved, waiting, not picked up, picked up, none. */
export function agentStatusOf(
  review: Pick<InboxItem, "state" | "agentWaiting" | "pendingSend" | "pickedUpAt">,
): AgentStatusKey | null {
  if (review.state === "approved") return "approved";
  if (review.agentWaiting) return "waiting";
  if (review.pendingSend) return "pending";
  if (review.pickedUpAt) return "pickedUp";
  return null;
}

export const agentStatusLabels: Record<AgentStatusKey, string> = {
  approved: "Approved",
  waiting: "Agent waiting",
  pending: "Not picked up yet",
  pickedUp: "Picked up",
};
export const agentDotClasses = {
  waiting: "bg-agent-waiting text-agent-waiting animate-[em-pulse_var(--dur-pulse)_var(--ease-out)_infinite]",
  pending: "border-[1.5px] border-agent-none",
  pickedUp: "bg-agent-none",
};

/** The label as plain text, with the relative time after "Picked up". */
export function agentStatusText(status: AgentStatusKey, pickedUpAt: string | null, now: number): string {
  const label = agentStatusLabels[status];
  const when = status === "pickedUp" && pickedUpAt ? relativeTime(pickedUpAt, now) : "";
  return when ? `${label} ${when}` : label;
}

export function AgentStatus({
  status,
  pickedUpAt = null,
  now = Date.now(),
  pill = false,
  className,
}: {
  status: AgentStatusKey | null;
  pickedUpAt?: string | null;
  now?: number;
  pill?: boolean;
  className?: string;
}) {
  if (!status) return null;
  const when = status === "pickedUp" && pickedUpAt ? relativeTime(pickedUpAt, now) : "";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-12 font-medium leading-[1.2]",
        status === "approved" ? "text-success-fg" : status === "waiting" ? "text-fg-1" : "text-fg-2",
        pill && "h-6 rounded-full border border-line-1 bg-surface pr-[9px] pl-2",
        className,
      )}
    >
      {status === "approved" ? (
        <Icon icon={Check} size={13} strokeWidth={2.25} />
      ) : (
        <span aria-hidden="true" className={cn("size-[0.5rem] shrink-0 rounded-full", agentDotClasses[status])} />
      )}
      <span>{agentStatusLabels[status]}</span>
      {when && <time dateTime={pickedUpAt ?? undefined}>{when}</time>}
    </span>
  );
}
