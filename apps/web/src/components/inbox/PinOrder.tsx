import { type InboxItem, placePin, type ReviewPinPlaceRequest } from "@emend/contract";
import { createContext, type ReactNode, use, useRef, useState } from "react";
import { mutationMessage, usePlacePin } from "../../api/mutations.ts";
import { useLayout } from "../../lib/layout.ts";
import { usePinDrag } from "../../lib/use-pin-drag.ts";
import { useToast } from "../ui/Toast.tsx";

export interface PinMoves {
  up?: () => void;
  down?: () => void;
}
interface PinOrderContextValue {
  state: { draggingId: string | null };
  actions: { movesFor: (reviewId: string) => PinMoves | undefined; drop: (reviewId: string, slot: number) => void };
  meta: { draggable: boolean };
}
const PinOrderContext = createContext<PinOrderContextValue | null>(null);

/** Only the shown Pinned list owns moves; copies in other sections do not participate. */
export function PinOrder({ rows, children }: { rows: InboxItem[]; children: ReactNode }) {
  const mutation = usePlacePin();
  const toast = useToast();
  const draggable = useLayout() !== "phone";
  const list = useRef<HTMLUListElement>(null);
  const [announcement, setAnnouncement] = useState({ serial: 0, text: "" });
  const move = async (reviewId: string, place: ReviewPinPlaceRequest) => {
    const order = placePin(
      rows.map((row) => row.id),
      reviewId,
      place,
    );
    if (!order) return;
    try {
      await mutation.mutateAsync({ reviewId, place });
      setAnnouncement((previous) => ({
        serial: previous.serial + 1,
        text: `Moved to place ${order.indexOf(reviewId) + 1} of ${order.length}`,
      }));
    } catch (error) {
      toast.show({ tone: "danger", title: mutationMessage(error as Error) });
    }
  };
  const drop = (reviewId: string, slot: number) => {
    const index = rows.findIndex((row) => row.id === reviewId);
    if (index < 0 || slot < 0 || slot > rows.length || slot === index || slot === index + 1) return;
    const anchor = rows[slot] ?? rows.at(-1);
    if (anchor) void move(reviewId, slot === rows.length ? { after: anchor.id } : { before: anchor.id });
  };
  const { drag, handlers } = usePinDrag(list, draggable, drop);
  const value: PinOrderContextValue = {
    state: { draggingId: drag?.reviewId ?? null },
    actions: {
      drop,
      movesFor: (reviewId) => {
        const index = rows.findIndex((row) => row.id === reviewId);
        if (index < 0) return undefined;
        const previous = rows[index - 1];
        const next = rows[index + 1];
        return {
          up: previous ? () => void move(reviewId, { before: previous.id }) : undefined,
          down: next ? () => void move(reviewId, { after: next.id }) : undefined,
        };
      },
    },
    meta: { draggable },
  };
  return (
    <PinOrderContext value={value}>
      <div className="relative">
        <ul ref={list} {...handlers} className={draggable ? "select-none" : undefined}>
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
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        <span key={announcement.serial}>{announcement.text}</span>
      </div>
    </PinOrderContext>
  );
}

export function usePinOrder() {
  return use(PinOrderContext);
}
