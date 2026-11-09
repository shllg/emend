// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import type { RenderedBlock, ReviewView, RevisionView, ThreadView } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Window } from "happy-dom";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { layoutStore } from "./lib/layout-store.ts";
import { focusReadingTarget } from "./lib/reading-focus.ts";
import { loadReadingPosition, readingKey, readingPositionKey, saveReadingPosition } from "./lib/reading-position.ts";
import { restoreDelays } from "./lib/use-reading-position.ts";

vi.mock("./components/diff/LazyDiffPane.tsx", () => ({
  LazyDiffPane: () => <p>Diff stub</p>,
}));

const presentation = vi.hoisted(() => ({ collapsedDocCards: false }));
vi.mock("./components/reading/BlockReader.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/reading/BlockReader.tsx")>();
  return {
    ...actual,
    // Exercise the existing collapsed-card mode without changing DocView's display defaults.
    BlockReader: (props: ComponentProps<typeof actual.BlockReader>) => (
      <actual.BlockReader
        {...props}
        focus={
          props.focus || (presentation.collapsedDocCards && props.groups.some((group) => group.path !== undefined))
        }
      />
    ),
  };
});

let id = "11111111-1111-4111-8111-111111111111";
const review: ReviewView = {
  id,
  title: "Synthetic garden",
  origin: { id, name: "Workshop" },
  repo: null,
  branch: null,
  state: "open",
  newestRevision: 1,
  unsentCount: 0,
  openThreads: 0,
  agentWaiting: false,
  pendingSend: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  movedTo: null,
  list: "active",
  snoozed: false,
  snoozedUntil: null,
  releasedAt: null,
  pickedUpAt: null,
  kind: "review",
  importedAt: null,
  revisions: [
    { seq: 1, createdAt: "2026-01-01T00:00:00.000Z" },
    { seq: 2, createdAt: "2026-01-02T00:00:00.000Z" },
  ],
};
const block = (name: string): RenderedBlock => ({
  id: `overview-${name.padEnd(8, "0")}`,
  section: "overview",
  kind: "paragraph",
  text: `Paragraph ${name}`,
  html: `<p>Paragraph ${name}</p>`,
});
const a = block("aaaa");
const b = block("bbbb");
const c = block("cccc");
const docBlock = (doc: string, name: string): RenderedBlock => ({
  id: `doc-${doc}-${name.padEnd(8, "0")}`,
  section: `doc-${doc}`,
  kind: "paragraph",
  text: `Doc ${doc} ${name}`,
  html: `<p>Doc ${doc} ${name}</p>`,
});
const docA = [docBlock("a1a1a1a1", "1111"), docBlock("a1a1a1a1", "2222"), docBlock("a1a1a1a1", "3333")];
const docB = [docBlock("b2b2b2b2", "1111"), docBlock("b2b2b2b2", "2222"), docBlock("b2b2b2b2", "3333")];
const docs: RevisionView["docs"] = [
  { kind: "markdown", path: "a.md", blocks: docA },
  { kind: "markdown", path: "b.md", blocks: docB },
];
const thread: ThreadView = {
  id: "22222222-2222-4222-8222-222222222222",
  createdOn: 1,
  state: "sent",
  target: { kind: "writeup-span", blockId: "overview-bbbb0000", quote: "Paragraph bbbb", prefix: "", suffix: "" },
  placement: {
    status: "placed",
    location: { kind: "writeup-span", blockId: "overview-bbbb0000", start: 0, end: 9 },
  },
  comments: [{ id, author: "user", body: "A synthetic question", sent: true, sentOn: 1 }],
};
const revisionWith = (seq: number, blocks: RenderedBlock[], threads: ThreadView[] = []): RevisionView => ({
  seq,
  base: null,
  head: null,
  main: "writeup",
  writeupEmpty: false,
  topics: [],
  files: [
    {
      id,
      path: "seed.txt",
      oldPath: null,
      role: "diff",
      topic: null,
      order: 0,
      status: "modified",
      mediaType: "text/plain",
      flag: "binary",
      hasOld: false,
      hasNew: false,
    },
  ],
  writeup: { sections: [{ key: "overview", label: "Body", topic: null, blocks }] },
  docs: structuredClone(docs),
  threads,
  changedBlocks: [],
});
// Document offsets of each block inside the reading scroller; every block is 100px tall.
const offsets = new Map<string, number>();
let revisions: Record<number, RevisionView>;
let client: QueryClient;
let width = 390;
const originalBounds = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
let writeupKey = readingPositionKey(id, "writeup", "", 1);

