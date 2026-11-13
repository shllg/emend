import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RenderedBlock, RenderedWriteup, ThreadView, TopicMeta } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearDraft, draftKey, editDraftKey, saveDraft } from "../../lib/drafts.ts";
import { layoutStore } from "../../lib/layout-store.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import { DashOutline } from "./DashOutline.tsx";
import { DocView } from "./DocView.tsx";
import { Writeup } from "./Writeup.tsx";

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
  layoutStore.update({ compact: true });
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

test.each([false, true])("writeup outline stays visible with compact=%s", (compact) => {
  layoutStore.update({ compact });
  const view = mount();
  expect(screen.getByRole("navigation", { name: "Writeup outline" })).toBeTruthy();
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
  layoutStore.update({ compact: true });
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

test("a writeup with only one outline section has no rail", () => {
  mount({ writeup: { sections: writeup.sections.slice(0, 1) }, topics: [] });
  expect(screen.queryByRole("navigation", { name: "Writeup outline" })).toBeNull();
  expect(document.querySelector(".em-outline-layout")).toBeNull();
});

test.each([false, true])(
  "Markdown headings use the dash outline off phone and the Contents menu on phone=%s",
  async (phone) => {
    vi.stubGlobal("matchMedia", () => ({ matches: !phone, addEventListener() {}, removeEventListener() {} }));
    const headings = [
      { id: "intro", text: "Introduction", level: 2 as const },
      { id: "detail", text: '<img src=x onerror="alert(1)">', level: 3 as const },
      { id: "end", text: "Conclusion", level: 2 as const },
    ] as const;
    const doc = { kind: "markdown" as const, path: "garden.md", blocks: [], headings: [...headings] };
    const onHeading = vi.fn();
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
            onHeading={onHeading}
            threads={[]}
            changedBlocks={[]}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(view.container.querySelector(".em-doc-contents-rail")).toBeNull();
    if (phone) {
      expect(view.container.querySelector(".em-dash-rail")).toBeNull();
      expect(screen.queryByRole("navigation", { name: "Document contents" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Contents" }));
      await screen.findByRole("dialog", { name: "Contents" });
    } else {
      expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
      expect(view.container.querySelector(".em-doc-body > .em-dash-rail")).toBeTruthy();
    }
    const nav = screen.getByRole("navigation", { name: "Document contents" });
    expect(within(nav).getAllByRole("button")).toHaveLength(3);
    const title = within(nav).getByText(headings[1].text);
    expect(title.getAttribute("dir")).toBe("auto");
    expect(nav.querySelector("img")).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: headings[1].text }));
    flushFrames();
    await waitFor(() => expect(onHeading).toHaveBeenCalledExactlyOnceWith("detail"));
  },
);

test("dash outline expands only on hover or visible keyboard focus and overlays from the right", () => {
  const outline = readFileSync(resolve(import.meta.dirname, "../../styles/outline.css"), "utf8");
  expect(outline).toContain("grid-template-columns: minmax(0, 1fr) 28px;");
  expect(outline).toContain(".em-dash-outline:is(:hover, :has(:focus-visible))");
  expect(outline).not.toMatch(/:focus-within|@container reading|transition:|display: none/);
  expect(outline).toContain("clip: rect(0, 0, 0, 0);");
  expect(outline).toContain("@media (pointer: coarse)");
  expect(outline).toContain("min-height: 44px;");
  expect(outline).toMatch(
    /\.em-outline-layout \.em-reading-group,\s*\.em-outline-layout \[id\]\s*\{\s*scroll-margin-top: calc\(var\(--reading-sticky-top\) \+ 14px\);/,
  );
});

test("dash items contain hidden labels and keep at least 24px touch targets when collapsed", () => {
  const outline = readFileSync(resolve(import.meta.dirname, "../../styles/outline.css"), "utf8");
  expect(outline).toMatch(/\.em-dash-outline__item\s*\{[^}]*position:\s*relative;/);
  const touchHeight = outline.match(
    /@media\s*\(pointer:\s*coarse\)\s*\{\s*\.em-dash-outline__item\s*\{[^}]*min-height:\s*(\d+)px;/,
  );
  expect(touchHeight).not.toBeNull();
  expect(Number(touchHeight?.[1])).toBeGreaterThanOrEqual(24);
});

test("dash outline measures its pane on mount, resize, hover and focus, and cleans up", () => {
  let paneHeight = 500.8;
  let navTop = 150.2;
  const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-reading-scroll")
      ? new DOMRect(0, 100, 800, paneHeight)
      : new DOMRect(0, navTop, 28, 200);
  });
  let resize = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const view = render(
    <section data-reading-scroll data-testid="pane">
      <DashOutline label="Outline" items={[{ id: "seed", label: "Seed" }]} onPick={() => {}} />
    </section>,
  );
  const nav = screen.getByRole("navigation", { name: "Outline" });
  expect(observe).toHaveBeenCalledExactlyOnceWith(screen.getByTestId("pane"));
  expect(nav.style.maxHeight).toBe("438px");
  paneHeight = 400;
  act(() => resize());
  expect(nav.style.maxHeight).toBe("337px");
  navTop = 200;
  fireEvent.pointerEnter(nav);
  expect(nav.style.maxHeight).toBe("288px");
  navTop = 480;
  fireEvent.focusIn(within(nav).getByRole("button", { name: "Seed" }));
  expect(nav.style.maxHeight).toBe("8px");
  navTop = 500;
  fireEvent.pointerEnter(nav);
  expect(nav.style.maxHeight).toBe("0");
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  bounds.mockClear();
  fireEvent.pointerEnter(nav);
  fireEvent.focusIn(nav);
  expect(bounds).not.toHaveBeenCalled();
});

test("dash outline measures without ResizeObserver and leaves the CSS fallback when there is no pane", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-reading-scroll") ? new DOMRect(0, 0, 800, 400) : new DOMRect(0, 100, 28, 200);
  });
  const outline = <DashOutline label="Outline" items={[{ id: "seed", label: "Seed" }]} onPick={() => {}} />;
  const view = render(<section data-reading-scroll>{outline}</section>);
  expect(screen.getByRole("navigation", { name: "Outline" }).style.maxHeight).toBe("288px");
  view.unmount();
  render(outline);
  expect(screen.getByRole("navigation", { name: "Outline" }).style.maxHeight).toBe("");
});

