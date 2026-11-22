import { useNavigate } from "@tanstack/react-router";
import { usePaneMode } from "../../lib/layout.ts";
import { useShortcut } from "../../lib/use-shortcut.tsx";
import type { ReviewSearch } from "../../router.tsx";
import { formatThreadCounts, type ThreadCounts } from "../status/ThreadStateBadge.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import { cn } from "../ui/utils.ts";

export interface ReviewTabsProps {
  id: string;
  search: ReviewSearch;
  hasDocs: boolean;
  hasWriteup: boolean;
  hasDiff: boolean;
  threadCounts?: ThreadCounts;
  filesCount?: number;
  viewedCount?: number;
}

export function ReviewTabs({
  id,
  search,
  hasDocs,
  hasWriteup,
  hasDiff,
  threadCounts,
  filesCount = 0,
  viewedCount = 0,
  docsCount,
  idBase,
  toolbarSlot,
  depthSlot,
}: ReviewTabsProps & {
  docsCount: number;
  idBase: string;
  toolbarSlot?: (element: HTMLDivElement | null) => void;
  depthSlot?: (element: HTMLDivElement | null) => void;
}) {
  const navigate = useNavigate();
  const showDiff = usePaneMode() === "tabs" && hasDiff;
  const active =
    (search.tab === "diff" && !showDiff) || (search.tab === "files" && !filesCount)
      ? hasWriteup
        ? "writeup"
        : hasDocs
          ? "docs"
          : "comments"
      : search.tab;
  const value = active ?? (hasWriteup ? "writeup" : hasDocs ? "docs" : "comments");
  const count = threadCounts && threadCounts.all > 0 ? formatThreadCounts(threadCounts) : undefined;
  const changeTab = (tab: string) => {
    if (tab !== "writeup" && tab !== "files" && tab !== "docs" && tab !== "comments" && tab !== "diff") return false;
    void navigate({
      to: "/r/$reviewId",
      params: { reviewId: id },
      search: { ...search, tab, thread: undefined },
      hash: "",
    });
    return true;
  };
  useShortcut("tab.writeup", () => changeTab("writeup"), { enabled: hasWriteup });
  useShortcut("tab.files", () => changeTab("files"), { enabled: filesCount > 0 });
  useShortcut("tab.docs", () => changeTab("docs"), { enabled: hasDocs });
  useShortcut("tab.comments", () => changeTab("comments"));
  useShortcut("tab.diff", () => changeTab("diff"), { enabled: showDiff });
  return (
    <div
      className={cn(
        "em-review-tabs sticky top-0 z-(--z-sticky) flex shrink-0 items-stretch bg-surface",
        value === "writeup" && depthSlot ? "flex-nowrap" : "flex-wrap",
      )}
    >
      <Tabs
        idBase={idBase}
        label="Reading tabs"
        className="min-w-0 flex-[999_1_auto]"
        value={value}
        items={[
          { id: "writeup", label: "Writeup", hidden: !hasWriteup },
          { id: "files", label: `Files ${viewedCount}/${filesCount}`, hidden: !filesCount },
          { id: "docs", label: "Docs", hidden: !hasDocs, count: docsCount },
          {
            id: "comments",
            label: "Comments",
            count: count?.text,
            countLabel: count?.description,
            accent: !!threadCounts && threadCounts.unsent > 0,
          },
          { id: "diff", label: "Diff", hidden: !showDiff },
        ].map((item) => ({ ...item, "aria-controls": `${idBase}-${item.id === "diff" ? "diff" : "reading"}-panel` }))}
        onChange={changeTab}
      />
      {value === "diff" && toolbarSlot && <div ref={toolbarSlot} className="em-tab-tools" />}
      {value === "writeup" && depthSlot && <div ref={depthSlot} className="em-depth-slot" />}
    </div>
  );
}
