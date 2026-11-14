import { type MouseEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDraftClaim } from "../../lib/composer-owner.ts";
import { draftKey, editDraftKey } from "../../lib/drafts.ts";
import { useLayout } from "../../lib/layout.ts";
import { focusReadingTarget } from "../../lib/reading-focus.ts";
import { Composer } from "../threads/Composer.tsx";
import { canReplyToThread, ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import type { ReaderProps } from "./BlockReader.tsx";
import { passageRect, type ReaderThread, visibleReadingArea } from "./reader-thread-ranges.ts";
import type { useReaderThreads } from "./use-reader-threads.ts";

type State = ReturnType<typeof useReaderThreads>;
export function ReadingThreads({
  state,
  root,
  ...props
}: Pick<ReaderProps, "reviewId" | "revision" | "changedBlocks" | "topics"> & {
  state: State;
  root: RefObject<HTMLDivElement | null>;
}) {
  const phone = useLayout() === "phone";
  const { openEntry, popover, chips, chipsRef, index, total, step, close } = state;
  const [position, setPosition] = useState({ top: 0, maxHeight: 400 });
  const navigation = useRef<HTMLElement>(null);
  const sequenceInside = useRef(false);
  const openId = openEntry?.thread.id;
  const isOpen = !!openEntry;
  useLayoutEffect(() => {
    if (!isOpen) return;
    sequenceInside.current = false;
    const trackSequence = (event: globalThis.MouseEvent) => {
      if (event.detail > 1) return;
      const surface = phone ? navigation.current?.closest('[role="dialog"]') : popover.current;
      sequenceInside.current = event.target instanceof Node && !!surface?.contains(event.target);
    };
    // Document capture records the sequence origin before the surface's React capture handler runs.
    document.addEventListener("click", trackSequence, true);
    return () => document.removeEventListener("click", trackSequence, true);
  }, [isOpen, phone, popover]);
  const ignoreContinuationClick = (event: MouseEvent) => {
    if (event.detail > 1 && !sequenceInside.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  useLayoutEffect(() => {
    if (!openId || phone) return;
    if (popover.current) popover.current.scrollTop = 0;
    if (!(document.activeElement instanceof HTMLTextAreaElement && popover.current?.contains(document.activeElement)))
      focusReadingTarget(popover.current);
  }, [openId, phone, popover]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Chip geometry changes after a fold or resize must reposition the open dialog.
  useLayoutEffect(() => {
    if (!openEntry || phone || !root.current || !popover.current) return;
    const column = root.current;
    const panel = popover.current;
    const measure = () => {
      const area = visibleReadingArea(column);
      const rect = passageRect(openEntry, area) ?? openEntry.element.getBoundingClientRect();
      const below = Math.max(0, area.bottom - rect.bottom - 8);
      const above = Math.max(0, rect.top - area.top - 8);
      const available = Math.max(0, area.bottom - area.top - 16);
      const minimum = Math.min(192, available);
      // A passage can fill the viewport. Overlay only when neither side can hold a usable dialog.
      const overlay = below < minimum && above < minimum;
      const up = below < Math.min(448, panel.scrollHeight) && above > below;
      const maxHeight = Math.min(448, overlay ? available : up ? above : below);
      const height = Math.min(panel.scrollHeight, maxHeight);
      const top =
        (overlay ? area.bottom - height - 8 : up ? rect.top - height - 8 : rect.bottom + 8) -
        column.getBoundingClientRect().top;
      setPosition((old) => (old.top === top && old.maxHeight === maxHeight ? old : { top, maxHeight }));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(panel);
    observer?.observe(column);
    const { scroller } = visibleReadingArea(column);
    if (scroller) observer?.observe(scroller);
    else window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [openEntry, phone, popover, root, chips]);
  const stepper = (
    <nav ref={navigation} className="flex items-center gap-2" aria-label="Comment navigation">
      <Button size="sm" disabled={index <= 0} onClick={() => step(-1)}>
        Previous
      </Button>
      <span role="status" className="whitespace-nowrap text-13">
        {index + 1} of {total}
      </span>
      <Button size="sm" disabled={index >= total - 1} onClick={() => step(1)}>
        Next
      </Button>
      {!phone && (
        <Button size="sm" onClick={() => close(true)}>
          Close
        </Button>
      )}
    </nav>
  );
  const card = openEntry && (
    <ThreadCard
      key={openEntry.thread.id}
      {...props}
      thread={openEntry.thread}
      surface="reading"
      replyInFooter={phone}
    />
  );
  return (
    <>
      {state.entries.map((entry) => (
        <ThreadDraftIntent
          key={entry.thread.id}
          entry={entry}
          reviewId={props.reviewId}
          active={entry.thread.id === openId}
          open={state.open}
        />
      ))}
      {chips.map((chip) => {
        const first = chip.entries[0];
        if (!first) return null;
        return (
          <button
            key={first.thread.id}
            type="button"
            data-thread-chip
            className="em-thread-chip"
            style={{ top: chip.top }}
            ref={(element) => {
              for (const entry of chip.entries) {
                if (element) chipsRef.current.set(entry.thread.id, element);
                else chipsRef.current.delete(entry.thread.id);
              }
            }}
            aria-label={`${chip.entries.length} ${chip.entries.length === 1 ? "comment" : "comments"}`}
            aria-haspopup="dialog"
            aria-expanded={chip.entries.some((entry) => entry.thread.id === openEntry?.thread.id)}
            onClick={() => state.open(first)}
          >
            {chip.entries.length}
          </button>
        );
      })}
      {openEntry &&
        (phone ? (
          <Sheet
            portalContainer={document.body}
            side="bottom"
            title="Comment thread"
            open
            returnFocus={() => {
              // A route change or a resize owns the new focus after this sheet unmounts.
              if (!root.current?.isConnected || root.current.querySelector("[data-reading-thread-popover]"))
                return document.activeElement instanceof HTMLElement ? document.activeElement : null;
              return state.returnFocus();
            }}
            onOpenChange={(open) => {
              if (!open) close();
            }}
            footer={
              canReplyToThread(openEntry.thread) && (
                <div className="w-full" onClickCapture={ignoreContinuationClick}>
                  <Composer
                    inline
                    embedded
                    reviewId={props.reviewId}
                    revision={props.revision}
                    target={openEntry.thread.target}
                    topics={props.topics}
                    threadId={openEntry.thread.id}
                    returnFocus={() => navigation.current?.closest<HTMLElement>('[role="dialog"]') ?? null}
                  />
                </div>
              )
            }
          >
            <div data-reading-thread-sheet className="space-y-4" onClickCapture={ignoreContinuationClick}>
              {stepper}
              {card}
            </div>
          </Sheet>
        ) : (
          <div
            ref={popover}
            className="em-reading-thread-popover"
            data-reading-thread-popover
            role="dialog"
            aria-modal="false"
            aria-label="Comment thread"
            tabIndex={-1}
            style={position}
            onClickCapture={ignoreContinuationClick}
            onKeyDown={(event) => {
              if (
                event.key === "Escape" &&
                !event.defaultPrevented &&
                event.target instanceof Element &&
                event.target.closest('[role="dialog"], [role="alertdialog"]') === event.currentTarget
              ) {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              }
            }}
          >
            <div className="sticky top-0 z-1 border-b border-line-1 bg-surface p-2">{stepper}</div>
            {card}
          </div>
        ))}
    </>
  );
}

/** Honor an explicit Resume without opening threads merely because they have saved drafts. */
function ThreadDraftIntent({
  entry,
  reviewId,
  active,
  open,
}: {
  entry: ReaderThread;
  reviewId: string;
  active: boolean;
  open: State["open"];
}) {
  const reply = draftKey(reviewId, entry.thread.target, entry.thread.id);
  const edits = entry.thread.comments
    .filter((comment) => comment.author === "user" && !comment.sent)
    .map((comment) => editDraftKey(reviewId, comment.id));
  const claim = useDraftClaim([reply, ...edits], "reading");
  const [handled, setHandled] = useState<typeof claim>();
  useEffect(() => {
    if (!active && claim && claim !== handled) open(entry, true);
    if (claim !== handled) setHandled(claim);
  }, [claim, handled, entry, active, open]);
  return null;
}