test("the current dash scrolls only its outline when it leaves the visible range", () => {
  const items = [
    { id: "seed", label: "Seed" },
    { id: "sprout", label: "Sprout" },
    { id: "flower", label: "Flower" },
  ];
  const ui = (current: string) => (
    <section data-reading-scroll data-testid="pane">
      <DashOutline label="Outline" items={items} current={current} onPick={() => {}} />
    </section>
  );
  const view = render(ui("seed"));
  const nav = screen.getByRole("navigation", { name: "Outline" });
  const pane = screen.getByTestId("pane");
  const buttons = within(nav).getAllByRole("button");
  vi.spyOn(nav, "clientHeight", "get").mockReturnValue(60);
  for (const [index, button] of buttons.entries()) {
    vi.spyOn(button, "offsetTop", "get").mockReturnValue(index * 30);
    vi.spyOn(button, "offsetHeight", "get").mockReturnValue(30);
  }
  pane.scrollTop = 240;
  view.rerender(ui("flower"));
  expect(nav.scrollTop).toBe(30);
  expect(buttons[2]?.getAttribute("aria-current")).toBe("location");
  view.rerender(ui("sprout"));
  expect(nav.scrollTop).toBe(30);
  view.rerender(ui("seed"));
  expect(nav.scrollTop).toBe(0);
  expect(pane.scrollTop).toBe(240);
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
});

