import type { ThreadState, ThreadView } from "@emend/contract";
import { plural } from "../../lib/count.ts";

export type ShownThreadState = ThreadState | "unsent";
export function shownThreadState(thread: ThreadView): ShownThreadState {
  return thread.comments.some((comment) => comment.author === "user" && comment.sent === false)
    ? "unsent"
    : thread.state;
}

export function threadListGroup(thread: ThreadView): ShownThreadState | "unplaced" {
  return thread.placement.status === "unplaced" ? "unplaced" : shownThreadState(thread);
}

export interface ThreadCounts {
  unsent: number;
  open: number;
  all: number;
}

export function threadCounts(threads: ThreadView[]): ThreadCounts {
  let unsent = 0;
  let open = 0;
  for (const thread of threads) {
    const isUnsent = shownThreadState(thread) === "unsent";
    if (threadListGroup(thread) === "unsent") unsent += 1;
    if (thread.state !== "resolved" || isUnsent) open += 1;
  }
  return { unsent, open, all: threads.length };
}

export function formatThreadCounts({ unsent, open, all }: ThreadCounts) {
  return {
    text: `${unsent} / ${open} / ${all}`,
    description: `${unsent} unsent, ${open} not resolved, ${all} ${plural(all, "thread")} in all`,
  };
}

const labels = { unsent: "Unsent", open: "Open", sent: "Sent", answered: "Answered", resolved: "Resolved" };
const dots = {
  unsent: "border-[1.5px] border-dashed border-thread-open",
  open: "bg-thread-open",
  sent: "bg-thread-sent",
  answered: "bg-thread-answered",
  resolved: "border-[1.5px] border-thread-resolved",
};
export function ThreadStateBadge({ state }: { state: ShownThreadState }) {
  return (
    <span className="em-card__pill" data-state={state}>
      <span aria-hidden="true" className={`size-[7px] shrink-0 rounded-full ${dots[state]}`} />
      {labels[state]}
    </span>
  );
}