beforeEach(() => {
  id = crypto.randomUUID();
  review.id = id;
  writeupKey = readingPositionKey(id, "writeup", "", 1);
  presentation.collapsedDocCards = false;
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      const pane = document.querySelector<HTMLElement>("[data-reading-scroll]");
      if (pane && this === pane) return new DOMRect(0, 0, 390, 600);
      const top = this.id.startsWith("block-") ? offsets.get(this.id.slice(6)) : undefined;
      if (top !== undefined) return new DOMRect(0, top - (pane?.scrollTop ?? 0), 390, 100);
      return bounds.call(this);
    },
  });
  width = 390;
  offsets.clear();
  offsets.set(a.id, 0).set(b.id, 100).set(c.id, 200);
  for (const [index, block] of docA.entries()) offsets.set(block.id, index * 100);
  for (const [index, block] of docB.entries()) offsets.set(block.id, index * 100);
  revisions = { 1: revisionWith(1, [a, b, c]), 2: revisionWith(2, [a, b, c]) };
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(query.match(/\d+/)?.[0] ?? Infinity),
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/api/v1/session") return new Response(null, { status: 204 });
      if (path === "/api/v1/reviews") return Response.json({ items: [review] });
      if (path === `/api/v1/reviews/${id}`) return Response.json(review);
      const match = path.match(/\/revisions\/(\d+)$/);
      if (match && path.startsWith(`/api/v1/reviews/${id}`)) return Response.json(revisions[Number(match[1])]);
      throw new Error(`Unexpected synthetic request: ${path}`);
    }),
  );
});
afterEach(async () => {
  cleanup();
  client.clear();
  await (window as unknown as Window).happyDOM.abort();
  vi.restoreAllMocks();
  if (originalBounds) Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", originalBounds);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function mount(search = "?tab=writeup&rev=1") {
  const history = createMemoryHistory({ initialEntries: [`/r/${id}${search}`] });
  return { ...render(<App queryClient={client} history={history} />), history };
}
const pane = () => screen.getByTestId("reading-pane");
// The reader moves the pane: input first, then the scroll it causes.
function readerScroll(top: number) {
  fireEvent.wheel(pane());
  pane().scrollTop = top;
  fireEvent.scroll(pane());
}
const stored = () => localStorage.getItem(readingKey);
async function readWriteup(search?: string) {
  const view = mount(search);
  await screen.findAllByText("Paragraph bbbb");
  readerScroll(150);
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${b.id}`, fraction: 0.5 });
  return view;
}
const go = (history: ReturnType<typeof mount>["history"], search: string, hash = "") =>
  act(async () => {
    history.push(`/r/${id}${search}${hash}`);
  });

test("Writeup, Diff, Writeup on the phone restores the anchor", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  await screen.findByText("Diff stub");
  expect(document.querySelector("[data-reading-scroll]")).toBeNull();
  await go(history, "?tab=writeup&rev=1");
  await screen.findByText("Paragraph bbbb");
  await waitFor(() => expect(pane().scrollTop).toBe(150));
});

test("a new revision with the same block restores; with the block gone it stays at the top", async () => {
  const { history } = await readWriteup();
  revisions[2] = revisionWith(2, [a, c, block("dddd")]);
  await go(history, "?tab=diff&rev=1");
  await screen.findByText("Diff stub");
  await go(history, "?tab=writeup&rev=2");
  await screen.findByText("Paragraph cccc");
  offsets.set(c.id, 100);
  await new Promise((resolve) => setTimeout(resolve, restoreDelays[2] + 100));
  expect(pane().scrollTop).toBe(0);

  revisions[2] = revisionWith(2, [a, b, c]);
  client.clear();
  await go(history, "?tab=diff&rev=2");
  await go(history, "?tab=writeup&rev=1");
  await screen.findByText("Paragraph bbbb");
  await waitFor(() => expect(pane().scrollTop).toBe(150));
});

test("a link with a hash wins over the saved anchor", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  await screen.findByText("Diff stub");
  const scrollIntoView = vi.fn();
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scrollIntoView);
  await go(history, "?tab=writeup&rev=1", `#block-${c.id}`);
  await screen.findByText("Paragraph cccc");
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, restoreDelays[2] + 100));
  expect(pane().scrollTop).toBe(0);
});

test("a thread jump to a thread of the revision wins even when the jump does not move the pane", async () => {
  revisions[1] = revisionWith(1, [a, b, c], [thread]);
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  await screen.findByText("Diff stub");
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  await go(history, "?tab=writeup&rev=1", `#thread-${thread.id}`);
  await screen.findAllByText("Paragraph bbbb");
  await new Promise((resolve) => setTimeout(resolve, restoreDelays[2] + 100));
  expect(pane().scrollTop).toBe(0);
});

