import type { RevisionView } from "@emend/contract";
import { useSyncExternalStore } from "react";
import { listDrafts, type SavedDraft, subscribeDrafts } from "../../lib/drafts.ts";
import { layoutStore, useLayoutPreferences } from "../../lib/layout-store.ts";
import { threadPlaces } from "../../lib/thread-places.ts";
import type { ReviewSearch } from "../../router.tsx";
import { shownThreadState } from "../status/ThreadStateBadge.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { DraftList } from "./DraftList.tsx";
import { ThreadCard, threadPlaceLink } from "./ThreadCard.tsx";

export function ThreadList({
  reviewId,
  revision,
  threads,
  changedBlocks,
  topics = [],
  writeup = { sections: [] },
  docs = [],
  files = [],
  search = {},
  phone = false,
  onResume,
}: {
  reviewId: string;
  revision: number;
  threads: RevisionView["threads"];
  changedBlocks: RevisionView["changedBlocks"];
  topics?: RevisionView["topics"];
  writeup?: RevisionView["writeup"];
  docs?: RevisionView["docs"];
  files?: RevisionView["files"];
  search?: ReviewSearch;
  phone?: boolean;
  onResume: (draft: SavedDraft) => void;
}) {
  const hasDrafts = useSyncExternalStore(subscribeDrafts, () => listDrafts(reviewId).length > 0);
  const { hideResolved } = useLayoutPreferences();
  const shown = threads.filter(
    (thread) => !hideResolved || shownThreadState(thread) !== "resolved" || search.thread === thread.id,
  );
  const hiddenCount = threads.length - shown.length;
  const groups = threadPlaces({ threads: shown, topics, writeup, docs, files });
  const writtenTopics = new Set(writeup.sections.flatMap((section) => (section.topic !== null ? [section.topic] : [])));
  const props = { reviewId, revision, changedBlocks, topics, surface: "comments" as const };
  return (
    <div className="space-y-6 px-4 pt-4 pb-8 md:mx-auto md:max-w-[calc(1000px+88px)] md:pt-7 md:pr-8 md:pb-[72px] md:pl-14">
      <DraftList reviewId={reviewId} topics={topics} onResume={onResume} />
      {threads.length > 0 && (
        <div className="flex items-center gap-3">
          <Checkbox
            label="Hide resolved"
            checked={hideResolved}
            onChange={(event) => layoutStore.update({ hideResolved: event.target.checked })}
          />
          {hiddenCount > 0 && <span className="text-fg-3 [font:var(--type-meta)]">{hiddenCount} hidden</span>}
        </div>
      )}
      {!hasDrafts && threads.length === 0 && (
        <div className="space-y-1">
          <p>No comments yet.</p>
          <p className="text-fg-3 [font:var(--type-meta)]">
            Select text in the writeup or a doc, or click a line in the diff.
          </p>
        </div>
      )}
      {threads.length > 0 && shown.length === 0 && <p>Every thread is resolved.</p>}
      {groups.map(({ key, label, threads: group }) => (
        <section key={key} aria-label={label} className="space-y-3">
          <h2 className="em-comment-group">
            {label}
            <span>{group.length}</span>
          </h2>
          {group.map((thread) => (
            <ThreadCard
              key={thread.id}
              {...props}
              thread={thread}
              showInPlace={threadPlaceLink(reviewId, thread, search, phone, writtenTopics)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
