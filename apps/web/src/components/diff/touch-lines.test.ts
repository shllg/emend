import { expect, onTestFinished, test, vi } from "vitest";
import { diffShadowCSS } from "./shadow.ts";
import { holdToSelectLines, TOUCH_HOLD_MS, TOUCH_SLOP_PX } from "./touch-lines.ts";

function fixture() {
  vi.useFakeTimers();
  const wrapper = document.createElement("div");
  const host = document.createElement("div");
  wrapper.append(host);
  const pre = document.createElement("pre");
  host.attachShadow({ mode: "open" }).append(pre);
  pre.setAttribute("data-interactive-line-numbers", "");
  const cell = document.createElement("div");
  cell.setAttribute("data-column-number", "1");
  const label = document.createElement("span");
  label.textContent = "1";
  cell.append(label);
  const code = document.createElement("div");
  code.setAttribute("data-line", "1");
  code.textContent = "sample line";
  pre.append(cell, code);
  const cleanup = holdToSelectLines(wrapper);
  onTestFinished(() => {
    cleanup();
    vi.useRealTimers();
  });
  return { pre, cell, label, code, cleanup };
}

function touch(target: Element, type: string, ...points: [number, number][]) {
  const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
  target.dispatchEvent(event);
  return event;
}

function contextMenu(target: Element) {
  const event = new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test("interactive line numbers and the gutter utility allow native panning", () => {
  expect(diffShadowCSS).toMatch(
    /\[data-interactive-line-numbers\] \[data-column-number\],\s*\[data-gutter-utility-slot\]\s*\{[^}]*touch-action:\s*manipulation;/,
  );
});

test.each(["touchend", "touchcancel"])("a held number captures movement until %s", (end) => {
  const { cell, label } = fixture();
  touch(label, "touchstart", [20, 30]);
  vi.advanceTimersByTime(TOUCH_HOLD_MS - 1);
  expect(touch(label, "touchmove", [20, 30 + TOUCH_SLOP_PX]).defaultPrevented).toBe(false);
  expect(cell.hasAttribute("data-touch-hold")).toBe(false);
  vi.advanceTimersByTime(1);
  expect(cell.hasAttribute("data-touch-hold")).toBe(true);
  expect(touch(label, "touchmove", [20, 100]).defaultPrevented).toBe(true);
  touch(label, end);
  expect(cell.hasAttribute("data-touch-hold")).toBe(false);
  expect(contextMenu(label).defaultPrevented).toBe(false);
});

test("a swipe that passes the slop before the hold stays free to scroll", () => {
  const { cell } = fixture();
  touch(cell, "touchstart", [20, 30]);
  expect(touch(cell, "touchmove", [21, 30 + TOUCH_SLOP_PX]).defaultPrevented).toBe(false);
  vi.advanceTimersByTime(TOUCH_HOLD_MS);
  expect(cell.hasAttribute("data-touch-hold")).toBe(false);
  expect(touch(cell, "touchmove", [20, 100]).defaultPrevented).toBe(false);
});

test("holding code text leaves scrolling available", () => {
  const { cell, code } = fixture();
  touch(code, "touchstart", [20, 30]);
  vi.advanceTimersByTime(TOUCH_HOLD_MS);
  expect(touch(code, "touchmove", [20, 100]).defaultPrevented).toBe(false);
  expect(cell.hasAttribute("data-touch-hold")).toBe(false);
});

test("holding a read-only line number leaves scrolling available", () => {
  const { cell, pre } = fixture();
  pre.removeAttribute("data-interactive-line-numbers");
  touch(cell, "touchstart", [20, 30]);
  vi.advanceTimersByTime(TOUCH_HOLD_MS);
  expect(touch(cell, "touchmove", [20, 100]).defaultPrevented).toBe(false);
  expect(cell.hasAttribute("data-touch-hold")).toBe(false);
});

test.each(["touchstart", "touchmove"])("a second finger on %s releases a held number for pinch zoom", (type) => {
  const { cell } = fixture();
  touch(cell, "touchstart", [20, 30]);
  vi.advanceTimersByTime(TOUCH_HOLD_MS);
  expect(cell.hasAttribute("data-touch-hold")).toBe(true);
  expect(touch(cell, type, [20, 30], [40, 60]).defaultPrevented).toBe(false);
  expect(cell.hasAttribute("data-touch-hold")).toBe(false);
  expect(touch(cell, "touchmove", [20, 100]).defaultPrevented).toBe(false);
});

test("the context menu is suppressed from touchstart until tracking ends", () => {
  const { cell } = fixture();
  expect(contextMenu(cell).defaultPrevented).toBe(false);
  touch(cell, "touchstart", [20, 30]);
  expect(contextMenu(cell).defaultPrevented).toBe(true);
  vi.advanceTimersByTime(TOUCH_HOLD_MS);
  expect(contextMenu(cell).defaultPrevented).toBe(true);
  touch(cell, "touchend");
  expect(contextMenu(cell).defaultPrevented).toBe(false);
});

test.each([0, TOUCH_HOLD_MS])("cleanup at %d ms clears the hold and detaches the listeners", (elapsed) => {
  const { cell, cleanup } = fixture();
  touch(cell, "touchstart", [20, 30]);
  vi.advanceTimersByTime(elapsed);
  cleanup();
  vi.advanceTimersByTime(TOUCH_HOLD_MS);
  expect(cell.hasAttribute("data-touch-hold")).toBe(false);
  touch(cell, "touchstart", [20, 30]);
  vi.advanceTimersByTime(TOUCH_HOLD_MS);
  expect(cell.hasAttribute("data-touch-hold")).toBe(false);
  expect(touch(cell, "touchmove", [20, 100]).defaultPrevented).toBe(false);
  expect(contextMenu(cell).defaultPrevented).toBe(false);
});
