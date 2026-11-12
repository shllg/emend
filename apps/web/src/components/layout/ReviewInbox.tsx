import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { inboxQuery, serverNow } from "../../api/queries.ts";
import { adjacentInboxItem, inboxSections, inboxSequence, readInboxKind } from "../../lib/inbox-list.ts";
import { useLayout } from "../../lib/layout.ts";
import { useShortcut } from "../../lib/use-shortcut.tsx";
import { Inbox } from "../../routes/inbox.tsx";
import { InboxRail } from "../inbox/InboxRail.tsx";
import { Sheet } from "../ui/Sheet.tsx";

export function ReviewInbox({
  collapsed,
  onCollapsedChange,
}: {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const layout = useLayout();
  const [open, setOpen] = useState(false);
  const query = useQuery(inboxQuery());
  const navigate = useNavigate();
  const { reviewId } = useParams({ strict: false });
  const search = useRef<HTMLInputElement>(null);
  const focusSearch = useRef(false);
  const mountedInbox = (layout === "desktop" && !collapsed) || (layout === "tablet" && open);
  const move = (delta: 1 | -1) => {
    if (!query.data) return false;
    const sequence = inboxSequence(inboxSections(query.data.items, serverNow(query.data), { kind: readInboxKind() }));
    const item = adjacentInboxItem(sequence, reviewId, delta);
    if (!item) return false;
    void navigate({ to: "/r/$reviewId", params: { reviewId: item.id }, search: { rev: item.newestRevision } });
    return true;
  };
  useShortcut("inbox.next", () => move(1), { enabled: !mountedInbox });
  useShortcut("inbox.previous", () => move(-1), { enabled: !mountedInbox });
  useShortcut(
    "inbox.search",
    () => {
      focusSearch.current = true;
      if (layout === "tablet") setOpen(true);
      else onCollapsedChange(false);
      return true;
    },
    { enabled: !mountedInbox },
  );
  useEffect(() => {
    if (layout !== "tablet") setOpen(false);
  }, [layout]);
  if (layout === "desktop" && !collapsed)
    return (
      <aside
        aria-label="Inbox"
        data-testid="inbox-pane"
        className="flex min-h-0 w-(--inbox-w) shrink-0 flex-col bg-app"
      >
        <Inbox
          compact
          onCollapse={() => onCollapsedChange(true)}
          searchRef={(node) => {
            search.current = node;
            if (node && focusSearch.current) {
              focusSearch.current = false;
              node.focus();
            }
          }}
        />
      </aside>
    );
  return (
    <>
      <InboxRail onShow={() => (layout === "tablet" ? setOpen(true) : onCollapsedChange(false))} />
      {layout === "tablet" && (
        <Sheet
          side="left"
          title="Inbox"
          open={open}
          onOpenChange={(value) => {
            setOpen(value);
            if (!value) focusSearch.current = false;
          }}
          initialFocus={focusSearch.current ? search : undefined}
        >
          <Inbox compact hideHead searchRef={search} onOpen={() => setOpen(false)} />
        </Sheet>
      )}
    </>
  );
}
