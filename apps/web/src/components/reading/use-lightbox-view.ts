import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type Bounds,
  clampView,
  classifyGesture,
  distance,
  fitView,
  type Gesture,
  isAtFit,
  type Point,
  panStep,
  pinchView,
  type Size,
  toggleZoom,
  type View,
  wheelScale,
  zoomAt,
} from "../../lib/lightbox-view.ts";
import type { LightboxItem } from "./screenshots.ts";

type Model = { bounds: Bounds; view: View };

export function useLightboxView(item: LightboxItem | undefined, onStep: (delta: number) => void, onClose: () => void) {
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [image, setImage] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const [model, setModel] = useState<Model | null>(null);
  const current = useRef<Model | null>(null);
  const update = useCallback((next: Model) => {
    current.current = next;
    setModel(next);
  }, []);
  // Retain the toolbar DOM (and keyboard focus) while retiring the previous image and gestures.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Item identity resets the view even for duplicate image sources.
  useLayoutEffect(() => {
    current.current = null;
    setModel(null);
    setImage(null);
    setFailed(false);
  }, [item]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Item changes clear image; only a new size may initialize that item's bounds.
  useLayoutEffect(() => {
    if (!stage || !image) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const bounds = {
        stage: { width: rect.width, height: rect.height },
        image,
        maxFit: item?.kind === "diagram" ? 3 : 1,
      };
      const previous = current.current;
      const view =
        !previous || isAtFit(previous.view, previous.bounds) ? fitView(bounds) : clampView(previous.view, bounds);
      update({ bounds, view });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [stage, image, update]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Navigation cancels pointers still held on the previous item.
  useEffect(() => {
    if (!stage) return;
    const pointers = new Map<number, Point & { type: string }>();
    let gesture: (Gesture & { onImage: boolean }) | null = null;
    let handledPointerAt: number | null = null;
    const point = (event: MouseEvent | PointerEvent): Point => {
      const rect = stage.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const isControl = (target: EventTarget | null) => target instanceof Element && !!target.closest("button");
    const tap = (at: Point, onImage: boolean) => {
      const state = current.current;
      if (onImage && state) update({ ...state, view: toggleZoom(state.view, at, state.bounds) });
      else if (!onImage) onClose();
    };
    const down = (event: PointerEvent) => {
      handledPointerAt = null;
      if (event.button !== 0 || isControl(event.target)) return;
      const at = point(event);
      pointers.set(event.pointerId, { ...at, type: event.pointerType });
      if (pointers.size === 1) {
        const state = current.current;
        gesture = {
          start: at,
          end: at,
          maxDistance: 0,
          zoomed: !!state && !isAtFit(state.view, state.bounds),
          pinched: false,
          onImage: event.target instanceof Element && !!event.target.closest("[data-lightbox-subject]"),
        };
      } else if (gesture) gesture.pinched = true;
      // Capture on the stage so a drag continues outside the image or viewport.
      stage.setPointerCapture?.(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);
      if (!previous || !gesture) return;
      const before = [...pointers.values()].filter((pointer) => pointer.type === "touch");
      const at = point(event);
      pointers.set(event.pointerId, { ...at, type: previous.type });
      gesture.end = at;
      gesture.maxDistance = Math.max(gesture.maxDistance, distance(gesture.start, at));
      const state = current.current;
      if (!state) return;
      const after = [...pointers.values()].filter((pointer) => pointer.type === "touch");
      if (before.length === 2 && after.length === 2 && before[0] && before[1] && after[0] && after[1]) {
        update({ ...state, view: pinchView(state.view, [before[0], before[1]], [after[0], after[1]], state.bounds) });
      } else if (pointers.size === 1 && !isAtFit(state.view, state.bounds)) {
        gesture.zoomed = true;
        update({
          ...state,
          view: clampView(
            { ...state.view, x: state.view.x + at.x - previous.x, y: state.view.y + at.y - previous.y },
            state.bounds,
          ),
        });
      }
    };
    const end = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      move(event);
      pointers.delete(event.pointerId);
      if (pointers.size || !gesture) return;
      handledPointerAt = event.timeStamp;
      const action = classifyGesture(gesture);
      if (action === "tap") tap(gesture.end, gesture.onImage);
      else if (action === "next" || action === "previous") onStep(action === "next" ? 1 : -1);
      gesture = null;
    };
    const cancel = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      if (gesture) gesture.pinched = true;
      if (!pointers.size) gesture = null;
    };
    // Pointer releases handle taps before compatibility clicks (whose target may be the capture node).
    // Suppress only the following compatibility click; later click-only activations must still work.
    const click = (event: MouseEvent) => {
      const release = handledPointerAt;
      handledPointerAt = null;
      if (isControl(event.target)) return;
      if (release !== null && event.timeStamp >= release && event.timeStamp - release <= 500) return;
      if (event.detail === 0)
        tap(point(event), event.target instanceof Element && !!event.target.closest("[data-lightbox-subject]"));
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const state = current.current;
      if (!state) return;
      update({
        ...state,
        view: zoomAt(
          state.view,
          wheelScale(state.view.scale, event.deltaY, event.deltaMode, state.bounds.stage.height),
          point(event),
          state.bounds,
        ),
      });
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    stage.addEventListener("pointerdown", down);
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", cancel);
    stage.addEventListener("lostpointercapture", cancel);
    stage.addEventListener("click", click);
    return () => {
      stage.removeEventListener("wheel", wheel);
      stage.removeEventListener("pointerdown", down);
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", end);
      stage.removeEventListener("pointercancel", cancel);
      stage.removeEventListener("lostpointercapture", cancel);
      stage.removeEventListener("click", click);
    };
  }, [stage, onStep, onClose, update, item]);

  const zoom = (factor?: number) => {
    const state = current.current;
    if (!state) return;
    const { bounds, view } = state;
    update({
      bounds,
      view:
        factor === undefined
          ? fitView(bounds)
          : zoomAt(view, view.scale * factor, { x: bounds.stage.width / 2, y: bounds.stage.height / 2 }, bounds),
    });
  };
  const arrow = (key: string) => {
    const dx = key === "ArrowLeft" ? 1 : key === "ArrowRight" ? -1 : 0;
    const dy = key === "ArrowUp" ? 1 : key === "ArrowDown" ? -1 : 0;
    if (!dx && !dy) return false;
    const state = current.current;
    if (state && !failed && !isAtFit(state.view, state.bounds)) {
      update({ ...state, view: panStep(state.view, dx, dy, state.bounds) });
      return true;
    }
    if (!dx) return false;
    onStep(-dx);
    return true;
  };
  return { setStage, image, setImage, failed, setFailed, model, zoom, arrow };
}
