import { type MouseEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export const SWIPE_REVEAL_PX = 56;
export const SWIPE_SLOP_PX = 10;
export const SWIPE_CLICK_WINDOW_MS = 600;

interface Gesture {
  pointerId: number;
  x: number;
  y: number;
  start: number;
  offset: number;
  dragging: boolean;
}

export function useRowSwipe<T extends HTMLElement = HTMLAnchorElement>(enabled: boolean) {
  const row = useRef<HTMLLIElement>(null);
  const content = useRef<T>(null);
  const actions = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const swallowClickAt = useRef<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const writeOffset = useCallback((value: number) => {
    if (content.current) content.current.style.transform = value === 0 ? "" : `translateX(${value}px)`;
    if (actions.current) actions.current.style.width = `${-value}px`;
  }, []);
  useLayoutEffect(() => {
    writeOffset(dragging && gesture.current ? gesture.current.offset : offset);
  }, [offset, dragging, writeOffset]);
  const revealed = offset === -SWIPE_REVEAL_PX && !dragging;
  const hide = useCallback(() => {
    gesture.current = null;
    writeOffset(0);
    setDragging(false);
    setOffset(0);
  }, [writeOffset]);
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
      swallowClickAt.current = null;
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
      writeOffset(current.offset);
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      gesture.current = null;
      if (current.dragging) {
        const settled = current.offset <= -SWIPE_REVEAL_PX / 2 ? -SWIPE_REVEAL_PX : 0;
        writeOffset(settled);
        setOffset(settled);
        setDragging(false);
        swallowClickAt.current = performance.now();
      } else if (current.start < 0) {
        hide();
        swallowClickAt.current = performance.now();
      }
    },
    onPointerCancel(event: PointerEvent<HTMLElement>) {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      writeOffset(current.start);
      setOffset(current.start);
      setDragging(false);
      gesture.current = null;
    },
  };
  return {
    row,
    content,
    actions,
    offset,
    dragging,
    hide,
    handlers,
    guardClick(event: MouseEvent<HTMLElement>) {
      const at = swallowClickAt.current;
      swallowClickAt.current = null;
      if (event.detail > 0 && at !== null && performance.now() - at <= SWIPE_CLICK_WINDOW_MS) event.preventDefault();
    },
  };
}
