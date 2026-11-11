import { Link } from "@tanstack/react-router";
import { FileDiff, Files, FileText, ListChecks, MessageSquare } from "lucide-react";
import { formatThreadCounts } from "../status/ThreadStateBadge.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import { cn } from "../ui/utils.ts";
import type { ReviewTabsProps } from "./ReviewTabs.tsx";

const tabs = [
  { id: "writeup", label: "Writeup", icon: FileText },
  { id: "files", label: "Files", icon: ListChecks },
  { id: "docs", label: "Docs", icon: Files },
  { id: "comments", label: "Comments", icon: MessageSquare },
  { id: "diff", label: "Diff", icon: FileDiff },
] as const;

export function PhoneTabs({
  id,
  search,
  hasDocs,
  hasWriteup,
  hasDiff,
  threadCounts,
  filesCount = 0,
  viewedCount = 0,
}: ReviewTabsProps) {
  const count = threadCounts && threadCounts.all > 0 ? formatThreadCounts(threadCounts) : undefined;
  return (
    <nav
      aria-label="Review tabs"
      className="grid shrink-0 auto-cols-fr grid-flow-col border-t border-line-1 bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      {tabs
        .filter(
          (tab) =>
            ({ writeup: hasWriteup, files: filesCount > 0, diff: hasDiff, docs: hasDocs, comments: true })[tab.id],
        )
        .map((tab) => (
          <Link
            key={tab.id}
            to="/r/$reviewId"
            params={{ reviewId: id }}
            search={{ ...search, tab: tab.id, thread: undefined }}
            hash=""
            aria-current={tab.id === search.tab ? "page" : undefined}
            className={cn(
              "relative flex h-(--tab-touch) items-center justify-center text-11 font-medium leading-none no-underline hover:text-fg-1",
              tab.id === search.tab
                ? "text-fg-1 before:absolute before:-top-px before:right-[28%] before:left-[28%] before:h-0.5 before:rounded-b-[2px] before:bg-accent before:content-['']"
                : "text-fg-3",
            )}
          >
            <span className="relative flex flex-col items-center gap-[3px]">
              <Icon icon={tab.icon} size={18} />
              <span>{tab.id === "files" ? `Files ${viewedCount}/${filesCount}` : tab.label}</span>
              {tab.id === "comments" && count && (
                <>
                  <Tooltip content={count.description}>
                    {/* Grow right up to 34px, then shift left by the excess width. */}
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute -top-1.5 left-[calc(50%+3px)] inline-grid h-[15px] min-w-[15px] translate-x-[min(0px,calc(34px-100%))] place-items-center rounded-full px-1 text-[9.5px] font-semibold leading-none whitespace-nowrap tabular-nums [word-spacing:-0.2em]",
                        threadCounts && threadCounts.unsent > 0 ? "bg-accent text-accent-fg" : "bg-active text-fg-2",
                      )}
                    >
                      {count.text}
                    </span>
                  </Tooltip>
                  <span className="sr-only"> {count.description}</span>
                </>
              )}
            </span>
          </Link>
        ))}
    </nav>
  );
}
