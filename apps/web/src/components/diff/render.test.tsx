import { DiffHunksRenderer } from "@pierre/diffs";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { ReadOnlyReview } from "../../lib/read-only-review.ts";
import { DiffView } from "./FileDiff.tsx";
import { parsePair } from "./parse.worker.ts";
import { syntaxTheme } from "./theme.ts";
import { TOUCH_HOLD_MS } from "./touch-lines.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test.each([
  { style: "split", side: "deletions", line: 3, start: 2, end: 4 },
  { style: "split", side: "additions", line: 4, start: 3, end: 5 },
  { style: "unified", side: "deletions", line: 3, start: 2, end: 4 },
  { style: "unified", side: "additions", line: 4, start: 3, end: 5 },
] as const)(
  "real $style gutter selects the hovered $side line $line and numbers still drag",
  async ({ style, side, line, start: first, end: last }) => {
    const parsed = parsePair({
      oldFile: { name: "sample.ts", contents: "start\nold one\nold two\nold three\nend\n" },
      newFile: { name: "sample.ts", contents: "inserted prefix\nstart\nnew one\nnew two\nnew three\nend\n" },
    });
    const select = vi.fn();
    const view = render(
      <DiffView fileDiff={parsed} diffStyle={style} selected={null} annotations={[]} onSelect={select} />,
    );
    const lineType = side === "deletions" ? "change-deletion" : "change-addition";
    const shadow = view.container.querySelector("diffs-container")?.shadowRoot;
    await waitFor(() =>
      expect(shadow?.querySelector(`[data-line-type="${lineType}"][data-line="${line}"]`)).toBeTruthy(),
    );
    const row = shadow?.querySelector(`[data-line-type="${lineType}"][data-line="${line}"]`) as HTMLElement;
    fireEvent.pointerMove(row, { pointerType: "mouse", pointerId: 1 });
    expect(row.hasAttribute("data-hovered")).toBe(true);
    const slot = shadow?.querySelector("[data-gutter-utility-slot] slot") as HTMLSlotElement;
    expect(slot).toBeTruthy();
    const button = view.getByRole("button", { name: "Comment on line" });
    expect(button.tabIndex).toBe(-1);
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    fireEvent.pointerMove(button, { pointerType: "mouse" });
    await waitFor(() =>
      expect(view.getByRole("tooltip").textContent).toBe(`Comment on line ${line} · drag to select lines`),
    );
    fireEvent.pointerDown(button, { pointerType: "mouse", pointerId: 1 });
    fireEvent.pointerUp(button, { pointerType: "mouse", pointerId: 1 });
    fireEvent.click(button);
    expect(select).toHaveBeenCalledExactlyOnceWith({ start: line, end: line, side });
    select.mockClear();
    const start = shadow?.querySelector(`[data-line-type="${lineType}"][data-column-number="${first}"]`) as HTMLElement;
    const end = shadow?.querySelector(`[data-line-type="${lineType}"][data-column-number="${last}"]`) as HTMLElement;
    // Happy DOM has no hit testing; let the real selection manager see the end row.
    Object.defineProperty(shadow, "elementFromPoint", { configurable: true, value: () => end });
    fireEvent.pointerDown(start, { pointerType: "mouse", pointerId: 2 });
    fireEvent.pointerMove(end, { pointerType: "mouse", pointerId: 2 });
    fireEvent.pointerUp(end, { pointerType: "mouse", pointerId: 2 });
    expect(select).toHaveBeenCalledExactlyOnceWith({ start: first, end: last, side });
    select.mockClear();
    view.rerender(
      <DiffView
        fileDiff={parsed}
        diffStyle={style}
        selected={{ start: first, end: last, side }}
        annotations={[]}
        onSelect={select}
      />,
    );
    const hovered = shadow?.querySelector(`[data-line-type="${lineType}"][data-line="${line}"]`) as HTMLElement;
    expect(hovered.isConnected).toBe(true);
    fireEvent.pointerMove(hovered, { pointerType: "mouse", pointerId: 3 });
    expect(shadow?.querySelector("[data-gutter-utility-slot]")?.parentElement?.getAttribute("data-column-number")).toBe(
      String(line),
    );
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    fireEvent.click(button);
    expect(select).toHaveBeenCalledExactlyOnceWith({ start: line, end: line, side });
  },
);

