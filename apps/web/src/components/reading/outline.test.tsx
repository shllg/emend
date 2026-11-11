import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RenderedBlock, RenderedWriteup, ThreadView, TopicMeta } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearDraft, draftKey, editDraftKey, saveDraft } from "../../lib/drafts.ts";
import { layoutStore } from "../../lib/layout-store.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import { DocView } from "./DocView.tsx";
import { Writeup } from "./Writeup.tsx";
import { OUTLINE_MIN_WIDTH, OUTLINE_WIDTH } from "./WriteupOutline.tsx";

const reviewId = "11111111-1111-4111-8111-111111111111";
const block: RenderedBlock = {
  id: "overview-12345678",
  section: "overview",
  kind: "paragraph",
  text: "Plant a seed.",
  html: "<p>Plant a seed.</p>",
};
const topic: TopicMeta = {
  slug: "seed",
  title: "Plant a seed",
  summary: "A synthetic garden",
  importance: 1,
  attention: "skim",
  door: "two-way",
};
const writeup: RenderedWriteup = {
  sections: [
    { key: "overview", label: "Overview", topic: null, blocks: [block] },
    { key: "tldr", label: "TL;DR", topic: null, blocks: [] },
    { key: "decisions", label: "Decisions", topic: null, blocks: [] },
    { key: "glossary", label: "Glossary", topic: null, blocks: [] },
    {
      key: "t-seed-why",
      label: "Why",
      topic: "seed",
      blocks: [{ ...block, id: "t-seed-why-12345678", section: "t-seed-why" }],
    },
    { key: "t-seed-body", label: "Details", topic: "seed", blocks: [] },
  ],
};
const thread: ThreadView = {
  id: reviewId,
  createdOn: 1,
  state: "open",
  target: { kind: "writeup-span", blockId: block.id, quote: "seed", prefix: "Plant a ", suffix: "." },
  placement: { status: "placed", location: { kind: "writeup-span", blockId: block.id, start: 8, end: 12 } },
  comments: [{ id: reviewId, author: "user", body: "A synthetic comment", sent: true, sentOn: 1 }],
};
type Observation = {
  callback: () => void;
  options?: IntersectionObserverInit;
  elements: Element[];
  disconnect: ReturnType<typeof vi.fn<() => void>>;
};
let observers: Observation[];
let frames: Map<number, FrameRequestCallback>;
let positions: Map<string, number>;
let client: QueryClient;
beforeEach(() => {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  layoutStore.update({ contents: true, compact: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  observers = [];
  frames = new Map();
  positions = new Map([
    ["overview", 26],
    ["tldr", 400],
    ["decisions", 800],
    ["glossary", 1200],
    ["t-seed-why", 1600],
  ]);
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      entry: Observation;
      constructor(callback: () => void, options?: IntersectionObserverInit) {
        this.entry = { callback, options, elements: [], disconnect: vi.fn() };
        observers.push(this.entry);
      }
      observe(element: Element) {
        this.entry.elements.push(element);
      }
      disconnect() {
        this.entry.disconnect();
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const section = this.closest<HTMLElement>("[data-reading-section]")?.dataset.readingSection;
    return new DOMRect(0, section ? (positions.get(section) ?? 0) : 0, 800, 20);
  });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(overrides: Partial<React.ComponentProps<typeof Writeup>> = {}, visible = true) {
  const ui = (props: Partial<React.ComponentProps<typeof Writeup>>, shown: boolean) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <section data-reading-scroll hidden={!shown} data-testid="scroll">
          <Writeup
            reviewId={reviewId}
            revision={1}
            writeup={writeup}
            topics={[topic]}
            threads={[thread]}
            changedBlocks={[]}
            {...props}
            visible={shown}
          />
        </section>
      </ToastProvider>
    </QueryClientProvider>
  );
  const view = render(ui(overrides, visible));
  return { ...view, rerender: (props = overrides, shown = visible) => view.rerender(ui(props, shown)) };
}
function flushFrames() {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  });
}

