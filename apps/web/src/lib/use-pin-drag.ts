import {
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

interface Gesture {
  reviewId: string;
  pointerId: number;
  row: HTMLElement;
  x: number;
  y: number;
  dragging: boolean;
}
interface DropPlace {
  slot: number;
  top: number;
}

function dropPlace(list: HTMLUListElement, x: number, y: number): DropPlace | null {
  const box = list.getBoundingClientRect();
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
  const rows = Array.from(list.children, (row) => row.getBoundingClientRect());
  const slot = rows.findIndex((row) => y < row.top + row.height / 2);
  if (slot >= 0) return { slot, top: (rows[slot]?.top ?? box.top) - box.top };
  return { slot: rows.length, top: (rows.at(-1)?.bottom ?? box.bottom) - box.top };
}

/** Mouse ordering is separate from the row's touch swipe. The list delegates to its row links. */
export function usePinDrag(
  list: RefObject<HTMLUListElement | null>,
  enabled: boolean,
  drop: (reviewId: string, slot: number) => void,
) {
  const gesture = useRef<Gesture | null>(null);
  const swallowClickAt = useRef<number | null>(null);
  const [drag, setDrag] = useState<{ reviewId: string; place: DropPlace | null } | null>(null);
  const release = () => {
    const current = gesture.current;
    gesture.current = null;
    if (current?.dragging) swallowClickAt.current = performance.now();
    if (current) {
      try {
        if (current.row.hasPointerCapture(current.pointerId)) current.row.releasePointerCapture(current.pointerId);
      } catch {}
    }
    document.body.classList.remove("em-pin-dragging");
  };
  const cancel = useEffectEvent(() => {
    release();
    setDrag(null);
  });
  const move = useEffectEvent((event: globalThis.PointerEvent) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId || !list.current) return;
    if (!current.dragging) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4) return;
      current.dragging = true;
      try {
        current.row.setPointerCapture(current.pointerId);
      } catch {}
      document.body.classList.add("em-pin-dragging");
      window.getSelection()?.removeAllRanges();
    }
    event.preventDefault();
    const place = dropPlace(list.current, event.clientX, event.clientY);
    setDrag((previous) =>
      previous?.reviewId === current.reviewId &&
      previous.place?.slot === place?.slot &&
      previous.place?.top === place?.top
        ? previous
        : { reviewId: current.reviewId, place },
    );
  });
  const finish = useEffectEvent((event: globalThis.PointerEvent) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const place = current.dragging && list.current ? dropPlace(list.current, event.clientX, event.clientY) : null;
    release();
    setDrag(null);
    if (place) drop(current.reviewId, place.slot);
  });
  useEffect(() => {
    if (!enabled) return;
    const onMove = (event: globalThis.PointerEvent) => move(event);
    const onUp = (event: globalThis.PointerEvent) => finish(event);
    const onCancel = (event: globalThis.PointerEvent) => {
      if (gesture.current?.pointerId === event.pointerId) cancel();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !gesture.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("lostpointercapture", onCancel);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("lostpointercapture", onCancel);
      document.removeEventListener("keydown", onKey, true);
      cancel();
    };
  }, [enabled]);
  return {
    drag,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLUListElement>) {
        swallowClickAt.current = null;
        if (
          !enabled ||
          event.pointerType !== "mouse" ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        const row = event.target instanceof Element ? event.target.closest<HTMLElement>("a[data-inbox-row]") : null;
        if (!row?.dataset.inboxRow || !event.currentTarget.contains(row)) return;
        gesture.current = {
          reviewId: row.dataset.inboxRow,
          pointerId: event.pointerId,
          row,
          x: event.clientX,
          y: event.clientY,
          dragging: false,
        };
      },
      onDragStart(event: DragEvent<HTMLUListElement>) {
        // Cancelling native link drag keeps the mouse pointer stream alive.
        event.preventDefault();
      },
      onClickCapture(event: MouseEvent<HTMLUListElement>) {
        const at = swallowClickAt.current;
        swallowClickAt.current = null;
        if (event.detail > 0 && at !== null && performance.now() - at <= 600) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
    },
  };
}
