import type { RevisionView, ThreadView, TopicMeta, UnplacedReason } from "@emend/contract";
import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Pencil,
  Reply,
  RotateCcw,
  Trash2,
  Unlink,
  User,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { mutationMessage, useReviewMutation } from "../../api/mutations.ts";
import { claimDraft, useDraftClaim, useEditComposer, useReplyComposer } from "../../lib/composer-owner.ts";
import {
  clearDraft,
  draftKey,
  editDraftKey,
  hasDraft,
  loadDraft,
  saveDraft,
  subscribeDrafts,
} from "../../lib/drafts.ts";
import { useThreadActionFocus } from "../../lib/thread-action-focus.ts";
import { useThreadJump } from "../../lib/thread-jump.ts";
import type { ReviewSearch } from "../../router.tsx";
import { useCommentCard } from "../diff/comment-lines.ts";
import { targetLabel } from "../diff/targets.ts";
import { CommentHtml } from "../reading/BlockView.tsx";
import { useThreadComposer } from "../reading/ThreadComposerContext.ts";
import { ChangedMarker } from "../status/ChangedMarker.tsx";
import { OutcomeBadge } from "../status/OutcomeBadge.tsx";
import { shownThreadState, ThreadStateBadge } from "../status/ThreadStateBadge.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Composer } from "./Composer.tsx";

export type ThreadProps = {
  surface?: "reading" | "comments" | "diff";
  reviewId: string;
  revision: number;
  thread: ThreadView;
  changedBlocks: RevisionView["changedBlocks"];
  topics?: TopicMeta[];
  showInPlace?: string;
};
export function blockLink(reviewId: string, revision: number, blockId: string, doc?: string) {
  return `/r/${encodeURIComponent(reviewId)}?rev=${revision}&tab=${doc ? `docs&doc=${encodeURIComponent(doc)}` : "writeup"}#block-${encodeURIComponent(blockId)}`;
}
function answeredBefore(thread: ThreadView, revision: number) {
  let newestSent = 0;
  let answeredOn = 0;
  for (const comment of thread.comments) {
    if (comment.author === "user" && comment.sentOn !== null) newestSent = Math.max(newestSent, comment.sentOn);
    if (comment.author === "agent") answeredOn = newestSent;
  }
  return answeredOn > 0 && answeredOn < revision;
}

