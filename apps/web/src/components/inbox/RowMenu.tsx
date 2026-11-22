import type { InboxItem } from "@emend/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowDown, ArrowUp } from "lucide-react";
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
import { AnchoredMenu, type MenuItem } from "../ui/Menu.tsx";
import { usePinOrder } from "./PinOrder.tsx";

export interface RowMenuRequest {
  reviewId: string;
  inPinnedList?: boolean;
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

type RowMenuTarget = RowMenuRequest & { surface: Element | null; candidateIds: string[] };

function rowToFocus(request: RowMenuTarget): HTMLElement | null {
  if (request.row.isConnected) return request.row;
  if (!request.surface?.isConnected) return null;
  for (const id of request.candidateIds) {
    const row = request.surface.querySelector<HTMLElement>(`[data-row-menu="${CSS.escape(id)}"]`);
    if (row) return row;
  }
  return null;
}

export function RowMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ request: RowMenuTarget; open: boolean } | null>(null);
  const followedRow = useRef<HTMLElement | null>(null);
  const inbox = useQuery(inboxQuery());
  const open = useCallback((request: RowMenuRequest) => {
    followedRow.current = null;
    const surface = request.row.closest("[data-row-menu-surface]");
    const rows = Array.from(surface?.querySelectorAll<HTMLElement>("[data-row-menu]") ?? []);
    const index = rows.indexOf(request.row);
    const candidateIds = [
      request.reviewId,
      ...[...rows.slice(index + 1), ...rows.slice(0, index).reverse()].map((row) => row.dataset.rowMenu ?? ""),
    ];
    setMenu({ request: { ...request, surface, candidateIds }, open: true });
  }, []);
  const request = menu?.request;
  useEffect(() => {
    if (!request) return;
    // Dialogs can restore their saved opener without reading returnFocus again.
    const onFocus = (event: FocusEvent) => {
      const row = rowToFocus(request);
      followedRow.current = row && event.target === row ? row : null;
    };
    const onBlur = (event: FocusEvent) => {
      const followed = followedRow.current;
      if (!followed || event.target !== followed) return;
      // A reader can blur to the body without a focusin; removal must still let focus follow.
      queueMicrotask(() => {
        if (followedRow.current === followed && followed.isConnected) followedRow.current = null;
      });
    };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
    };
  }, [request]);
  useLayoutEffect(() => {
    const followed = followedRow.current;
    if (!request || !inbox.data || !followed || followed.isConnected) return;
    if (document.activeElement && document.activeElement !== document.body) {
      followedRow.current = null;
      return;
    }
    const row = rowToFocus(request);
    followedRow.current = row;
    row?.focus({ preventScroll: true });
  }, [inbox.data, request]);
  const item = inbox.data?.items.find((item) => item.id === menu?.request.reviewId);
  if (menu?.open && (!item || item.movedTo)) setMenu({ ...menu, open: false });
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
export function useRowMenuTrigger(review: InboxItem, options?: { side?: "bottom" | "right"; inPinnedList?: boolean }) {
  const open = useRowMenu();
  if (!open || review.movedTo) return undefined;
  const show = (row: HTMLElement, anchor: RowMenuRequest["anchor"], via: RowMenuRequest["via"]) =>
    open({ reviewId: review.id, row, anchor, via, side: options?.side, inPinnedList: options?.inPinnedList });
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
  const pinOrder = usePinOrder();
  const moves = request.inPinnedList ? pinOrder?.actions.movesFor(item.id) : undefined;
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
  const items = actions.items.flatMap<MenuItem>((item) => {
    if (!("label" in item) || item.label !== "Unpin") return [item];
    return [
      item,
      ...(moves?.up ? [{ label: "Move up", icon: ArrowUp, onSelect: moves.up }] : []),
      ...(moves?.down ? [{ label: "Move down", icon: ArrowDown, onSelect: moves.down }] : []),
    ];
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
        items={items}
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
