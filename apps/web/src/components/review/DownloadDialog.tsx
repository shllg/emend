import { LIMITS, type RevisionView, reviewDownloadPath } from "@emend/contract";
import { type RefObject, useEffect, useState } from "react";
import { downloadBaseLabel, downloadDocChoices, downloadHasComments } from "../../lib/download.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Dialog } from "../ui/Dialog.tsx";

export function DownloadDialog({
  reviewId,
  revision,
  open,
  onOpenChange,
  returnFocus,
}: {
  reviewId: string;
  revision: RevisionView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [tickedIds, setTickedIds] = useState<string[]>([]);
  const [comments, setComments] = useState(false);
  const base = downloadBaseLabel(revision);
  const choices = downloadDocChoices(revision);
  const hasComments = downloadHasComments(revision);
  useEffect(() => {
    if (open) {
      setTickedIds([]);
      setComments(false);
    }
  }, [open]);
  return (
    <Dialog
      title="Download"
      description={
        <>
          {base ? (
            base.title ? (
              <>
                <bdi>{base.title}</bdi> (<bdi>{base.path}</bdi>)
              </>
            ) : (
              <bdi>{base.path}</bdi>
            )
          ) : (
            "The writeup"
          )}
          {choices.length > 0
            ? " is always in. Tick docs to add them; with any doc ticked, the download is a ZIP file."
            : " is always in."}
        </>
      }
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      actions={
        <>
          <Button data-autofocus onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button asChild variant="primary">
            <a
              href={reviewDownloadPath(reviewId, revision.seq, tickedIds, { comments })}
              download
              onClick={() => onOpenChange(false)}
            >
              Download
            </a>
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3 wrap-anywhere">
        {hasComments && (
          <Checkbox
            label="Comments and replies"
            description="Sent comments and the agent's replies, next to their text. Unsent comments stay out."
            checked={comments}
            onChange={(event) => setComments(event.currentTarget.checked)}
          />
        )}
        {choices.map((doc) => (
          <Checkbox
            key={doc.id}
            label={<bdi>{doc.label}</bdi>}
            description={
              doc.title || doc.source ? (
                <>
                  <bdi>{doc.path}</bdi>
                  {doc.source && " · source"}
                </>
              ) : undefined
            }
            checked={tickedIds.includes(doc.id)}
            disabled={tickedIds.length >= LIMITS.downloadDocs && !tickedIds.includes(doc.id)}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setTickedIds((ids) =>
                checked
                  ? ids.length < LIMITS.downloadDocs
                    ? [...ids, doc.id]
                    : ids
                  : ids.filter((id) => id !== doc.id),
              );
            }}
          />
        ))}
      </div>
    </Dialog>
  );
}
