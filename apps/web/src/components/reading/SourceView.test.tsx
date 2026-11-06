import type { RevisionView, SourceToken, ThreadView } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claimDraft } from "../../lib/composer-owner.ts";
import { draftKey, editDraftKey, loadDraft } from "../../lib/drafts.ts";
import { stubIntersectionObserver } from "../../test/intersection.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import type { ReaderProps } from "./BlockReader.tsx";
import { SourceView } from "./SourceView.tsx";

const clients: QueryClient[] = [];
beforeEach(() => {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("IntersectionObserver", undefined);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});
const lines: SourceToken[][] = Array.from({ length: 100000 }, (_, i) => [{ text: `line ${i + 1}` }]);
function mount(
  threads: ThreadView[] = [],
  doc: Partial<Extract<RevisionView["docs"][number], { kind: "source" }>> = {},
  props: Partial<ReaderProps> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const tree = (extra: Partial<ReaderProps>) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <SourceView
          reviewId="large-source"
          revision={1}
          threads={threads}
          changedBlocks={[]}
          {...extra}
          doc={{ kind: "source", path: "large.log", language: "text", lines, ...doc }}
        />
      </ToastProvider>
    </QueryClientProvider>
  );
  const result = render(tree(props));
  return { ...result, update: (extra: Partial<ReaderProps>) => result.rerender(tree({ ...props, ...extra })) };
}

function placedThread(end: number, start = end): ThreadView {
  return {
    id: `11111111-1111-4111-8111-${String(end).padStart(12, "0")}`,
    createdOn: 1,
    state: "open",
    target: { kind: "source-lines", path: "large.log", start, end, lines: ["synthetic"], before: [], after: [] },
    placement: { status: "placed", location: { kind: "source-lines", path: "large.log", start, end } },
    comments: [
      {
        id: `22222222-2222-4222-8222-${String(end).padStart(12, "0")}`,
        author: "user",
        body: `Comment at ${end}`,
        sent: true,
        sentOn: 1,
      },
    ],
  };
}

test("100,000 lines mount a bounded number of real rows without IntersectionObserver", () => {
  const { container } = mount();
  const rows = container.querySelectorAll("[data-source-line]");
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThanOrEqual(400);
  expect(container.querySelector('[data-source-line="100000"]')).toBeNull();
  const placeholder = container.querySelector<HTMLElement>('[data-source-chunk="99801"]');
  expect(placeholder?.style.height).toBe("calc(200 * var(--source-line-height))");
  expect(screen.getByRole("button", { name: "Show lines 99801–100000" }).parentElement).toBe(placeholder);
  fireEvent.click(screen.getByRole("button", { name: "Show lines 99801–100000" }));
  expect(container.querySelectorAll("[data-source-line]")).toHaveLength(600);
  expect(container.querySelector('[data-source-line="100000"]')).toBeTruthy();
  expect(container.querySelector('[data-source-line="99601"]')).toBeNull();
});

test("placed threads in four scattered chunks do not pin any rows at first paint", () => {
  stubIntersectionObserver();
  const { container } = mount([1000, 10000, 50000, 90000].map((end) => placedThread(end)));
  expect(container.querySelectorAll("[data-source-line]")).toHaveLength(400);
  expect(container.querySelectorAll("[data-thread-card]")).toHaveLength(0);
  expect(container.querySelector<HTMLElement>('[data-source-chunk="89801"]')?.style.height).toBe(
    "calc(200 * var(--source-line-height))",
  );
});

