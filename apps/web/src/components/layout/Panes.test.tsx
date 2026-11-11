import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { defaultLayout, layoutKey, layoutStore } from "../../lib/layout-store.ts";
import { OUTLINE_WIDTH } from "../reading/WriteupOutline.tsx";
import { Panes } from "./Panes.tsx";

let width: number;
let layoutWidth: number;
let measure: () => void;
beforeEach(() => {
  localStorage.clear();
  width = 1200;
  layoutWidth = 1600;
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, this.classList.contains("em-panes") ? layoutWidth : width, 800);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        measure = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(hasDiff = true, hasWriteup = false) {
  const ui = (tab: string) => (
    <Panes
      inbox={<aside>Inbox</aside>}
      header={null}
      reading="Writeup"
      diff={<input aria-label="Diff editor" defaultValue="Draft" />}
      phoneTabs={null}
      tab={tab}
      hasDiff={hasDiff}
      hasWriteup={hasWriteup}
    />
  );
  const view = render(ui("writeup"));
  return { ...view, rerender: (tab: string) => view.rerender(ui(tab)) };
}
function inbox() {
  return screen.getByRole("separator", { name: "Resize inbox" });
}
function reading() {
  return screen.getByRole("separator", { name: "Resize reading pane" });
}
function value(handle: HTMLElement) {
  return Number(handle.getAttribute("aria-valuenow"));
}

test("only the reading pane uses the reading background", () => {
  mount();
  expect(screen.getByTestId("reading-pane").classList.contains("bg-reading")).toBe(true);
  expect(screen.getByTestId("diff-pane").classList.contains("bg-reading")).toBe(false);
});

test("inbox keyboard steps, limits and reset expose their widths", () => {
  mount();
  expect(value(inbox())).toBe(280);
  expect(inbox().tabIndex).toBe(0);
  expect(inbox().getAttribute("aria-orientation")).toBe("vertical");
  fireEvent.keyDown(inbox(), { key: "ArrowRight" });
  expect(value(inbox())).toBe(296);
  fireEvent.keyDown(inbox(), { key: "ArrowLeft", shiftKey: true });
  expect(value(inbox())).toBe(232);
  fireEvent.keyDown(inbox(), { key: "Home" });
  fireEvent.keyDown(inbox(), { key: "ArrowLeft" });
  expect(value(inbox())).toBe(220);
  fireEvent.keyDown(inbox(), { key: "End" });
  fireEvent.keyDown(inbox(), { key: "ArrowRight", shiftKey: true });
  expect(value(inbox())).toBe(520);
  fireEvent.keyDown(inbox(), { key: "Enter" });
  expect(value(inbox())).toBe(280);
  fireEvent.keyDown(inbox(), { key: "End" });
  fireEvent.doubleClick(inbox());
  expect(value(inbox())).toBe(280);
});
test("reading limits reserve 440px for diff, preserve 360px at small widths and reset the default clamp", () => {
  mount();
  expect(value(reading())).toBe(504);
  fireEvent.keyDown(reading(), { key: "End" });
  expect(value(reading())).toBe(752);
  expect(layoutStore.getSnapshot().readingShare).toBe(752 / 1200);
  fireEvent.keyDown(reading(), { key: "Home" });
  expect(value(reading())).toBe(360);
  fireEvent.doubleClick(reading());
  expect(value(reading())).toBe(504);
  act(() => {
    width = 2000;
    measure();
  });
  expect(value(reading())).toBe(760);
  act(() => {
    width = 700;
    measure();
  });
  expect(value(reading())).toBe(360);
  expect(reading().getAttribute("aria-valuemax")).toBe("360");
  expect(layoutStore.getSnapshot().readingShare).toBe(defaultLayout.readingShare);
});

test("Contents adds the outline width to Split reading and removes it when switched off", () => {
  mount(true, true);
  const pane = screen.getByTestId("reading-pane");
  expect(pane.style.flexBasis).toBe("504px");
  act(() => layoutStore.update({ contents: true }));
  expect(pane.style.flexBasis).toBe(`${504 + OUTLINE_WIDTH}px`);
  act(() => layoutStore.update({ contents: false }));
  expect(pane.style.flexBasis).toBe("504px");
  expect(layoutStore.getSnapshot().readingShare).toBe(defaultLayout.readingShare);
});

test("Contents keeps the extra reading width when switching tabs", () => {
  const view = mount(true, true);
  act(() => layoutStore.update({ contents: true }));
  const diff = screen.getByTestId("diff-pane");
  for (const tab of ["files", "docs", "comments", "diff", "writeup"]) {
    view.rerender(tab);
    expect(screen.getByTestId("reading-pane").style.flexBasis).toBe(`${504 + OUTLINE_WIDTH}px`);
    expect(screen.getByTestId("diff-pane")).toBe(diff);
  }
});

test("Contents caps the extra reading width to reserve 440px for the diff", () => {
  width = 1000;
  mount(true, true);
  const pane = screen.getByTestId("reading-pane");
  expect(pane.style.flexBasis).toBe("420px");
  act(() => layoutStore.update({ contents: true }));
  expect(pane.style.flexBasis).toBe("552px");
  expect(reading().getAttribute("aria-valuemax")).toBe("552");
  expect(width - Number.parseFloat(pane.style.flexBasis) - 8).toBe(440);
  act(() => layoutStore.update({ contents: false }));
  expect(pane.style.flexBasis).toBe("420px");
});

test.each([
  { name: "without a writeup", hasWriteup: false, hasDiff: true, pane: "split", phone: false, basis: "504px" },
  { name: "without a diff", hasWriteup: true, hasDiff: false, pane: "split", phone: false, basis: "" },
  { name: "in Tabs", hasWriteup: true, hasDiff: true, pane: "tabs", phone: false, basis: "" },
  { name: "on phone", hasWriteup: true, hasDiff: true, pane: "split", phone: true, basis: "" },
] as const)("Contents adds no reading width $name", ({ hasWriteup, hasDiff, pane, phone, basis }) => {
  vi.stubGlobal("matchMedia", () => ({ matches: !phone, addEventListener() {}, removeEventListener() {} }));
  layoutStore.update({ pane: { desktop: pane, tablet: pane } });
  mount(hasDiff, hasWriteup);
  const readingPane = screen.getByTestId("reading-pane");
  expect(readingPane.style.flexBasis).toBe(basis);
  act(() => layoutStore.update({ contents: true }));
  expect(readingPane.style.flexBasis).toBe(basis);
  act(() => layoutStore.update({ contents: false }));
  expect(readingPane.style.flexBasis).toBe(basis);
});

test.each(["keyboard", "pointer"])("a %s resize with Contents stores the width without the outline", (input) => {
  mount(true, true);
  act(() => layoutStore.update({ contents: true }));
  const handle = reading();
  const pane = screen.getByTestId("reading-pane");
  const start = 504 + OUTLINE_WIDTH;
  const committed = start + 16;
  if (input === "keyboard") {
    fireEvent.keyDown(handle, { key: "ArrowRight" });
  } else {
    Object.assign(handle, { setPointerCapture() {}, hasPointerCapture: () => false });
    fireEvent.pointerDown(handle, { pointerId: 1, pointerType: "mouse", button: 0, clientX: start });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: committed });
    expect(pane.style.flexBasis).toBe(`${committed}px`);
    expect(layoutStore.getSnapshot().readingShare).toBe(defaultLayout.readingShare);
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: committed });
  }
  expect(value(handle)).toBe(committed);
  expect(pane.style.flexBasis).toBe(`${committed}px`);
  expect(layoutStore.getSnapshot().readingShare).toBe((committed - OUTLINE_WIDTH) / width);
  expect(JSON.parse(localStorage.getItem(layoutKey) ?? "{}").readingShare).toBe((committed - OUTLINE_WIDTH) / width);
  act(() => layoutStore.update({ contents: false }));
  expect(pane.style.flexBasis).toBe(`${committed - OUTLINE_WIDTH}px`);
  act(() => layoutStore.update({ contents: true }));
  expect(pane.style.flexBasis).toBe(`${committed}px`);
});

