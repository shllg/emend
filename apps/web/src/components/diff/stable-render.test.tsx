import { DiffHunksRenderer } from "@pierre/diffs";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { DiffView } from "./FileDiff.tsx";
import { parsePair } from "./parse.worker.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const parsed = () =>
  parsePair({
    oldFile: { name: "sample.ts", contents: "start\nold one\nold two\nend\n" },
    newFile: { name: "sample.ts", contents: "start\nnew one\nnew two\nend\n" },
  });
const contextDiff = () => {
  const old = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  return parsePair({
    oldFile: { name: "context.txt", contents: old },
    newFile: { name: "context.txt", contents: `${old}\nadded` },
  });
};

type Harness = { bump: () => void; setText: (text: string) => void; setStyle: (s: "split" | "unified") => void };
function Wrapper({
  diff,
  handle,
  lines = [3],
  overflow,
}: {
  diff: ReturnType<typeof parsed>;
  handle: Harness[];
  lines?: number[];
  overflow?: "scroll" | "wrap";
}) {
  const [, setTick] = useState(0);
  const [text, setText] = useState("first");
  const [style, setStyle] = useState<"split" | "unified">("split");
  handle[0] = { bump: () => setTick((t) => t + 1), setText, setStyle };
  return (
    <DiffView
      fileDiff={diff}
      diffStyle={style}
      overflow={overflow}
      selected={{ start: 2, end: 2, side: "additions" }}
      onSelect={() => {}}
      annotations={lines.map((lineNumber) => ({
        side: "additions" as const,
        lineNumber,
        metadata: <p>{`${text} ${lineNumber}`}</p>,
      }))}
    />
  );
}

async function mount(diff = parsed(), lines = [3], overflow?: "scroll" | "wrap") {
  const handle: Harness[] = [];
  const view = render(<Wrapper diff={diff} handle={handle} lines={lines} overflow={overflow} />);
  const shadow = view.container.querySelector("diffs-container")?.shadowRoot as ShadowRoot;
  await waitFor(() => expect(shadow.querySelector("[data-line]")).toBeTruthy());
  const removed: Node[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.removedNodes) removed.push(node);
  });
  observer.observe(shadow, { childList: true, subtree: true });
  const rows = () => {
    for (const record of observer.takeRecords()) for (const node of record.removedNodes) removed.push(node);
    return removed.filter((node) => node instanceof Element && node.hasAttribute("data-line"));
  };
  return { view, handle: handle[0] as Harness, shadow, rows };
}
async function settle(update: () => void) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  // Commit React's update before draining Pierre's queued render frames and timers.
  await act(async () => update());
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

test("a loaded file is not rebuilt when its parent re-renders with equal inputs", async () => {
  const { handle, rows } = await mount();
  await settle(() => handle.bump());
  expect(rows()).toHaveLength(0);
});

test("annotation content updates without a rebuild", async () => {
  const { view, handle, rows } = await mount();
  await waitFor(() => expect(view.getByText("first 3")).toBeTruthy());
  await settle(() => handle.setText("second"));
  vi.useRealTimers();
  await waitFor(() => expect(view.getByText("second 3")).toBeTruthy());
  expect(rows()).toHaveLength(0);
});

test("a new annotation position still renders its slot and content", async () => {
  const handle: Harness[] = [];
  const diff = parsed();
  const view = render(<Wrapper diff={diff} handle={handle} lines={[3]} />);
  view.rerender(<Wrapper diff={diff} handle={handle} lines={[3, 4]} />);
  const shadow = view.container.querySelector("diffs-container")?.shadowRoot as ShadowRoot;
  await waitFor(() => expect(shadow.querySelector('slot[name="annotation-additions-4"]')).toBeTruthy());
  expect(view.getByText("first 4")).toBeTruthy();
});

test("an annotation in a collapsed region still expands it", async () => {
  const { shadow } = await mount(contextDiff(), [10]);
  await waitFor(() => expect(shadow.querySelector('slot[name="annotation-additions-10"]')).toBeTruthy());
});

test("changing diffStyle still re-renders", async () => {
  const { handle, shadow } = await mount();
  handle.setStyle("unified");
  await waitFor(() => expect(shadow.querySelector("[data-unified]")).toBeTruthy());
});

test("changing overflow still re-renders", async () => {
  const handle: Harness[] = [];
  const diff = parsed();
  const view = render(<Wrapper diff={diff} handle={handle} overflow="scroll" />);
  const shadow = view.container.querySelector("diffs-container")?.shadowRoot as ShadowRoot;
  await waitFor(() => expect(shadow.querySelector("[data-line]")).toBeTruthy());
  expect(shadow.querySelector("pre")?.getAttribute("data-overflow")).toBe("scroll");
  view.rerender(<Wrapper diff={diff} handle={handle} overflow="wrap" />);
  await waitFor(() => expect(shadow.querySelector("pre")?.getAttribute("data-overflow")).toBe("wrap"));
});

const shadowOf = (view: ReturnType<typeof render>) =>
  view.container.querySelector("diffs-container")?.shadowRoot as ShadowRoot;
