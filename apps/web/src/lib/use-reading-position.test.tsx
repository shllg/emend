import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { focusReadingTarget } from "./reading-focus.ts";
import { loadReadingPosition, saveReadingPosition } from "./reading-position.ts";
import { type IntentState, useReadingPosition } from "./use-reading-position.ts";
import type { ReadingEntry } from "./use-reading-trail.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useRealTimers();
});

function Reader({
  entry,
  active = true,
  preserve = false,
  intent = () => ({ current: false, epoch: 0 }),
}: {
  entry: ReadingEntry;
  active?: boolean;
  preserve?: boolean;
  intent?: () => IntentState;
}) {
  const doc = {
    blocks: [{ id: "doc-focus", kind: "heading" as const }],
    path: "doc.md",
    headings: [{ level: 2 as const, id: "heading-focus", text: "Focus target" }],
  };
  useReadingPosition({
    storageKey: "focus-test",
    selector: "[data-block-id]",
    active,
    preserve,
    intentState: intent,
    entry,
    doc,
  });
  return (
    <div data-reading-scroll>
      <div data-reading-doc="doc.md" data-reading-section="doc.md">
        <div id="block-doc-focus" data-block-id="doc-focus" data-block-kind="heading">
          <h2 id="heading-focus">Focus target</h2>
          <a href="#heading-focus">Block link</a>
        </div>
      </div>
      <section id="topic-seed">
        <button type="button">Topic control</button>
      </section>
      <article id="thread-synthetic">
        <a href="#thread-synthetic">Thread link</a>
      </article>
      <div data-reading-thread-popover>
        <article id="thread-popover">
          <a href="https://example.com">Popover link</a>
          <textarea aria-label="Popover reply" />
        </article>
      </div>
      <button type="button">Outside control</button>
    </div>
  );
}

test("R1.7 stored focus makes a validated declared heading keyboard focusable", async () => {
  const entry: ReadingEntry = {
    title: "Doc",
    revision: 1,
    folds: new Map(),
    positions: new Map(),
    focus: { id: "h-heading-focus", children: [] },
  };

  render(<Reader entry={entry} />);
  const heading = screen.getByRole("heading", { name: "Focus target" });
  await waitFor(() => expect(heading.getAttribute("tabindex")).toBe("-1"));
  expect(document.activeElement).toBe(heading);
});

test("R2.9 reopening a pane after a diff navigation still restores its position", async () => {
  const entry: ReadingEntry = {
    title: "Doc",
    revision: 1,
    folds: new Map(),
    positions: new Map([["focus-test", { id: "block-doc-focus", fraction: 0.5 }]]),
  };
  const view = render(<Reader entry={entry} preserve />);
  const scroller = document.querySelector<HTMLElement>("[data-reading-scroll]");
  const block = document.getElementById("block-doc-focus");
  if (!scroller || !block) throw new Error("missing fixture");
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 600));
  vi.spyOn(block, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 100 - scroller.scrollTop, 400, 100));
  await waitFor(() => expect(scroller.scrollTop).toBe(150));
  view.rerender(<Reader entry={entry} active={false} preserve />);
  scroller.scrollTop = 0;
  view.rerender(<Reader entry={entry} preserve />);
  await waitFor(() => expect(scroller.scrollTop).toBe(150));
});

const entryWith = (): ReadingEntry => ({ title: "Doc", revision: 1, folds: new Map(), positions: new Map() });

test.each(["Popover link", "Popover reply"])("focus on %s is never remembered as reading focus", (name) => {
  const entry = entryWith();
  render(<Reader entry={entry} />);
  act(() => screen.getByRole("link", { name: "Block link" }).focus());
  expect(entry.focus?.id).toBe("block-doc-focus");
  const control = name === "Popover link" ? screen.getByRole("link", { name }) : screen.getByRole("textbox", { name });
  act(() => control.focus());
  expect(entry.focus).toBeUndefined();
});

