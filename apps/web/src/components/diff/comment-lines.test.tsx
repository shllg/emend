import type { LinesTarget, ThreadView } from "@emend/contract";
import { DiffHunksRenderer, FileDiff as PierreFileDiff } from "@pierre/diffs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as commentHighlights from "../../lib/comment-highlights.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { DiffView, type ParsedDiff } from "./FileDiff.tsx";
import { parsePair } from "./parse.worker.ts";
import { diffShadowCSS } from "./shadow.ts";

const hostile = '"]{}</style><script>';
const target: LinesTarget = {
  kind: "lines",
  path: hostile,
  side: "new",
  start: 1,
  end: 1,
  lines: [hostile],
  before: [],
  after: [],
};
const parsed = parsePair({
  oldFile: { name: "sample.txt", contents: "start\nold one\nold two\nold three\ncontext\nlast\n" },
  newFile: { name: "sample.txt", contents: "prefix\nstart\nnew one\nnew two\nnew three\ncontext\nlast\n" },
});
function thread(side: "old" | "new", start: number, end: number, id = "thread"): ThreadView {
  return {
    id,
    target,
    state: "sent",
    createdOn: 1,
    placement: { status: "placed", location: { kind: "lines", path: hostile, side, start, end } },
    comments: [{ id: `${id}-comment`, author: "user", body: hostile, sent: true, sentOn: 1 }],
  };
}
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  // Diff activity must not depend on the CSS Custom Highlight API.
  vi.stubGlobal("CSS", {});
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(
  style: "split" | "unified",
  threads: ThreadView[],
  {
    fileDiff = parsed,
    composer = false,
    onSelect = () => {},
  }: { fileDiff?: ParsedDiff; composer?: boolean; onSelect?: (range: unknown) => void } = {},
) {
  const ui = (
    values: ThreadView[],
    diffStyle = style,
    overflow: "scroll" | "wrap" = "scroll",
    showComposer = composer,
  ) => (
    <QueryClientProvider client={client}>
      <button type="button">Outside</button>
      <DiffView
        fileDiff={fileDiff}
        diffStyle={diffStyle}
        overflow={overflow}
        onSelect={onSelect}
        selected={null}
        annotations={[
          ...values.map((value) => {
            if (value.placement.status !== "placed" || value.placement.location.kind !== "lines")
              throw new Error("Expected lines");
            const { side, end } = value.placement.location;
            return {
              side: side === "old" ? ("deletions" as const) : ("additions" as const),
              lineNumber: end,
              metadata: <ThreadCard reviewId="review" revision={2} thread={value} changedBlocks={[]} surface="diff" />,
            };
          }),
          ...(showComposer
            ? [
                {
                  side: "additions" as const,
                  lineNumber: 4,
                  metadata: (
                    <Composer reviewId="review" revision={2} surface="diff" target={{ ...target, start: 3, end: 4 }} />
                  ),
                },
              ]
            : []),
        ]}
      />
    </QueryClientProvider>
  );
  const view = render(ui(threads));
  const root = view.container.querySelector("diffs-container")?.shadowRoot;
  if (!root) throw new Error("Missing shadow root");
  return {
    ...view,
    root,
    update: (
      values: ThreadView[],
      diffStyle = style,
      overflow: "scroll" | "wrap" = "scroll",
      showComposer = composer,
    ) => view.rerender(ui(values, diffStyle, overflow, showComposer)),
  };
}
function marked(root: ShadowRoot) {
  return [...root.querySelectorAll("[data-comment-active]")].map((row) => ({
    side: row.closest("[data-deletions]") ? "old" : row.closest("[data-additions]") ? "new" : "unified",
    line: Number(row.getAttribute("data-column-number")),
  }));
}

