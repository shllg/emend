import { type MouseEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";

export const SWIPE_REVEAL_PX = 56;
export const SWIPE_SLOP_PX = 10;

interface Gesture {
  pointerId: number;
  x: number;
  y: number;
  start: number;
  offset: number;
  dragging: boolean;
}

export function useRowSwipe(enabled: boolean) {
  const row = useRef<HTMLLIElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const swallowClick = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const revealed = offset === -SWIPE_REVEAL_PX && !dragging;
  const hide = useCallback(() => {
    gesture.current = null;
    setDragging(false);
    setOffset(0);
  }, []);
  useEffect(() => {
    if (!revealed) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !row.current?.contains(event.target)) hide();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [revealed, hide]);
  const handlers = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      swallowClick.current = false;
      if (!enabled || event.pointerType !== "touch") return;
      gesture.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        start: offset,
        offset,
        dragging: false,
      };
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (!current.dragging) {
        if (Math.abs(dx) >= SWIPE_SLOP_PX && Math.abs(dx) > Math.abs(dy)) {
          current.dragging = true;
          setDragging(true);
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {}
        } else {
          if (Math.abs(dy) >= SWIPE_SLOP_PX) gesture.current = null;
          return;
        }
      }
      current.offset = Math.max(-SWIPE_REVEAL_PX, Math.min(0, current.start + dx));
      setOffset(current.offset);
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      gesture.current = null;
      if (current.dragging) {
        setOffset(current.offset <= -SWIPE_REVEAL_PX / 2 ? -SWIPE_REVEAL_PX : 0);
        setDragging(false);
        swallowClick.current = true;
      } else if (current.start < 0) {
        hide();
        swallowClick.current = true;
      }
    },
    onPointerCancel(event: PointerEvent<HTMLElement>) {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      setOffset(current.start);
      setDragging(false);
      gesture.current = null;
    },
  };
  return {
    row,
    offset,
    dragging,
    hide,
    handlers,
    guardClick(event: MouseEvent<HTMLElement>) {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
    },
  };
}
