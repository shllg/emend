import { type FileView, OTHER_TOPIC, type RevisionView } from "@emend/contract";
import { useRef } from "react";
import { diffGroups } from "../../lib/diff-groups.ts";
import { lineTotals } from "../../lib/diff-totals.ts";
import { rankedTopics } from "../../lib/topics.ts";
import { useShortcut } from "../../lib/use-shortcut.tsx";
import { FileStatusMark } from "../diff/FileStatusMark.tsx";
import { LineTotals } from "../diff/LineTotals.tsx";
import type { DiffCounts } from "../diff/presentation.ts";
import { ThreadCount } from "../diff/ThreadCount.tsx";
import { resolveFile } from "../diff/targets.ts";
import { TopicRank } from "../status/TopicRank.tsx";
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
  const groups = diffGroups(revision);
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
      {[...groups.values()].map(({ topic, files }) => {
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
            {files.map((file) => {
              const slash = file.path.lastIndexOf("/");
              const count = counts.get(file.id);
              return (
                <div key={file.id} className="em-files-row" data-viewed={file.viewed}>
                  <button
                    type="button"
                    className="em-files-row__main"
                    aria-label={[
                      `Open diff for ${file.path}`,
                      file.status?.replaceAll("-", " "),
                      count && `${count.additions} added, ${count.deletions} removed`,
                      (threads.get(file.id) ?? 0) > 0 &&
                        `${threads.get(file.id)} ${threads.get(file.id) === 1 ? "thread" : "threads"}`,
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
                    <ThreadCount count={threads.get(file.id) ?? 0} />
                  </button>
                  <ViewedMark
                    state={file.viewed}
                    viewedOn={file.viewedOn}
                    label={file.path}
                    onToggle={() => onViewed([file.path], file.viewed !== "viewed")}
                  />
                </div>
              );
            })}
          </section>
        );
      })}
      <div className="em-files-progress">
        <progress className="em-files-progress__bar" value={viewed} max={files.length || 1} aria-label="Files viewed" />
        <span>
          {viewed} of {files.length} viewed
        </span>
      </div>
    </div>
  );
}
