import type { RevisionView } from "@emend/contract";
import { useSyncExternalStore } from "react";
import { listDrafts, type SavedDraft, subscribeDrafts } from "../../lib/drafts.ts";
import type { ReviewSearch } from "../../router.tsx";
import { threadListGroup } from "../status/ThreadStateBadge.tsx";
import { DraftList } from "./DraftList.tsx";
import { ThreadCard, threadPlaceLink } from "./ThreadCard.tsx";

export function ThreadList({
  reviewId,
  revision,
  threads,
  changedBlocks,
  topics,
  search = {},
  phone = false,
  onResume,
}: {
  reviewId: string;
  revision: number;
  threads: RevisionView["threads"];
  changedBlocks: RevisionView["changedBlocks"];
  topics?: RevisionView["topics"];
  search?: ReviewSearch;
  phone?: boolean;
  onResume: (draft: SavedDraft) => void;
}) {
  const hasDrafts = useSyncExternalStore(subscribeDrafts, () => listDrafts(reviewId).length > 0);
  const props = { reviewId, revision, changedBlocks, topics, surface: "comments" as const };
  return (
    <div className="space-y-6 px-4 pt-4 pb-8 md:mx-auto md:max-w-[calc(1000px+88px)] md:pt-7 md:pr-8 md:pb-[72px] md:pl-14">
      <DraftList reviewId={reviewId} topics={topics} onResume={onResume} />
      {!hasDrafts && threads.length === 0 && (
        <div className="space-y-1">
          <p>No comments yet.</p>
          <p className="text-fg-3 [font:var(--type-meta)]">
            Select text in the writeup or a doc, or click a line in the diff.
          </p>
        </div>
      )}
      {(["unsent", "sent", "answered", "open", "unplaced", "resolved"] as const).map((state) => {
        const group = threads.filter((thread) => threadListGroup(thread) === state);
        if (!group.length) return null;
        const label = state[0]?.toUpperCase() + state.slice(1);
        return (
          <section key={state} aria-label={label} className="space-y-3">
            <h2 className="em-comment-group">
              {label}
              <span>{group.length}</span>
            </h2>
            {group.map((thread) => (
              <ThreadCard
                key={thread.id}
                {...props}
                thread={thread}
                showInPlace={threadPlaceLink(reviewId, thread, search, phone)}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}
