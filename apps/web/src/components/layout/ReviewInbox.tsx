import { useEffect, useState } from "react";
import { useLayout } from "../../lib/layout.ts";
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
        <Inbox compact onCollapse={() => onCollapsedChange(true)} />
      </aside>
    );
  return (
    <>
      <InboxRail onShow={() => (layout === "tablet" ? setOpen(true) : onCollapsedChange(false))} />
      {layout === "tablet" && (
        <Sheet side="left" title="Inbox" open={open} onOpenChange={setOpen}>
          <Inbox compact hideHead onOpen={() => setOpen(false)} />
        </Sheet>
      )}
    </>
  );
}