test("a scroll by the reviewer during the retry window stops the retries", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  await screen.findByText("Diff stub");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await go(history, "?tab=writeup&rev=1");
  expect(pane().scrollTop).toBe(150);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(restoreDelays[1] - 1);
  });
  expect(pane().scrollTop).toBe(150);
  readerScroll(40);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(restoreDelays.at(-1) ?? 0);
  });
  expect(pane().scrollTop).toBe(40);
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${a.id}`, fraction: 0.4 });
});

test("touching the pane stops the retries", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await go(history, "?tab=writeup&rev=1");
  expect(pane().scrollTop).toBe(150);
  fireEvent.touchStart(pane());
  pane().scrollTop = 40;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(restoreDelays.at(-1) ?? 0);
  });
  expect(pane().scrollTop).toBe(40);
});

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
const keyOf = (tab: string, doc = "") => readingPositionKey(id, tab, doc, 1);

test("single-pane Writeup, Docs, Writeup keeps and restores the Writeup entry through a clamp scroll", async () => {
  width = 1280;
  layoutStore.update({ pane: { desktop: "tabs", tablet: "tabs" } });
  const { history } = await readWriteup();
  const saved = stored();
  fakeTimers();
  await go(history, "?tab=docs&rev=1&doc=a.md");
  expect(screen.getByText("Doc a1a1a1a1 2222")).toBeTruthy();
  // The browser clamps the shared scroller when the shorter content arrives.
  pane().scrollTop = 0;
  fireEvent.scroll(pane());
  await tick(restoreDelays.at(-1) ?? 0);
  expect(stored()).toBe(saved);
  await go(history, "?tab=writeup&rev=1");
  await tick(1);
  expect(pane().scrollTop).toBe(150);
  expect(loadReadingPosition(keyOf("writeup"))).toEqual({ id: `block-${b.id}`, fraction: 0.5 });
});

test.each([true, false])("switching docs saves the old doc and restores the new one (saved entry: %s)", async (has) => {
  if (has) saveReadingPosition(keyOf("docs", "b.md"), { id: `block-${docB[2]?.id}`, fraction: 0.5 });
  const { history } = mount("?tab=docs&rev=1&doc=a.md");
  await screen.findByText("Doc a1a1a1a1 2222");
  readerScroll(150);
  fakeTimers();
  await go(history, "?tab=docs&rev=1&doc=b.md");
  await tick(1);
  expect(screen.getByText("Doc b2b2b2b2 2222")).toBeTruthy();
  expect(loadReadingPosition(keyOf("docs", "a.md"))).toEqual({ id: `block-${docA[1]?.id}`, fraction: 0.5 });
  // B never inherits A's offset: it gets its own anchor or the top.
  expect(pane().scrollTop).toBe(has ? 250 : 0);
});

test("two reader scrolls inside the throttle window, then an immediate tab switch, save the second", async () => {
  const { history } = mount();
  await screen.findByText("Paragraph bbbb");
  fakeTimers();
  readerScroll(150);
  readerScroll(250);
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${b.id}`, fraction: 0.5 });
  await go(history, "?tab=diff&rev=1");
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${c.id}`, fraction: 0.5 });
});

test("pagehide saves the latest reader position", async () => {
  mount();
  await screen.findByText("Paragraph bbbb");
  fakeTimers();
  readerScroll(150);
  readerScroll(250);
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${b.id}`, fraction: 0.5 });
  window.dispatchEvent(new Event("pagehide"));
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${c.id}`, fraction: 0.5 });
});

test("a hash that stays in the URL from an earlier navigation does not block the restore", async () => {
  const { history } = await readWriteup(`?tab=writeup&rev=1#block-${c.id}`);
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  await go(history, "?tab=diff&rev=1", `#block-${c.id}`);
  fakeTimers();
  await go(history, "?tab=writeup&rev=1", `#block-${c.id}`);
  await tick(1);
  expect(pane().scrollTop).toBe(150);
});

test("an intent that was never fulfilled does not block a later restore after a new revision", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  await screen.findByText("Diff stub");
  fakeTimers();
  // The target block does not exist: this navigation's own restore yields, and the intent stays unfulfilled.
  await go(history, "?tab=writeup&rev=1", "#block-overview-ffff0000");
  await tick(restoreDelays.at(-1) ?? 0);
  expect(pane().scrollTop).toBe(0);
  await go(history, "?tab=diff&rev=1");
  saveReadingPosition(readingPositionKey(id, "writeup", "", 2), { id: `block-${b.id}`, fraction: 0.5 });
  await go(history, "?tab=writeup&rev=2");
  await tick(1);
  expect(pane().scrollTop).toBe(150);
});

test("scrolls the reader did not make neither stop the restore nor save", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  fakeTimers();
  await go(history, "?tab=writeup&rev=1");
  await tick(1);
  expect(pane().scrollTop).toBe(150);
  // Scroll anchoring or a clamp lands mid-window: the next retry still restores.
  pane().scrollTop = 7;
  fireEvent.scroll(pane());
  await tick(restoreDelays[1]);
  expect(pane().scrollTop).toBe(150);
  await tick(restoreDelays.at(-1) ?? 0);
  // The last retry's scroll event arrives after the retries ended and saves nothing.
  const before = stored();
  pane().scrollTop = 40;
  fireEvent.scroll(pane());
  await tick(500);
  expect(stored()).toBe(before);
});

test("typing in a text field is not reader input, but a scroll key is", async () => {
  mount();
  await screen.findByText("Paragraph bbbb");
  const field = document.createElement("textarea");
  document.body.append(field);
  fireEvent.keyDown(field, { key: "a" });
  fireEvent.keyDown(field, { key: "ArrowDown" });
  fireEvent.keyDown(field, { key: " " });
  // A clamp scroll after typing is not the reader's.
  pane().scrollTop = 150;
  fireEvent.scroll(pane());
  expect(stored()).toBeNull();
  fireEvent.keyDown(document.body, { key: "a" });
  pane().scrollTop = 150;
  fireEvent.scroll(pane());
  expect(stored()).toBeNull();
  fireEvent.keyDown(document.body, { key: "PageDown" });
  fireEvent.scroll(pane());
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${b.id}`, fraction: 0.5 });
  field.remove();
});

test.each([390, 1280])(
  "a tab with no saved entry starts at the top, not at the old tab's offset (%s px)",
  async (px) => {
    width = px;
    if (px > 1000) layoutStore.update({ pane: { desktop: "tabs", tablet: "tabs" } });
    const { history } = mount();
    await screen.findByText("Paragraph bbbb");
    readerScroll(250);
    fakeTimers();
    await go(history, "?tab=comments&rev=1");
    await tick(1);
    expect(pane().scrollTop).toBe(0);
    expect(loadReadingPosition(keyOf("writeup"))).toEqual({ id: `block-${c.id}`, fraction: 0.5 });
  },
);

test("a fulfilled jump no longer blocks a later restore without a navigation", async () => {
  width = 1280;
  const { history } = mount(`?tab=diff&rev=1#block-${c.id}`);
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  await screen.findByText("Paragraph bbbb");
  fakeTimers();
  await tick(restoreDelays.at(-1) ?? 0);
  readerScroll(150);
  // The pane hides and shows again (pane mode change) under the same navigation.
  act(() => layoutStore.update({ pane: { desktop: "tabs", tablet: "tabs" } }));
  expect(history.location.search).toContain("tab=diff");
  pane().scrollTop = 0;
  act(() => layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } }));
  await tick(1);
  expect(pane().scrollTop).toBe(150);
});