test.each(["touch", "pen", "mouse"])(
  "%s drag previews without writing, captures the pointer, commits once and keeps the diff mounted",
  (pointerType) => {
    mount();
    const handle = reading();
    const diff = screen.getByTestId("diff-pane");
    const editor = screen.getByRole("textbox", { name: "Diff editor" });
    const capture = vi.fn();
    const release = vi.fn();
    Object.assign(handle, {
      setPointerCapture: capture,
      hasPointerCapture: () => true,
      releasePointerCapture: release,
    });
    const write = vi.spyOn(localStorage, "setItem");
    fireEvent.pointerDown(handle, { pointerId: 7, pointerType, button: 0, clientX: 504 });
    expect(capture).toHaveBeenCalledWith(7);
    expect(document.body.classList.contains("em-resizing")).toBe(true);
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 560 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 600 });
    expect(value(handle)).toBe(600);
    expect(screen.getByTestId("reading-pane").style.flexBasis).toBe("600px");
    expect(write).not.toHaveBeenCalled();
    expect(screen.getByTestId("diff-pane")).toBe(diff);
    expect(screen.getByRole("textbox", { name: "Diff editor" })).toBe(editor);
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 600 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(layoutKey) ?? "{}").readingShare).toBe(0.5);
    expect(release).toHaveBeenCalledWith(7);
    expect(document.body.classList.contains("em-resizing")).toBe(false);
  },
);
test("cancelled drags revert, pointer capture loss and unmount release the body cursor", () => {
  const view = mount();
  const handle = inbox();
  Object.assign(handle, { setPointerCapture() {}, hasPointerCapture: () => false });
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 280 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 999 });
  expect(value(handle)).toBe(520);
  fireEvent.pointerCancel(handle, { pointerId: 1 });
  expect(value(handle)).toBe(280);
  fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 280 });
  fireEvent.lostPointerCapture(handle, { pointerId: 2 });
  expect(document.body.classList.contains("em-resizing")).toBe(false);
  fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientX: 280 });
  view.unmount();
  expect(document.body.classList.contains("em-resizing")).toBe(false);
});

