import type { InboxItem, ReviewPinPlaceRequest } from "@emend/contract";
import { useIsFetching, useIsMutating, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, use, useRef, useState } from "react";
import { mutationMessage, usePlacePin } from "../../api/mutations.ts";
import { type InboxData, inboxQuery } from "../../api/queries.ts";
import { useLayout } from "../../lib/layout.ts";
import { usePinDrag } from "../../lib/use-pin-drag.ts";
import { useToast } from "../ui/Toast.tsx";

export interface PinMoves {
  up: boolean;
  down: boolean;
}
interface PinOrderContextValue {
  state: { rows: InboxItem[] };
  actions: {
    movesFor: (reviewId: string) => PinMoves | undefined;
    move: (reviewId: string, direction: "up" | "down") => void;
    drop: (reviewId: string, slot: number) => void;
  };
  meta: { draggable: boolean };
}
const PinOrderContext = createContext<PinOrderContextValue | null>(null);
const PinListContext = createContext<
  (Omit<PinOrderContextValue, "state"> & { state: { draggingId: string | null } }) | null
>(null);

/** Menus and the list share actions derived from the currently shown Pinned rows. */
export function PinOrderProvider({
  rows,
  source,
  children,
}: {
  rows: InboxItem[];
  source: InboxData | undefined;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const mutation = usePlacePin();
  const toast = useToast();
  const draggable = useLayout() !== "phone";
  const placing = useIsMutating({ mutationKey: ["pin-place"] });
  const fetchingInbox = useIsFetching({ queryKey: ["inbox"] });
  const [acceptedReview, setAcceptedReview] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState({ serial: 0, text: "" });
  // Announce the latest acceptance after placements and refetches settle and rendered rows match the cache.
  if (acceptedReview && placing === 0 && fetchingInbox === 0 && source === client.getQueryData(inboxQuery().queryKey)) {
    setAcceptedReview(null);
    const index = rows.findIndex((row) => row.id === acceptedReview);
    if (index >= 0)
      setAnnouncement({
        serial: announcement.serial + 1,
        text: `Moved to place ${index + 1} of ${rows.length}`,
      });
  }
  const place = async (reviewId: string, placement: ReviewPinPlaceRequest) => {
    try {
      await mutation.mutateAsync({ reviewId, place: placement });
      setAcceptedReview(reviewId);
    } catch (error) {
      toast.show({ tone: "danger", title: mutationMessage(error as Error) });
    }
  };
  const move = (reviewId: string, direction: "up" | "down") => {
    const index = rows.findIndex((row) => row.id === reviewId);
    if (index < 0) return;
    const neighbour = rows[index + (direction === "up" ? -1 : 1)];
    if (neighbour) void place(reviewId, direction === "up" ? { before: neighbour.id } : { after: neighbour.id });
  };
  const drop = (reviewId: string, slot: number) => {
    const index = rows.findIndex((row) => row.id === reviewId);
    if (index < 0 || slot < 0 || slot > rows.length || slot === index || slot === index + 1) return;
    const anchor = rows[slot] ?? rows.at(-1);
    if (anchor) void place(reviewId, slot === rows.length ? { after: anchor.id } : { before: anchor.id });
  };
  const value: PinOrderContextValue = {
    state: { rows },
    actions: {
      drop,
      move,
      movesFor: (reviewId) => {
        const index = rows.findIndex((row) => row.id === reviewId);
        if (index < 0) return undefined;
        return { up: index > 0, down: index < rows.length - 1 };
      },
    },
    meta: { draggable },
  };
  return (
    <PinOrderContext value={value}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        <span key={announcement.serial}>{announcement.text}</span>
      </div>
    </PinOrderContext>
  );
}

/** Only rows rendered inside this list participate in ordering and dragging. */
export function PinOrderList({ children }: { children: ReactNode }) {
  const order = usePinOrder();
  const list = useRef<HTMLUListElement>(null);
  if (!order) throw new Error("PinOrderList requires PinOrderProvider");
  const { drag, handlers } = usePinDrag(list, order.meta.draggable, order.actions.drop);
  return (
    <PinListContext value={{ state: { draggingId: drag?.reviewId ?? null }, actions: order.actions, meta: order.meta }}>
      <div className="relative">
        <ul ref={list} {...handlers} className={order.meta.draggable ? "select-none" : undefined}>
          {children}
        </ul>
        {drag?.place && (
          <span
            aria-hidden="true"
            data-pin-drop-slot={drag.place.slot}
            className="pointer-events-none absolute inset-x-0 h-0.5 bg-accent"
            style={{ top: drag.place.top }}
          />
        )}
      </div>
    </PinListContext>
  );
}

export function usePinOrder() {
  return use(PinOrderContext);
}

export function usePinList() {
  return use(PinListContext);
}