test("scroll keys from another pane do not stop the restore", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  fakeTimers();
  await go(history, "?tab=writeup&rev=1");
  await tick(1);
  expect(pane().scrollTop).toBe(150);
  pane().scrollTop = 7;
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  fireEvent.keyDown(elsewhere, { key: "ArrowDown" });
  await tick(restoreDelays[1]);
  expect(pane().scrollTop).toBe(150);
  fireEvent.keyDown(document.body, { key: "ArrowDown" });
  pane().scrollTop = 7;
  await tick(restoreDelays.at(-1) ?? 0);
  expect(pane().scrollTop).toBe(7);
  elsewhere.remove();
});

test("reading works when storage throws", async () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("denied");
  });
  mount();
  await screen.findByText("Paragraph bbbb");
  pane().scrollTop = 150;
  expect(() => fireEvent.scroll(pane())).not.toThrow();
  expect(pane().scrollTop).toBe(150);
});

test("Back and Forward restore each visit to a doc independently of its latest position", async () => {
  const { history } = mount("?tab=docs&doc=a.md&rev=1");
  await screen.findByText("Doc a1a1a1a1 2222");
  readerScroll(125);
  await go(history, "?tab=docs&doc=b.md&rev=1");
  await screen.findByText("Doc b2b2b2b2 2222");
  readerScroll(175);
  await go(history, "?tab=docs&doc=a.md&rev=1");
  await screen.findByText("Doc a1a1a1a1 2222");
  await waitFor(() => expect(pane().scrollTop).toBe(125));
  readerScroll(225);
  await act(async () => history.back());
  await screen.findByText("Doc b2b2b2b2 2222");
  await waitFor(() => expect(pane().scrollTop).toBe(175));
  await act(async () => history.back());
  await screen.findByText("Doc a1a1a1a1 2222");
  await waitFor(() => expect(pane().scrollTop).toBe(125));
  await act(async () => history.forward());
  await waitFor(() => expect(pane().scrollTop).toBe(175));
  await act(async () => history.forward());
  await waitFor(() => expect(pane().scrollTop).toBe(225));
});

test("R2.3 Back restores the scrolled-on passage ahead of the original heading target", async () => {
  const first = docs[0];
  if (first?.kind !== "markdown") throw new Error("missing doc");
  const firstBlock = docA[0];
  const otherDoc = docs[1];
  if (!firstBlock || !otherDoc || !revisions[1]) throw new Error("missing fixture");
  revisions[1] = {
    ...revisions[1],
    docs: [
      {
        ...first,
        headings: [{ level: 2, id: "heading-start", text: "Start" }],
        blocks: [{ ...firstBlock, kind: "heading", html: '<h2 id="heading-start">Start</h2>' }, ...docA.slice(1)],
      },
      otherDoc,
    ],
  };
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
    if (this.id === "heading-start") pane().scrollTop = 0;
  });
  const { history } = mount("?tab=docs&doc=a.md&rev=1#h-heading-start");
  await screen.findByRole("heading", { name: "Start" });
  readerScroll(175);
  await go(history, "?tab=docs&doc=b.md&rev=1");
  await screen.findByText("Doc b2b2b2b2 2222");
  await act(async () => history.back());
  await screen.findByRole("heading", { name: "Start" });
  await waitFor(() => expect(pane().scrollTop).toBe(175));
  expect(scroll.mock.instances).not.toContain(screen.getByRole("heading", { name: "Start" }));
});

test("a visit restored from storage keeps its own position even without another scroll", async () => {
  const firstBlock = docA[1];
  if (!firstBlock) throw new Error("missing block");
  saveReadingPosition(readingPositionKey(id, "docs", "a.md", 1), { id: `block-${firstBlock.id}`, fraction: 0.25 });
  const { history } = mount("?tab=docs&doc=a.md&rev=1");
  await screen.findByText("Doc a1a1a1a1 2222");
  await waitFor(() => expect(pane().scrollTop).toBe(125));
  await go(history, "?tab=docs&doc=b.md&rev=1");
  await screen.findByText("Doc b2b2b2b2 2222");
  await go(history, "?tab=docs&doc=a.md&rev=1");
  await screen.findByText("Doc a1a1a1a1 2222");
  readerScroll(225);
  await act(async () => history.go(-2));
  await waitFor(() => expect(pane().scrollTop).toBe(125));
});

