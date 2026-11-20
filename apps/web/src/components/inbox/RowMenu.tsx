import type { InboxItem } from "@emend/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { removeReviewQueries } from "../../api/mutations.ts";
import { inboxQuery } from "../../api/queries.ts";
import { isReviewSending, subscribeDrafts } from "../../lib/drafts.ts";
import { useLayout } from "../../lib/layout.ts";
import { ResumeDialog, showsHandOver } from "../send/HandOver.tsx";
import { ReviewActionDialogs, useReviewActions } from "../send/ReviewActions.tsx";
import { AnchoredMenu } from "../ui/Menu.tsx";

export interface RowMenuRequest {
  reviewId: string;
  via: "keyboard" | "pointer";
  anchor: { x: number; y: number; width: number; height: number };
  side?: "bottom" | "right";
  align?: "start" | "end";
  /** The row's focusable element, for focus after the menu or a dialog closes. */
  row: HTMLElement;
  /** Called when the menu closes, to hide the swipe button. */
  onClose?: () => void;
}

const RowMenuContext = createContext<((request: RowMenuRequest) => void) | null>(null);

type RowMenuTarget = RowMenuRequest & { surface: Element | null };

function rowToFocus(request: RowMenuTarget): HTMLElement | null {
  if (request.row.isConnected) return request.row;
  if (!request.surface?.isConnected) return null;
  return request.surface.querySelector<HTMLElement>(`[data-row-menu="${CSS.escape(request.reviewId)}"]`);
}

export function RowMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ request: RowMenuTarget; open: boolean } | null>(null);
  const followedRow = useRef<HTMLElement | null>(null);
  const inbox = useQuery(inboxQuery());
  const open = useCallback((request: RowMenuRequest) => {
    followedRow.current = null;
    setMenu({ request: { ...request, surface: request.row.closest("[data-row-menu-surface]") }, open: true });
  }, []);
  const request = menu?.request;
  useEffect(() => {
    if (!request) return;
    // Dialogs can restore their saved opener without reading returnFocus again.
    const onFocus = (event: FocusEvent) => {
      const row = rowToFocus(request);
      followedRow.current = row && event.target === row ? row : null;
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [request]);
  useLayoutEffect(() => {
    const followed = followedRow.current;
    if (!request || !inbox.data || !followed || document.activeElement === followed) return;
    if (followed.isConnected || (document.activeElement && document.activeElement !== document.body)) {
      followedRow.current = null;
      return;
    }
    const row = rowToFocus(request);
    followedRow.current = row;
    row?.focus();
  }, [inbox.data, request]);
  const item = inbox.data?.items.find((item) => item.id === menu?.request.reviewId);
  return (
    <RowMenuContext value={open}>
      {children}
      {menu && item && !item.movedTo && (
        <RowActions
          key={item.id}
          item={item}
          request={menu.request}
          open={menu.open}
          onOpenChange={(open) => {
            setMenu({ ...menu, open });
            if (!open) menu.request.onClose?.();
          }}
        />
      )}
    </RowMenuContext>
  );
}

export function useRowMenu(): ((request: RowMenuRequest) => void) | null {
  return use(RowMenuContext);
}

/** Handlers for the row's focusable element; moved rows keep the browser menu. */
export function useRowMenuTrigger(review: InboxItem, options?: { side?: "bottom" | "right" }) {
  const open = useRowMenu();
  if (!open || review.movedTo) return undefined;
  const show = (row: HTMLElement, anchor: RowMenuRequest["anchor"], via: RowMenuRequest["via"]) =>
    open({ reviewId: review.id, row, anchor, via, side: options?.side });
  return {
    onContextMenu(event: MouseEvent<HTMLElement>) {
      event.preventDefault();
      const { clientX: x, clientY: y, currentTarget: row } = event;
      const keyboard = x === 0 && y === 0;
      show(
        row,
        keyboard ? row.getBoundingClientRect() : { x, y, width: 0, height: 0 },
        keyboard ? "keyboard" : "pointer",
      );
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      event.preventDefault();
      show(event.currentTarget, event.currentTarget.getBoundingClientRect(), "keyboard");
    },
  };
}

function RowActions({
  item,
  request,
  open,
  onOpenChange,
}: {
  item: InboxItem;
  request: RowMenuTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { reviewId } = useParams({ strict: false });
  const phone = useLayout() === "phone";
  const [resumeOpen, setResumeOpen] = useState(false);
  const sending = useSyncExternalStore(subscribeDrafts, () => isReviewSending(item.id));
  const canResume =
    !phone &&
    showsHandOver({
      approved: item.state === "approved",
      retired: item.state === "settled",
      releasedAt: item.releasedAt,
    }) &&
    !item.agentWaiting;
  useEffect(() => {
    if (resumeOpen && !canResume) setResumeOpen(false);
  }, [resumeOpen, canResume]);
  const actions = useReviewActions({
    reviewId: item.id,
    lifecycle: {
      title: item.title,
      groupId: item.groupId,
      pinned: item.pinnedAt !== null,
      state: item.state,
      snoozed: item.snoozed,
      snoozedUntil: item.snoozedUntil,
      onDeleted: () => {
        if (reviewId === item.id) void navigate({ to: "/" }).then(() => removeReviewQueries(client, item.id));
        else removeReviewQueries(client, item.id);
      },
    },
    unsentCount: item.unsentCount,
    howToResume: phone ? undefined : { disabled: !canResume || sending, onSelect: () => setResumeOpen(true) },
  });
  const returnFocus = {
    get current() {
      return rowToFocus(request);
    },
  };
  return (
    <>
      <AnchoredMenu
        label={`Actions for “${item.title}”`}
        open={open}
        onOpenChange={onOpenChange}
        anchor={request.anchor}
        side={request.side}
        align={request.align}
        size={phone ? "lg" : "md"}
        items={actions.items}
        focusFirstItem={request.via === "keyboard"}
        returnFocus={() => returnFocus.current}
      />
      <ReviewActionDialogs actions={actions} returnFocus={returnFocus} />
      {!phone && (
        <ResumeDialog
          reviewId={item.id}
          agent={{
            agentWaiting: item.agentWaiting,
            pendingSend: item.pendingSend,
            pickedUpAt: item.pickedUpAt,
            releasedAt: item.releasedAt,
            newestRevision: item.newestRevision,
          }}
          lifecycle={{ state: item.state, snoozed: item.snoozed }}
          open={resumeOpen}
          onOpenChange={setResumeOpen}
          returnFocus={returnFocus}
        />
      )}
    </>
  );
}