test.each(["split", "unified"] as const)("real %s gutter selects on tap and cancels on pan", async (style) => {
  const parsed = parsePair({ oldFile: null, newFile: { name: "sample.txt", contents: "first\nsecond\n" } });
  const select = vi.fn();
  const view = render(
    <DiffView fileDiff={parsed} diffStyle={style} selected={null} annotations={[]} onSelect={select} />,
  );
  const shadow = view.container.querySelector("diffs-container")?.shadowRoot;
  const selector = 'pre[data-interactive-line-numbers] [data-column-number="2"]';
  await waitFor(() => expect(shadow?.querySelector(selector)).toBeTruthy());
  const cell = shadow?.querySelector(selector) as HTMLElement;
  const pan = { pointerType: "touch", pointerId: 1 };
  fireEvent.pointerDown(cell, pan);
  fireEvent.pointerCancel(cell, pan);
  expect(select).not.toHaveBeenCalled();
  const tap = { pointerType: "touch", pointerId: 2 };
  fireEvent.pointerDown(cell, tap);
  fireEvent.pointerUp(cell, tap);
  expect(select).toHaveBeenCalledExactlyOnceWith({ start: 2, end: 2, side: "additions" });
});

test.each([
  { mode: "writable", readOnly: false },
  { mode: "read-only", readOnly: true },
])("holding a real gutter line number in a $mode review", async ({ readOnly }) => {
  const parsed = parsePair({ oldFile: null, newFile: { name: "sample.txt", contents: "first\nsecond\n" } });
  const view = render(
    <ReadOnlyReview value={readOnly}>
      <DiffView fileDiff={parsed} diffStyle="unified" selected={null} annotations={[]} onSelect={() => {}} />
    </ReadOnlyReview>,
  );
  const shadow = view.container.querySelector("diffs-container")?.shadowRoot;
  const selector = readOnly
    ? '[data-column-number="2"]'
    : 'pre[data-interactive-line-numbers] [data-column-number="2"]';
  await waitFor(() => expect(shadow?.querySelector(selector)).toBeTruthy());
  const cell = shadow?.querySelector(selector) as HTMLElement;

  function touch(type: string, ...points: [number, number][]) {
    const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
    cell.dispatchEvent(event);
    return event;
  }

  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  touch("touchstart", [20, 30]);
  vi.advanceTimersByTime(TOUCH_HOLD_MS + 1);
  expect(cell.hasAttribute("data-touch-hold")).toBe(!readOnly);
  expect(touch("touchmove", [20, 100]).defaultPrevented).toBe(!readOnly);
  touch("touchend");
  expect(cell.hasAttribute("data-touch-hold")).toBe(false);
});