test("tablet uses the default inbox width without changing the stored desktop width", () => {
  localStorage.setItem(layoutKey, JSON.stringify({ inboxWidth: 520 }));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)",
    addEventListener() {},
    removeEventListener() {},
  }));
  const { container } = mount();
  expect(container.querySelector<HTMLElement>(".em-panes")?.style.getPropertyValue("--inbox-w")).toBe("280px");
  expect(screen.queryByRole("separator", { name: "Resize inbox" })).toBeNull();
  expect(layoutStore.getSnapshot().inboxWidth).toBe(520);
});

test("a 1280px Split layout reserves both CSS handle widths and keeps at least 440px for diff", () => {
  layoutWidth = 1280;
  localStorage.setItem(layoutKey, JSON.stringify({ inboxWidth: 520 }));
  const style = document.createElement("style");
  // Happy DOM does not apply cascade layers; use the actual handle declarations.
  style.textContent = readFileSync(resolve(import.meta.dirname, "../../styles/layout.css"), "utf8")
    .replace("@layer components {", "")
    .replace(/}\s*$/, "");
  document.head.append(style);
  try {
    const { container } = mount();
    const root = container.querySelector<HTMLElement>(".em-panes");
    const inboxWidth = Number.parseFloat(root?.style.getPropertyValue("--inbox-w") ?? "");
    const inboxHandleWidth = Number.parseFloat(getComputedStyle(inbox()).flexBasis);
    const readingHandleWidth = Number.parseFloat(getComputedStyle(reading()).flexBasis);
    // Deliver the review-area measurement after the inbox has taken its rendered width.
    act(() => {
      width = layoutWidth - inboxWidth - inboxHandleWidth;
      measure();
    });
    const readingWidth = Number.parseFloat(screen.getByTestId("reading-pane").style.flexBasis);
    const diffWidth = width - readingWidth - readingHandleWidth;
    expect([inboxWidth, inboxHandleWidth, readingWidth, readingHandleWidth, diffWidth]).toEqual([464, 8, 360, 8, 440]);
    expect(inboxWidth + inboxHandleWidth + readingWidth + readingHandleWidth + diffWidth).toBe(layoutWidth);
    expect(diffWidth).toBeGreaterThanOrEqual(440);
    expect(value(inbox())).toBe(464);
    expect(inbox().getAttribute("aria-valuemax")).toBe("464");
    expect(layoutStore.getSnapshot().inboxWidth).toBe(520);
    act(() => {
      layoutWidth = 1600;
      measure();
    });
    expect(value(inbox())).toBe(520);
  } finally {
    style.remove();
  }
});

test.each([
  { pane: "tabs", hasDiff: true },
  { pane: "split", hasDiff: false },
] as const)("$pane with hasDiff=$hasDiff reserves only the inbox handle", ({ pane, hasDiff }) => {
  layoutWidth = 1280;
  localStorage.setItem(layoutKey, JSON.stringify({ inboxWidth: 520, pane: { desktop: pane } }));
  mount(hasDiff);
  expect(value(inbox())).toBe(472);
  expect(screen.getAllByRole("separator")).toHaveLength(1);
  expect(layoutStore.getSnapshot().inboxWidth).toBe(520);
});

test.each(["mouse", "touch", "pen"])(
  "a %s click without movement keeps default reading sizing and writes nothing",
  (pointerType) => {
    width = 2000;
    mount();
    const handle = reading();
    Object.assign(handle, { setPointerCapture() {}, hasPointerCapture: () => false });
    const write = vi.spyOn(localStorage, "setItem");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, pointerType, clientX: 760 });
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType, clientX: 760 });
    expect(write).not.toHaveBeenCalled();
    expect(layoutStore.getSnapshot().readingShare).toBe(defaultLayout.readingShare);
    act(() => {
      width = 1200;
      measure();
    });
    expect(value(handle)).toBe(504);
  },
);