test("shrinking the pane reveals the current dash after the smaller height is applied", () => {
  let paneHeight = 712;
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-reading-scroll") ? new DOMRect(0, 0, 800, paneHeight) : new DOMRect(0, 100, 28, 600);
  });
  let resize = () => {};
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
  const items = Array.from({ length: 50 }, (_, index) => ({ id: `heading-${index}`, label: `Heading ${index + 1}` }));
  const ui = (current: string) => (
    <section data-reading-scroll data-testid="pane">
      <DashOutline label="Outline" items={items} current={current} onPick={() => {}} />
    </section>
  );
  const view = render(ui("heading-0"));
  const nav = screen.getByRole("navigation", { name: "Outline" });
  const pane = screen.getByTestId("pane");
  vi.spyOn(nav, "clientHeight", "get").mockImplementation(() => Number.parseFloat(nav.style.maxHeight));
  for (const [index, button] of within(nav).getAllByRole("button").entries()) {
    vi.spyOn(button, "offsetTop", "get").mockReturnValue(index * 12);
    vi.spyOn(button, "offsetHeight", "get").mockReturnValue(12);
  }
  pane.scrollTop = 240;
  view.rerender(ui("heading-39"));
  expect(nav.style.maxHeight).toBe("600px");
  expect(nav.scrollTop).toBe(0);
  paneHeight = 412;
  act(() => resize());
  expect(nav.style.maxHeight).toBe("300px");
  expect(nav.scrollTop).toBe(180);
  const current = within(nav).getByRole("button", { name: "Heading 40" });
  expect(current.offsetTop).toBeGreaterThanOrEqual(nav.scrollTop);
  expect(current.offsetTop + current.offsetHeight).toBeLessThanOrEqual(nav.scrollTop + nav.clientHeight);
  expect(pane.scrollTop).toBe(240);
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
});

test("tabbing into a long outline keeps the focused first entry visible instead of the current entry", () => {
  const items = Array.from({ length: 50 }, (_, index) => ({ id: `heading-${index}`, label: `Heading ${index + 1}` }));
  const ui = (current: string) => (
    <section data-reading-scroll data-testid="pane">
      <button type="button">Outside</button>
      <DashOutline label="Outline" items={items} current={current} onPick={() => {}} />
    </section>
  );
  const view = render(ui("heading-0"));
  const nav = screen.getByRole("navigation", { name: "Outline" });
  const pane = screen.getByTestId("pane");
  const first = within(nav).getByRole("button", { name: "Heading 1" });
  vi.spyOn(nav, "clientHeight", "get").mockReturnValue(120);
  for (const [index, button] of within(nav).getAllByRole("button").entries()) {
    vi.spyOn(button, "offsetTop", "get").mockReturnValue(index * 30);
    vi.spyOn(button, "offsetHeight", "get").mockReturnValue(30);
  }
  pane.scrollTop = 240;
  view.rerender(ui("heading-39"));
  expect(nav.scrollTop).toBe(1080);
  act(() => screen.getByRole("button", { name: "Outside" }).focus());
  nav.scrollTop = 0;
  act(() => first.focus());
  expect(document.activeElement).toBe(first);
  expect(nav.scrollTop).toBe(0);
  view.rerender(ui("heading-49"));
  expect(nav.scrollTop).toBe(0);
  fireEvent.pointerEnter(nav);
  expect(nav.scrollTop).toBe(0);
  expect(pane.scrollTop).toBe(240);
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
});

test.each([30, 44])("expanding dash rows to %spx reveals the current or focused item", (height) => {
  const items = [
    { id: "seed", label: "Seed" },
    { id: "sprout", label: "Sprout" },
    { id: "flower", label: "Flower" },
  ];
  const ui = (current: string) => (
    <section data-reading-scroll data-testid="pane">
      <button type="button">Outside</button>
      <DashOutline label="Outline" items={items} current={current} onPick={() => {}} />
    </section>
  );
  const view = render(ui("seed"));
  const nav = screen.getByRole("navigation", { name: "Outline" });
  const pane = screen.getByTestId("pane");
  const outside = screen.getByRole("button", { name: "Outside" });
  const seed = within(nav).getByRole("button", { name: "Seed" });
  const sprout = within(nav).getByRole("button", { name: "Sprout" });
  let rowHeight = 12;
  vi.spyOn(nav, "clientHeight", "get").mockReturnValue(60);
  for (const [index, button] of within(nav).getAllByRole("button").entries()) {
    vi.spyOn(button, "offsetTop", "get").mockImplementation(() => index * rowHeight);
    vi.spyOn(button, "offsetHeight", "get").mockImplementation(() => rowHeight);
  }
  pane.scrollTop = 240;
  view.rerender(ui("flower"));
  expect(nav.scrollTop).toBe(0);
  rowHeight = height;
  fireEvent.pointerEnter(nav);
  expect(nav.scrollTop).toBe(3 * height - 60);
  for (const relatedTarget of [outside, null]) {
    act(() => {
      if (relatedTarget) relatedTarget.focus();
      else seed.blur();
    });
    nav.scrollTop = 0;
    act(() => seed.focus());
    expect(document.activeElement).toBe(seed);
    expect(nav.scrollTop).toBe(0);
  }
  nav.scrollTop = 0;
  act(() => sprout.focus());
  expect(nav.scrollTop).toBe(0);
  expect(pane.scrollTop).toBe(240);
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
});