test.each([
  { style: "split", index: 0, line: 8, stillHidden: 80 },
  { style: "split", index: 1, line: 80, stillHidden: 8 },
  { style: "split", index: 2, line: 160, stillHidden: 80 },
  { style: "unified", index: 0, line: 8, stillHidden: 80 },
  { style: "unified", index: 1, line: 80, stillHidden: 8 },
  { style: "unified", index: 2, line: 160, stillHidden: 80 },
] as const)(
  "$style collapsed region $index has a working manual expand control",
  async ({ style, index, line, stillHidden }) => {
    const expand = vi.spyOn(DiffHunksRenderer.prototype, "expandHunk");
    const view = render(
      <DiffView fileDiff={contextDiff()} diffStyle={style} selected={null} annotations={[]} onSelect={() => {}} />,
    );
    const shadow = view.container.querySelector("diffs-container")?.shadowRoot;
    const selector = `[data-gutter] [data-separator="line-info"][data-expand-index="${index}"]`;
    await waitFor(() => expect(shadow?.querySelector(`${selector} [data-expand-button]`)).toBeTruthy());
    const separator = shadow?.querySelector(selector);
    expect(separator?.textContent).toMatch(/\d+ unmodified lines/);
    expect(shadow?.querySelector(`[data-line="${line}"]`)).toBeNull();
    expect(expand).not.toHaveBeenCalled();
    const button = separator?.querySelector('[data-expand-button][role="button"]');
    if (!button) throw new Error("Missing manual expand control");
    fireEvent.click(button);
    await waitFor(() => expect(shadow?.querySelector(`[data-line="${line}"]`)).toBeTruthy());
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand.mock.calls[0]?.[0]).toBe(index);
    expect(shadow?.querySelector(`[data-line="${stillHidden}"]`)).toBeNull();
  },
);
test.each(["split", "unified"] as const)(
  "real %s renderer keeps hostile text and token styles inert",
  async (style) => {
    const text =
      '<script>alert(1)</script>\n</style><script>alert(1)</script>\n<img src=x onerror=alert(1)>\njavascript:alert(1)\n</span><b>raw HTML</b>\n<svg onload=alert(1)>\n<a href="javascript:alert(1)">link</a>\n[link](javascript:alert(1))\nclick node "javascript:alert(1)"\n';
    const allowed = new Set([
      ...syntaxTheme.tokenColors.map((rule) => `color:${rule.settings.foreground}`),
      "font-style:italic",
      "font-weight:bold",
    ]);
    for (const extension of ["txt", "ts", "md", "html"]) {
      const parsed = parsePair({ oldFile: null, newFile: { name: `hostile.${extension}`, contents: text } });
      const view = render(
        <DiffView fileDiff={parsed} diffStyle={style} annotations={[]} onSelect={() => {}} selected={null} />,
      );
      const shadow = view.container.querySelector("diffs-container")?.shadowRoot;
      await waitFor(() => expect(shadow?.querySelector("[data-line]")).toBeTruthy());
      if (extension !== "txt")
        await waitFor(() => expect(shadow?.querySelector('[data-line] span[style*="--diffs-"]')).toBeTruthy());
      expect(shadow?.querySelector("script, img, b, a, [onerror], [onload], [href^='javascript:']")).toBeNull();
      const lines = [...(shadow?.querySelectorAll("[data-line]") ?? [])];
      expect(lines.map((line) => line.textContent)).toEqual(text.trimEnd().split("\n"));
      for (const line of lines)
        for (const element of line.querySelectorAll("*")) {
          expect(element.tagName).toBe("SPAN");
          for (const declaration of (element.getAttribute("style") ?? "").split(";").filter(Boolean)) {
            expect(allowed.has(declaration)).toBe(true);
          }
        }
      // SVG belongs only to Pierre's fixed icon sprite, never to the reviewed lines.
      for (const svg of shadow?.querySelectorAll("svg") ?? []) expect(svg.closest("[data-icon-sprite]")).toBeTruthy();
      view.unmount();
    }
  },
);

test("a line annotation in unchanged context has a visible slot under its end line", async () => {
  const old = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const parsed = parsePair({
    oldFile: { name: "context.txt", contents: old },
    newFile: { name: "context.txt", contents: `${old}\nadded` },
  });
  const view = render(
    <DiffView
      fileDiff={parsed}
      diffStyle="split"
      selected={null}
      onSelect={() => {}}
      annotations={[{ side: "additions", lineNumber: 10, metadata: <p>Context thread</p> }]}
    />,
  );
  await waitFor(() =>
    expect(
      view.container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector('slot[name="annotation-additions-10"]'),
    ).toBeTruthy(),
  );
});

const contextDiff = () => {
  const old = Array.from({ length: 180 }, (_, index) => `line ${index + 1}`);
  const next = [...old];
  next.splice(39, 1, "changed 40", "inserted line");
  next[120] = "changed 120";
  return parsePair({
    oldFile: { name: "context.txt", contents: old.join("\n") },
    newFile: { name: "context.txt", contents: next.join("\n") },
  });
};