const slotName = "annotation-additions-10";

test("a new fileDiff re-renders and expands an annotation in its collapsed region", async () => {
  const expand = vi.spyOn(DiffHunksRenderer.prototype, "expandHunk");
  const props = { diffStyle: "split" as const, onSelect: () => {}, selected: null };
  const annotations = [{ side: "additions" as const, lineNumber: 10, metadata: <p>Thread</p> }];
  const view = render(<DiffView {...props} fileDiff={contextDiff()} annotations={annotations} />);
  await waitFor(() => expect(shadowOf(view).querySelector(`slot[name="${slotName}"]`)).toBeTruthy());
  expect(expand).toHaveBeenCalledTimes(1);
  view.rerender(<DiffView {...props} fileDiff={contextDiff()} annotations={[...annotations]} />);
  await waitFor(() => expect(expand).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(shadowOf(view).querySelector(`slot[name="${slotName}"]`)).toBeTruthy());
});

test("two annotations on one line render exactly one card, the last", async () => {
  const diff = parsed();
  const view = render(
    <DiffView
      fileDiff={diff}
      diffStyle="split"
      selected={null}
      onSelect={() => {}}
      annotations={[
        { side: "additions", lineNumber: 3, metadata: <p>First card</p> },
        { side: "additions", lineNumber: 3, metadata: <p>Last card</p> },
      ]}
    />,
  );
  await waitFor(() => expect(shadowOf(view).querySelector('slot[name="annotation-additions-3"]')).toBeTruthy());
  expect(view.queryAllByText(/card/)).toHaveLength(1);
  expect(view.getByText("Last card")).toBeTruthy();
});

test("a thread moving to another line renders at the new line only", async () => {
  const diff = parsed();
  const at = (lineNumber: number) => (
    <DiffView
      fileDiff={diff}
      diffStyle="split"
      selected={null}
      onSelect={() => {}}
      annotations={[{ side: "additions", lineNumber, metadata: <p>Moving thread</p> }]}
    />
  );
  const view = render(at(2));
  await waitFor(() => expect(shadowOf(view).querySelector('slot[name="annotation-additions-2"]')).toBeTruthy());
  view.rerender(at(3));
  await waitFor(() => expect(shadowOf(view).querySelector('slot[name="annotation-additions-3"]')).toBeTruthy());
  expect(shadowOf(view).querySelector('slot[name="annotation-additions-2"]')).toBeNull();
  expect(view.queryAllByText("Moving thread")).toHaveLength(1);
});

test("an annotation added after mount in a collapsed region expands it", async () => {
  const expand = vi.spyOn(DiffHunksRenderer.prototype, "expandHunk");
  const props = { diffStyle: "split" as const, onSelect: () => {}, selected: null };
  const diff = contextDiff();
  const view = render(<DiffView {...props} fileDiff={diff} annotations={[]} />);
  await waitFor(() => expect(shadowOf(view).querySelector("[data-line]")).toBeTruthy());
  expect(expand).not.toHaveBeenCalled();
  view.rerender(
    <DiffView
      {...props}
      fileDiff={diff}
      annotations={[{ side: "additions", lineNumber: 10, metadata: <p>Later</p> }]}
    />,
  );
  await waitFor(() => expect(shadowOf(view).querySelector(`slot[name="${slotName}"]`)).toBeTruthy());
  expect(expand).toHaveBeenCalledTimes(1);
});

test("after a re-render with a new onSelect, selection and the gutter button call the newest one", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const diff = parsed();
  const view = render(<DiffView fileDiff={diff} diffStyle="split" selected={null} annotations={[]} onSelect={first} />);
  const shadow = shadowOf(view);
  await waitFor(() => expect(shadow.querySelector("[data-line]")).toBeTruthy());
  view.rerender(<DiffView fileDiff={diff} diffStyle="split" selected={null} annotations={[]} onSelect={second} />);
  const row = shadow.querySelector('[data-line-type="change-addition"][data-line="2"]') as HTMLElement;
  fireEvent.pointerMove(row, { pointerType: "mouse", pointerId: 1 });
  const button = view.getByRole("button", { name: "Comment on line" });
  fireEvent.pointerEnter(button, { pointerType: "mouse" });
  fireEvent.click(button);
  expect(second).toHaveBeenCalledExactlyOnceWith({ start: 2, end: 2, side: "additions" });
  second.mockClear();
  const start = shadow.querySelector('[data-line-type="change-addition"][data-column-number="2"]') as HTMLElement;
  const end = shadow.querySelector('[data-line-type="change-addition"][data-column-number="3"]') as HTMLElement;
  Object.defineProperty(shadow, "elementFromPoint", { configurable: true, value: () => end });
  fireEvent.pointerDown(start, { pointerType: "mouse", pointerId: 2 });
  fireEvent.pointerMove(end, { pointerType: "mouse", pointerId: 2 });
  fireEvent.pointerUp(end, { pointerType: "mouse", pointerId: 2 });
  expect(second).toHaveBeenCalledExactlyOnceWith({ start: 2, end: 3, side: "additions" });
  expect(first).not.toHaveBeenCalled();
});