test.each([
  { contents: true, compact: false },
  { contents: false, compact: true },
  { contents: true, compact: true },
  { contents: false, compact: false },
])("writeup effects are independent with contents=$contents compact=$compact", ({ contents, compact }) => {
  layoutStore.update({ contents, compact });
  const view = mount();
  expect(!!screen.queryByRole("navigation", { name: "Writeup outline" })).toBe(contents);
  expect(!!view.container.querySelector(".em-outline-progress")).toBe(contents);
  expect(view.container.querySelector(".em-reading-column")?.className).toBe(
    "em-reading-column pt-4 pb-8 md:pt-7 md:pb-[72px]",
  );
  expect(!!document.getElementById(`thread-${thread.id}`)).toBe(!compact);
  expect(!!screen.queryByRole("button", { name: "1 comment", expanded: false })).toBe(compact);
  for (const wrapper of view.container.querySelectorAll(".em-block-threads")) {
    expect(wrapper.hasAttribute("data-compact")).toBe(compact);
  }
  if (compact) {
    fireEvent.click(screen.getByRole("button", { name: "1 comment" }));
    expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide", expanded: true })).toBeTruthy();
  }
});

test.each([false, true])("Markdown doc comments honor compact independently and stay open on phone=%s", (phone) => {
  vi.stubGlobal("matchMedia", () => ({ matches: !phone, addEventListener() {}, removeEventListener() {} }));
  layoutStore.update({ contents: false, compact: true });
  const doc = { kind: "markdown" as const, path: "garden.md", blocks: [block] };
  const docThread: ThreadView = {
    ...thread,
    target: { kind: "doc-span", path: doc.path, blockId: block.id, quote: "seed", prefix: "Plant a ", suffix: "." },
    placement: {
      status: "placed",
      location: { kind: "doc-span", path: doc.path, blockId: block.id, start: 8, end: 12 },
    },
  };
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DocView
          reviewId={reviewId}
          revision={1}
          docs={[doc]}
          openDoc={doc}
          search={{ tab: "docs", doc: doc.path }}
          targeted={false}
          onOpenDoc={() => {}}
          changedBlocks={[]}
          threads={[docThread]}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("navigation", { name: "Writeup outline" })).toBeNull();
  expect(!!document.getElementById(`thread-${thread.id}`)).toBe(phone);
  expect(!!view.container.querySelector(".em-thread-pill")).toBe(!phone);
  if (!phone) {
    fireEvent.click(screen.getByRole("button", { name: "1 comment", expanded: false }));
    expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide", expanded: true }));
    expect(document.getElementById(`thread-${thread.id}`)).toBeNull();
    act(() => layoutStore.update({ compact: false }));
    expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
    expect(view.container.querySelector(".em-thread-pill")).toBeNull();
  }
});