test.each([
  { style: "split", side: "old", start: 2, end: 3, visible: [2, 3] },
  { style: "split", side: "new", start: 3, end: 4, visible: [3, 4] },
  { style: "unified", side: "old", start: 2, end: 3, visible: [2, 3] },
  { style: "unified", side: "new", start: 3, end: 4, visible: [3, 4] },
  { style: "split", side: "old", start: 5, end: 6, visible: [5, 6] },
  { style: "unified", side: "old", start: 5, end: 6, visible: [6, 7] },
  { style: "unified", side: "new", start: 6, end: 7, visible: [6, 7] },
] as const)(
  "$style card tracks exactly placed $side lines $start–$end without rendering",
  async ({ style, side, start, end, visible }) => {
    const value = thread(side, start, end);
    const view = mount(style, [value]);
    await waitFor(() => expect(view.root.querySelector("[data-line]")).toBeTruthy());
    const card = view.getByRole("article");
    const renders = vi.spyOn(PierreFileDiff.prototype, "render");
    const highlights = vi.spyOn(DiffHunksRenderer.prototype, "renderDiff");
    const css = view.root.querySelector("style[data-unsafe-css]")?.textContent;
    const expected = visible.map((line) => ({ side: style === "split" ? side : "unified", line }));
    expect(marked(view.root)).toEqual([]);
    fireEvent.pointerEnter(card);
    expect(marked(view.root)).toEqual(expected);
    act(() => within(card).getByRole("button", { name: "Reply" }).focus());
    fireEvent.pointerLeave(card);
    expect(marked(view.root)).toEqual(expected);
    act(() => within(card).getByRole("button", { name: "Resolve" }).focus());
    expect(marked(view.root)).toEqual(expected);
    act(() => view.getByRole("button", { name: "Outside" }).focus());
    expect(marked(view.root)).toEqual([]);
    expect(renders).not.toHaveBeenCalled();
    expect(highlights).not.toHaveBeenCalled();
    expect(view.root.querySelector("style[data-unsafe-css]")?.textContent).toBe(css);
    expect(css).toContain(diffShadowCSS);
    expect(css).not.toContain(hostile);
    expect(css).toContain("box-shadow: inset 2px 0 0 var(--accent)");
    expect(card.querySelector("script, style")).toBeNull();
    // The only dynamic marker is a fixed, empty attribute. All CSS stays app-owned.
    fireEvent.pointerEnter(card);
    for (const row of view.root.querySelectorAll("[data-comment-active]"))
      expect(row.getAttribute("data-comment-active")).toBe("");
    fireEvent.pointerLeave(card);
    expect(marked(view.root)).toEqual([]);
  },
);

test("a link inside a comment card on the diff selects no lines and leaves the card as it is", async () => {
  const value = thread("new", 3, 4);
  const [first] = value.comments;
  if (!first) throw new Error("Expected a comment");
  value.comments = [
    {
      ...first,
      html: '<p>see <a href="https://example.test/x" target="_blank" rel="noopener noreferrer nofollow">the link</a></p>',
    },
  ];
  const onSelect = vi.fn();
  const view = mount("split", [value], { onSelect });
  await waitFor(() => expect(view.root.querySelector("[data-line]")).toBeTruthy());
  const card = view.getByRole("article");
  const anchor = within(card).getByRole("link", { name: "the link" });
  const navigations = vi.fn((event: Event) => event.preventDefault());
  document.addEventListener("click", navigations);
  fireEvent.pointerDown(anchor);
  fireEvent.mouseDown(anchor);
  fireEvent.mouseUp(anchor);
  fireEvent.click(anchor);
  document.removeEventListener("click", navigations);
  expect(navigations).toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
  expect(marked(view.root)).toEqual([]);
  expect(view.getByRole("article")).toBe(card);
  expect(within(card).getByRole("link", { name: "the link" })).toBe(anchor);
  expect(within(card).getByRole("button", { name: "Reply" })).toBeTruthy();
});

test("two active cards combine; removing one preserves the other, and style changes retain its line", async () => {
  const first = thread("old", 2, 3, "first");
  const second = thread("new", 4, 5, "second");
  const view = mount("split", [first, second]);
  await waitFor(() => expect(view.root.querySelector("[data-line]")).toBeTruthy());
  const cards = view.getAllByRole("article");
  fireEvent.pointerEnter(cards[1] as HTMLElement);
  act(() =>
    within(cards[0] as HTMLElement)
      .getByRole("button", { name: "Reply" })
      .focus(),
  );
  expect(marked(view.root)).toEqual([
    { side: "old", line: 2 },
    { side: "old", line: 3 },
    { side: "new", line: 4 },
    { side: "new", line: 5 },
  ]);
  view.update([first]);
  expect(marked(view.root)).toEqual([
    { side: "old", line: 2 },
    { side: "old", line: 3 },
  ]);
  view.update([first], "unified");
  expect(marked(view.root)).toEqual([
    { side: "unified", line: 2 },
    { side: "unified", line: 3 },
  ]);
  view.update([]);
  expect(marked(view.root)).toEqual([]);
});