test.each([
  { side: "deletions", line: 8, index: 0, direction: "up", hidden: 80 },
  { side: "additions", line: 30, index: 0, direction: "down", hidden: 80 },
  { side: "deletions", line: 55, index: 1, direction: "up", hidden: 8 },
  { side: "additions", line: 106, index: 1, direction: "down", hidden: 8 },
  { side: "deletions", line: 140, index: 2, direction: "up", hidden: 80 },
  { side: "additions", line: 141, index: 2, direction: "up", hidden: 80 },
] as const)(
  "$side line $line expands only region $index from $direction",
  async ({ side, line, index, direction, hidden }) => {
    const expand = vi.spyOn(DiffHunksRenderer.prototype, "expandHunk");
    const renders = vi.spyOn(DiffHunksRenderer.prototype, "renderDiff");
    const parsed = contextDiff();
    expect(parsed.hunks).toHaveLength(2);
    const annotations = [{ side, lineNumber: line, metadata: <p>Placed comment</p> }];
    const props = { fileDiff: parsed, annotations, onSelect: () => {}, selected: null };
    const view = render(<DiffView {...props} diffStyle="split" />);
    const shadow = () => view.container.querySelector("diffs-container")?.shadowRoot;
    await waitFor(() => expect(shadow()?.querySelector(`slot[name="annotation-${side}-${line}"]`)).toBeTruthy());
    expect(expand).toHaveBeenCalledTimes(1);
    const hunk = parsed.hunks[index];
    const previous = parsed.hunks[index - 1];
    const start = hunk ? (side === "deletions" ? hunk.deletionStart : hunk.additionStart) : 0;
    const tailStart = previous
      ? side === "deletions"
        ? previous.deletionStart + previous.deletionCount
        : previous.additionStart + previous.additionCount
      : 0;
    const count = hunk
      ? (direction === "up" ? line - (start - hunk.collapsedBefore) + 1 : start - line) + 3
      : line - tailStart + 4;
    expect(expand).toHaveBeenCalledWith(index, direction, count);
    expect(
      renders.mock.contexts.every(
        (renderer) =>
          renderer instanceof DiffHunksRenderer &&
          renderer.options.expandUnchanged === false &&
          renderer.options.hunkSeparators === "line-info",
      ),
    ).toBe(true);
    for (let number = line - 3; number <= line + 3; number++)
      expect(shadow()?.querySelector(`[data-${side}] [data-line="${number}"]`)).toBeTruthy();
    expect(shadow()?.querySelector(`[data-${side}] [data-line="${hidden}"]`)).toBeNull();
    view.rerender(<DiffView {...props} annotations={[...annotations]} diffStyle="unified" />);
    await waitFor(() => expect(shadow()?.querySelector("[data-unified]")).toBeTruthy());
    expect(expand).toHaveBeenCalledTimes(1);
    expect(shadow()?.querySelector(`slot[name="annotation-${side}-${line}"]`)).toBeTruthy();
  },
);

test("comments inside hunks do not expand context", async () => {
  const expand = vi.spyOn(DiffHunksRenderer.prototype, "expandHunk");
  const view = render(
    <DiffView
      fileDiff={contextDiff()}
      diffStyle="split"
      onSelect={() => {}}
      selected={null}
      annotations={[{ side: "deletions", lineNumber: 40, metadata: <p>Changed line</p> }]}
    />,
  );
  await waitFor(() =>
    expect(
      view.container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector('slot[name="annotation-deletions-40"]'),
    ).toBeTruthy(),
  );
  expect(expand).not.toHaveBeenCalled();
});

test("same-region threads share expansion, and a later comment extends it only as needed", async () => {
  const expand = vi.spyOn(DiffHunksRenderer.prototype, "expandHunk");
  const parsed = contextDiff();
  const annotations = [8, 10].map((lineNumber) => ({
    side: "additions" as const,
    lineNumber,
    metadata: <p>Comment {lineNumber}</p>,
  }));
  const props = { fileDiff: parsed, diffStyle: "split" as const, onSelect: () => {}, selected: null };
  const view = render(<DiffView {...props} annotations={annotations} />);
  const shadow = () => view.container.querySelector("diffs-container")?.shadowRoot;
  await waitFor(() => expect(shadow()?.querySelector('slot[name="annotation-additions-10"]')).toBeTruthy());
  expect(expand.mock.calls).toEqual([[0, "up", 13]]);
  const later = [...annotations, { side: "deletions" as const, lineNumber: 15, metadata: <p>Later comment</p> }];
  view.rerender(<DiffView {...props} annotations={later} />);
  await waitFor(() => expect(shadow()?.querySelector('slot[name="annotation-deletions-15"]')).toBeTruthy());
  expect(expand.mock.calls).toEqual([
    [0, "up", 13],
    [0, "up", 5],
  ]);
  view.rerender(<DiffView {...props} annotations={[...later]} />);
  expect(expand).toHaveBeenCalledTimes(2);
});