test("Contents keeps the standard measure and the outline hides below 640px", () => {
  const outline = readFileSync(resolve(import.meta.dirname, "../../styles/outline.css"), "utf8");
  expect(outline).toContain(`grid-template-columns: ${OUTLINE_WIDTH}px minmax(0, 1fr);`);
  expect(outline).toContain(`@container reading (width < ${OUTLINE_MIN_WIDTH}px)`);
  expect(outline).not.toMatch(/max-width|62ch/);
  expect(outline).toMatch(
    /\.em-outline-layout \.em-reading-group,\s*\.em-outline-layout \[id\]\s*\{\s*scroll-margin-top: calc\(var\(--reading-sticky-top\) \+ 14px\);/,
  );
  expect(outline).toMatch(
    /@container reading \(width < 640px\)\s*\{\s*\.em-outline-layout\s*\{\s*grid-template-columns: minmax\(0, 1fr\);\s*\}\s*\.em-outline\s*\{\s*display: none;/,
  );
  const reading = readFileSync(resolve(import.meta.dirname, "../../styles/reading.css"), "utf8");
  expect(reading).toMatch(/\.em-reading-column\s*\{\s*--reading-max:\s*1000px;\s*\}/);
  expect(reading).not.toMatch(/\.em-reading-column:not\(/);
});

test("outline has one row per section, topic ranks and placed thread counts", () => {
  const topicThread: ThreadView = {
    ...thread,
    id: "22222222-2222-4222-8222-222222222222",
    target: { kind: "topic", slug: "seed" },
    placement: { status: "placed", location: { kind: "topic", slug: "seed" } },
  };
  mount({
    threads: [
      thread,
      { ...thread, id: "resolved", state: "resolved" },
      topicThread,
      { ...thread, id: "lost", placement: { status: "unplaced", reason: "block-gone" } },
    ],
  });
  const outline = within(screen.getByRole("navigation", { name: "Writeup outline" }));
  expect(outline.getAllByRole("button").map((row) => row.textContent)).toEqual([
    "Overview2 comments",
    "TL;DR",
    "Decisions & drift",
    "Glossary",
    "01Plant a seed1 comment",
  ]);
  expect(outline.getByRole("button", { name: "Overview 2 comments" }).getAttribute("aria-current")).toBe("location");
  expect(screen.getAllByRole("heading", { name: "Topic 1: Plant a seed" })).toHaveLength(1);
});

test("outline reveals folded topics and the glossary before scrolling their existing sections", () => {
  mount();
  const outline = within(screen.getByRole("navigation", { name: "Writeup outline" }));
  const fold = screen.getByRole("button", { name: "Topic 1: Plant a seed", expanded: false });
  let hiddenAtScroll: boolean | undefined;
  vi.mocked(HTMLElement.prototype.scrollIntoView).mockImplementation(function (this: HTMLElement) {
    hiddenAtScroll = !!this.querySelector("[hidden]");
  });
  fireEvent.click(outline.getByRole("button", { name: "Plant a seed" }));
  expect(outline.getByRole("button", { name: "Plant a seed" }).getAttribute("aria-current")).toBe("location");
  expect(hiddenAtScroll).toBe(false);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.instances).toContain(
    document.getElementById("topic-seed"),
  );
  const glossary = screen.getByText("Glossary · 0 terms").closest("details");
  expect(glossary?.open).toBe(false);
  fireEvent.click(outline.getByRole("button", { name: "Glossary" }));
  expect(glossary?.open).toBe(true);
  expect(outline.getByRole("button", { name: "Glossary" }).getAttribute("aria-current")).toBe("location");
});

test("one header observer follows the current section and scroll only queues progress", () => {
  const onCurrentTopic = vi.fn();
  mount({ onCurrentTopic });
  const observer = observers.at(-1);
  expect(observers).toHaveLength(1);
  expect(observer?.options?.root).toBe(screen.getByTestId("scroll"));
  expect(observer?.elements.map((node) => node.tagName)).toEqual(["H2", "H2", "H2", "SUMMARY", "H2"]);
  const outline = within(screen.getByRole("navigation", { name: "Writeup outline" }));
  positions.set("t-seed-why", -10);
  act(() => observer?.callback());
  expect(outline.getByRole("button", { name: "Plant a seed" }).getAttribute("aria-current")).toBe("location");
  expect(onCurrentTopic).toHaveBeenLastCalledWith("seed");
  const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
  bounds.mockClear();
  fireEvent.scroll(screen.getByTestId("scroll"));
  flushFrames();
  expect(bounds).not.toHaveBeenCalled();
});

test("progress is aria-hidden, clamped, frame-coalesced and suspended with the pane", () => {
  const onCurrentTopic = vi.fn();
  const props = { onCurrentTopic };
  const view = mount(props);
  const pane = screen.getByTestId("scroll");
  Object.defineProperties(pane, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 1500 },
  });
  const progress = view.container.querySelector<HTMLElement>(".em-outline-progress");
  expect(progress?.getAttribute("aria-hidden")).toBe("true");
  pane.scrollTop = 500;
  fireEvent.scroll(pane);
  fireEvent.scroll(pane);
  expect(frames.size).toBe(1);
  flushFrames();
  expect(progress?.style.transform).toBe("scaleX(0.5)");
  pane.scrollTop = 2000;
  fireEvent.scroll(pane);
  flushFrames();
  expect(progress?.style.transform).toBe("scaleX(1)");
  pane.scrollTop = -10;
  fireEvent.scroll(pane);
  flushFrames();
  expect(progress?.style.transform).toBe("scaleX(0)");
  fireEvent.scroll(pane);
  const observer = observers.at(-1);
  view.rerender(props, false);
  expect(frames.size).toBe(0);
  expect(observer?.disconnect).toHaveBeenCalled();
  onCurrentTopic.mockClear();
  act(() => observer?.callback());
  fireEvent.scroll(pane);
  expect(frames.size).toBe(0);
  expect(onCurrentTopic).not.toHaveBeenCalled();
  pane.scrollTop = 750;
  view.rerender(props, true);
  expect(observers.at(-1)).not.toBe(observer);
  flushFrames();
  expect(progress?.style.transform).toBe("scaleX(0.75)");
});

test("a pane mounted hidden starts observing only when shown", () => {
  const view = mount({}, false);
  expect(observers).toHaveLength(0);
  expect(frames.size).toBe(0);
  view.rerender({}, true);
  expect(observers).toHaveLength(1);
});

test.each([
  ["open", "1 comment"],
  ["answered", "1 comment · answered"],
  ["resolved", "1 comment · resolved"],
] as const)("%s threads fold and reopen without changing the block DOM or anchors", (state, label) => {
  const view = mount({ threads: [{ ...thread, state }] });
  const content = document.getElementById(`block-${block.id}`);
  const pill = screen.getByRole("button", { name: label, expanded: false });
  expect(view.container.querySelector("[data-thread-card]")).toBeNull();
  fireEvent.click(pill);
  expect(document.getElementById(`thread-${thread.id}`)?.classList.contains("em-card")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Hide", expanded: true }));
  expect(view.container.querySelector("[data-thread-card]")).toBeNull();
  expect(document.getElementById(`block-${block.id}`)).toBe(content);
  expect(screen.getByRole("button", { name: label })).toBe(document.activeElement);
});

test("multiple threads share a pill, with answered taking precedence unless all are resolved", () => {
  const view = mount({
    threads: [thread, { ...thread, id: "second", state: "answered" }, { ...thread, id: "third", state: "resolved" }],
  });
  expect(screen.getByRole("button", { name: "3 comments · answered" })).toBeTruthy();
  view.rerender({ threads: [thread, { ...thread, id: "second", state: "resolved" }] });
  expect(screen.getByRole("button", { name: "2 comments" })).toBeTruthy();
});

test("unsent comments, including replies, and resumed composers keep all block threads open", () => {
  const unsent = {
    ...thread,
    comments: [
      ...thread.comments,
      { id: "reply", author: "user" as const, body: "An unsent reply", sent: false, sentOn: null },
    ],
  };
  const view = mount({ threads: [unsent] });
  expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
  view.rerender({ resumedBlockId: block.id });
  expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
});

test("closing the gutter composer keeps its cards mounted until Hide", () => {
  mount();
  const overview = screen.getByRole("region", { name: "Overview" });
  fireEvent.click(within(overview).getByRole("button", { name: "Comment on block" }));
  const card = document.getElementById(`thread-${thread.id}`);
  expect(card).toBeTruthy();
  expect(screen.getByRole("textbox")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.getElementById(`thread-${thread.id}`)).toBe(card);
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(screen.getByRole("button", { name: "1 comment" })).toBeTruthy();
});

test("selection commenting uses the same anchor and keeps the selected block's threads open", () => {
  mount();
  const content = document.getElementById(`block-${block.id}`);
  const text = content?.querySelector("p")?.firstChild;
  if (!content || !text) throw new Error("Missing block text");
  const range = document.createRange();
  range.setStart(text, 8);
  range.setEnd(text, 12);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent.mouseUp(content);
  fireEvent.click(screen.getByRole("button", { name: "Comment on selection" }));
  expect(screen.getByRole("textbox")).toBeTruthy();
  expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
  window.getSelection()?.removeAllRanges();
});

test("turning both switches off restores cards without replacing blocks or fold choices", () => {
  const view = mount();
  const content = document.getElementById(`block-${block.id}`);
  const title = screen.getByRole("heading", { name: "Topic 1: Plant a seed" });
  const fold = screen.getByRole("button", { name: "Topic 1: Plant a seed" });
  fireEvent.click(fold);
  act(() => layoutStore.update({ contents: false, compact: false }));
  expect(screen.queryByRole("navigation", { name: "Writeup outline" })).toBeNull();
  expect(view.container.querySelector(".em-outline-progress")).toBeNull();
  expect(view.container.querySelector(".em-reading-column")?.className).toBe(
    "em-reading-column pt-4 pb-8 md:pt-7 md:pb-[72px]",
  );
  expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
  expect(document.getElementById(`block-${block.id}`)).toBe(content);
  expect(screen.getByRole("heading", { name: "Topic 1: Plant a seed" })).toBe(title);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
});

test("phone disables both effects even when both preferences are stored", () => {
  mount({ phone: true });
  expect(screen.queryByRole("navigation", { name: "Writeup outline" })).toBeNull();
  expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
  expect(layoutStore.getSnapshot()).toMatchObject({ contents: true, compact: true });
});

test("an open reply composer survives enabling compact comments and cannot be folded", async () => {
  layoutStore.update({ contents: false, compact: false });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const input = screen.getByRole("textbox");
  await act(async () => {});
  act(() => layoutStore.update({ contents: true, compact: true }));
  expect(screen.getByRole("textbox")).toBe(input);
  expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
});

test("a pending thread navigation opens its pill when placement data arrives", () => {
  const threadJump = { threadId: thread.id, token: {} };
  const view = mount({ threads: [], threadJump });
  expect(document.getElementById(`thread-${thread.id}`)).toBeNull();
  view.rerender({ threads: [thread], threadJump });
  expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
});

test("with both switches off and on phone there is no query container and thread wrappers are layout-neutral", () => {
  const style = document.createElement("style");
  // Happy DOM does not apply cascade layers; use the actual component declarations.
  style.textContent = ["outline.css", "threads.css"]
    .map((file) =>
      readFileSync(resolve(import.meta.dirname, `../../styles/${file}`), "utf8")
        .replace("@layer components {", "")
        .replace(/}\s*$/, ""),
    )
    .join("\n");
  document.head.append(style);
  try {
    layoutStore.update({ contents: false, compact: false });
    const view = mount();
    const card = document.getElementById(`thread-${thread.id}`);
    expect(card).toBeTruthy();
    expect(screen.queryByRole("button", { name: /comment|Hide/ })).not.toBeTruthy();
    expect(view.container.querySelector(".em-outline-container")).toBeNull();
    expect(getComputedStyle(screen.getByTestId("scroll")).getPropertyValue("container")).toBe("");
    for (const wrapper of view.container.querySelectorAll(".em-block-threads, .em-block-threads__cards")) {
      expect(getComputedStyle(wrapper).display).toBe("contents");
    }
    act(() => layoutStore.update({ compact: true }));
    expect(view.container.querySelector(".em-outline-container")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "1 comment" }));
    for (const wrapper of view.container.querySelectorAll(".em-block-threads, .em-block-threads__cards")) {
      expect(getComputedStyle(wrapper).display).toBe("block");
    }
    expect(getComputedStyle(screen.getByRole("button", { name: "Hide" })).display).toBe("inline-flex");
    act(() => layoutStore.update({ contents: true }));
    expect(view.container.querySelector(".em-outline-container")).toBeTruthy();
    expect(getComputedStyle(screen.getByTestId("scroll")).getPropertyValue("container")).toBe("");
    view.rerender({ phone: true });
    expect(view.container.querySelector(".em-outline-container")).toBeNull();
    for (const wrapper of view.container.querySelectorAll(".em-block-threads, .em-block-threads__cards")) {
      expect(getComputedStyle(wrapper).display).toBe("contents");
    }
    expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
  } finally {
    style.remove();
  }
});