test.each(["split", "unified"] as const)(
  "%s overlapping cards update only changed markers without rescanning the gutter",
  async (style) => {
    const view = mount(style, [thread("new", 3, 4, "first"), thread("new", 4, 5, "second")]);
    await waitFor(() => expect(view.root.querySelector("[data-line]")).toBeTruthy());
    const [first, second] = view.getAllByRole("article");
    const scans = vi.spyOn(view.root, "querySelectorAll");
    const changes = new MutationObserver(() => {});
    changes.observe(view.root, { subtree: true, attributes: true, attributeFilter: ["data-comment-active"] });
    const changedLines = () =>
      changes
        .takeRecords()
        .map(({ target }) => Number((target as Element).getAttribute("data-column-number")))
        .sort();
    try {
      fireEvent.pointerEnter(first as HTMLElement);
      expect(changedLines()).toEqual([3, 4]);
      fireEvent.pointerEnter(second as HTMLElement);
      expect(changedLines()).toEqual([5]);
      fireEvent.pointerLeave(first as HTMLElement);
      expect(changedLines()).toEqual([3]);
      expect(marked(view.root)).toEqual([4, 5].map((line) => ({ side: style === "split" ? "new" : "unified", line })));
      fireEvent.pointerLeave(second as HTMLElement);
      expect(changedLines()).toEqual([4, 5]);
      expect(marked(view.root)).toEqual([]);
      expect(scans.mock.calls.filter(([selector]) => selector !== "[data-comment-active]")).toEqual([]);
    } finally {
      changes.disconnect();
    }
  },
);

test("typing in a reply does not reconcile all cards or scan gutter rows", async () => {
  const view = mount("split", [thread("new", 3, 4)]);
  await waitFor(() => expect(view.root.querySelector("[data-line]")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "Reply" }));
  await act(async () => {});
  // Query before spying: happy-dom's computed-style lookup inside getByRole queries the shadow root's stylesheets.
  const input = view.getByRole("textbox");
  const reconcile = vi.spyOn(commentHighlights, "refreshCommentCards");
  const scan = vi.spyOn(view.root, "querySelectorAll");
  for (const value of ["a", "ab", "abc"]) {
    fireEvent.change(input, { target: { value } });
    await act(async () => {});
  }
  expect(reconcile).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  expect(marked(view.root)).toHaveLength(2);
});

test.each(["reply", "edit"])("diffs retain draft-based %s restoration after dismissal and remount", async (kind) => {
  const placed = thread("new", 3, 4);
  placed.comments = placed.comments.map((comment) => ({
    ...comment,
    sent: kind === "reply",
    sentOn: kind === "reply" ? 1 : null,
  }));
  const first = mount("split", [placed]);
  await waitFor(() => expect(first.root.querySelector("[data-line]")).toBeTruthy());
  fireEvent.click(first.getByRole("button", { name: kind === "reply" ? "Reply" : "Edit" }));
  const label = kind === "reply" ? "Reply" : "Edit comment";
  const editor = first.getByRole("textbox", { name: label });
  fireEvent.change(editor, { target: { value: "Retained diff draft" } });
  if (kind === "reply") fireEvent.click(first.getByRole("button", { name: "Cancel" }));
  else fireEvent.keyDown(editor, { key: "Escape" });
  expect(first.queryByRole("textbox", { name: label })).toBeNull();
  await act(async () => first.unmount());
  const second = mount("split", [placed]);
  await waitFor(() => expect(second.root.querySelector("[data-line]")).toBeTruthy());
  expect((second.getByRole("textbox", { name: label }) as HTMLTextAreaElement).value).toBe("Retained diff draft");
});

