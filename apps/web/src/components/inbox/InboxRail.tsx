import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { PanelLeftOpen } from "lucide-react";
import type { Ref } from "react";
import { inboxQuery, serverNow } from "../../api/queries.ts";
import { inboxSections, inboxSequence } from "../../lib/inbox-list.ts";
import { ariaKeyShortcuts, jumpBadge, jumpCommands } from "../../lib/shortcuts.ts";
import { useJumpShortcuts, useShortcutKeys } from "../../lib/use-shortcut.tsx";
import { OriginBadge } from "../status/OriginBadge.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import { cn } from "../ui/utils.ts";
import { doneDimmed, looksDone, needsAttention } from "./ReviewRow.tsx";

export function InboxRail({ onShow, showRef }: { onShow: () => void; showRef?: Ref<HTMLButtonElement> }) {
  // The collapsed rail ignores Kind, search, machine and project filters and folds.
  // It numbers its first ten rows, pinned items first.
  const query = useQuery(inboxQuery());
  const navigate = useNavigate();
  const keys = useShortcutKeys();
  const sections = inboxSections(query.data?.items ?? [], serverNow(query.data), { groups: query.data?.groups });
  const rows = inboxSequence(sections.map((section) => ({ ...section, expanded: true })));
  useJumpShortcuts((index) => {
    const item = rows[index];
    if (!item) return;
    void navigate({ to: "/r/$reviewId", params: { reviewId: item.id }, search: { rev: item.newestRevision } });
  });
  return (
    <aside
      aria-label="Inbox"
      className="flex w-(--inbox-w-collapsed) shrink-0 flex-col items-center gap-2 border-r border-line-1 bg-app py-2"
    >
      <IconButton ref={showRef} label="Show inbox" icon={PanelLeftOpen} onClick={onShow} />
      <div className="relative min-h-0 w-full flex-1 overflow-y-auto">
        <ul className="flex flex-col items-center gap-0.5">
          {rows.map((review, index) => {
            const command = jumpCommands[index];
            const key = command ? keys[command] : null;
            const badge = jumpBadge(key);
            return (
              <li key={review.id}>
                <Tooltip content={review.title}>
                  <Link
                    aria-keyshortcuts={key === null ? undefined : ariaKeyShortcuts(key)}
                    to="/r/$reviewId"
                    params={{ reviewId: review.id }}
                    search={{ rev: review.newestRevision }}
                    aria-label={`${needsAttention(review) ? "Needs you: " : ""}${review.title}`}
                    activeOptions={{ includeSearch: false }}
                    activeProps={{ "aria-current": "page" }}
                    className={cn(
                      "relative grid h-8 w-9 place-items-center rounded-[6px] no-underline hover:bg-hover aria-[current=page]:bg-selected [&>span[role=img]]:size-[0.625rem]",
                      looksDone(review) && doneDimmed,
                    )}
                  >
                    {badge && (
                      <span
                        aria-hidden="true"
                        data-jump-number
                        className="absolute top-1/2 left-0.5 -translate-y-1/2 font-mono text-[10px] font-medium leading-none text-fg-3 tabular-nums"
                      >
                        {badge}
                      </span>
                    )}
                    <OriginBadge origin={review.origin} dot />
                    {needsAttention(review) && (
                      <span
                        aria-hidden="true"
                        className="absolute top-1.5 right-[7px] size-[0.375rem] rounded-full bg-accent"
                      />
                    )}
                  </Link>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