test("C3 HTML positions use the frame's declared headings rather than the outer pane", async () => {
  if (!revisions[1]) throw new Error("missing revision");
  revisions[1].docs = [
    {
      kind: "html",
      path: "page.html",
      contentUrl: "/content/synthetic/page.html",
      headings: [{ level: 2, text: "First" }],
    },
  ];
  const key = readingPositionKey(id, "docs", "page.html", 1, "original");
  mount("?tab=docs&doc=page.html&rev=1");
  await screen.findByRole("heading", { name: "page.html" });
  const frame = document.querySelector("iframe");
  if (!frame) throw new Error("missing frame");
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: vi.fn() } });
  fireEvent.load(frame);
  fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { type: "emend:ready" } }));
  fireEvent(
    window,
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: { type: "emend:position", heading: 0, fraction: 0.25 },
    }),
  );
  readerScroll(200);
  expect(loadReadingPosition(key)).toEqual({ id: "h-0", fraction: 0.25 });
});

test.each(["heading-middle", "missing"])("R2.3 Back restores its own position even with target %s", async (target) => {
  const first = docs[0];
  const middle = docA[1];
  const other = docs[1];
  if (!revisions[1] || first?.kind !== "markdown" || !middle || !other) throw new Error("missing fixture");
  revisions[1].docs = [
    {
      ...first,
      headings: [{ level: 2, id: "heading-middle", text: "Middle" }],
      blocks: first.blocks.map((block) =>
        block === middle ? { ...block, kind: "heading", html: '<h2 id="heading-middle">Middle</h2>' } : block,
      ),
    },
    other,
  ];
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
    if (this.id === "heading-middle") pane().scrollTop = 100;
  });
  const { history } = mount(`?tab=docs&doc=a.md&rev=1#h-${target}`);
  await screen.findByRole("heading", { name: "Middle" });
  readerScroll(175);
  await go(history, "?tab=docs&doc=b.md&rev=1");
  await screen.findByText("Doc b2b2b2b2 2222");
  fakeTimers();
  await act(async () => history.back());
  await tick(restoreDelays.at(-1) ?? 0);
  expect(pane().scrollTop).toBe(175);
  expect(screen.queryByText("Heading not found. Showing the top of the document.")).toBeNull();
});

test("R2.2 Comments reading position survives a reload", async () => {
  revisions[1] = revisionWith(1, [a, b, c], [thread]);
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.id === `thread-${thread.id}`) return new DOMRect(0, 100 - pane().scrollTop, 390, 400);
    return bounds.call(this);
  });
  const key = readingPositionKey(id, "comments", "", 1);
  const first = mount("?tab=comments&rev=1");
  await screen.findByText("A synthetic question");
  readerScroll(200);
  expect(loadReadingPosition(key)).toEqual({ id: `thread-${thread.id}`, fraction: 0.25 });
  first.unmount();
  mount("?tab=comments&rev=1");
  await screen.findByText("A synthetic question");
  await waitFor(() => expect(pane().scrollTop).toBe(200));
});

test.each(["heading-middle", "missing"])("R2.3 Back to an unvisited entry follows target %s", async (target) => {
  const middle = docA[1];
  if (!revisions[1] || !middle) throw new Error("missing fixture");
  revisions[1].docs[0] = {
    kind: "markdown",
    path: "a.md",
    headings: [{ level: 2, id: "heading-middle", text: "Middle" }],
    blocks: docA.map((block) =>
      block === middle ? { ...block, kind: "heading", html: '<h2 id="heading-middle">Middle</h2>' } : block,
    ),
  };
  const history = createMemoryHistory({
    initialEntries: [`/r/${id}?tab=docs&doc=a.md&rev=1#h-${target}`, `/r/${id}?tab=docs&doc=b.md&rev=1`],
    initialIndex: 1,
  });
  saveReadingPosition(keyOf("docs", "a.md"), { id: `block-${middle.id}`, fraction: 0.75 });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
    if (this.id === "heading-middle") pane().scrollTop = 100;
  });
  render(<App queryClient={client} history={history} />);
  await screen.findByText("Doc b2b2b2b2 2222");
  await act(async () => history.back());
  await screen.findByRole("heading", { name: "Middle" });
  await waitFor(() => expect(pane().scrollTop).toBe(target === "missing" ? 0 : 100));
});

test.each(["topic", "block", "thread"])(
  "R3.1 Back restores the live target after a %s jump without reader scrolling",
  async (kind) => {
    const target = kind === "topic" ? "topic-seed" : kind === "block" ? `block-${c.id}` : `thread-${thread.id}`;
    const tab = kind === "thread" ? "comments" : "writeup";
    const source = { ...a, html: `<p><a href="/r/${id}?tab=${tab}&amp;rev=1#${target}">Jump to target</a></p>` };
    const current = revisionWith(1, [source, b], [thread]);
    current.topics = [{ slug: "seed", title: "Plant a seed", summary: "Synthetic topic", importance: 1 }];
    current.writeup.sections.push({ key: "t-seed-body", label: "Details", topic: "seed", blocks: [c] });
    revisions[1] = current;
    const bounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id === `thread-${thread.id}`) return new DOMRect(0, 200 - pane().scrollTop, 390, 100);
      return bounds.call(this);
    });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      if (this.id === target) pane().scrollTop = 250;
    });
    saveReadingPosition(keyOf("writeup"), { id: `block-${a.id}`, fraction: 0.25 });
    saveReadingPosition(keyOf("comments"), { id: `thread-${thread.id}`, fraction: 0 });
    const { history } = mount();
    const link = await screen.findByRole("link", { name: "Jump to target" });
    await waitFor(() => expect(pane().scrollTop).toBe(25));
    fireEvent.click(link);
    await waitFor(() => expect(pane().scrollTop).toBe(250));
    await go(history, "?tab=docs&doc=a.md&rev=1");
    await screen.findByText("Doc a1a1a1a1 2222");
    await act(async () => history.back());
    await waitFor(() => expect(pane().scrollTop).toBe(250));
    expect(loadReadingPosition(keyOf(tab))).toEqual({
      id: kind === "thread" ? target : `block-${c.id}`,
      fraction: 0.5,
    });
  },
);