test("touch entry cannot start a line bar; mouse hover and control focus still can", async () => {
  const view = mount("split", [thread("new", 3, 4)]);
  await waitFor(() => expect(view.root.querySelector("[data-line]")).toBeTruthy());
  const card = view.getByRole("article");
  fireEvent.pointerEnter(card, { pointerType: "touch" });
  expect(marked(view.root)).toEqual([]);
  act(() => within(card).getByRole("button", { name: "Reply" }).focus());
  expect(marked(view.root)).toHaveLength(2);
  act(() => view.getByRole("button", { name: "Outside" }).focus());
  expect(marked(view.root)).toEqual([]);
  fireEvent.pointerEnter(card, { pointerType: "mouse" });
  expect(marked(view.root)).toHaveLength(2);
  fireEvent.pointerLeave(card, { pointerType: "mouse" });
  expect(marked(view.root)).toEqual([]);
});

test.each(["split", "unified"] as const)(
  "%s slotted composer keeps event focus through slot replacement and layout changes",
  async (style) => {
    const view = mount(style, [], { composer: true });
    await waitFor(() => expect(view.root.querySelector("[data-line]")).toBeTruthy());
    const input = view.getByRole("textbox");
    const card = input.closest(".em-card");
    if (!card) throw new Error("Missing composer card");
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    expect(card.hasAttribute("data-focus-within")).toBe(true);
    const focus = vi.spyOn(input, "focus");
    const slot = view.root.querySelector('slot[name="annotation-additions-4"]');
    if (!slot) throw new Error("Missing annotation slot");
    const replacement = document.createElement("slot");
    replacement.name = "annotation-additions-4";
    slot.replaceWith(replacement);
    expect(slot.isConnected).toBe(false);
    expect(replacement.isConnected).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(card.hasAttribute("data-focus-within")).toBe(true);
    view.update([], style === "split" ? "unified" : "split", "wrap");
    expect(document.activeElement).toBe(input);
    expect(view.getByRole("textbox")).toBe(input);
    expect(card.hasAttribute("data-focus-within")).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    act(() => view.getByRole("button", { name: "Outside" }).focus());
    expect(card.hasAttribute("data-focus-within")).toBe(false);
  },
);

test.each(["split", "unified"] as const)(
  "%s active markers survive hunk expansion and a Wrap toggle",
  async (style) => {
    const old = Array.from({ length: 180 }, (_, index) => `line ${index + 1}`);
    const next = [...old];
    next[39] = "changed 40";
    next[119] = "changed 120";
    const fileDiff = parsePair({
      oldFile: { name: "context.txt", contents: old.join("\n") },
      newFile: { name: "context.txt", contents: next.join("\n") },
    });
    const value = thread("new", 40, 41);
    const view = mount(style, [value], { fileDiff });
    const buttonSelector = '[data-gutter] [data-expand-index="1"] [data-expand-button][role="button"]';
    await waitFor(() => expect(view.root.querySelector(buttonSelector)).toBeTruthy());
    fireEvent.pointerEnter(view.getByRole("article"), { pointerType: "mouse" });
    const expected = [40, 41].map((line) => ({ side: style === "split" ? "new" : "unified", line }));
    expect(marked(view.root)).toEqual(expected);
    const count = view.root.querySelectorAll("[data-column-number]").length;
    fireEvent.click(view.root.querySelector(buttonSelector) as HTMLElement);
    await waitFor(() => expect(view.root.querySelectorAll("[data-column-number]").length).toBeGreaterThan(count));
    expect(marked(view.root)).toEqual(expected);
    view.update([value], style, "wrap");
    await waitFor(() => expect(view.root.querySelector('[data-overflow="wrap"]')).toBeTruthy());
    expect(marked(view.root)).toEqual(expected);
    fireEvent.pointerLeave(view.getByRole("article"), { pointerType: "mouse" });
    expect(marked(view.root)).toEqual([]);
  },
);

