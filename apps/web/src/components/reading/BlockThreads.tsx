import type { RevisionView } from "@emend/contract";
import { type ReactNode, useCallback, useContext, useId, useMemo, useState, useSyncExternalStore } from "react";
import { isEditComposerOpen } from "../../lib/composer-owner.ts";
import { plural } from "../../lib/count.ts";
import { draftKey, editDraftKey, hasDraft, hasDraftText, subscribeDrafts } from "../../lib/drafts.ts";
import { ReadingFoldContext } from "./ReadingGroup.tsx";
import { ThreadComposerContext } from "./ThreadComposerContext.ts";

export type ThreadJump = { threadId: string; token: object };

/** Keep the existing cards and their highlight lifecycle; only their presentation folds. */
export function BlockThreads({
  compact,
  reviewId,
  threads,
  composing,
  jump,
  children,
}: {
  compact: boolean;
  reviewId: string;
  threads: RevisionView["threads"];
  composing: boolean;
  jump?: ThreadJump;
  children: ReactNode;
}) {
  const id = useId();
  const [composers, setComposers] = useState(0);
  const registerComposer = useCallback(() => {
    setComposers((count) => count + 1);
    return () => setComposers((count) => count - 1);
  }, []);
  const keys = useMemo(
    () => ({
      replies: threads.map((thread) => draftKey(reviewId, thread.target, thread.id)),
      edits: threads.flatMap((thread) =>
        thread.comments
          .filter((comment) => comment.author === "user" && !comment.sent)
          .map((comment) => editDraftKey(reviewId, comment.id)),
      ),
    }),
    [reviewId, threads],
  );
  const saved = useSyncExternalStore(
    subscribeDrafts,
    () => keys.replies.some(hasDraftText) || keys.edits.some((key) => hasDraft(key) && isEditComposerOpen(key)),
  );
  const forced =
    composing ||
    composers > 0 ||
    saved ||
    threads.some((thread) => thread.comments.some((comment) => comment.author === "user" && !comment.sent));
  const folds = useContext(ReadingFoldContext);
  const [choice, setChoice] = useState({ open: forced });
  // Read this entry's choices before restoration measures the cards, including when the group stays mounted.
  const expanded =
    folds && threads.length ? threads.some((thread) => folds.choices.get(`thread-${thread.id}`)) : choice.open;
  const rememberOpen = (open: boolean) => {
    // One pill controls all cards at this block. Only app thread ids enter the in-memory trail.
    for (const thread of threads) folds?.choices.set(`thread-${thread.id}`, open);
    setChoice({ open });
  };
  const [handledJump, setHandledJump] = useState<object>();
  if (jump && handledJump !== jump.token && threads.some((thread) => thread.id === jump.threadId)) {
    // A pending jump is consumed only once its thread is placed in this block.
    setHandledJump(jump.token);
    rememberOpen(true);
  }
  // Forced opening is sticky: saving, sending or closing an editor must not remove
  // the card (or its focused control) until the reviewer explicitly presses Hide.
  if (forced && !expanded) rememberOpen(true);
  const open = !compact || expanded || forced;
  const state = threads.every((thread) => thread.state === "resolved")
    ? " · resolved"
    : threads.some((thread) => thread.state === "answered")
      ? " · answered"
      : "";
  return (
    <ThreadComposerContext value={registerComposer}>
      <div className="em-block-threads" data-compact={compact ? "" : undefined}>
        {open && (
          <div id={id} className="em-block-threads__cards">
            {children}
          </div>
        )}
        {compact && threads.length > 0 && !forced && (
          <button
            type="button"
            className="em-thread-pill"
            aria-expanded={open}
            aria-controls={open ? id : undefined}
            onClick={(event) => {
              rememberOpen(!open);
              if (open) event.currentTarget.focus();
            }}
          >
            {open ? "Hide" : `${threads.length} ${plural(threads.length, "comment")}${state}`}
          </button>
        )}
      </div>
    </ThreadComposerContext>
  );
}
