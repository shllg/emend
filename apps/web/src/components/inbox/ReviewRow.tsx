import type { InboxItem } from "@emend/contract";
import { Link } from "@tanstack/react-router";
import { Ellipsis, MessageSquare, Pencil, Pin } from "lucide-react";
import { useRef } from "react";
import { plural } from "../../lib/count.ts";
import { useLayout } from "../../lib/layout.ts";
import { relativeTime, wakeHasPassed, wakeTime } from "../../lib/time.ts";
import { useRowSwipe } from "../../lib/use-row-swipe.ts";
import { agentDotClasses, agentStatusOf, agentStatusText } from "../status/AgentStatus.tsx";
import { OriginBadge } from "../status/OriginBadge.tsx";
import { StateBadge } from "../status/StateBadge.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { cn } from "../ui/utils.ts";
import { useRowMenu, useRowMenuTrigger } from "./RowMenu.tsx";

/** Approved and Done reviews need no work: dim them until the reviewer points at or focuses one. */
export const doneDimmed = "opacity-60 hover:opacity-100 focus-within:opacity-100 aria-[current=page]:opacity-100";

export function looksDone(review: InboxItem) {
  return review.list === "done" || review.state === "approved";
}

export function needsAttention(review: InboxItem) {
  return (
    review.state === "open" && !review.snoozed && !review.movedTo && (review.agentWaiting || review.unsentCount > 0)
  );
}