test("sticky offset follows the measured tab row, and is removed with Contents off", () => {
  let resize: (() => void) | undefined;
  const observed: Element[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe(node: Element) {
        observed.push(node);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const view = mount();
  const pane = screen.getByTestId("scroll");
  const tabRow = document.createElement("div");
  tabRow.className = "em-review-tabs";
  pane.prepend(tabRow);
  const bounds = vi.spyOn(tabRow, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 57));
  const root = view.container.querySelector<HTMLElement>(".em-outline-layout");
  act(() => resize?.());
  expect(observed).toContain(tabRow);
  expect(root?.style.getPropertyValue("--reading-sticky-top")).toBe("57px");
  bounds.mockReturnValue(new DOMRect(0, 0, 800, 73));
  act(() => resize?.());
  expect(root?.style.getPropertyValue("--reading-sticky-top")).toBe("73px");
  tabRow.remove();
  act(() => resize?.());
  expect(root?.style.getPropertyValue("--reading-sticky-top")).toBe("0px");
  act(() => layoutStore.update({ contents: false, compact: false }));
  expect(root?.style.getPropertyValue("--reading-sticky-top")).toBe("");
});

test("at the bottom, a short final section is current without rect reads on every scroll frame", () => {
  mount();
  const pane = screen.getByTestId("scroll");
  positions.set("overview", -700);
  positions.set("tldr", -500);
  positions.set("decisions", -300);
  positions.set("glossary", -100);
  positions.set("t-seed-why", 450);
  act(() => observers.at(-1)?.callback());
  const outline = within(screen.getByRole("navigation", { name: "Writeup outline" }));
  expect(outline.getByRole("button", { name: "Glossary" }).getAttribute("aria-current")).toBe("location");
  pane.scrollTop = 1400;
  fireEvent.scroll(pane);
  flushFrames();
  expect(outline.getByRole("button", { name: "Plant a seed" }).getAttribute("aria-current")).toBe("location");
  const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
  bounds.mockClear();
  fireEvent.scroll(pane);
  flushFrames();
  expect(bounds).not.toHaveBeenCalled();
  pane.scrollTop = 1200;
  fireEvent.scroll(pane);
  flushFrames();
  expect(outline.getByRole("button", { name: "Glossary" }).getAttribute("aria-current")).toBe("location");
});

test("a phone reply sheet reports its open composer and survives resizing into compact comments", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const view = mount({ phone: true });
  const card = document.getElementById(`thread-${thread.id}`);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const input = screen.getByRole("textbox", { name: "Reply" });
  expect(view.container.contains(input)).toBe(false);
  expect(input.closest('[role="dialog"]')).toBeTruthy();
  // No saved draft: the context alone must keep this empty editor's card mounted.
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  view.rerender({ phone: false });
  expect(document.getElementById(`thread-${thread.id}`)).toBe(card);
  expect(screen.getByRole("textbox", { name: "Reply" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
  expect(document.getElementById(`thread-${thread.id}`)).toBe(card);
});

test.each(["reply", "edit"])("a saved %s draft opens its block on mount", (kind) => {
  const key = kind === "reply" ? draftKey(reviewId, thread.target, thread.id) : editDraftKey(reviewId, reviewId);
  saveDraft(key, "Saved synthetic draft");
  mount({
    threads: [
      kind === "edit"
        ? {
            ...thread,
            comments: thread.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })),
          }
        : thread,
    ],
  });
  expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
  if (kind === "reply")
    expect((screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement).value).toBe("Saved synthetic draft");
});