test.each(["writeup", "comments"])("R3.3 restores %s positions saved under the literal HEAD key", async (tab) => {
  revisions[1] = revisionWith(1, [a, b, c], [thread]);
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.id === `thread-${thread.id}`) return new DOMRect(0, 100 - pane().scrollTop, 390, 100);
    return bounds.call(this);
  });
  const anchor = { id: tab === "writeup" ? `block-${b.id}` : `thread-${thread.id}`, fraction: 0.5, at: 1 };
  localStorage.setItem(readingKey, JSON.stringify({ [`${id}\n${tab}\n`]: anchor }));
  mount(`?tab=${tab}&rev=1`);
  await screen.findByText(tab === "writeup" ? "Paragraph cccc" : "A synthetic question");
  await waitFor(() => expect(pane().scrollTop).toBe(150));
});

test("R3.4 Tab to an offscreen link stops retries and restores both passage and focus on Back", async () => {
  const last = { ...c, html: `<p><a href="/r/${id}?tab=docs&amp;doc=a.md&amp;rev=1">Offscreen doc link</a></p>` };
  revisions[1] = revisionWith(1, [a, b, last]);
  saveReadingPosition(writeupKey, { id: `block-${b.id}`, fraction: 0.25 });
  const { history } = mount();
  const link = await screen.findByRole("link", { name: "Offscreen doc link" });
  await waitFor(() => expect(pane().scrollTop).toBe(125));
  fakeTimers();
  const focus = link.focus.bind(link);
  vi.spyOn(link, "focus").mockImplementation(() => {
    pane().scrollTop = 250;
    focus();
  });
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => link.focus());
  fireEvent.scroll(pane());
  await tick(restoreDelays.at(-1) ?? 0);
  expect(pane().scrollTop).toBe(250);
  fireEvent.click(link);
  await tick(1);
  expect(screen.getByText("Doc a1a1a1a1 2222")).toBeTruthy();
  await act(async () => history.back());
  await tick(1);
  expect(pane().scrollTop).toBe(250);
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Offscreen doc link" }));
});

test("R3.5 Back refocuses a keyboard-activated Comments Show in place link", async () => {
  revisions[1] = revisionWith(1, [a, b, c], [thread]);
  const { history } = mount("?tab=comments&rev=1");
  const link = await screen.findByRole("link", { name: "Show in place" });
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => link.focus());
  fireEvent.keyDown(link, { key: "Enter" });
  fireEvent.click(link);
  await screen.findByText("Paragraph cccc");
  await act(async () => history.back());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: "Show in place" })));
});

test("R3.3 a shared writeup key falls to top when the saved block is absent in the new revision", async () => {
  width = 1280;
  const { history } = await readWriteup();
  revisions[2] = revisionWith(2, [a, c, block("dddd")]);
  await go(history, "?tab=writeup&rev=2");
  await screen.findByText("Paragraph dddd");
  expect(pane().scrollTop).toBe(0);
});

test.each(
  ["switcher", "All docs", "link", "Back"].flatMap((via) => ["layout", "frame"].map((settling) => ({ via, settling }))),
)(
  "R4.1 $via keeps restoring the saved passage after a late $settling change and title focus",
  async ({ via, settling }) => {
    width = 1280;
    const current = revisions[1];
    const target = docA[1];
    if (!current || !target) throw new Error("missing fixture");
    const doc = current.docs[0];
    if (doc?.kind !== "markdown" || !doc.blocks[0]) throw new Error("missing doc");
    if (settling === "frame") doc.blocks[0] = { ...doc.blocks[0], kind: "diagram", source: "graph TD; A-->B" };
    const source = current.docs[1];
    if (source?.kind !== "markdown" || !source.blocks[0]) throw new Error("missing source doc");
    source.blocks[0] = { ...source.blocks[0], html: `<p><a href="/r/${id}?tab=docs&amp;doc=a.md">Open doc</a></p>` };
    let shift = 0;
    const bounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const index = docA.findIndex((block) => this.id === `block-${block.id}`);
      if (index > 0) {
        const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Diagram"]');
        const delta = settling === "frame" ? Number.parseFloat(frame?.style.height ?? "160") - 160 : shift;
        return new DOMRect(0, index * 100 + delta - pane().scrollTop, 390, 100);
      }
      return bounds.call(this);
    });
    const key = keyOf("docs", "a.md");
    const anchor = { id: `block-${target.id}`, fraction: 0.5 };
    saveReadingPosition(key, anchor);
    const start = via === "All docs" ? "?tab=docs&rev=1" : `?tab=docs&doc=${via === "Back" ? "a.md" : "b.md"}&rev=1`;
    const { history } = mount(start);
    await screen.findByRole(via === "link" ? "link" : "heading", {
      name: via === "All docs" ? "Docs" : via === "link" ? "Open doc" : via === "Back" ? "a.md" : "b.md",
    });
    fakeTimers();
    if (via === "switcher") {
      fireEvent.click(screen.getByRole("button", { name: "Docs" }));
      await tick(1);
      fireEvent.click(within(screen.getByRole("dialog", { name: "Docs" })).getByRole("button", { name: /a\.md/ }));
    } else if (via === "All docs") {
      fireEvent.click(screen.getByRole("link", { name: /a\.md/ }));
    } else if (via === "link") {
      fireEvent.click(screen.getByRole("link", { name: "Open doc" }));
    } else {
      await go(history, "?tab=docs&doc=b.md&rev=1");
      await tick(1);
      const back = screen.getByRole("button", { name: "Back to a.md" });
      act(() => back.focus());
      fireEvent.click(back);
    }
    await tick(1);
    const title = screen.getByRole("heading", { name: "a.md" });
    expect(document.activeElement).toBe(title);
    expect(pane().scrollTop).toBe(150);
    await tick(300);
    if (settling === "frame") {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Diagram"]');
      if (!frame) throw new Error("missing diagram frame");
      // happy-dom does not load iframe pages; keep the real frame and its message-source check.
      Object.defineProperty(frame, "contentWindow", { value: { postMessage: vi.fn() } });
      act(() =>
        window.dispatchEvent(
          new MessageEvent("message", { source: frame.contentWindow, data: { type: "size", height: 360 } }),
        ),
      );
      expect(frame.style.height).toBe("360px");
    } else shift = 200;
    // A clamp caused by layout is not input, even though the app focused the title.
    pane().scrollTop = 10;
    fireEvent.scroll(pane());
    expect(loadReadingPosition(key)).toEqual(anchor);
    await tick(restoreDelays.at(-1) ?? 0);
    expect(pane().scrollTop).toBe(350);
    expect(document.activeElement).toBe(title);
    pane().scrollTop += 20;
    fireEvent.scroll(pane());
    expect(loadReadingPosition(key)).toEqual(anchor);
  },
);