test("scrolling through chunks bounds mounted rows, preserving only pinned selection", () => {
  const observer = stubIntersectionObserver();
  const { container } = mount();
  const chunk = (start: number) => container.querySelector(`[data-source-chunk="${start}"]`);
  fireEvent.click(screen.getByRole("button", { name: "Comment on line 1" }));
  act(() => {
    observer.intersect(chunk(1), false);
    observer.intersect(chunk(201), false);
  });
  expect(observer.options.every((option) => option?.rootMargin === "1200px 0px")).toBe(true);
  for (let start = 401; start <= 4001; start += 200) {
    act(() => observer.intersect(chunk(start)));
    expect(container.querySelector(`[data-source-line="${start}"]`)).toBeTruthy();
    expect(container.querySelectorAll("[data-source-line]").length).toBeLessThanOrEqual(600);
    act(() => observer.intersect(chunk(start), false));
    expect(chunk(start)?.children.length).toBe(0);
    expect((chunk(start) as HTMLElement).style.height).toBe("calc(200 * var(--source-line-height))");
    expect(container.querySelectorAll("[data-source-line]")).toHaveLength(200);
  }
  expect(screen.getByRole("textbox", { name: "Comment" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(container.querySelectorAll("[data-source-line]")).toHaveLength(0);
});

test("thread chunks retain their measured height on exit and restore the card on entry", () => {
  const observer = stubIntersectionObserver();
  const thread = placedThread(90000);
  const { container } = mount([thread]);
  const chunk = container.querySelector<HTMLElement>('[data-source-chunk="89801"]');
  if (!chunk) throw new Error("missing chunk");
  const rect = new DOMRect(0, 0, 800, 5123.5);
  vi.spyOn(chunk, "getClientRects").mockReturnValue([rect] as unknown as DOMRectList);
  const measure = vi.spyOn(chunk, "getBoundingClientRect").mockReturnValue(rect);
  act(() => observer.intersect(chunk));
  expect(screen.getByText("Comment at 90000")).toBeTruthy();
  act(() => observer.intersect(chunk, false));
  expect(measure).toHaveBeenCalledTimes(1);
  expect(chunk.children.length).toBe(0);
  expect(chunk.style.height).toBe("5123.5px");
  act(() => observer.intersect(chunk));
  expect(screen.getByText("Comment at 90000")).toBeTruthy();
  expect(chunk.style.height).toBe("");
});

test.each([
  { name: "hidden pane", height: 0, width: 0, rendered: false },
  { name: "no client rects", height: 4000, width: 800, rendered: false },
  { name: "zero height", height: 0, width: 800, rendered: true },
  { name: "negative height", height: -1, width: 800, rendered: true },
  { name: "NaN height", height: Number.NaN, width: 800, rendered: true },
  { name: "infinite height", height: Infinity, width: 800, rendered: true },
  { name: "zero width", height: 4000, width: 0, rendered: true },
  { name: "infinite width", height: 4000, width: Infinity, rendered: true },
])("$name retains the baseline or last valid thread chunk height", ({ height, width, rendered }) => {
  const observer = stubIntersectionObserver();
  const { container } = mount([placedThread(90000)]);
  const chunk = container.querySelector<HTMLElement>('[data-source-chunk="89801"]');
  if (!chunk) throw new Error("missing chunk");
  const pane = container.querySelector<HTMLElement>(".em-source-scroll");
  if (!pane) throw new Error("missing pane");
  const rects = vi.spyOn(chunk, "getClientRects");
  const measure = vi.spyOn(chunk, "getBoundingClientRect");
  const geometry = (rect: DOMRect, visible: boolean) => {
    pane.hidden = !visible;
    rects.mockReturnValue((visible ? [rect] : []) as unknown as DOMRectList);
    measure.mockReturnValue(rect);
  };
  const invalid = new DOMRect(0, 0, width, height);
  // A first hidden exit must leave the line-count baseline intact.
  act(() => observer.intersect(chunk));
  geometry(invalid, rendered);
  act(() => observer.intersect(chunk, false));
  expect(chunk.style.height).toBe("calc(200 * var(--source-line-height))");
  geometry(new DOMRect(0, 0, 800, 5123.5), true);
  act(() => observer.intersect(chunk));
  act(() => observer.intersect(chunk, false));
  expect(chunk.style.height).toBe("5123.5px");
  act(() => observer.intersect(chunk));
  geometry(invalid, rendered);
  act(() => observer.intersect(chunk, false));
  expect(chunk.children.length).toBe(0);
  expect(chunk.style.height).toBe("5123.5px");
  // Showing the pane restores rows and allows a new valid measurement.
  geometry(new DOMRect(0, 0, 800, 5400), true);
  act(() => observer.intersect(chunk));
  expect(screen.getByText("Comment at 90000")).toBeTruthy();
  expect(chunk.style.height).toBe("");
  act(() => observer.intersect(chunk, false));
  expect(chunk.style.height).toBe("5400px");
});

test.each(["active", "jump"])("the full %s thread range is pinned until the intent clears", (intent) => {
  const observer = stubIntersectionObserver();
  const thread = placedThread(90202, 89999);
  const { container, update } = mount([thread]);
  update(intent === "active" ? { activeThreadId: thread.id } : { threadJump: { threadId: thread.id, token: {} } });
  const chunks = [89801, 90001, 90201].map((start) => container.querySelector(`[data-source-chunk="${start}"]`));
  for (const chunk of chunks) act(() => observer.intersect(chunk, false));
  expect(screen.getByText("Comment at 90202")).toBeTruthy();
  expect(container.querySelectorAll("[data-source-line]")).toHaveLength(1000);
  update({});
  expect(container.querySelectorAll("[data-source-line]")).toHaveLength(400);
  expect(screen.queryByText("Comment at 90202")).toBeNull();
});

test.each(["reply", "edit"])("open %s pins its chunk and its draft restores after remount", async (kind) => {
  const observer = stubIntersectionObserver();
  const thread = placedThread(90000);
  if (kind === "edit") thread.comments = thread.comments.map((comment) => ({ ...comment, sent: false, sentOn: null }));
  const first = mount([thread]);
  const chunk = first.container.querySelector('[data-source-chunk="89801"]');
  act(() => observer.intersect(chunk));
  fireEvent.click(screen.getByRole("button", { name: kind === "reply" ? "Reply" : "Edit" }));
  act(() => observer.intersect(chunk, false));
  const label = kind === "reply" ? "Reply" : "Edit comment";
  const editor = screen.getByRole("textbox", { name: label });
  expect(editor).toBeTruthy(); // Even an empty, explicitly opened reply stays mounted.
  fireEvent.change(editor, { target: { value: "Keep this unsaved draft" } });
  const comment = thread.comments[0];
  if (!comment) throw new Error("missing comment");
  const key =
    kind === "reply" ? draftKey("large-source", thread.target, thread.id) : editDraftKey("large-source", comment.id);
  expect(loadDraft(key)).toBe("Keep this unsaved draft");
  await act(async () => first.unmount());
  const second = mount([thread]);
  expect(screen.queryByRole("textbox", { name: label })).toBeNull();
  const restoredChunk = second.container.querySelector('[data-source-chunk="89801"]');
  act(() => observer.intersect(restoredChunk));
  act(() => observer.intersect(restoredChunk, false));
  expect((screen.getByRole("textbox", { name: label }) as HTMLTextAreaElement).value).toBe("Keep this unsaved draft");
  expect(screen.getByRole("button", { name: kind === "reply" ? "Save comment" : "Save changes" })).toBeTruthy();
});

test.each(["reply", "edit"])("dismissed %s stays closed and unpinned across virtual remounts", async (kind) => {
  const observer = stubIntersectionObserver();
  const thread = placedThread(90000);
  if (kind === "edit") thread.comments = thread.comments.map((comment) => ({ ...comment, sent: false, sentOn: null }));
  const { container } = mount([thread]);
  const chunk = container.querySelector('[data-source-chunk="89801"]');
  act(() => observer.intersect(chunk));
  fireEvent.click(screen.getByRole("button", { name: kind === "reply" ? "Reply" : "Edit" }));
  const label = kind === "reply" ? "Reply" : "Edit comment";
  const editor = screen.getByRole("textbox", { name: label });
  fireEvent.change(editor, { target: { value: "Keep this dismissed draft" } });
  if (kind === "reply") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  else fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: label })).toBeNull();
  const comment = thread.comments[0];
  if (!comment) throw new Error("missing comment");
  const key =
    kind === "reply" ? draftKey("large-source", thread.target, thread.id) : editDraftKey("large-source", comment.id);
  for (let visit = 0; visit < 2; visit++) {
    // Flush the last card's microtask cleanup before returning to the chunk.
    await act(async () => observer.intersect(chunk, false));
    expect(chunk?.children.length).toBe(0);
    act(() => observer.intersect(chunk));
    expect(screen.getByText("Comment at 90000")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: label })).toBeNull();
    expect(loadDraft(key)).toBe("Keep this dismissed draft");
  }
  await act(async () => observer.intersect(chunk, false));
  expect(chunk?.children.length).toBe(0);
  // An explicit resume while virtualized still overrides the saved dismissal.
  act(() => claimDraft(key, "reading"));
  act(() => observer.intersect(chunk));
  act(() => observer.intersect(chunk, false));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: label }).value).toBe("Keep this dismissed draft");
});