export function threadPlaceLink(reviewId: string, thread: ThreadView, search: ReviewSearch, phone: boolean) {
  if (thread.placement.status !== "placed") return undefined;
  const location = thread.placement.location;
  if (location.kind === "review") return undefined;
  const params = new URLSearchParams();
  if (search.rev !== undefined) params.set("rev", String(search.rev));
  let hash = `thread-${thread.id}`;
  if (location.kind === "writeup-span") params.set("tab", "writeup");
  else if (location.kind === "doc-span" || location.kind === "html-span" || location.kind === "source-lines") {
    params.set("tab", "docs");
    params.set("doc", location.path);
    if (location.kind === "html-span") params.set("thread", thread.id);
    if (location.kind === "source-lines") params.set("view", "source");
  } else {
    params.set("tab", phone ? "diff" : (search.tab ?? "comments"));
    if (search.doc) params.set("doc", search.doc);
    if (search.view) params.set("view", search.view);
    hash = `diff-thread-${thread.id}`;
  }
  return `/r/${encodeURIComponent(reviewId)}?${params}#${encodeURIComponent(hash)}`;
}
const reasons: Record<UnplacedReason, string> = {
  "block-gone": "The block this comment was on is gone.",
  ambiguous: "The quoted text now appears more than once.",
  "topic-gone": "The topic this comment was on is gone.",
  "file-gone": "The file this comment was on is no longer in the diff.",
  "lines-gone": "The lines this comment was on are gone.",
  "not-placed": "This comment has no place in this revision.",
};
export function ThreadCard({
  reviewId,
  revision,
  thread,
  changedBlocks,
  topics,
  showInPlace,
  surface = "reading",
}: ThreadProps) {
  const location = thread.placement.status === "placed" ? thread.placement.location : null;
  const highlightCard = useCommentCard(thread.id, surface === "diff" ? location : null);
  const cardId = `${surface === "diff" ? "diff-thread" : "thread"}-${thread.id}`;
  const jump = useThreadJump(cardId);
  const mutation = useReviewMutation(reviewId);
  const key = draftKey(reviewId, thread.target, thread.id);
  const keys = [key, ...thread.comments.map((comment) => editDraftKey(reviewId, comment.id))];
  const claim = useDraftClaim(keys, surface);
  const { open: replyOpen, close: closeReply } = useReplyComposer(key);
  const replyButton = useThreadActionFocus(reviewId, thread.id, surface, "reply", replyOpen);
  const [collapse, setCollapsed] = useState(
    () => surface === "comments" && thread.state === "resolved" && !keys.some((key) => loadDraft(key).trim()),
  );
  useEffect(() => {
    if (claim) {
      setCollapsed(false);
    }
  }, [claim]);
  const changed =
    location && "blockId" in location ? changedBlocks.find((change) => change.blockId === location.blockId) : undefined;
  const showChanged = changed && location && "blockId" in location && answeredBefore(thread, changed.revision);
  const { label, icon } = targetLabel(thread.target, topics);
  const resolved = thread.state === "resolved";
  const collapsed = collapse && resolved;
  useThreadComposer(replyOpen && !collapsed);
  const canReply = !resolved && thread.comments.some((comment) => comment.author === "agent" || comment.sent);
  return (
    <article
      ref={highlightCard}
      data-thread-card
      id={cardId}
      className="em-card em-thread"
      data-state={shownThreadState(thread)}
      data-jump={jump ? "" : undefined}
      data-resolved={resolved ? "" : undefined}
      data-collapsed={collapsed ? "" : undefined}
    >
      <header className="em-card__head em-thread__head">
        <span className="em-card__target" title={label}>
          <Icon icon={icon} size={13} />
          <span>{label}</span>
        </span>
        {showChanged && (
          <a
            href={blockLink(
              reviewId,
              revision,
              location.blockId,
              location.kind === "doc-span" ? location.path : undefined,
            )}
          >
            <ChangedMarker revision={changed.revision} />
          </a>
        )}
        <ThreadStateBadge state={shownThreadState(thread)} />
        {surface === "comments" && showInPlace && !showChanged && (
          <IconButton asChild size="sm" icon={ArrowUpRight} label="Show in place">
            <a href={showInPlace}>
              <span className="sr-only">Show in place</span>
            </a>
          </IconButton>
        )}
        {surface === "comments" && resolved && (
          <IconButton
            size="sm"
            icon={collapsed ? ChevronDown : ChevronUp}
            label={collapsed ? "Expand thread" : "Collapse thread"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          />
        )}
      </header>
      {!collapsed && (
        <>
          {thread.placement.status === "unplaced" && (
            <div className="flex items-start gap-2 border-b border-line-1 bg-warning-bg px-3 py-2 text-warning-fg [font:var(--type-meta)]">
              <Icon icon={Unlink} size={14} className="mt-px" />
              <span>
                {reasons[thread.placement.reason]}
                {thread.createdOn !== revision && (
                  <>
                    {" "}
                    Made on{" "}
                    <a
                      className="underline"
                      href={`/r/${encodeURIComponent(reviewId)}?rev=${thread.createdOn}&tab=comments&thread=${encodeURIComponent(thread.id)}#thread-${encodeURIComponent(thread.id)}`}
                    >
                      revision {thread.createdOn}
                    </a>
                    .
                  </>
                )}
              </span>
            </div>
          )}
          <div className="em-card__body">
            {"quote" in thread.target && (
              <p className="em-thread-quote">
                <mark>{thread.target.quote}</mark>
              </p>
            )}
            <ol className="em-thread__comments">
              {thread.comments.map((comment) => (
                <Comment
                  key={comment.id}
                  comment={comment}
                  reviewId={reviewId}
                  revision={revision}
                  thread={thread}
                  topics={topics}
                  surface={surface}
                />
              ))}
            </ol>
            {mutation.error && <p role="alert">{mutationMessage(mutation.error)}</p>}
          </div>
          {(canReply || resolved || replyOpen) && (
            <footer className="em-card__foot" data-reply-open={replyOpen ? "" : undefined}>
              {(canReply || resolved) && (
                <div className={replyOpen ? "em-card__foot" : "contents"}>
                  {canReply && !replyOpen && (
                    <Button
                      ref={replyButton.ref}
                      variant="ghost"
                      size="sm"
                      icon={Reply}
                      onClick={() => {
                        claimDraft(key, surface);
                      }}
                    >
                      Reply
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={resolved ? RotateCcw : Check}
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        path: `/api/v1/threads/${encodeURIComponent(thread.id)}/${resolved ? "reopen" : "resolve"}`,
                      })
                    }
                  >
                    {resolved ? "Reopen" : "Resolve"}
                  </Button>
                </div>
              )}
              {replyOpen && (
                <Composer
                  embedded
                  surface={surface}
                  reviewId={reviewId}
                  revision={revision}
                  target={thread.target}
                  topics={topics}
                  threadId={thread.id}
                  onSaved={closeReply}
                  onCancel={closeReply}
                  returnFocus={replyButton.returnFocus}
                />
              )}
            </footer>
          )}
        </>
      )}
    </article>
  );
}