test.each(["Edited synthetic text", ""])("an unsent comment's saved edit resumes with text %j", (text) => {
  saveDraft(editDraftKey(reviewId, reviewId), text);
  mount({
    threads: [{ ...thread, comments: thread.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) }],
  });
  expect((screen.getByRole("textbox", { name: "Edit comment" }) as HTMLTextAreaElement).value).toBe(text);
  expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
});

test("draft subscriptions open a closed block and clearing the draft leaves its card and focus in place", () => {
  mount();
  expect(document.getElementById(`thread-${thread.id}`)).toBeNull();
  const key = draftKey(reviewId, thread.target, thread.id);
  act(() => saveDraft(key, "Synthetic saved reply"));
  const card = document.getElementById(`thread-${thread.id}`);
  expect(card).toBeTruthy();
  const resolve = screen.getByRole("button", { name: "Resolve" });
  act(() => resolve.focus());
  act(() => clearDraft(key));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.getElementById(`thread-${thread.id}`)).toBe(card);
  expect(document.activeElement).toBe(resolve);
  expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
});

test("sending the last unsent comment keeps the card and focused control mounted", () => {
  const unsent = {
    ...thread,
    comments: [
      ...thread.comments,
      { id: "unsent-reply", author: "user" as const, body: "Synthetic reply", sent: false, sentOn: null },
    ],
  };
  const view = mount({ threads: [unsent] });
  const card = document.getElementById(`thread-${thread.id}`);
  const resolve = screen.getByRole("button", { name: "Resolve" });
  act(() => resolve.focus());
  view.rerender({
    threads: [{ ...unsent, comments: unsent.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 })) }],
  });
  expect(document.getElementById(`thread-${thread.id}`)).toBe(card);
  expect(document.activeElement).toBe(resolve);
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(document.getElementById(`thread-${thread.id}`)).toBeNull();
});