test.each(["Show in place", "click", "collapsed"])(
  "R4.2 Back keeps Markdown comment cards after %s without replaying the thread jump",
  async (action) => {
    width = 1280;
    presentation.collapsedDocCards = true;
    const target = docA[1];
    if (!target) throw new Error("missing target");
    const placed: ThreadView = {
      ...thread,
      target: { kind: "doc-span", path: "a.md", blockId: target.id, quote: target.text, prefix: "", suffix: "" },
      placement: {
        status: "placed",
        location: { kind: "doc-span", path: "a.md", blockId: target.id, start: 0, end: target.text.length },
      },
    };
    revisions[1] = revisionWith(1, [a, b, c], [placed]);
    const jump = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      if (this.id === `thread-${thread.id}`) pane().scrollTop = 125;
    });
    const { history } = mount(action === "click" ? "?tab=docs&doc=a.md&rev=1" : "?tab=comments&rev=1");
    if (action === "click") fireEvent.click(await screen.findByRole("button", { name: "1 comment", expanded: false }));
    else fireEvent.click(await screen.findByRole("link", { name: "Show in place" }));
    await screen.findByRole("button", { name: "Hide", expanded: true });
    expect(document.getElementById(`thread-${thread.id}`)).toBeTruthy();
    if (action === "collapsed") fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    readerScroll(175);
    await go(history, "?tab=docs&doc=b.md&rev=1");
    await screen.findByText("Doc b2b2b2b2 2222");
    jump.mockClear();
    await act(async () => history.back());
    await screen.findByRole("heading", { name: "a.md" });
    await waitFor(() => expect(pane().scrollTop).toBe(175));
    expect(
      screen.getByRole("button", { name: action === "collapsed" ? "1 comment" : "Hide" }).getAttribute("aria-expanded"),
    ).toBe(String(action !== "collapsed"));
    expect(!!document.getElementById(`thread-${thread.id}`)).toBe(action !== "collapsed");
    expect(jump).not.toHaveBeenCalled();
    expect(localStorage.getItem(readingKey)).not.toContain(`thread-${thread.id}`);
  },
);