test("R3.1 a pending link never seeds its entry with a stored starting position", () => {
  saveReadingPosition("focus-test", { id: "block-doc-focus", fraction: 0.5 });
  const entry = entryWith();
  render(<Reader entry={entry} intent={() => ({ current: true, epoch: 1 })} />);
  expect(entry.positions.has("focus-test")).toBe(false);
});

test("R3.1 keepOffset captures the live pane rather than the previous entry and restores it on Back", async () => {
  const first = entryWith();
  const view = render(<Reader entry={first} />);
  const scroller = document.querySelector<HTMLElement>("[data-reading-scroll]");
  const block = document.getElementById("block-doc-focus");
  if (!scroller || !block) throw new Error("missing fixture");
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 600));
  vi.spyOn(block, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 100 - scroller.scrollTop, 400, 100));
  await waitFor(() => expect(first.positions.get("focus-test")).toBeNull());
  scroller.scrollTop = 175;
  const kept = entryWith();
  view.rerender(<Reader entry={kept} preserve />);
  expect(kept.positions.get("focus-test")).toEqual({ id: "block-doc-focus", fraction: 0.75 });
  const third = entryWith();
  third.positions.set("focus-test", null);
  view.rerender(<Reader entry={third} />);
  await waitFor(() => expect(scroller.scrollTop).toBe(0));
  view.rerender(<Reader entry={kept} />);
  await waitFor(() => expect(scroller.scrollTop).toBe(175));
});

test.each(["Topic control", "Thread link", "Outside control"])(
  "R3.5 focus on %s replaces or clears the older block focus",
  async (name) => {
    const entry = entryWith();
    const view = render(<Reader entry={entry} />);
    const older = screen.getByRole("link", { name: "Block link" });
    act(() => older.focus());
    expect(entry.focus?.id).toBe("block-doc-focus");
    const target = screen.getByText(name);
    fireEvent.keyDown(older, { key: "Tab" });
    act(() => target.focus());
    if (name === "Outside control") expect(entry.focus).toBeUndefined();
    else expect(entry.focus?.id).toBe(name === "Topic control" ? "topic-seed" : "thread-synthetic");
    view.unmount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<Reader entry={entry} />);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    if (name === "Outside control")
      expect(document.activeElement).not.toBe(screen.getByRole("link", { name: "Block link" }));
    else expect(document.activeElement).toBe(screen.getByText(name));
  },
);

test.each(["Thread link", "Outside control"])(
  "R4.1 app focus on %s preserves focus memory and retries, while reader focus captures",
  async (name) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let shift = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const scrollTop = document.querySelector<HTMLElement>("[data-reading-scroll]")?.scrollTop ?? 0;
      return new DOMRect(0, this.id === "block-doc-focus" ? 100 + shift - scrollTop : 0, 400, 100);
    });
    const entry = entryWith();
    const rememberedFocus = { id: "h-heading-focus", children: [] };
    entry.focus = rememberedFocus;
    const anchor = { id: "block-doc-focus", fraction: 0.5 };
    saveReadingPosition("focus-test", anchor);
    render(<Reader entry={entry} />);
    const scroller = document.querySelector<HTMLElement>("[data-reading-scroll]");
    if (!scroller) throw new Error("missing scroller");
    expect(scroller.scrollTop).toBe(150);
    const control = screen.getByText(name);
    act(() => focusReadingTarget(control));
    expect(entry.focus).toBe(rememberedFocus);
    shift = 200;
    scroller.scrollTop = 10;
    fireEvent.scroll(scroller);
    expect(entry.positions.get("focus-test")).toEqual(anchor);
    expect(loadReadingPosition("focus-test")).toEqual(anchor);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(scroller.scrollTop).toBe(350);
    expect(document.activeElement).toBe(control);

    act(() => focusReadingTarget(screen.getByRole("heading")));
    scroller.scrollTop = 375;
    // The same control's unmarked focus is reader activity, without a key/pointer heuristic.
    act(() => control.focus());
    expect(entry.focus?.id).toBe(name === "Thread link" ? "thread-synthetic" : undefined);
    expect(loadReadingPosition("focus-test")).toEqual({ id: "block-doc-focus", fraction: 0.75 });
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(scroller.scrollTop).toBe(375);
  },
);
