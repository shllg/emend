import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PanelLeftOpen } from "lucide-react";
import { inboxQuery } from "../../api/queries.ts";
import { OriginBadge } from "../status/OriginBadge.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import { cn } from "../ui/utils.ts";
import { doneDimmed, looksDone, needsAttention } from "./ReviewRow.tsx";

export function InboxRail({ onShow }: { onShow: () => void }) {
  // The collapsed rail ignores kind and machine filters; the expanded inbox applies its kind choice.
  const query = useQuery(inboxQuery());
  return (
    <aside
      aria-label="Inbox"
      className="flex w-(--inbox-w-collapsed) shrink-0 flex-col items-center gap-2 border-r border-line-1 bg-app py-2"
    >
      <IconButton label="Show inbox" icon={PanelLeftOpen} onClick={onShow} />
      <div className="relative min-h-0 w-full flex-1 overflow-y-auto">
        <ul className="flex flex-col items-center gap-0.5">
          {query.data?.items
            .filter((review) => !review.movedTo)
            .map((review) => (
              <li key={review.id}>
                <Tooltip content={review.title}>
                  <Link
                    to="/r/$reviewId"
                    params={{ reviewId: review.id }}
                    search={{ rev: review.newestRevision }}
                    aria-label={`${needsAttention(review) ? "Needs you: " : ""}${review.title}`}
                    activeOptions={{ includeSearch: false }}
                    activeProps={{ "aria-current": "page" }}
                    className={cn(
                      "relative grid h-8 w-9 place-items-center rounded-[6px] no-underline hover:bg-hover aria-[current=page]:bg-selected [&>span[role=img]]:size-2.5",
                      looksDone(review) && doneDimmed,
                    )}
                  >
                    <OriginBadge origin={review.origin} dot />
                    {needsAttention(review) && (
                      <span
                        aria-hidden="true"
                        className="absolute top-1.5 right-[7px] size-1.5 rounded-full bg-accent"
                      />
                    )}
                  </Link>
                </Tooltip>
              </li>
            ))}
        </ul>
      </div>
    </aside>
  );
}
