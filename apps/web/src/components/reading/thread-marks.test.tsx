// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RenderedBlock, ThreadView } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claimDraft } from "../../lib/composer-owner.ts";
import { docHeading, findDocHeadings } from "../../lib/doc-navigation.ts";
import { draftKey, editDraftKey, saveDraft } from "../../lib/drafts.ts";
import { applyAnchor, findAnchor } from "../../lib/reading-position.ts";
import { useReadingPosition } from "../../lib/use-reading-position.ts";
import type { ReadingEntry } from "../../lib/use-reading-trail.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import { BlockReader, type ReaderGroup } from "./BlockReader.tsx";

const block: RenderedBlock = {
  id: "overview-12345678",
  section: "overview",
  kind: "paragraph",
  text: "Plant a seed today.",
  html: '<p>Plant a <strong>seed</strong> <a href="https://example.com">today.</a></p>',
};
const thread: ThreadView = {
  id: "11111111-1111-4111-8111-111111111111",
  createdOn: 1,
  state: "open",
  target: { kind: "writeup-span", blockId: block.id, quote: "seed", prefix: "Plant a ", suffix: " today." },
  placement: { status: "placed", location: { kind: "writeup-span", blockId: block.id, start: 8, end: 12 } },
  comments: [
    { id: "22222222-2222-4222-8222-222222222222", author: "user", body: "A synthetic comment", sent: true, sentOn: 1 },
  ],
};
const second: ThreadView = {
  ...thread,
  id: "33333333-3333-4333-8333-333333333333",
  placement: { status: "placed", location: { kind: "writeup-span", blockId: block.id, start: 0, end: 18 } },
};
let client: QueryClient;
let phone: boolean;
let highlights: Map<string, Set<Range>>;
let resize: () => void;
class MockHighlight extends Set<Range> {
  priority = 0;
}
const rect = (y = 100) => new DOMRect(50, y, 200, 20);
beforeEach(() => {
  phone = false;
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  highlights = new Map();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", MockHighlight);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: !phone && 1280 >= Number(query.match(/\d+/)?.[0]),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [rect()] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() => [rect()] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("em-reading-column") || this.hasAttribute("data-reading-scroll")
      ? new DOMRect(0, 0, 600, 700)
      : rect();
  });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function ReadingMemory({ entry }: { entry: ReadingEntry }) {
  useReadingPosition({
    storageKey: "thread-marks",
    selector: "[data-block-id]",
    active: true,
    intentState: () => ({ current: false, epoch: 0 }),
    entry,
  });
  return null;
}
function mount(
  threads = [thread],
  groups: ReaderGroup[] = [{ key: "overview", blocks: [block] }],
  jump?: string,
  options: { resumedBlockId?: string; entry?: ReadingEntry } = {},
) {
  const ui = (items: ThreadView[], jumpId?: string) => (
    <BlockReader
      reviewId={thread.id}
      revision={1}
      changedBlocks={[]}
      threads={items}
      groups={groups}
      resumedBlockId={options.resumedBlockId}
      threadJump={jumpId ? { threadId: jumpId, token: {} } : undefined}
    />
  );
  const wrap = (children: ReactNode) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <div data-reading-scroll>
            {options.entry && <ReadingMemory entry={options.entry} />}
            {children}
          </div>
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const view = render(wrap(ui(threads, jump)));
  return { ...view, update: (items: ThreadView[], jumpId?: string) => view.rerender(wrap(ui(items, jumpId))) };
}
const chip = (count = 1) => screen.getByRole("button", { name: `${count} comment${count === 1 ? "" : "s"}` });
const dialog = () => screen.getByRole("dialog", { name: "Comment thread" });

