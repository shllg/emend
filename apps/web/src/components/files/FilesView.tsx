import { type FileView, OTHER_TOPIC, type RevisionView } from "@emend/contract";
import { useMemo, useRef } from "react";
import { diffGroups, pathOrder } from "../../lib/diff-groups.ts";
import { lineTotals } from "../../lib/diff-totals.ts";
import { rankedTopics } from "../../lib/topics.ts";
import { useShortcut } from "../../lib/use-shortcut.tsx";
import { FileStatusMark } from "../diff/FileStatusMark.tsx";
import { LineTotals } from "../diff/LineTotals.tsx";
import { type DiffCounts, useFileOrder } from "../diff/presentation.ts";
import { ThreadCount } from "../diff/ThreadCount.tsx";
import { resolveFile } from "../diff/targets.ts";
import { TopicRank } from "../status/TopicRank.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { ViewedMark } from "./ViewedMark.tsx";

export function FilesView({
  revision,
  counts,
  onViewed,
  onNavigate,
}: {
  revision: RevisionView;
  counts: ReadonlyMap<string, DiffCounts>;
  onViewed: (paths: string[], viewed: boolean) => void;
  onNavigate: (file: FileView) => void;
}) {
  const [order, setOrder, saving] = useFileOrder();
  const groups = diffGroups(revision);
  const orderedFiles = useMemo(
    () => pathOrder(revision.files.filter((file) => file.role === "diff")),
    [revision.files],
  );
  const root = useRef<HTMLDivElement>(null);
  useShortcut(
    "file.toggleViewed",
    () => {
      const focused = document.activeElement;
      if (!focused || !root.current?.contains(focused)) return false;
      const mark = focused.closest(".em-files-row")?.querySelector<HTMLButtonElement>(".em-viewed-mark");
      if (!mark || mark.disabled) return false;
      mark.click();
      return true;
    },
    { priority: 10 },
  );
  const ranks = new Map(
    rankedTopics([...groups.values()].map(({ topic }) => topic)).map(({ topic, rank }) => [topic.slug, rank]),
  );
  const files = revision.files.filter((file) => file.role === "diff");
  const viewed = files.filter((file) => file.viewed === "viewed").length;
  const threads = new Map<string, number>();
  for (const thread of revision.threads) {
    if (thread.placement.status !== "placed") continue;
    const file = resolveFile(files, thread.placement.location);
    if (file) threads.set(file.id, (threads.get(file.id) ?? 0) + 1);
  }
  return (
    <div ref={root} className="em-files-view">
      <div className="em-files-order">
        <SegmentedControl
          size="sm"
          label="File order"
          value={order}
          onChange={(value) => setOrder(value === "path" ? "path" : "topics")}
          options={[
            {
              value: "topics",
              label: "Topics",
              disabled: saving,
              title: saving ? "Wait until the comment is saved" : undefined,
            },
            {
              value: "path",
              label: "A to Z",
              disabled: saving,
              title: saving ? "Wait until the comment is saved" : undefined,
            },
          ]}
        />
      </div>
      {order === "path" ? (
        <section className="em-files-group" aria-label="Files A to Z">
          {orderedFiles.map((file) => (
            <FileRow
              key={file.id}
              file={file}
              count={counts.get(file.id)}
              threads={threads.get(file.id) ?? 0}
              onViewed={onViewed}
              onNavigate={onNavigate}
            />
          ))}
        </section>
      ) : (
        [...groups.values()].map(({ topic, files }) => {
          const done = files.filter((file) => file.viewed === "viewed").length;
          const all = files.length > 0 && done === files.length;
          const rank = ranks.get(topic.slug);
          const title = topic.slug === OTHER_TOPIC.slug ? "Other files" : topic.title;
          return (
            <section key={topic.slug} className="em-files-group" aria-label={title}>
              <div className="em-files-group__head">
                {rank ? <TopicRank rank={rank} /> : <span aria-hidden="true">··</span>}
                <h3 className="em-files-group__title">{title}</h3>
                <LineTotals counts={lineTotals(files, counts)} />
                <span className="em-files-group__count">
                  {done}/{files.length}
                </span>
                <ViewedMark
                  state={all ? "viewed" : undefined}
                  label={`topic ${title}`}
                  disabled={!files.length}
                  onToggle={() =>
                    onViewed(
                      files.map((file) => file.path),
                      !all,
                    )
                  }
                />
              </div>
              {files.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  count={counts.get(file.id)}
                  threads={threads.get(file.id) ?? 0}
                  onViewed={onViewed}
                  onNavigate={onNavigate}
                />
              ))}
            </section>
          );
        })
      )}
      <div className="em-files-progress">
        <progress className="em-files-progress__bar" value={viewed} max={files.length || 1} aria-label="Files viewed" />
        <span>
          {viewed} of {files.length} viewed
        </span>
      </div>
    </div>
  );
}

function FileRow({
  file,
  count,
  threads,
  onViewed,
  onNavigate,
}: {
  file: FileView;
  count?: DiffCounts;
  threads: number;
  onViewed: (paths: string[], viewed: boolean) => void;
  onNavigate: (file: FileView) => void;
}) {
  const slash = file.path.lastIndexOf("/");
  return (
    <div className="em-files-row" data-viewed={file.viewed}>
      <button
        type="button"
        className="em-files-row__main"
        aria-label={[
          `Open diff for ${file.path}`,
          file.status?.replaceAll("-", " "),
          count && `${count.additions} added, ${count.deletions} removed`,
          threads > 0 && `${threads} ${threads === 1 ? "thread" : "threads"}`,
        ]
          .filter(Boolean)
          .join(", ")}
        onClick={() => onNavigate(file)}
      >
        <FileStatusMark status={file.status} />
        <span className="em-files-row__path" title={file.path}>
          <bdi>
            <span className="em-files-row__dir">{file.path.slice(0, slash + 1)}</span>
            {file.path.slice(slash + 1)}
          </bdi>
        </span>
        <span className="em-files-row__counts">
          {count ? (
            <>
              <span className="text-diff-add-fg">+{count.additions}</span>
              <span className="text-diff-del-fg">−{count.deletions}</span>
            </>
          ) : null}
        </span>
        <ThreadCount count={threads} />
      </button>
      <ViewedMark
        state={file.viewed}
        viewedOn={file.viewedOn}
        label={file.path}
        onToggle={() => onViewed([file.path], file.viewed !== "viewed")}
      />
    </div>
  );
}
