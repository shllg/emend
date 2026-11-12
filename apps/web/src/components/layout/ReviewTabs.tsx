import { useNavigate } from "@tanstack/react-router";
import { useLayout, usePaneMode } from "../../lib/layout.ts";
import { layoutStore, useLayoutPreferences } from "../../lib/layout-store.ts";
import { useShortcut } from "../../lib/use-shortcut.tsx";
import type { ReviewSearch } from "../../router.tsx";
import { formatThreadCounts, type ThreadCounts } from "../status/ThreadStateBadge.tsx";
import { Button } from "../ui/Button.tsx";
import { Tabs } from "../ui/Tabs.tsx";

export interface ReviewTabsProps {
  id: string;
  search: ReviewSearch;
  hasDocs: boolean;
  hasWriteup: boolean;
  hasDiff: boolean;
  compactDoc?: boolean;
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
  compactDoc = false,
  threadCounts,
  filesCount = 0,
  viewedCount = 0,
  docsCount,
  idBase,
}: ReviewTabsProps & { docsCount: number; idBase: string }) {
  const navigate = useNavigate();
  const phone = useLayout() === "phone";
  const { contents, compact } = useLayoutPreferences();
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
    <div className="em-review-tabs sticky top-0 z-(--z-sticky) flex shrink-0 items-center border-b border-line-1 bg-surface">
      <Tabs
        idBase={idBase}
        label="Reading tabs"
        className="min-w-0 flex-1 border-b-0"
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
      {!phone && (value === "writeup" || (value === "docs" && compactDoc)) && (
        <div className="mx-2 flex shrink-0 gap-1">
          {hasWriteup && value === "writeup" && (
            <Button
              size="sm"
              variant="ghost"
              className={contents ? "bg-raised text-fg-1" : undefined}
              aria-pressed={contents}
              onClick={() => layoutStore.update({ contents: !contents })}
            >
              Contents
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className={compact ? "bg-raised text-fg-1" : undefined}
            aria-pressed={compact}
            onClick={() => layoutStore.update({ compact: !compact })}
          >
            Compact comments
          </Button>
        </div>
      )}
    </div>
  );
}