test("passages starting on the same line share a count chip and resolved threads have no mark", () => {
  const view = mount([thread, second, { ...thread, id: "resolved", state: "resolved" }]);
  expect(chip(2).getAttribute("aria-haspopup")).toBe("dialog");
  expect(screen.queryByRole("button", { name: "1 comment" })).toBeNull();
  expect(view.container.querySelector("[data-thread-card]")).toBeNull();
  view.update([{ ...thread, state: "resolved" }]);
  expect(screen.queryByRole("button", { name: /comments?$/ })).toBeNull();
});
test.each(["diagram", "unmapped", "unsupported"])("a %s thread has a chip at its block", (kind) => {
  if (kind === "unsupported") vi.stubGlobal("Highlight", undefined);
  const value = kind === "diagram" ? { ...block, kind: "diagram" as const, source: "graph TD; A-->B" } : block;
  const item =
    kind === "unmapped"
      ? {
          ...thread,
          placement: {
            status: "placed" as const,
            location: { kind: "writeup-span" as const, blockId: block.id, start: 999, end: 1000 },
          },
        }
      : thread;
  mount([item], [{ key: "overview", blocks: [value] }]);
  expect(chip().style.top).toBe("100px");
});
test("opening a chip inserts no card into the block flow and Escape restores chip focus", () => {
  const view = mount();
  const blockNode = view.container.querySelector("[data-block-id]");
  const before = blockNode?.parentElement?.childElementCount;
  fireEvent.click(chip());
  expect(dialog().getAttribute("aria-modal")).toBe("false");
  expect(document.activeElement).toBe(dialog());
  expect(dialog().parentElement?.classList.contains("em-reading-column")).toBe(true);
  expect(blockNode?.parentElement?.childElementCount).toBe(before);
  expect(blockNode?.parentElement?.querySelector("[data-thread-card]")).toBeNull();
  fireEvent.keyDown(dialog(), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(chip());
});
test("a tinted point opens the shortest overlapping passage and ignores outside, selections and links", () => {
  const view = mount([second, thread]);
  const text = view.container.querySelector("strong") as HTMLElement;
  fireEvent.click(text, { clientX: 20, clientY: 20 });
  expect(screen.queryByRole("dialog")).toBeNull();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(text);
  selection?.addRange(range);
  fireEvent.click(text, { clientX: 60, clientY: 110 });
  expect(screen.queryByRole("dialog")).toBeNull();
  selection?.removeAllRanges();
  fireEvent.click(view.container.querySelector("a") as HTMLElement, { clientX: 60, clientY: 110 });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(text, { clientX: 60, clientY: 110 });
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
});
test.each([false, true])("continuation clicks cannot step through a newly opened thread with phone=%s", (isPhone) => {
  phone = isPhone;
  const view = mount([
    thread,
    {
      ...second,
      placement: { status: "placed", location: { kind: "writeup-span", blockId: block.id, start: 13, end: 18 } },
    },
  ]);
  fireEvent.click(view.container.querySelector("strong") as HTMLElement, { clientX: 60, clientY: 110, detail: 1 });
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
  const next = within(dialog()).getByRole("button", { name: "Next" });
  expect(fireEvent.click(next, { detail: 2 })).toBe(false);
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
  fireEvent.click(next, { detail: 1 });
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${second.id}`);
  const previous = within(dialog()).getByRole("button", { name: "Previous" });
  fireEvent.click(previous, { detail: 2 });
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
  // Keyboard activation dispatches a click with detail 0.
  fireEvent.click(next, { detail: 0 });
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${second.id}`);
});
test.each([false, true])("a double-click started on Next steps twice with phone=%s", (isPhone) => {
  phone = isPhone;
  const thirdId = "44444444-4444-4444-8444-444444444444";
  const view = mount([
    thread,
    {
      ...second,
      placement: { status: "placed", location: { kind: "writeup-span", blockId: block.id, start: 12, end: 18 } },
    },
    {
      ...second,
      id: thirdId,
      placement: { status: "placed", location: { kind: "writeup-span", blockId: block.id, start: 13, end: 18 } },
    },
  ]);
  fireEvent.click(view.container.querySelector("strong") as HTMLElement, { clientX: 60, clientY: 110, detail: 1 });
  const next = within(dialog()).getByRole("button", { name: "Next" });
  expect(fireEvent.click(next, { detail: 2 })).toBe(false);
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
  fireEvent.click(next, { detail: 1 });
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${second.id}`);
  fireEvent.click(next, { detail: 2 });
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thirdId}`);
});
test("clicking a different tinted passage resets a sequence that started inside the open popover", () => {
  vi.mocked(Range.prototype.getClientRects).mockImplementation(function (this: Range) {
    return [rect(this.toString() === "seed" ? 160 : 100)] as unknown as DOMRectList;
  });
  const view = mount([thread, second]);
  const passage = view.container.querySelector("strong") as HTMLElement;
  fireEvent.click(passage, { clientX: 60, clientY: 170, detail: 1 });
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
  fireEvent.click(within(dialog()).getByRole("button", { name: "Previous" }), { detail: 1 });
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${second.id}`);
  fireEvent.click(passage, { clientX: 60, clientY: 170, detail: 1 });
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
  const previous = within(dialog()).getByRole("button", { name: "Previous" });
  expect(fireEvent.click(previous, { detail: 2 })).toBe(false);
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
  fireEvent.click(previous, { detail: 1 });
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${second.id}`);
});
test.each([0, 1])("continuation clicks cannot open Reply but activation with detail=%s can", (detail) => {
  const view = mount();
  fireEvent.click(view.container.querySelector("strong") as HTMLElement, { clientX: 60, clientY: 110, detail: 1 });
  const reply = within(dialog()).getByRole("button", { name: "Reply" });
  expect(fireEvent.click(reply, { detail: 2 })).toBe(false);
  expect(within(dialog()).queryByRole("textbox", { name: "Reply" })).toBeNull();
  fireEvent.click(reply, { detail });
  expect(within(dialog()).getByRole("textbox", { name: "Reply" })).toBeTruthy();
});
test("stepping follows range order with disabled ends and one dialog", () => {
  mount([thread, second]);
  fireEvent.click(chip(2));
  expect(within(dialog()).getByText("1 of 2")).toBeTruthy();
  expect(within(dialog()).getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(within(dialog()).getByRole("button", { name: "Next" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(within(dialog()).getByText("2 of 2")).toBeTruthy();
  expect(within(dialog()).getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(within(dialog()).getByRole("button", { name: "Previous" }));
  expect(within(dialog()).getByText("1 of 2")).toBeTruthy();
});
test("a jump opens even a resolved thread and removing its data closes the dialog", () => {
  const view = mount([{ ...thread, state: "resolved" }], undefined, thread.id);
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
  expect(within(dialog()).getByRole("button", { name: "Reopen" })).toBeTruthy();
  view.update([]);
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("a new jump token reveals an already open thread immediately without replaying after a data refresh", () => {
  const threads = [thread];
  const view = mount(threads, undefined, thread.id);
  const passage = view.container.querySelector("[data-block-id]");
  const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView);
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
  expect(scroll.mock.instances).toContain(passage);
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  scroll.mockClear();
  // Keep the thread data stable so only the new jump token can trigger the reveal.
  view.update(threads, thread.id);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
  expect(scroll.mock.instances[0]).toBe(passage);
  scroll.mockClear();
  view.update([...threads]);
  expect(scroll).not.toHaveBeenCalled();
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
});
test("outside presses close a thread and starting a block comment closes it", () => {
  mount();
  fireEvent.click(chip());
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(chip());
  fireEvent.click(screen.getByRole("button", { name: "Comment on block" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Comment" })).toBeTruthy();
});
test("resizing remeasures a chip and a hidden passage has no chip", () => {
  mount();
  vi.mocked(Range.prototype.getClientRects).mockReturnValue([rect(180)] as unknown as DOMRectList);
  act(() => resize());
  expect(chip().style.top).toBe("180px");
  vi.mocked(Range.prototype.getClientRects).mockReturnValue([] as unknown as DOMRectList);
  act(() => resize());
  expect(screen.queryByRole("button", { name: "1 comment" })).toBeNull();
});
test("a popover never becomes a remembered reading anchor", () => {
  const view = mount();
  fireEvent.click(chip());
  const scroller = view.container.querySelector<HTMLElement>("[data-reading-scroll]") as HTMLElement;
  scroller.scrollTop = 1;
  expect(findAnchor(scroller, '[id^="thread-"]')).toBeNull();
});
test.each([false, true])("hostile quotes and bodies stay literal in the thread with phone=%s", (isPhone) => {
  phone = isPhone;
  const hostile = '<script>evil()</script><img onerror="evil()">';
  mount([
    {
      ...thread,
      target: { ...thread.target, kind: "writeup-span", blockId: block.id, quote: hostile, prefix: "", suffix: "" },
      comments: [{ ...thread.comments[0], id: thread.id, author: "user", body: hostile, sent: true, sentOn: 1 }],
    },
  ]);
  fireEvent.click(chip());
  expect(within(dialog()).getAllByText(hostile)).toHaveLength(2);
  expect(dialog().querySelector("script, img, [onerror]")).toBeNull();
});
test("a phone sheet shows a clamped quote and an unfocused inline reply field without nesting sheets", async () => {
  phone = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 201 })),
  );
  mount();
  fireEvent.click(chip());
  const sheet = dialog();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(sheet.querySelector(".em-thread-quote")?.classList.contains("line-clamp-2")).toBe(true);
  const input = within(sheet).getByRole("textbox", { name: "Reply" });
  expect(document.activeElement).not.toBe(input);
  expect(input.closest("footer")?.parentElement).toBe(sheet);
  expect(within(sheet).queryByRole("button", { name: "Reply" })).toBeNull();
  expect(within(sheet).getByRole("button", { name: "Resolve" })).toBeTruthy();
  fireEvent.change(input, { target: { value: "Another synthetic comment" } });
  fireEvent.click(within(sheet).getByRole("button", { name: "Save comment" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect((input as HTMLTextAreaElement).value).toBe("");
  expect(screen.getByRole("textbox", { name: "Reply" })).toBe(input);
});

test("the phone reply footer can shrink and scroll in a short viewport", () => {
  phone = true;
  mount();
  fireEvent.click(chip());
  const footer = within(dialog()).getByRole("textbox", { name: "Reply" }).closest("footer");
  expect(footer?.classList.contains("min-h-0")).toBe(true);
  expect(footer?.classList.contains("overflow-y-auto")).toBe(true);
  expect(footer?.classList.contains("shrink-0")).toBe(false);
  const body = footer?.previousElementSibling;
  expect(body?.classList.contains("flex-[1_1000000_0%]")).toBe(true);
  expect(body?.classList.contains("flex-1")).toBe(false);
});

test.each([0, 1])("the phone reply footer ignores continuation clicks but saves with detail=%s", async (detail) => {
  phone = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 201 })),
  );
  const view = mount();
  fireEvent.click(view.container.querySelector("strong") as HTMLElement, { clientX: 60, clientY: 110, detail: 1 });
  const input = within(dialog()).getByRole<HTMLTextAreaElement>("textbox", { name: "Reply" });
  fireEvent.change(input, { target: { value: "Synthetic reply" } });
  const save = within(dialog()).getByRole("button", { name: "Save comment" });
  expect(fireEvent.click(save, { detail: 2 })).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  expect(input.value).toBe("Synthetic reply");
  fireEvent.click(save, { detail });
  await waitFor(() => expect(input.value).toBe(""));
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("a popover fits above a passage near the visible bottom", () => {
  vi.mocked(Range.prototype.getClientRects).mockReturnValue([rect(670)] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(300);
  mount();
  fireEvent.click(chip());
  expect(dialog().style.top).toBe("362px");
  expect(dialog().style.maxHeight).toBe("448px");
});

test("resizing only the reading scroller repositions and constrains the open popover", () => {
  const observers: { callback: () => void; elements: Set<Element> }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: (typeof observers)[number];
      constructor(callback: () => void) {
        this.entry = { callback, elements: new Set() };
        observers.push(this.entry);
      }
      observe(element: Element) {
        this.entry.elements.add(element);
      }
      disconnect() {
        this.entry.elements.clear();
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
  const view = mount();
  fireEvent.click(chip());
  expect(dialog().style.top).toBe("128px");
  expect(dialog().style.maxHeight).toBe("448px");
  const scroller = view.container.querySelector<HTMLElement>("[data-reading-scroll]") as HTMLElement;
  const observer = observers.find((entry) => entry.elements.has(scroller) && entry.elements.has(dialog()));
  expect(observer).toBeTruthy();
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 600, 300);
  act(() => observer?.callback());
  expect(dialog().style.top).toBe("8px");
  expect(dialog().style.maxHeight).toBe("284px");
  fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
  expect(observer?.elements.size).toBe(0);
});

test("window resize repositions a popover without a reading scroller", () => {
  vi.stubGlobal("innerHeight", 700);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
  const view = mount();
  view.container.querySelector("[data-reading-scroll]")?.removeAttribute("data-reading-scroll");
  fireEvent.click(chip());
  expect(dialog().style.top).toBe("128px");
  expect(dialog().style.maxHeight).toBe("448px");
  vi.stubGlobal("innerHeight", 300);
  fireEvent(window, new Event("resize"));
  expect(dialog().style.top).toBe("8px");
  expect(dialog().style.maxHeight).toBe("284px");
});

test("clicking a different chip switches the dialog and Escape dismisses the reply before the popover", () => {
  vi.mocked(Range.prototype.getClientRects).mockImplementation(function (this: Range) {
    return [rect(this.toString() === "seed" ? 160 : 100)] as unknown as DOMRectList;
  });
  mount([thread, second]);
  const chips = screen.getAllByRole("button", { name: "1 comment" });
  fireEvent.click(chips[0] as HTMLElement);
  fireEvent.pointerDown(chips[1] as HTMLElement);
  fireEvent.click(chips[1] as HTMLElement);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
  fireEvent.click(within(dialog()).getByRole("button", { name: "Reply" }));
  fireEvent.keyDown(within(dialog()).getByRole("textbox", { name: "Reply" }), { key: "Escape" });
  expect(within(dialog()).queryByRole("textbox", { name: "Reply" })).toBeNull();
  expect(within(dialog()).getByRole("article").id).toBe(`thread-${thread.id}`);
  fireEvent.keyDown(within(dialog()).getByRole("button", { name: "Reply" }), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(chips[1]);
});

test("stepping reveals a folded topic and a closed glossary before opening their passages", () => {
  const folded = { ...block, id: "t-garden-body-12345678", section: "t-garden-body" };
  const glossary = { ...block, id: "glossary-12345678", section: "glossary" };
  const placed = (id: string, value: RenderedBlock): ThreadView => ({
    ...thread,
    id,
    target: { ...thread.target, kind: "writeup-span", blockId: value.id, quote: "seed", prefix: "", suffix: "" },
    placement: { status: "placed", location: { kind: "writeup-span", blockId: value.id, start: 8, end: 12 } },
  });
  mount(
    [placed("glossary", glossary), placed("folded", folded), thread],
    [
      { key: "overview", blocks: [block] },
      {
        key: "garden",
        heading: "Garden",
        topic: { slug: "garden", title: "Garden", importance: 1, summary: "Synthetic plants", attention: "skim" },
        blocks: [folded],
      },
      { key: "glossary", presentation: "glossary", blocks: [glossary] },
    ],
  );
  expect(screen.getAllByRole("button", { name: "1 comment" })).toHaveLength(1);
  fireEvent.click(chip());
  fireEvent.click(within(dialog()).getByRole("button", { name: "Next" }));
  expect(screen.getByRole("button", { name: "Garden" }).getAttribute("aria-expanded")).toBe("true");
  expect(within(dialog()).getByRole("article").id).toBe("thread-folded");
  fireEvent.click(within(dialog()).getByRole("button", { name: "Next" }));
  expect(document.querySelector("details")?.open).toBe(true);
  expect(within(dialog()).getByRole("article").id).toBe("thread-glossary");
  expect(within(dialog()).getByText("3 of 3")).toBeTruthy();
});

test.each(["resolved", "unsent"])("a phone %s thread has no reply field", (state) => {
  phone = true;
  const item: ThreadView =
    state === "resolved"
      ? { ...thread, state }
      : { ...thread, comments: thread.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) };
  mount([item], undefined, thread.id);
  expect(within(dialog()).queryByRole("textbox", { name: "Reply" })).toBeNull();
});

test("resolving an open thread removes its chip but keeps it in the stepper until closed", () => {
  const view = mount([thread, second]);
  fireEvent.click(chip(2));
  view.update([thread, { ...second, state: "resolved" }]);
  expect(chip()).toBeTruthy();
  expect(within(dialog()).getByText("1 of 2")).toBeTruthy();
  fireEvent.keyDown(dialog(), { key: "Escape" });
  expect(document.activeElement?.classList.contains("em-reading-column")).toBe(true);
});

test("pointer movement hit tests once per animation frame and restores the ordinary cursor outside a tint", () => {
  const view = mount();
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const root = view.container.querySelector<HTMLElement>(".em-reading-column") as HTMLElement;
  const text = root.querySelector("strong") as HTMLElement;
  fireEvent.pointerMove(text, { clientX: 60, clientY: 110 });
  fireEvent.pointerMove(text, { clientX: 70, clientY: 110 });
  expect(callbacks).toHaveLength(1);
  act(() => callbacks[0]?.(0));
  expect(root.style.cursor).toBe("pointer");
  fireEvent.pointerMove(text, { clientX: 20, clientY: 20 });
  act(() => callbacks[1]?.(0));
  expect(root.style.cursor).toBe("");
});

test("editing an unsent comment in the phone thread keeps a single sheet", () => {
  phone = true;
  mount([{ ...thread, comments: thread.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) }]);
  fireEvent.click(chip());
  fireEvent.click(within(dialog()).getByRole("button", { name: "Edit" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(within(dialog()).getByRole("textbox", { name: "Edit comment" })).toBeTruthy();
});

test("Escape closes the popover after focus moves elsewhere in the reader", () => {
  mount();
  fireEvent.click(chip());
  act(() => chip().focus());
  fireEvent.keyDown(chip(), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(chip());
});

test("a saved reply stays closed without scrolling until its chip opens the restored editor", () => {
  saveDraft(draftKey(thread.id, thread.target, thread.id), "Retained surface draft");
  const view = mount();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(view.container.querySelector("[data-thread-card]")).toBeNull();
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  fireEvent.click(chip());
  expect(within(dialog()).getByRole<HTMLTextAreaElement>("textbox", { name: "Reply" }).value).toBe(
    "Retained surface draft",
  );
});

test.each(["reply", "edit"])("an explicit reading claim opens and reveals its %s editor", (kind) => {
  const item =
    kind === "edit"
      ? { ...thread, comments: thread.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) }
      : thread;
  const key =
    kind === "reply"
      ? draftKey(thread.id, thread.target, thread.id)
      : editDraftKey(thread.id, "22222222-2222-4222-8222-222222222222");
  saveDraft(key, "Retained surface draft");
  mount([item]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  act(() => claimDraft(key, "reading"));
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  const input = within(dialog()).getByRole<HTMLTextAreaElement>("textbox", {
    name: kind === "reply" ? "Reply" : "Edit comment",
  });
  expect(input.value).toBe("Retained surface draft");
  expect(document.activeElement).toBe(input);
});

test.each([
  { name: "a visible continuation", lines: [-300, -200, 100, 120], top: 148 },
  { name: "all visible passage lines", lines: [100, 120, 140], top: 168 },
  { name: "visible lines with later lines below the viewport", lines: [100, 120, 780], top: 148 },
  { name: "a multiline passage near the bottom", lines: [600, 620, 650], top: 292 },
  { name: "all lines when none are visible", lines: [800, 820], top: 492 },
])("the popover avoids $name and leaves the chip on the first line", ({ lines, top }) => {
  vi.mocked(Range.prototype.getClientRects).mockReturnValue(lines.map((y) => rect(y)) as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(300);
  const view = mount();
  const y = lines.find((y) => y >= 0 && y < 700);
  if (y === undefined) fireEvent.click(chip());
  else fireEvent.click(view.container.querySelector("strong") as HTMLElement, { clientX: 60, clientY: y + 10 });
  expect(dialog().style.top).toBe(`${top}px`);
  expect(chip().style.top).toBe(`${lines[0]}px`);
});

test("the popover anchors below the visible passage rather than lines behind the sticky doc bar", () => {
  vi.mocked(Range.prototype.getClientRects).mockReturnValue([
    rect(60),
    rect(80),
    rect(180),
    rect(200),
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(300);
  const view = mount();
  const bar = document.createElement("div");
  bar.className = "em-doc-bar";
  bar.getBoundingClientRect = () => new DOMRect(0, 0, 600, 160);
  view.container.querySelector("[data-reading-scroll]")?.prepend(bar);
  fireEvent.click(view.container.querySelector("strong") as HTMLElement, { clientX: 60, clientY: 190 });
  expect(dialog().style.top).toBe("228px");
});

test.each([
  { name: "fills", top: 0, height: 700, areaTop: 0 },
  { name: "covers most of", top: 20, height: 660, areaTop: 0 },
  { name: "fills a short viewport in", top: 600, height: 100, areaTop: 600 },
])("a passage that $name the visible area opens a usable popover inside it", ({ top, height, areaTop }) => {
  vi.mocked(Range.prototype.getClientRects).mockReturnValue([
    new DOMRect(50, top, 200, height),
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
  const view = mount();
  if (areaTop) {
    const bar = document.createElement("div");
    bar.className = "em-doc-bar";
    bar.getBoundingClientRect = () => new DOMRect(0, 0, 600, areaTop);
    view.container.querySelector("[data-reading-scroll]")?.prepend(bar);
  }
  fireEvent.click(view.container.querySelector("strong") as HTMLElement, { clientX: 60, clientY: top + 10 });
  const popoverTop = Number.parseFloat(dialog().style.top);
  const maxHeight = Number.parseFloat(dialog().style.maxHeight);
  expect(maxHeight).toBeGreaterThanOrEqual(Math.min(192, 700 - areaTop - 16));
  expect(maxHeight).toBeLessThanOrEqual(448);
  expect(popoverTop).toBeGreaterThanOrEqual(areaTop);
  expect(popoverTop + maxHeight).toBeLessThanOrEqual(700);
  expect(document.activeElement).toBe(dialog());
});

test("stepping opens the next and previous thread at the top of the popover", () => {
  mount([thread, second]);
  fireEvent.click(chip(2));
  dialog().scrollTop = 220;
  fireEvent.click(within(dialog()).getByRole("button", { name: "Next" }));
  expect(dialog().scrollTop).toBe(0);
  dialog().scrollTop = 180;
  fireEvent.click(within(dialog()).getByRole("button", { name: "Previous" }));
  expect(dialog().scrollTop).toBe(0);
});

test.each(["chip", "passage"])("a %s opens a thread after starting a new comment", (trigger) => {
  const view = mount();
  fireEvent.click(chip());
  fireEvent.click(screen.getByRole("button", { name: "Comment on block" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Comment" })).toBeTruthy();
  if (trigger === "chip") fireEvent.click(chip());
  else fireEvent.click(view.container.querySelector("strong") as HTMLElement, { clientX: 60, clientY: 110 });
  expect(dialog()).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Comment" })).toBeTruthy();
});

test("a resumed block does not prevent opening or stepping through its threads", () => {
  mount([thread, second], undefined, undefined, { resumedBlockId: block.id });
  fireEvent.click(chip(2));
  expect(within(dialog()).getByText("1 of 2")).toBeTruthy();
  fireEvent.click(within(dialog()).getByRole("button", { name: "Next" }));
  expect(within(dialog()).getByText("2 of 2")).toBeTruthy();
});

test.each(["Cancel", "Escape", "Save changes"])("phone inline Edit returns focus to Edit after %s", async (action) => {
  phone = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
  mount([{ ...thread, comments: thread.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) }]);
  fireEvent.click(chip());
  fireEvent.click(within(dialog()).getByRole("button", { name: "Edit" }));
  const input = within(dialog()).getByRole("textbox", { name: "Edit comment" });
  act(() => input.focus());
  fireEvent.change(input, { target: { value: "A revised synthetic comment" } });
  if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
  else fireEvent.click(within(dialog()).getByRole("button", { name: action }));
  await waitFor(() => expect(within(dialog()).queryByRole("textbox", { name: "Edit comment" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Edit" })));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

test("saving the phone footer reply returns focus to the sheet and keeps the empty field", async () => {
  phone = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 201 })),
  );
  mount();
  fireEvent.click(chip());
  const input = within(dialog()).getByRole<HTMLTextAreaElement>("textbox", { name: "Reply" });
  act(() => input.focus());
  fireEvent.change(input, { target: { value: "Synthetic reply" } });
  fireEvent.click(within(dialog()).getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(input.value).toBe(""));
  await waitFor(() => expect(document.activeElement).toBe(dialog()));
  expect(within(dialog()).getByRole("textbox", { name: "Reply" })).toBe(input);
});

test("a pending phone footer save preserves focus moved to another editor", async () => {
  phone = true;
  let finish = () => {};
  const response = new Promise<Response>((resolve) => {
    finish = () => resolve(new Response(null, { status: 201 }));
  });
  const fetch = vi.fn(() => response);
  vi.stubGlobal("fetch", fetch);
  mount([
    {
      ...thread,
      comments: [
        ...thread.comments,
        { id: second.id, author: "user", body: "Unsent synthetic comment", sent: false, sentOn: null },
      ],
    },
  ]);
  fireEvent.click(chip());
  fireEvent.click(within(dialog()).getByRole("button", { name: "Edit" }));
  const reply = within(dialog()).getByRole<HTMLTextAreaElement>("textbox", { name: "Reply" });
  const edit = within(dialog()).getByRole("textbox", { name: "Edit comment" });
  act(() => reply.focus());
  fireEvent.change(reply, { target: { value: "Synthetic reply" } });
  fireEvent.click(within(dialog()).getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  act(() => edit.focus());
  await act(async () => finish());
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(reply.value).toBe("");
  expect(document.activeElement).toBe(edit);
});

test("a phone reply claimed by another surface stays a placeholder until the reviewer takes it over", () => {
  phone = true;
  const key = draftKey(thread.id, thread.target, thread.id);
  saveDraft(key, "Reply from another surface");
  claimDraft(key, "comments");
  mount();
  fireEvent.click(chip());
  expect(within(dialog()).queryByRole("textbox", { name: "Reply" })).toBeNull();
  fireEvent.click(within(dialog()).getByRole("button", { name: "Reply" }));
  const input = within(dialog()).getByRole<HTMLTextAreaElement>("textbox", { name: "Reply" });
  expect(input.value).toBe("Reply from another surface");
  expect(document.activeElement).toBe(input);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

test("the popover stacks above the text and chips but below sticky reading bars", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../../styles/threads.css"), "utf8");
  const rule = css.match(/\.em-reading-thread-popover\s*\{([^}]+)\}/)?.[1];
  expect(rule).toMatch(/z-index:\s*calc\(var\(--z-sticky\) - 1\)/);
});

test.each([false, true])(
  "sanitized agent HTML stays outside reading targets and hit tests with phone=%s",
  (isPhone) => {
    phone = isPhone;
    const entry: ReadingEntry = { title: "Synthetic doc", revision: 1, folds: new Map(), positions: new Map() };
    const item: ThreadView = {
      ...second,
      comments: [
        {
          id: "agent",
          author: "agent",
          sent: false,
          sentOn: null,
          body: "Synthetic rendered comment",
          html: '<h2 id="user-content-seed">Comment heading</h2><p>Rendered agent text</p><p><a href="https://example.com/seed" rel="noopener noreferrer nofollow">Comment link</a> &lt;script&gt;evil()&lt;/script&gt;&lt;img onerror="evil()"&gt;</p>',
        },
      ],
    };
    const heading: RenderedBlock = {
      id: "doc-heading",
      section: "overview",
      kind: "heading",
      text: "Document heading",
      html: '<h2 id="user-content-document">Document heading</h2>',
    };
    const view = mount([thread, item], [{ key: "overview", blocks: [block, heading] }], undefined, { entry });
    fireEvent.click(chip(2));
    const sheet = dialog();
    expect(within(sheet).getByRole("article").id).toBe(`thread-${second.id}`);
    const link = within(sheet).getByRole("link", { name: "Comment link" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(sheet.querySelector("script, img, [onerror]")).toBeNull();
    expect(sheet.textContent).toContain('<script>evil()</script><img onerror="evil()">');
    // Prevent navigation in the fixture while allowing the reader's click listener to receive it.
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link, { clientX: 60, clientY: 110 });
    expect(within(dialog()).getByRole("article").id).toBe(`thread-${second.id}`);
    fireEvent.click(within(sheet).getByText("Rendered agent text"), { clientX: 60, clientY: 110 });
    expect(within(dialog()).getByRole("article").id).toBe(`thread-${second.id}`);
    act(() => link.focus());
    expect(entry.focus).toBeUndefined();
    const scroller = view.container.querySelector<HTMLElement>("[data-reading-scroll]") as HTMLElement;
    const column = scroller.querySelector<HTMLElement>(".em-reading-column") as HTMLElement;
    column.dataset.readingDoc = "seed.md";
    const doc = {
      path: "seed.md",
      blocks: [block, heading],
      headings: [
        { level: 2 as const, id: "user-content-seed", text: "Seed" },
        { level: 2 as const, id: "user-content-document", text: "Document heading" },
      ],
    };
    const ownHeading = column.querySelector<HTMLElement>("h2") as HTMLElement;
    expect(docHeading(scroller, doc, "user-content-document")).toBe(ownHeading);
    expect(docHeading(scroller, doc, "user-content-seed")).toBeUndefined();
    expect([...findDocHeadings(scroller, doc).keys()]).toEqual(["user-content-document"]);
    scroller.scrollTop = 42;
    expect(applyAnchor(scroller, { id: "h-user-content-seed", fraction: 0 }, doc)).toBeUndefined();
    expect(scroller.scrollTop).toBe(42);
    ownHeading.getBoundingClientRect = () => new DOMRect(0, 400 - scroller.scrollTop, 400, 24);
    expect(applyAnchor(scroller, { id: "h-user-content-document", fraction: 0 }, doc)).toBe(400);
  },
);
