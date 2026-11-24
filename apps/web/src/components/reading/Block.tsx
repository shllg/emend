import type { RenderedBlock } from "@recense/contract";
import { MessageSquarePlus } from "lucide-react";
import type { ReactNode } from "react";
import { useReadOnlyReview } from "../../lib/read-only-review.ts";
import { blockAnchor } from "../../lib/selection.ts";
import { ChangedMarker } from "../status/ChangedMarker.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { BlockView } from "./BlockView.tsx";

export function Block({
  block,
  drift,
  changedIn,
  continuesChange,
  commenting,
  onComment,
  children,
}: {
  block: RenderedBlock;
  drift?: boolean;
  changedIn?: number;
  continuesChange: boolean;
  commenting: boolean;
  onComment: () => void;
  children?: ReactNode;
}) {
  const readOnly = useReadOnlyReview();
  return (
    <div
      className="em-reading-block relative rounded-sm"
      data-drift={drift ? "" : undefined}
      data-commenting={commenting ? "" : undefined}
      data-change-continuation={changedIn !== undefined && continuesChange ? "" : undefined}
    >
      {changedIn !== undefined && (
        <>
          <span aria-hidden="true" className="em-reading-block__change absolute w-0.5 bg-changed-line" />
          {!continuesChange && (
            <div className="em-reading-block__marker mb-1.5 flex">
              <ChangedMarker revision={changedIn} />
            </div>
          )}
        </>
      )}
      <BlockView block={block} />
      {!readOnly && block.kind !== "heading" && blockAnchor(block).quote !== "" && (
        <span className="em-reading-block__comment">
          <IconButton
            icon={MessageSquarePlus}
            label={block.kind === "chart" || block.kind === "diagram" ? `Comment on ${block.kind}` : "Comment on block"}
            size="sm"
            variant="ghost"
            className="size-6 [&:not(:disabled):not([aria-disabled=true])]:hover:bg-accent-tint [&:not(:disabled):not([aria-disabled=true])]:hover:text-accent-text"
            onMouseUpCapture={(event) => event.stopPropagation()}
            onKeyUpCapture={(event) => event.stopPropagation()}
            onClick={onComment}
          />
        </span>
      )}
      {children}
    </div>
  );
}