test("only a new matching jump token reopens a hidden pill", () => {
  const threadJump = { threadId: thread.id, token: {} };
  const view = mount({ threadJump });
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  view.rerender({ threadJump, search: { tab: "diff" } });
  expect(document.getElementById(`thread-${thread.id}`)).toBeNull();
  view.rerender({ threadJump: { threadId: "other-thread", token: {} } });
  expect(document.getElementById(`thread-${thread.id}`)).toBeNull();
  view.rerender({ threadJump: undefined });
  expect(document.getElementById(`thread-${thread.id}`)).toBeNull();
  view.rerender({ threadJump: { threadId: thread.id, token: {} } });
  expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
});

test("a writeup that fits the pane keeps its first section current after the progress frame", () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
  positions.set("overview", 26);
  positions.set("tldr", 140);
  positions.set("decisions", 240);
  positions.set("glossary", 340);
  positions.set("t-seed-why", 450);
  mount();
  const outline = within(screen.getByRole("navigation", { name: "Writeup outline" }));
  const overview = outline.getByRole("button", { name: "Overview 1 comment" });
  expect(overview.getAttribute("aria-current")).toBe("location");
  flushFrames();
  expect(overview.getAttribute("aria-current")).toBe("location");
  expect(outline.getByRole("button", { name: "Plant a seed" }).hasAttribute("aria-current")).toBe(false);
});

test.each(["", " \n\t"])("a blank saved reply %j does not pin its block open and Hide works", (text) => {
  const key = draftKey(reviewId, thread.target, thread.id);
  saveDraft(key, text);
  mount();
  expect(document.getElementById(`thread-${thread.id}`)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "1 comment" }));
  expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
  expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(document.getElementById(`thread-${thread.id}`)).toBeNull();
  act(() => saveDraft(key, " \t"));
  expect(screen.getByRole("button", { name: "1 comment" })).toBeTruthy();
  expect(document.getElementById(`thread-${thread.id}`)).toBeNull();
});

test.each(["sent", "agent"])("a stale edit draft for a %s comment does not pin its block open", (kind) => {
  saveDraft(editDraftKey(reviewId, reviewId), "Stale synthetic edit");
  mount({
    threads: [
      {
        ...thread,
        comments: thread.comments.map((comment) => ({
          ...comment,
          author: kind === "agent" ? "agent" : "user",
          sent: kind === "sent",
          sentOn: kind === "sent" ? 1 : null,
        })),
      },
    ],
  });
  expect(document.getElementById(`thread-${thread.id}`)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "1 comment" }));
  expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(document.getElementById(`thread-${thread.id}`)).toBeNull();
});