test("outline has one row per section, topic ranks and placed thread counts", () => {
  const topicThread: ThreadView = {
    ...thread,
    id: "22222222-2222-4222-8222-222222222222",
    target: { kind: "topic", slug: "seed" },
    placement: { status: "placed", location: { kind: "topic", slug: "seed" } },
  };
  const view = mount({
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
  const nav = screen.getByRole("navigation", { name: "Writeup outline" });
  expect(nav.querySelectorAll(".em-dash-outline__dash")).toHaveLength(5);
  expect([...nav.querySelectorAll(".em-dash-outline__text")].every((node) => node.getAttribute("dir") === "auto")).toBe(
    true,
  );
  expect(view.container.querySelector(".em-outline-layout")?.firstElementChild?.contains(nav)).toBe(true);
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
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
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

test("one header observer follows the current section without measuring every scroll", () => {
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

test("section tracking suspends with the hidden pane and resumes when shown", () => {
  const onCurrentTopic = vi.fn();
  const view = mount({ onCurrentTopic });
  const observer = observers.at(-1);
  view.rerender({ onCurrentTopic }, false);
  expect(observer?.disconnect).toHaveBeenCalled();
  onCurrentTopic.mockClear();
  act(() => observer?.callback());
  fireEvent.scroll(screen.getByTestId("scroll"));
  expect(onCurrentTopic).not.toHaveBeenCalled();
  view.rerender({ onCurrentTopic }, true);
  expect(observers.at(-1)).not.toBe(observer);
  expect(onCurrentTopic).toHaveBeenCalled();
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

test("turning compact comments off restores cards without replacing blocks or fold choices", () => {
  const view = mount();
  const content = document.getElementById(`block-${block.id}`);
  const title = screen.getByRole("heading", { name: "Topic 1: Plant a seed" });
  const fold = screen.getByRole("button", { name: "Topic 1: Plant a seed" });
  fireEvent.click(fold);
  act(() => layoutStore.update({ compact: false }));
  expect(screen.getByRole("navigation", { name: "Writeup outline" })).toBeTruthy();
  expect(view.container.querySelector(".em-reading-column")?.className).toBe(
    "em-reading-column pt-4 pb-8 md:pt-7 md:pb-[72px]",
  );
  expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
  expect(document.getElementById(`block-${block.id}`)).toBe(content);
  expect(screen.getByRole("heading", { name: "Topic 1: Plant a seed" })).toBe(title);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
});

test("phone disables the outline and stored compact comments", () => {
  mount({ phone: true });
  expect(screen.queryByRole("navigation", { name: "Writeup outline" })).toBeNull();
  expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
  expect(layoutStore.getSnapshot()).toMatchObject({ compact: true });
});

test("an open reply composer survives enabling compact comments and cannot be folded", async () => {
  layoutStore.update({ compact: false });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const input = screen.getByRole("textbox");
  await act(async () => {});
  act(() => layoutStore.update({ compact: true }));
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

test("thread wrappers stay layout-neutral outside compact comments, including on phone", () => {
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
    layoutStore.update({ compact: false });
    const view = mount();
    const card = document.getElementById(`thread-${thread.id}`);
    expect(card).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(?:\d+ comments?|Hide)$/ })).not.toBeTruthy();
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

test("sticky offset follows the measured tab row, and is removed on phone", () => {
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
  view.rerender({ phone: true });
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

test("a writeup that fits the pane keeps its first section current on scroll", () => {
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
  fireEvent.scroll(screen.getByTestId("scroll"));
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