test("an unsent thread without an editor unmounts and returns with its controls", () => {
  const observer = stubIntersectionObserver();
  const thread = placedThread(90000);
  thread.comments = thread.comments.map((comment) => ({ ...comment, sent: false, sentOn: null }));
  const { container } = mount([thread]);
  const chunk = container.querySelector('[data-source-chunk="89801"]');
  act(() => observer.intersect(chunk));
  expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  act(() => observer.intersect(chunk, false));
  expect(screen.queryByText("Comment at 90000")).toBeNull();
  act(() => observer.intersect(chunk));
  expect(screen.getByText("Comment at 90000")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
});

test("selection across chunks opens a composer with the exact source range", async () => {
  const observer = stubIntersectionObserver();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { threadId: "11111111-1111-4111-8111-111111111111", commentId: "22222222-2222-4222-8222-222222222222" },
        { status: 201 },
      ),
    ),
  );
  const { container } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Comment on line 199" }));
  fireEvent.click(screen.getByRole("button", { name: "Comment on line 202" }), { shiftKey: true });
  act(() => {
    observer.intersect(container.querySelector('[data-source-chunk="1"]'), false);
    observer.intersect(container.querySelector('[data-source-chunk="201"]'), false);
  });
  const input = screen.getByRole("textbox", { name: "Comment" });
  expect(input.closest("[data-source-end]")?.getAttribute("data-source-end")).toBe("202");
  expect(
    [...container.querySelectorAll("[data-source-line][data-selected]")].map((row) =>
      Number(row.getAttribute("data-source-line")),
    ),
  ).toEqual([199, 200, 201, 202]);
  fireEvent.change(input, { target: { value: "Check this range" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  });
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/reviews/large-source/threads",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        revision: 1,
        target: {
          kind: "source-lines",
          path: "large.log",
          start: 199,
          end: 202,
          lines: ["line 199", "line 200", "line 201", "line 202"],
          before: ["line 196", "line 197", "line 198"],
          after: ["line 203", "line 204", "line 205"],
        },
        body: "Check this range",
      }),
    }),
  );
  expect(container.querySelectorAll("[data-source-line]").length).toBeLessThanOrEqual(400);
});

test.each([false, true])("empty and unrendered files are distinct (unrendered: %s)", (unrendered) => {
  mount([], { lines: [], ...(unrendered ? { unrendered: true } : {}) });
  expect(screen.getByText(unrendered ? "This file could not be shown." : "This file is empty.")).toBeTruthy();
});