export function ReviewRow({
  review,
  now,
  onOpen,
  highlight = false,
  pinned = false,
  jump,
  keyShortcuts,
}: {
  review: InboxItem;
  now: number;
  onOpen?: () => void;
  highlight?: boolean;
  pinned?: boolean;
  jump?: string;
  keyShortcuts?: string;
}) {
  const openMenu = useRowMenu();
  const menuTrigger = useRowMenuTrigger(review);
  const swipe = useRowSwipe(!!openMenu && !review.movedTo);
  const link = useRef<HTMLAnchorElement>(null);
  const phone = useLayout() === "phone";
  const attention = needsAttention(review);
  const agent = agentStatusOf(review);
  const contents = (
    <>
      <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-1.5 text-11 leading-[1.2] text-fg-3">
        {jump && !review.movedTo && (
          <span
            aria-hidden="true"
            data-jump-number
            className="inline-grid h-[14px] min-w-[14px] shrink-0 place-items-center rounded-[3px] border border-line-2 px-[3px] font-mono text-[10px] font-medium leading-none text-fg-3 tabular-nums"
          >
            {jump}
          </span>
        )}
        <span aria-hidden="true" className="inline-flex [&>span]:size-[7px] [&>span]:opacity-85">
          <OriginBadge origin={review.origin} dot />
        </span>
        <span className="min-w-0 truncate">{review.origin.name}</span>
        {review.project !== null && (
          <>
            <span aria-hidden="true" className="shrink-0 text-fg-3">
              ·
            </span>
            <span dir="auto" className="min-w-0 truncate">
              {review.project}
            </span>
          </>
        )}
      </span>
      <span className="col-start-2 row-start-1 inline-flex items-center whitespace-nowrap text-12 font-normal text-fg-3 tabular-nums">
        {pinned && (
          <span role="img" aria-label="Pinned" className="mr-1.5 inline-flex text-fg-3">
            <Icon icon={Pin} size={11} />
          </span>
        )}
        {review.snoozed ? (
          review.snoozedUntil ? (
            wakeHasPassed(review.snoozedUntil, now) ? (
              <span>waking up</span>
            ) : (
              <time dateTime={review.snoozedUntil} title={new Date(review.snoozedUntil).toLocaleString()}>
                until {wakeTime(review.snoozedUntil, now)}
              </time>
            )
          ) : (
            <span>until it changes</span>
          )
        ) : review.state === "open" ? (
          <time dateTime={review.updatedAt} title={new Date(review.updatedAt).toLocaleString()}>
            {relativeTime(review.updatedAt, now)}
          </time>
        ) : (
          <StateBadge state={review.state} variant="inline" />
        )}
      </span>
      <span
        className={cn(
          "relative col-span-2 row-start-2 min-w-0 text-13 leading-[1.35] font-[450] group-aria-[current=page]:font-medium group-aria-[current=page]:text-fg-1",
          attention && "font-medium text-fg-1",
        )}
      >
        {attention && (
          <span
            aria-hidden="true"
            className="absolute top-1/2 -left-2.5 size-[5px] -translate-y-1/2 rounded-full bg-accent"
          />
        )}
        <span className="block truncate">
          {attention && <span className="sr-only">Needs you. </span>}
          {review.title}
        </span>
      </span>
      <span className="col-start-1 row-start-3 truncate font-mono text-12 leading-[1.3] text-fg-3">
        {review.movedTo ? `Moved to ${new URL(review.movedTo).host}` : review.branch}
      </span>
      {!review.movedTo && (
        <span className="col-start-2 row-start-3 flex items-center justify-end gap-2 text-11 font-medium leading-none text-fg-3 tabular-nums">
          {review.openThreads > 0 && (
            <span className="inline-flex items-center gap-[3px]">
              <Icon icon={MessageSquare} size={11} />
              {review.openThreads}
              <span className="sr-only">{plural(review.openThreads, " open thread")}</span>
            </span>
          )}
          {review.unsentCount > 0 && (
            <span className="inline-flex items-center gap-[3px] text-accent-text">
              <Icon icon={Pencil} size={11} />
              {review.unsentCount}
              <span className="sr-only"> unsent</span>
            </span>
          )}
          {agent && agent !== "approved" && (
            <span
              role="img"
              aria-label={agentStatusText(agent, review.pickedUpAt, now)}
              className={cn("size-[7px] shrink-0 rounded-full", agentDotClasses[agent])}
            />
          )}
        </span>
      )}
    </>
  );
  const className = cn(
    "group relative grid w-full grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto_auto] gap-x-2 gap-y-0.75 rounded-sm px-2.5 pt-2 pb-2.25 text-left text-fg-2 no-underline",
    highlight && "em-inbox-new",
  );
  return (
    <li ref={swipe.row} className={cn("relative", swipe.offset !== 0 && "overflow-hidden")}>
      {review.movedTo ? (
        <div className={cn(className, "opacity-50")} aria-disabled="true">
          {contents}
        </div>
      ) : (
        <Link
          ref={link}
          {...menuTrigger}
          {...swipe.handlers}
          style={{ transform: swipe.offset !== 0 ? `translateX(${swipe.offset}px)` : undefined }}
          data-inbox-row={review.id}
          aria-keyshortcuts={keyShortcuts}
          to="/r/$reviewId"
          params={{ reviewId: review.id }}
          search={{ rev: review.newestRevision }}
          activeOptions={{ includeSearch: false }}
          activeProps={{ "aria-current": "page" }}
          onClick={(event) => {
            swipe.guardClick(event);
            if (
              !event.defaultPrevented &&
              event.button === 0 &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey &&
              !event.altKey
            )
              onOpen?.();
          }}
          className={cn(
            className,
            "touch-pan-y touch-pinch-zoom hover:bg-hover hover:text-fg-2 aria-[current=page]:bg-active motion-reduce:transition-none",
            !swipe.dragging && "transition-transform duration-(--dur-2) ease-(--ease-out)",
            looksDone(review) && doneDimmed,
          )}
        >
          {contents}
        </Link>
      )}
      {swipe.offset < 0 && openMenu && !review.movedTo && (
        <div
          className="absolute inset-y-0 right-0 flex items-center justify-end overflow-hidden"
          style={{ width: -swipe.offset }}
        >
          <IconButton
            icon={Ellipsis}
            label={`Actions for “${review.title}”`}
            tooltip={false}
            size={phone ? "lg" : "md"}
            onClick={(event) => {
              if (!link.current) return;
              openMenu({
                reviewId: review.id,
                anchor: event.currentTarget.getBoundingClientRect(),
                align: "end",
                row: link.current,
                onClose: swipe.hide,
              });
            }}
          />
        </div>
      )}
    </li>
  );
}
