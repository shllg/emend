export const TOUCH_HOLD_MS = 500;
export const TOUCH_SLOP_PX = 10;

export function holdToSelectLines(element: HTMLElement): () => void {
  let hold: { cell: Element; startX: number; startY: number; timer: ReturnType<typeof setTimeout> } | undefined;

  function clear() {
    if (!hold) return;
    clearTimeout(hold.timer);
    hold.cell.removeAttribute("data-touch-hold");
    hold = undefined;
  }

  function start(event: TouchEvent) {
    clear();
    const touch = event.touches[0];
    if (event.touches.length !== 1 || !touch) return;
    const cell = event
      .composedPath()
      .find(
        (node): node is Element =>
          node instanceof Element && node.matches("pre[data-interactive-line-numbers] [data-column-number]"),
      );
    if (!cell) return;
    hold = {
      cell,
      startX: touch.clientX,
      startY: touch.clientY,
      timer: setTimeout(() => cell.setAttribute("data-touch-hold", ""), TOUCH_HOLD_MS),
    };
  }

  function move(event: TouchEvent) {
    if (!hold) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || !touch) {
      clear();
    } else if (hold.cell.hasAttribute("data-touch-hold")) {
      if (event.cancelable) event.preventDefault();
    } else if (Math.hypot(touch.clientX - hold.startX, touch.clientY - hold.startY) > TOUCH_SLOP_PX) {
      clear();
    }
  }

  function contextMenu(event: MouseEvent) {
    if (hold) event.preventDefault();
  }

  const controller = new AbortController();
  const { signal } = controller;
  const passive = { signal, passive: true };
  element.addEventListener("touchstart", start, passive);
  element.addEventListener("touchmove", move, { signal, passive: false });
  element.addEventListener("touchend", clear, passive);
  element.addEventListener("touchcancel", clear, passive);
  element.addEventListener("contextmenu", contextMenu, { signal });
  return () => {
    clear();
    controller.abort();
  };
}