function Comment({
  comment,
  reviewId,
  revision,
  thread,
  topics,
  surface = "reading",
}: {
  comment: ThreadView["comments"][number];
} & Pick<ThreadProps, "reviewId" | "revision" | "thread" | "topics" | "surface">) {
  const key = editDraftKey(reviewId, comment.id);
  const draftExists = useSyncExternalStore(subscribeDrafts, () => hasDraft(key));
  const { open: editOpen, close: closeEdit } = useEditComposer(key);
  const editing = draftExists && editOpen;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const editButton = useThreadActionFocus(reviewId, thread.id, surface, comment.id, editing);
  const mutation = useReviewMutation(reviewId, key);
  const agent = comment.author === "agent";
  const editable = !agent && !comment.sent;
  useThreadComposer(editable && editing);
  return (
    <li className="em-comment" data-agent={agent ? "" : undefined}>
      <span className="em-comment__avatar">
        <Icon icon={agent ? Bot : User} size={13} />
      </span>
      <header className="em-comment__head">
        <span className="em-comment__name">{agent ? "Agent" : "You"}</span>
        {agent && comment.outcome && <OutcomeBadge outcome={comment.outcome} />}
        {editable && (
          <span className="ml-auto flex gap-0.5">
            {!editing && (
              <IconButton
                ref={editButton.ref}
                label="Edit"
                icon={Pencil}
                size="sm"
                disabled={mutation.isPending}
                onClick={() => {
                  if (!hasDraft(key)) saveDraft(key, comment.body);
                  claimDraft(key, surface);
                }}
              />
            )}
            <IconButton
              label="Delete"
              icon={Trash2}
              size="sm"
              disabled={mutation.isPending}
              onClick={() => setDeleteOpen(true)}
            />
            <Dialog
              open={deleteOpen}
              onOpenChange={(open) => {
                if (!mutation.isPending) setDeleteOpen(open);
              }}
              title="Delete this comment?"
              description="It has not been sent yet. This cannot be undone."
              actions={
                <>
                  <Button data-autofocus disabled={mutation.isPending} onClick={() => setDeleteOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate(
                        {
                          path: `/api/v1/comments/${encodeURIComponent(comment.id)}`,
                          method: "DELETE",
                          deleteDraft: key,
                        },
                        {
                          onSuccess: () => {
                            setDeleteOpen(false);
                          },
                        },
                      )
                    }
                  >
                    Delete
                  </Button>
                </>
              }
            >
              {mutation.error && <p role="alert">{mutationMessage(mutation.error)}</p>}
            </Dialog>
          </span>
        )}
      </header>
      <div>
        {editable && editing ? (
          <Composer
            embedded
            surface={surface}
            reviewId={reviewId}
            revision={revision}
            target={thread.target}
            topics={topics}
            commentId={comment.id}
            onCancel={() => {
              clearDraft(key);
              closeEdit();
            }}
            onDismiss={() => {
              if (loadDraft(key) === comment.body) clearDraft(key);
              closeEdit();
            }}
            returnFocus={editButton.returnFocus}
          />
        ) : // A null or absent html is the plain-text fallback.
        typeof comment.html === "string" ? (
          <CommentHtml html={comment.html} />
        ) : (
          <p className="em-comment__body">{comment.body}</p>
        )}
        {mutation.error && !deleteOpen && <p role="alert">{mutationMessage(mutation.error)}</p>}
      </div>
    </li>
  );
}
