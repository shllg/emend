import type { FileView } from "@emend/contract";
import { ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react";
import type { Ref } from "react";
import { ViewedMark } from "../files/ViewedMark.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { FilePathMenu, Path } from "./FilePath.tsx";
import { FileStatusMark } from "./FileStatusMark.tsx";
import type { DiffCounts } from "./presentation.ts";
import { ThreadCount } from "./ThreadCount.tsx";

export function FileHeader({
  ref,
  file,
  collapsed,
  counts,
  threads,
  onToggle,
  onComment,
  onViewed,
}: {
  ref?: Ref<HTMLElement>;
  file: FileView;
  collapsed: boolean;
  counts?: DiffCounts;
  threads: number;
  onToggle: () => void;
  onComment: () => void;
  onViewed?: (paths: string[], viewed: boolean) => void;
}) {
  return (
    <header
      ref={ref}
      id={`diff-file-${file.id}`}
      data-file-header
      className="em-file"
      data-collapsed={collapsed || undefined}
    >
      <IconButton
        size="sm"
        label={collapsed ? "Expand file" : "Collapse file"}
        icon={collapsed ? ChevronRight : ChevronDown}
        aria-expanded={!collapsed}
        onClick={onToggle}
      />
      <FileStatusMark status={file.status} />
      <div className="min-w-0 flex-1 font-stretch-mono [font:var(--type-path)]">
        <FilePathMenu path={file.path} oldPath={file.oldPath} />
        {file.oldPath && (
          <p className="em-file-path text-fg-3" title={`Renamed from ${file.oldPath}`}>
            <span className="em-file-from-label">Renamed from</span>{" "}
            <span className="em-file-from">
              <Path path={file.oldPath} />
            </span>
          </p>
        )}
      </div>
      {counts && !file.flag && (
        <span className="flex shrink-0 gap-1.5 font-mono text-11 font-stretch-mono tabular-nums">
          <span className="text-diff-add-fg">+{counts.additions}</span>
          <span className="text-diff-del-fg">−{counts.deletions}</span>
        </span>
      )}
      <ThreadCount count={threads} />
      <IconButton label="Comment on file" icon={MessageSquarePlus} size="sm" onClick={onComment} />
      {onViewed && (
        <ViewedMark
          state={file.viewed}
          viewedOn={file.viewedOn}
          label={file.path}
          showLabel
          onToggle={() => onViewed([file.path], file.viewed !== "viewed")}
        />
      )}
    </header>
  );
}
