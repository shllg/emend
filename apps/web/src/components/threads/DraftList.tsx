import type { TopicMeta } from "@recense/contract";
import { MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { clearDraft, listDrafts, loadDraft, type SavedDraft, subscribeDrafts } from "../../lib/drafts.ts";
import { targetLabel } from "../diff/targets.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";

export function DraftList({
  reviewId,
  topics,
  onResume,
}: {
  reviewId: string;
  topics?: TopicMeta[];
  onResume: (draft: SavedDraft) => void;
}) {
  const [drafts, setDrafts] = useState(() => listDrafts(reviewId));
  useEffect(() => {
    const refresh = () => setDrafts(listDrafts(reviewId));
    refresh();
    return subscribeDrafts(refresh);
  }, [reviewId]);
  if (!drafts.length) return null;
  return (
    <section aria-label="Unsaved comments" className="space-y-3">
      <h2 className="em-comment-group">
        Unsaved comments<span>{drafts.length}</span>
      </h2>
      {drafts.map((draft) => {
        const { label, icon } = draft.commentId
          ? { label: "Unsaved edit", icon: Pencil }
          : draft.target
            ? targetLabel(draft.target, topics)
            : { label: "Unreadable target", icon: MessageSquare };
        return (
          <article key={draft.key} className="rounded-lg border border-line-1 bg-surface px-3 py-2">
            <div className="em-card__target" title={label}>
              <Icon icon={icon} size={13} />
              <span>{label}</span>
            </div>
            <p className="my-2 line-clamp-2 whitespace-pre-wrap wrap-anywhere text-fg-2 [font:var(--type-body)]">
              {loadDraft(draft.key)}
            </p>
            <div className="flex gap-2">
              {(draft.target || draft.commentId) && (
                <Button variant="ghost" size="sm" onClick={() => onResume(draft)}>
                  Resume
                </Button>
              )}
              <Button variant="ghost" size="sm" icon={Trash2} onClick={() => clearDraft(draft.key)}>
                Discard
              </Button>
            </div>
          </article>
        );
      })}
    </section>
  );
}