test("R4.1 a reply composer's focus still captures the position for Back", async () => {
  width = 1280;
  revisions[1] = revisionWith(1, [a, b, c], [thread]);
  saveReadingPosition(writeupKey, { id: `block-${a.id}`, fraction: 0.5 });
  const focus = HTMLTextAreaElement.prototype.focus;
  vi.spyOn(HTMLTextAreaElement.prototype, "focus").mockImplementation(function (this: HTMLTextAreaElement, options) {
    pane().scrollTop = 175;
    focus.call(this, options);
  });
  const { history } = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  const composer = await screen.findByRole("textbox", { name: "Reply" });
  await waitFor(() => expect(document.activeElement).toBe(composer));
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${b.id}`, fraction: 0.75 });
  await go(history, "?tab=docs&doc=a.md&rev=1");
  await screen.findByRole("heading", { name: "a.md" });
  await act(async () => history.back());
  await screen.findByText("Paragraph cccc");
  await waitFor(() => expect(pane().scrollTop).toBe(175));
});

const filesLayouts = [
  { width: 1280, mode: "split" },
  { width: 1280, mode: "tabs" },
  { width: 390, mode: "tabs" },
] as const;

test.each(filesLayouts.flatMap((layout) => [false, true].map((programmatic) => ({ ...layout, programmatic }))))(
  "Files saves focus scrolling only for reader focus ($width px, $mode, programmatic=$programmatic)",
  async ({ width: nextWidth, mode, programmatic }) => {
    width = nextWidth;
    layoutStore.update({ pane: { desktop: mode, tablet: mode } });
    const { history } = mount("?tab=files&rev=1");
    const row = await screen.findByRole("button", { name: /Open diff for seed.txt/ });
    expect(pane().scrollTop).toBe(0);
    act(() => {
      if (programmatic) focusReadingTarget(row);
      else row.focus();
    });
    expect(document.activeElement).toBe(row);
    pane().scrollTop = 225;
    fireEvent.scroll(pane());
    pane().scrollTop = 275;
    fireEvent.scroll(pane());
    await go(history, "?tab=writeup&rev=1");
    await screen.findByText("Paragraph bbbb");
    await go(history, "?tab=files&rev=1");
    expect(pane().scrollTop).toBe(programmatic ? 0 : 275);
  },
);

test.each(filesLayouts.flatMap((layout) => [0, 150].map((top) => ({ ...layout, top }))))(
  "Files keeps its own offset with Writeup at $top ($width px, $mode)",
  async ({ width: nextWidth, mode, top }) => {
    width = nextWidth;
    layoutStore.update({ pane: { desktop: mode, tablet: mode } });
    const { history } = mount();
    await screen.findByText("Paragraph bbbb");
    if (top) readerScroll(top);
    await go(history, "?tab=files&rev=1");
    await screen.findByRole("button", { name: /Open diff for seed.txt/ });
    expect(pane().scrollTop).toBe(0);
    readerScroll(225);
    expect(loadReadingPosition(readingPositionKey(id, "files"))).toBeUndefined();
    await go(history, "?tab=writeup&rev=1");
    expect(pane().scrollTop).toBe(top);
    await go(history, "?tab=files&rev=1");
    expect(pane().scrollTop).toBe(225);
    if (mode === "split") {
      fireEvent.click(screen.getByRole("button", { name: /Open diff for seed.txt/ }));
      await waitFor(() => expect(history.location.hash).toBe(`#diff-file-${id}`));
      expect(pane().scrollTop).toBe(225);
    } else {
      await go(history, "?tab=diff&rev=1");
      if (width === 390) expect(document.querySelector("[data-reading-scroll]")).toBeNull();
      else {
        expect(pane().hidden).toBe(true);
        pane().scrollTop = 0;
        fireEvent.scroll(pane());
      }
      await go(history, "?tab=files&rev=1");
      expect(pane().scrollTop).toBe(225);
    }
    // Clamping after activation must not replace the saved reader offset.
    pane().scrollTop = 10;
    fireEvent.scroll(pane());
    await go(history, "?tab=writeup&rev=1");
    expect(pane().scrollTop).toBe(top);
    await go(history, "?tab=files&rev=1");
    expect(pane().scrollTop).toBe(225);
  },
);

test.each(filesLayouts)(
  "Files keeps its offset across a cached revision clamp ($width px, $mode)",
  async ({ width: nextWidth, mode }) => {
    width = nextWidth;
    layoutStore.update({ pane: { desktop: mode, tablet: mode } });
    client.setQueryData(["revision", id, 2], revisions[2]);
    const { history } = mount("?tab=files&rev=1");
    await screen.findByRole("button", { name: /Open diff for seed.txt/ });
    readerScroll(225);
    await go(history, "?tab=files&rev=2");
    expect(pane().scrollTop).toBe(225);
    pane().scrollTop = 10;
    fireEvent.scroll(pane());
    await go(history, "?tab=files&rev=1");
    expect(pane().scrollTop).toBe(225);
  },
);

test.each(filesLayouts.flatMap((layout) => ["gap", "heading"].map((between) => ({ ...layout, between }))))(
  "Writeup, Files, Writeup restores a line in a $between exactly ($width px, $mode)",
  async ({ width: nextWidth, mode, between }) => {
    width = nextWidth;
    layoutStore.update({ pane: { desktop: mode, tablet: mode } });
    const gap = between === "gap" ? 6 : 400;
    const top = 100 + gap / 2;
    offsets.set(b.id, 100 + gap).set(c.id, 200 + gap);
    if (between === "heading") {
      const value = revisions[1];
      if (!value) throw new Error("Missing revision");
      value.writeup.sections = [
        { key: "overview", label: "Body", topic: null, blocks: [a] },
        { key: "t-garden-body", label: "Garden details", topic: null, blocks: [b, c] },
      ];
      const bounds = HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        return this.tagName === "H2" && this.textContent === "Garden details"
          ? new DOMRect(0, 100 - pane().scrollTop, 390, gap)
          : bounds.call(this);
      });
    }
    const { history } = mount();
    await screen.findByText("Paragraph bbbb");
    readerScroll(top);
    const anchor = { id: `block-${a.id}`, fraction: 1, gap: 0.5 };
    expect(loadReadingPosition(writeupKey)).toEqual(anchor);
    if (between === "heading") {
      const rect = screen.getByRole("heading", { name: "Garden details" }).getBoundingClientRect();
      expect(rect.top).toBeLessThan(0);
      expect(rect.bottom).toBeGreaterThan(0);
    }
    await go(history, "?tab=files&rev=1");
    readerScroll(225);
    await go(history, "?tab=writeup&rev=1");
    expect(pane().scrollTop).toBe(top);
    await act(async () => history.back());
    await act(async () => history.back());
    expect(screen.getByText("Paragraph bbbb")).toBeTruthy();
    expect(pane().scrollTop).toBe(top);
    expect(loadReadingPosition(writeupKey)).toEqual(anchor);
  },
);