test.each([
  { kind: "card", activity: "hover" },
  { kind: "card", activity: "focus" },
  { kind: "composer", activity: "hover" },
  { kind: "composer", activity: "focus" },
])("unmounting a $activity-active $kind clears markers through subsequent renders", async ({ kind, activity }) => {
  const view = mount("split", kind === "card" ? [thread("new", 3, 4)] : [], { composer: kind === "composer" });
  const host = view.container.querySelector("diffs-container");
  await waitFor(() => expect(view.root.querySelector("[data-line]")).toBeTruthy());
  const card = kind === "card" ? view.getByRole("article") : view.getByRole("textbox").closest("form");
  if (activity === "hover") fireEvent.pointerEnter(card as HTMLElement, { pointerType: "mouse" });
  else
    act(() =>
      (kind === "card"
        ? within(card as HTMLElement).getByRole("button", { name: "Reply" })
        : view.getByRole("textbox")
      ).focus(),
    );
  expect(marked(view.root)).toHaveLength(2);
  expect(card?.hasAttribute("data-focus-within")).toBe(activity === "focus");
  view.update([], "split", "scroll", false);
  expect(card?.isConnected).toBe(false);
  expect(card?.hasAttribute("data-focus-within")).toBe(false);
  await waitFor(() => expect(marked(view.root)).toEqual([]));
  expect(view.container.querySelector("diffs-container")).toBe(host);
  view.update([], "split", "wrap", false);
  expect(card?.hasAttribute("data-focus-within")).toBe(false);
  expect(marked(view.root)).toEqual([]);
  expect(view.container.querySelector("diffs-container")).toBe(host);
});

test.each(["Reply", "Edit"])(
  "closing a focused %s clears its line bar when the textarea leaves the card",
  async (action) => {
    const value = thread("new", 3, 4);
    if (action === "Edit")
      value.comments = value.comments.map((comment) => ({ ...comment, sent: false, sentOn: null }));
    const view = mount("split", [value]);
    await waitFor(() => expect(view.root.querySelector("[data-line]")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: action }));
    expect(document.activeElement).toBe(view.getByRole("textbox"));
    const card = view.getByRole("article");
    expect(card.hasAttribute("data-focus-within")).toBe(true);
    expect(marked(view.root)).toHaveLength(2);
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(marked(view.root)).toEqual([]));
    expect(card.hasAttribute("data-focus-within")).toBe(false);
  },
);

test.each([
  { side: "new", start: 1.5, end: 2 },
  { side: "new", start: 0, end: 1 },
  { side: "new", start: 4, end: 3 },
  { side: "new", start: 1, end: 1001 },
  { side: "new", start: 1, end: Number.POSITIVE_INFINITY },
  { side: hostile, start: 2, end: 3 },
])("invalid placed coordinates $side $start–$end cannot mark rows", async ({ side, start, end }) => {
  const view = mount("split", [thread(side as "new", start, end)]);
  await waitFor(() => expect(view.root.querySelector("[data-line]")).toBeTruthy());
  fireEvent.pointerEnter(view.getByRole("article"));
  expect(marked(view.root)).toEqual([]);
});

test("a diff composer shares line activity and cleans up when removed", async () => {
  const view = render(
    <QueryClientProvider client={client}>
      <DiffView
        fileDiff={parsed}
        diffStyle="split"
        selected={null}
        onSelect={() => {}}
        annotations={[
          {
            side: "additions",
            lineNumber: 4,
            metadata: (
              <Composer reviewId="review" revision={2} surface="diff" target={{ ...target, start: 3, end: 4 }} />
            ),
          },
        ]}
      />
    </QueryClientProvider>,
  );
  const root = view.container.querySelector("diffs-container")?.shadowRoot;
  if (!root) throw new Error("Missing shadow root");
  await waitFor(() => expect(root.querySelector("[data-line]")).toBeTruthy());
  const input = view.getByRole("textbox");
  fireEvent.pointerEnter(input.closest("form") as HTMLElement);
  expect(marked(root)).toEqual([
    { side: "new", line: 3 },
    { side: "new", line: 4 },
  ]);
  act(() => input.focus());
  fireEvent.pointerLeave(input.closest("form") as HTMLElement);
  expect(marked(root)).toHaveLength(2);
  act(() => input.blur());
  expect(marked(root)).toEqual([]);
});
