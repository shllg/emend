// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { RenderedBlock, ReviewView, RevisionView, ThreadView } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Window } from "happy-dom";
import { type Element as BridgeElement, Window as BridgeWindow } from "happy-dom";
import { type ComponentProps, Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { App } from "./App.tsx";
import type { InboxData } from "./api/queries.ts";
import type { DiffPaneProps } from "./components/diff/DiffPane.tsx";
import type { ParsedDiff } from "./components/diff/FileDiff.tsx";
import { parsePair } from "./components/diff/parse.worker.ts";
import type { DiffParser } from "./components/diff/parse-client.ts";
import * as diffPresentation from "./components/diff/presentation.ts";
import { OUTLINE_WIDTH } from "./components/reading/WriteupOutline.tsx";
import { blockLink } from "./components/threads/ThreadCard.tsx";
import { claimDraft } from "./lib/composer-owner.ts";
import { draftKey, editDraftKey, saveDraft } from "./lib/drafts.ts";
import { layoutKey, layoutStore } from "./lib/layout-store.ts";
import * as readingPosition from "./lib/reading-position.ts";
import { cancelThreadActionFocus } from "./lib/thread-action-focus.ts";
import * as webRouter from "./router.tsx";
import { validateReviewSearch } from "./router.tsx";

const loading = vi.hoisted(() => ({
  ready: undefined as Promise<void> | undefined,
  parser: undefined as DiffParser | undefined,
  rendering: "normal" as "normal" | "delayed" | "without-slots",
}));
vi.mock("@pierre/diffs/react", async (original) => {
  const actual = await original<typeof import("@pierre/diffs/react")>();
  return {
    ...actual,
    WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => children,
    FileDiff: (props: ComponentProps<typeof actual.FileDiff>) =>
      loading.rendering === "delayed" ? null : (
        <actual.FileDiff
          {...props}
          lineAnnotations={loading.rendering === "without-slots" ? [] : props.lineAnnotations}
        />
      ),
  };
});
vi.mock("./components/diff/LazyDiffPane.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/diff/LazyDiffPane.tsx")>();
  return {
    ...actual,
    LazyDiffPane: (props: DiffPaneProps) => (
      <actual.LazyDiffPane
        {...props}
        parser={loading.parser}
        load={async () => {
          await loading.ready;
          return import("./components/diff/DiffPane.tsx");
        }}
      />
    ),
  };
});
const id = "11111111-1111-4111-8111-111111111111";
const review: ReviewView = {
  id,
  title: "Synthetic garden",
  origin: { id, name: "Workshop" },
  repo: null,
  project: null,
  branch: null,
  state: "open",
  newestRevision: 1,
  unsentCount: 2,
  openThreads: 0,
  agentWaiting: false,
  pendingSend: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  movedTo: null,
  list: "active",
  snoozed: false,
  snoozedUntil: null,
  activeUntil: null,
  releasedAt: null,
  pickedUpAt: null,
  kind: "review",
  importedAt: null,
  revisions: [{ seq: 1, createdAt: "2026-01-01T00:00:00.000Z" }],
};
const revision: RevisionView = {
  seq: 1,
  base: null,
  head: null,
  main: "writeup",
  writeupEmpty: false,
  topics: [{ slug: "seed", title: "Plant a seed", summary: "A synthetic garden", importance: 1 }],
  files: [
    {
      id,
      path: "seed.txt",
      oldPath: null,
      role: "diff",
      topic: "seed",
      order: 0,
      status: "modified",
      mediaType: "text/plain",
      flag: "binary",
      hasOld: false,
      hasNew: false,
    },
  ],
  writeup: {
    sections: [
      {
        key: "t-seed-body",
        label: "Plant a seed — Details",
        topic: "seed",
        blocks: [
          {
            id: "t-seed-body-12345678",
            section: "t-seed-body",
            kind: "paragraph",
            text: "Keep growing",
            html: "<p>Keep growing</p>",
          },
        ],
      },
    ],
  },
  docs: [
    { kind: "markdown", path: "seed.md", blocks: [] },
    { kind: "markdown", path: "water.md", blocks: [] },
  ],
  threads: [],
  changedBlocks: [],
};
let currentRevision: RevisionView;
let currentReview: ReviewView;
let revisionReply: Promise<Response> | undefined;
let width = 1280;
let client: QueryClient;
let loaded: ReturnType<typeof Promise.withResolvers<void>>;
const originalBounds = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
beforeEach(() => {
  // Happy DOM has no layout; dedicated diff tests control positive and hidden measurements.
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      return this.classList.contains("em-diff-pane") ? new DOMRect(0, 0, 900, 600) : bounds.call(this);
    },
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  width = 1280;
  currentRevision = structuredClone(revision);
  currentReview = structuredClone(review);
  revisionReply = undefined;
  loaded = Promise.withResolvers<void>();
  loading.ready = loaded.promise;
  loading.parser = undefined;
  loading.rendering = "normal";
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(query.match(/\d+/)?.[0] ?? Infinity),
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === `/api/v1/reviews/${id}/threads` && init?.method === "POST")
        return Response.json({ threadId: id, commentId: id }, { status: 201 });
      if (path === "/api/v1/session") return new Response(null, { status: 204 });
      if (path === "/api/v1/devices") return Response.json({ items: [] });
      if (path === "/api/v1/reviews")
        return Response.json({
          approvedActiveHours: 12,
          serverTime: new Date(Date.now()).toISOString(),
          items: [review],
        });
      if (path === `/api/v1/reviews/${id}`) return Response.json(currentReview);
      if (path === `/api/v1/reviews/${id}/revisions/1`) return revisionReply ?? Response.json(currentRevision);
      if (path === `/api/v1/reviews/${id}/revisions/2`) return Response.json({ ...currentRevision, seq: 2 });
      throw new Error(`Unexpected synthetic request: ${path}`);
    }),
  );
});
afterEach(async () => {
  cancelThreadActionFocus();
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

test("writeup doc links keep the older revision when their href has no rev", async () => {
  currentReview.newestRevision = 2;
  currentReview.revisions.push({ seq: 2, createdAt: "2026-01-02T00:00:00.000Z" });
  const block = currentRevision.writeup.sections[0]?.blocks[0];
  if (!block) throw new Error("Missing block");
  block.html = '<p><a href="?tab=docs&amp;doc=seed.md">Read seed</a></p>';
  // Memory history does not update the document base used by native relative anchors.
  window.history.replaceState(null, "", `/r/${id}?tab=writeup&rev=1`);
  try {
    const { history } = mount();
    fireEvent.click(await screen.findByRole("link", { name: "Read seed" }));
    await waitFor(() => expect(new URLSearchParams(history.location.search).get("doc")).toBe("seed.md"));
    expect(new URLSearchParams(history.location.search).get("rev")).toBe("1");
    expect(fetch).not.toHaveBeenCalledWith(`/api/v1/reviews/${id}/revisions/2`, expect.anything());
  } finally {
    window.history.replaceState(null, "", "/");
  }
});

test.each([
  { pixels: 1280, contents: false, compact: false, pane: "split", key: "click", path: "seed.txt" },
  { pixels: 1280, contents: false, compact: false, pane: "split", key: "click", path: "pnpm-lock.yaml" },
  { pixels: 1280, contents: false, compact: false, pane: "tabs", key: "Enter", path: "large.txt" },
  { pixels: 1280, contents: true, compact: true, pane: "tabs", key: "Enter", path: "seed.txt" },
  { pixels: 768, contents: false, compact: false, pane: "tabs", key: " ", path: "seed.txt" },
  { pixels: 390, contents: false, compact: false, pane: "tabs", key: "click", path: "seed.txt" },
] as const)(
  "note refs navigate and mark a hidden, viewed file at $pixels px with contents=$contents compact=$compact in $pane via $key",
  async ({ pixels, contents, compact, pane, key, path }) => {
    width = pixels;
    layoutStore.update({ contents, compact, pane: { desktop: pane, tablet: pane }, notes: false });
    const note = {
      id: crypto.randomUUID(),
      side: "new" as const,
      start: 1,
      end: 2,
      summary: "Keep the decision visible.",
      ref: "A",
    };
    currentRevision.files = currentRevision.files.map((file) => ({
      ...file,
      flag: null,
      hasOld: true,
      hasNew: true,
      viewed: "viewed",
      viewedOn: 1,
      notes: [note],
      path,
    }));
    const block = currentRevision.writeup.sections[0]?.blocks[0];
    if (!block) throw new Error("Missing block");
    block.html =
      '<p>Decision <span class="user-content-ref">ref A</span>. <span class="user-content-ref">ref Z</span> <span class="user-content-ref">ref A and more</span></p>';
    block.text = "Decision ref A. ref Z ref A and more";
    const large = path === "large.txt";
    const guarded = large || path === "pnpm-lock.yaml";
    client.setQueryData(["file", id, "old"], large ? "before\n".repeat(10001) : "before\nsecond\n");
    client.setQueryData(["file", id, "new"], large ? "after\n".repeat(10001) : "after\nsecond\n");
    loading.parser = vi.fn(parsePair);
    const scroll = vi.spyOn(diffPresentation, "holdDiffTarget");
    const { history } = mount();
    const chip = await screen.findByRole("button", { name: `Go to agent note A in ${path}` });
    expect(chip.getAttribute("tabindex")).toBe("0");
    expect(chip.getAttribute("data-agent-note-ref")).toBe(note.id);
    for (const text of ["ref Z", "ref A and more"]) {
      const span = screen.getByText(text);
      expect(span.hasAttribute("role")).toBe(false);
      expect(span.hasAttribute("tabindex")).toBe(false);
    }
    // R2.9 Diff-only navigation must not re-read storage to restore the unchanged reading pane.
    const restoreRead = vi.spyOn(readingPosition, "loadReadingPosition");
    if (key === "click") fireEvent.click(chip);
    else fireEvent.keyDown(chip, { key });
    await act(async () => {
      loaded.resolve();
      // Release the test gate and await the cold lazy import before timing DOM placement.
      await import("./components/diff/DiffPane.tsx");
    });
    if (pane === "split") expect(restoreRead).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(scroll.mock.calls.some(([element]) => element.id === `diff-note-${note.id}`)).toBe(true),
    );
    const card = document.getElementById(`diff-note-${note.id}`);
    if (!card) throw new Error("Missing card");
    expect(card.hasAttribute("data-jump")).toBe(true);
    if (guarded) {
      expect(card.closest(".em-diff-discussion")).toBeTruthy();
      expect(card.closest("[slot], [data-slot-pending]")).toBeNull();
      expect(loading.parser).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Show diff" })).toBeTruthy();
    } else expect(card.closest("[slot]")?.getAttribute("slot")).toBe("annotation-additions-2");
    expect(layoutStore.getSnapshot().notes).toBe(true);
    expect(history.location.hash).toBe(`#diff-note-${note.id}`);
    if (pane === "tabs") expect(new URLSearchParams(history.location.search).get("tab")).toBe("diff");
    expect(screen.getByRole("button", { name: "Collapse file" })).toBeTruthy();
    if (path === "pnpm-lock.yaml") {
      fireEvent.click(screen.getByRole("button", { name: "Show diff" }));
      await waitFor(() => expect(loading.parser).toHaveBeenCalledOnce());
    }
    // Like thread cards, the mark follows the current hash, including non-diff navigation.
    act(() => history.push(`/r/${id}?tab=writeup&rev=1#topic-seed`));
    await waitFor(() => expect(document.getElementById(`diff-note-${note.id}`)?.hasAttribute("data-jump")).toBeFalsy());
    if (large) expect(loading.parser).not.toHaveBeenCalled();
  },
);

test.each([1280, 768, 390])("Files in diff waits for lazy rendering and scrolls its topic at %s px", async (pixels) => {
  width = pixels;
  const scroll = vi.spyOn(diffPresentation, "holdDiffTarget");
  const { history, container } = mount();
  const link = await screen.findByRole("link", { name: "Files in diff: Plant a seed" });
  const href = new URL((link as HTMLAnchorElement).href);
  expect(href.searchParams.get("tab")).toBe(pixels < 768 ? "diff" : "writeup");
  expect(href.searchParams.get("rev")).toBe("1");
  expect(href.hash).toBe("#diff-topic-seed");
  const block = container.querySelector("[data-block-id]");
  const reading = screen.getByTestId("reading-pane");
  reading.scrollTop = 80;
  fireEvent.click(link);
  await waitFor(() => expect(history.location.hash).toBe("#diff-topic-seed"));
  expect(screen.getByText("Loading diff…")).toBeTruthy();
  expect(scroll.mock.calls.some(([node]) => (node as HTMLElement).id === "diff-topic-seed")).toBe(false);
  await act(async () => {
    loaded.resolve();
  });
  await waitFor(() =>
    expect(scroll.mock.calls.some(([node]) => (node as HTMLElement).id === "diff-topic-seed")).toBe(true),
  );
  if (pixels >= 1280) {
    expect(container.querySelector("[data-block-id]")).toBe(block);
    expect(screen.getByTestId("reading-pane")).toBe(reading);
    expect(reading.scrollTop).toBe(80);
    // A second click is a fresh scroll intent even when the URL is unchanged.
    scroll.mockClear();
    fireEvent.click(link);
    await waitFor(() =>
      expect(scroll.mock.calls.some(([node]) => (node as HTMLElement).id === "diff-topic-seed")).toBe(true),
    );
  } else {
    if (pixels < 768) {
      expect(screen.queryByTestId("reading-pane")).toBeNull();
      expect(screen.getByRole("link", { name: "Diff" }).getAttribute("aria-current")).toBe("page");
      expect(screen.queryByRole("tabpanel")).toBeNull();
    } else {
      expect(screen.getByTestId("reading-pane")).toBe(reading);
      expect(reading.hidden).toBe(true);
      expect(screen.getByRole("tab", { name: "Diff" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("tabpanel", { name: "Diff" })).toBeTruthy();
    }
  }
});

test.each([1280, 768])(
  "reading tabs have counts, keyboard navigation and a labelled panel at %s px",
  async (pixels) => {
    width = pixels;
    const { history } = mount(`?tab=writeup&thread=${id}#topic-seed`);
    const tabs = within(await screen.findByRole("tablist", { name: "Reading tabs" }));
    await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
    const writeup = tabs.getByRole("tab", { name: "Writeup" });
    const docs = tabs.getByRole("tab", { name: "Docs 2" });
    const comments = tabs.getByRole("tab", { name: "Comments" });
    expect(comments.textContent).toBe("Comments");
    expect(within(docs).getByText("2").className).toContain("bg-active");
    const files = tabs.getByRole("tab", { name: /^Files 0\// });
    expect(writeup.getAttribute("aria-controls")).toBe(screen.getByRole("tabpanel", { name: "Writeup" }).id);
    fireEvent.keyDown(writeup, { key: "ArrowRight" });
    await waitFor(() => expect(history.location.search).toContain("tab=files"));
    expect(document.activeElement).toBe(files);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(files.id);
    fireEvent.keyDown(files, { key: "ArrowRight" });
    await waitFor(() => expect(history.location.search).toContain("tab=docs"));
    expect(history.location.search).not.toContain("thread");
    expect(history.location.hash).toBe("");
    expect(document.activeElement).toBe(docs);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(docs.id);
    expect(docs.getAttribute("aria-selected")).toBe("true");
    expect(writeup.tabIndex).toBe(-1);
    fireEvent.keyDown(docs, { key: "End" });
    const last = pixels < 1280 ? tabs.getByRole("tab", { name: "Diff" }) : comments;
    await waitFor(() => expect(history.location.search).toContain(pixels < 1280 ? "tab=diff" : "tab=comments"));
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "ArrowRight" });
    await waitFor(() => expect(history.location.search).toContain("tab=writeup"));
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(writeup.id);
  },
);

test("a diff search still labels the panel with the first visible reading tab", async () => {
  mount("?tab=diff");
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  expect(screen.getByRole("tab", { name: "Writeup" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel", { name: "Writeup" })).toBeTruthy();
});

test.each(
  [1280, 390].flatMap((pixels) =>
    ["missing", "html"].flatMap((threadKind) =>
      ["files", "map", "map-diff"].map((destination) => ({ pixels, threadKind, destination })),
    ),
  ),
)(
  "$destination navigation discards a $threadKind thread at $pixels px",
  async ({ pixels, threadKind, destination }) => {
    width = pixels;
    const threadId = "22222222-2222-4222-8222-222222222222";
    const htmlThread: ThreadView = {
      id: threadId,
      target: { kind: "html-span", path: "seed.html", quote: "seed", prefix: "", suffix: "" },
      createdOn: 1,
      state: "open",
      comments: [],
      placement: { status: "placed", location: { kind: "html-span", path: "seed.html", start: 0, end: 4 } },
    };
    // Cache the writeup while the thread is loading, so its incoming navigation has not redirected yet.
    if (destination === "map-diff")
      currentRevision.writeup = { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [] }] };
    client.setQueryData(["revision", id, 1], currentRevision);
    await client.invalidateQueries({ queryKey: ["revision", id, 1], refetchType: "none" });
    const reply = Promise.withResolvers<Response>();
    revisionReply = reply.promise;
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { history } = mount(`?tab=writeup&rev=1&thread=${threadId}`);
    const link = await screen.findByRole("link", {
      name: destination === "files" ? "Files in diff: Plant a seed" : "Plant a seed",
    });
    const expectedTab = destination !== "map" && pixels < 768 ? "diff" : "writeup";
    const targetId = destination === "map" ? "topic-seed" : "diff-topic-seed";
    const diffScroll = vi.spyOn(diffPresentation, "holdDiffTarget");
    const href = new URL((link as HTMLAnchorElement).href);
    expect([...href.searchParams.keys()].sort()).toEqual(["rev", "tab"]);
    expect(href.searchParams.get("tab")).toBe(expectedTab);
    fireEvent.click(link);
    await waitFor(() => expect(history.location.search).not.toContain("thread"));
    await act(async () => {
      reply.resolve(
        Response.json({
          ...currentRevision,
          docs: [
            ...currentRevision.docs,
            { kind: "html", path: "seed.html", contentUrl: "/content/synthetic/seed.html" },
          ],
          threads: threadKind === "html" ? [htmlThread] : [],
        }),
      );
      loaded.resolve();
    });
    await waitFor(() => expect(client.isFetching({ queryKey: ["revision", id, 1] })).toBe(0));
    await waitFor(() =>
      expect(
        [...scroll.mock.instances, ...diffScroll.mock.calls.map(([node]) => node)].some(
          (node) => (node as HTMLElement).id === targetId,
        ),
      ).toBe(true),
    );
    expect(history.location.hash).toBe(`#${targetId}`);
    expect(history.location.search).toContain(`tab=${expectedTab}`);
    expect(history.location.search).not.toContain("thread");
    expect(client.getQueryData<RevisionView>(["revision", id, 1])?.threads).toHaveLength(threadKind === "html" ? 1 : 0);
  },
);

test.each(["writeup", "docs"].flatMap((tab) => ["Cancel", "Save comment"].map((close) => ({ tab, close }))))(
  "a resumed $tab block draft marks its placed block until $close",
  async ({ tab, close }) => {
    const block: RenderedBlock = {
      id: tab === "docs" ? "doc-12345678-12345678" : "t-seed-body-12345678",
      section: tab === "docs" ? "doc-12345678" : "t-seed-body",
      kind: "paragraph",
      text: "Keep growing",
      html: "<p>Keep growing</p>",
    };
    const otherBlock = {
      ...block,
      id: `${block.section}-23456789`,
      text: "Water regularly",
      html: "<p>Water regularly</p>",
    };
    if (tab === "docs") currentRevision.docs = [{ kind: "markdown", path: "seed.md", blocks: [block, otherBlock] }];
    else
      currentRevision.writeup.sections = [
        { key: "t-seed-body", label: "Details", topic: "seed", blocks: [block, otherBlock] },
      ];
    const { history, container } = mount(`?tab=${tab}`);
    const first = (await screen.findAllByRole("button", { name: "Comment on block" }))[0];
    if (!first) throw new Error("Missing block control");
    fireEvent.click(first);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("tab", { name: /^Comments/ }));
    const resume = await screen.findByRole("button", { name: "Resume" });
    // The original id has gone; quote placement must supply the new block id to the reader.
    const placedBlock = { ...block, id: `${block.section}-34567890` };
    if (tab === "docs")
      currentRevision.docs = [{ kind: "markdown", path: "seed.md", blocks: [placedBlock, otherBlock] }];
    else
      currentRevision.writeup.sections = [
        { key: "t-seed-body", label: "Details", topic: "seed", blocks: [placedBlock, otherBlock] },
      ];
    await act(async () => {
      client.setQueryData(["revision", id, 1], structuredClone(currentRevision));
    });
    fireEvent.click(resume);
    const editor = await screen.findByRole("region", { name: "Resumed comment" });
    await waitFor(() => expect(history.location.search).toContain(`tab=${tab}`));
    expect((within(editor).getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(container.querySelectorAll("[data-commenting]")).toHaveLength(1);
    expect(container.querySelector("[data-commenting] [data-block-id]")?.getAttribute("data-block-id")).toBe(
      placedBlock.id,
    );
    fireEvent.click(within(editor).getByRole("button", { name: close }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Resumed comment" })).toBeNull());
    expect(container.querySelector("[data-commenting]")).toBeNull();
  },
);

const docBlock: RenderedBlock = {
  id: "doc-12345678-12345678",
  section: "doc-12345678",
  kind: "paragraph",
  text: "Water the seedlings",
  html: "<p>Water the seedlings</p>",
};
const gardenDoc = {
  kind: "markdown" as const,
  path: "docs/z garden.md",
  blocks: [
    docBlock,
    {
      ...docBlock,
      id: "doc-12345678-23456789",
      kind: "heading" as const,
      text: "Garden plan",
      html: "<h2>Garden plan</h2>",
    },
    {
      ...docBlock,
      id: "doc-12345678-34567890",
      kind: "heading" as const,
      text: "Later heading",
      html: "<h3>Later heading</h3>",
    },
  ],
};
const plainDoc = {
  kind: "markdown" as const,
  path: "docs/a plain.md",
  blocks: [{ ...docBlock, id: "doc-23456789-12345678", text: "Another doc", html: "<p>Another doc</p>" }],
};
const htmlDoc = { kind: "html" as const, path: "docs/seed.html", contentUrl: "/content/synthetic/seed.html" };
const otherHtmlDoc = {
  kind: "html" as const,
  path: "docs/water.html",
  contentUrl: "/content/other-synthetic/water.html",
};
function docsFixture() {
  currentRevision.docs = [gardenDoc, plainDoc, htmlDoc, otherHtmlDoc];
  currentRevision.files = [];
}
function searchParams(history: ReturnType<typeof createMemoryHistory>) {
  return new URLSearchParams(history.location.search);
}
function frameMessage(frame: HTMLIFrameElement, data: unknown, source = frame.contentWindow) {
  fireEvent(window, new MessageEvent("message", { source, data }));
}
function prepareFrame(path: string) {
  const frame = document.querySelector<HTMLIFrameElement>(`iframe[title="${path}"]`);
  if (!frame) throw new Error("Missing synthetic frame");
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  fireEvent.load(frame);
  return { frame, post };
}

test.each([
  { pixels: 390, link: "Inbox", pathname: "/", heading: "Inbox" },
  { pixels: 1280, link: "emend", pathname: "/", heading: "Inbox" },
  { pixels: 1280, link: "Devices", pathname: "/devices", heading: "Devices" },
])(
  "$link header link leaves a doc review in one click at $pixels px and Back restores its doc",
  async ({ pixels, link, pathname, heading }) => {
    width = pixels;
    docsFixture();
    currentRevision.main = gardenDoc.path;
    const { history } = mount("");
    const paths = [history.location.pathname];
    onTestFinished(history.subscribe(({ location }) => paths.push(location.pathname)));
    await screen.findByText("Water the seedlings");
    await waitFor(() => expect(searchParams(history).get("doc")).toBe(gardenDoc.path));
    expect(history.location.pathname).toBe(`/r/${id}`);
    const search = history.location.search;

    await act(async () => fireEvent.click(screen.getByRole("link", { name: link })));
    expect(history.location.pathname).toBe(pathname);
    await screen.findByRole("heading", { name: heading, level: 1 });
    expect(history.location.pathname).toBe(pathname);
    expect(history.location.search).toBe("");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([path]) => typeof path === "string" && path.startsWith("/api/v1/reviews/undefined")),
    ).toBe(false);
    expect(paths).not.toContain("/r/undefined");

    await act(async () => history.back());
    await screen.findByText("Water the seedlings");
    expect(history.location.pathname).toBe(`/r/${id}`);
    expect(history.location.search).toBe(search);
    expect(searchParams(history).get("doc")).toBe(gardenDoc.path);
    expect(paths).not.toContain("/r/undefined");
  },
);

test("leaving as a doc commits keeps the inbox address ahead of pending effects", async () => {
  docsFixture();
  currentRevision.main = gardenDoc.path;
  const reply = Promise.withResolvers<Response>();
  revisionReply = reply.promise;
  const history = createMemoryHistory({ initialEntries: [`/r/${id}`] });
  let searchAtClick: string | undefined;
  // The commit callback runs after the doc enters the DOM and before passive effects.
  render(
    <Profiler
      id="leave-on-doc-commit"
      onRender={() => {
        if (searchAtClick !== undefined || !screen.queryByText("Water the seedlings")) return;
        searchAtClick = history.location.search;
        screen.getByRole("link", { name: "emend" }).click();
      }}
    >
      <App queryClient={client} history={history} />
    </Profiler>,
  );
  await screen.findByRole("heading", { name: review.title, level: 1 });
  expect(history.location.search).toBe("");
  const paths: string[] = [];
  onTestFinished(history.subscribe(({ location }) => paths.push(location.pathname)));
  await act(async () => reply.resolve(Response.json(currentRevision)));
  await waitFor(() => expect(searchAtClick).toBeDefined());
  expect(searchAtClick).toBe("");
  expect(history.location.pathname).toBe("/");
  expect(history.location.search).toBe("");
  await screen.findByRole("heading", { name: "Inbox", level: 1 });
  expect(history.location.pathname).toBe("/");
  expect(history.location.search).toBe("");
  expect(paths).not.toContain("/r/undefined");
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([path]) => typeof path === "string" && path.startsWith("/api/v1/reviews/undefined")),
  ).toBe(false);
  await act(async () => history.back());
  await screen.findByText("Water the seedlings");
  expect(history.location.pathname).toBe(`/r/${id}`);
  expect(searchParams(history).get("doc")).toBe(gardenDoc.path);
});

test("a review first loaded during departure keeps the inbox address and Back returns to its doc", async () => {
  width = 390;
  docsFixture();
  currentRevision.main = gardenDoc.path;
  const reply = Promise.withResolvers<Response>();
  const original = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation((path, init) => {
    if (path === `/api/v1/reviews/${id}`) return reply.promise.then((response) => response.clone());
    if (!original) throw new Error("Missing synthetic fetch");
    return original(path, init);
  });
  const arrival = Promise.withResolvers<void>();
  const createRouter = webRouter.createWebRouter;
  vi.spyOn(webRouter, "createWebRouter").mockImplementation((history) => {
    const router = createRouter(history);
    const inbox = router.routesById["/"];
    const beforeLoad = inbox.options.beforeLoad;
    // Keep the outgoing route mounted while the inbox navigation is pending.
    inbox.options.beforeLoad = () => arrival.promise;
    onTestFinished(() => {
      inbox.options.beforeLoad = beforeLoad;
    });
    return router;
  });
  const { history } = mount("");
  await screen.findByText("Loading review…");
  const paths: string[] = [];
  onTestFinished(history.subscribe(({ location }) => paths.push(location.pathname)));

  await act(async () => fireEvent.click(screen.getByRole("link", { name: "Inbox" })));
  expect(history.location.pathname).toBe("/");
  expect(history.location.search).toBe("");
  await act(async () => reply.resolve(Response.json(currentReview)));
  await screen.findByText("Water the seedlings");
  expect(history.location.pathname).toBe("/");
  expect(history.location.search).toBe("");
  await act(async () => arrival.resolve());
  await screen.findByRole("heading", { name: "Inbox", level: 1 });
  expect(history.location.pathname).toBe("/");
  expect(history.location.search).toBe("");
  expect(paths).not.toContain("/r/undefined");
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([path]) => typeof path === "string" && path.startsWith("/api/v1/reviews/undefined")),
  ).toBe(false);

  await act(async () => history.back());
  await screen.findByText("Water the seedlings");
  expect(history.location.pathname).toBe(`/r/${id}`);
  expect(searchParams(history).get("doc")).toBe(gardenDoc.path);
});

test("a review sub-path keeps its address and empty search when leaving an open doc", async () => {
  docsFixture();
  currentRevision.main = gardenDoc.path;
  const { history } = mount("");
  await screen.findByText("Water the seedlings");
  await waitFor(() => expect(searchParams(history).get("doc")).toBe(gardenDoc.path));
  expect(history.location.pathname).toBe(`/r/${id}`);

  const paths: string[] = [];
  onTestFinished(history.subscribe(({ location }) => paths.push(location.pathname)));
  await act(async () => history.push(`/r/${id}/extra`));
  expect(history.location.pathname).toBe(`/r/${id}/extra`);
  expect(history.location.search).toBe("");
  await screen.findByRole("heading", { name: "Page not found" });
  expect(history.location.pathname).toBe(`/r/${id}/extra`);
  expect(history.location.search).toBe("");
  expect(paths).not.toContain(`/r/${id}`);
});

test("the sidebar opens another review on its own doc and Back restores the first review's doc", async () => {
  width = 1280;
  docsFixture();
  currentRevision.main = gardenDoc.path;
  currentRevision.docs = [gardenDoc];
  const other = "22222222-2222-4222-8222-222222222222";
  const otherReview = { ...review, id: other, title: "Another garden" };
  const otherRevision = { ...currentRevision, main: plainDoc.path, docs: [plainDoc] };
  const original = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (path === "/api/v1/reviews")
      return Response.json({
        approvedActiveHours: 12,
        serverTime: new Date(Date.now()).toISOString(),
        items: [review, otherReview],
      });
    if (path === `/api/v1/reviews/${other}`) return Response.json(otherReview);
    if (path === `/api/v1/reviews/${other}/revisions/1`) return Response.json(otherRevision);
    if (!original) throw new Error("Missing synthetic fetch");
    return original(path, init);
  });
  const { history } = mount("");
  await screen.findByText("Water the seedlings");
  await waitFor(() => expect(searchParams(history).get("doc")).toBe(gardenDoc.path));
  expect(history.location.pathname).toBe(`/r/${id}`);
  const search = history.location.search;
  const sidebar = within(screen.getByRole("complementary", { name: "Inbox" }));
  const next = await sidebar.findByRole("link", { name: /Another garden/ });

  await act(async () => fireEvent.click(next));
  await screen.findByRole("heading", { name: "Another garden", level: 1 });
  await screen.findByRole("tab", { name: "Docs 1" });
  expect(history.location.pathname).toBe(`/r/${other}`);
  expect(searchParams(history).get("doc")).toBe(plainDoc.path);
  await screen.findByText("Another doc");
  expect(screen.queryByText("Document not found. Showing all docs.")).toBeNull();
  expect(screen.queryByText("Water the seedlings")).toBeNull();

  await act(async () => history.back());
  await screen.findByText("Water the seedlings");
  expect(history.location.pathname).toBe(`/r/${id}`);
  expect(history.location.search).toBe(search);
  expect(searchParams(history).get("doc")).toBe(gardenDoc.path);
  expect(screen.queryByText("Document not found. Showing all docs.")).toBeNull();
});

test.each(["row", "rail"])(
  "inbox %s opens the declared main doc and selects a newly published revision",
  async (entry) => {
    docsFixture();
    currentRevision.main = gardenDoc.path;
    if (entry === "rail") localStorage.setItem("emend.layout.v1", JSON.stringify({ inboxCollapsed: true }));
    const { history } = mount();
    await screen.findByText("Keep growing");
    const inboxLink = () =>
      within(screen.getByRole("complementary", { name: "Inbox" })).getByRole("link", { name: /Synthetic garden/ });
    await waitFor(() => expect(inboxLink()).toBeTruthy());
    expect(new URL((inboxLink() as HTMLAnchorElement).href).search).toBe("?rev=1");
    fireEvent.click(inboxLink());
    await screen.findByRole("heading", { name: "z garden.md" });
    expect(screen.getByRole("tab", { name: "Docs 4" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("Keep growing")).toBeNull();
    expect(searchParams(history).get("rev")).toBe("1");
    currentReview = {
      ...currentReview,
      newestRevision: 2,
      revisions: [...currentReview.revisions, { seq: 2, createdAt: "2026-01-02T00:00:00.000Z" }],
    };
    await act(async () => {
      client.setQueryData(["review", id], currentReview);
      client.setQueryData<InboxData>(["inbox"], {
        approvedActiveHours: 12,
        serverTime: new Date(Date.now()).toISOString(),
        receivedAt: Date.now(),
        receivedMono: performance.now(),
        items: [currentReview],
      });
    });
    expect(searchParams(history).get("rev")).toBe("1");
    await waitFor(() => expect(new URL((inboxLink() as HTMLAnchorElement).href).search).toBe("?rev=2"));
    fireEvent.click(inboxLink());
    await waitFor(() => expect(searchParams(history).get("rev")).toBe("2"));
    await screen.findByRole("button", { name: "Approve revision 2" });
    expect(screen.getByRole("heading", { name: "z garden.md" })).toBeTruthy();
  },
);

test.each([1280, 390])(
  "Show in place brings the HTML frame to the pane top before scrolling its highlight at %s px",
  async (pixels) => {
    width = pixels;
    docsFixture();
    currentRevision.threads = [
      {
        id,
        createdOn: 1,
        state: "open",
        target: { kind: "html-span", path: htmlDoc.path, quote: "seed", prefix: "", suffix: "" },
        placement: { status: "placed", location: { kind: "html-span", path: htmlDoc.path, start: 0, end: 4 } },
        comments: [{ id, author: "user", body: "A placed comment", sent: true, sentOn: 1 }],
      },
    ];
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    mount("?tab=comments&rev=1");
    fireEvent.click(await screen.findByRole("link", { name: "Show in place" }));
    await screen.findByRole("heading", { name: "seed.html" });
    const outer = document.getElementById(`html-doc-${htmlDoc.path}`);
    await waitFor(() => expect(scroll.mock.instances).toContain(outer));
    if (!outer) throw new Error("Missing HTML doc container");
    const index = scroll.mock.instances.indexOf(outer);
    expect(scroll.mock.calls[index]).toEqual([{ block: "start" }]);
    expect(scroll.mock.instances).not.toContain(document.getElementById(`thread-${id}`));
    const { frame, post } = prepareFrame(htmlDoc.path);
    frameMessage(frame, { type: "emend:ready" });
    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: "emend:scroll", threadId: id }, "*"));
    expect(scroll.mock.invocationCallOrder[index]).toBeLessThan(post.mock.invocationCallOrder.at(-1) ?? 0);
  },
);

test("instructions survive navigation to another review and back, then clear after Send", async () => {
  const other = "22222222-2222-4222-8222-222222222222";
  const original = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (path === `/api/v1/reviews/${other}`) return Response.json({ ...review, id: other, title: "Another garden" });
    if (path === `/api/v1/reviews/${other}/revisions/1`) return Response.json(revision);
    if (path === `/api/v1/reviews/${id}/sends`) return new Response(null, { status: 201 });
    if (!original) throw new Error("Missing synthetic fetch");
    return original(path, init);
  });
  const { history } = mount();
  const input = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Instructions" });
  await screen.findByText("Keep growing");
  fireEvent.change(input(), { target: { value: "Retain the garden instructions" } });
  await act(async () => history.push(`/r/${other}`));
  await screen.findByRole("heading", { name: "Another garden" });
  expect(input().value).toBe("");
  await act(async () => history.back());
  await screen.findByRole("heading", { name: "Synthetic garden" });
  expect(input().value).toBe("Retain the garden instructions");
  fireEvent.click(screen.getByRole("button", { name: "Send 2" }));
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  await waitFor(() => expect(input().value).toBe(""));
  await act(async () => history.push(`/r/${other}`));
  await screen.findByRole("heading", { name: "Another garden" });
  await act(async () => history.back());
  await screen.findByRole("heading", { name: "Synthetic garden" });
  expect(input().value).toBe("");
});

test("review search keeps contract-valid doc paths and explicitly clears rejected paths", () => {
  expect(validateReviewSearch({ doc: gardenDoc.path }).doc).toBe(gardenDoc.path);
  for (const doc of [undefined, "", 1, ["seed.md"], "../seed.md", "/seed.md", "a\\b.md", "a\0.md", "\ud800"])
    expect(validateReviewSearch({ doc })).toHaveProperty("doc", undefined);
});

test.each([1280, 768, 390])("doc list and open doc navigate, focus and reset scroll at %s px", async (pixels) => {
  width = pixels;
  docsFixture();
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history, container } = mount(`?tab=docs&rev=1&thread=${id}#missing-target`);
  await screen.findByRole("heading", { name: "Docs" });
  const panel = within(screen.getByTestId("reading-pane"));
  const list = panel.getByRole("list");
  const names = [
    "z garden.md docs/z garden.md",
    "a plain.md docs/a plain.md",
    "seed.html docs/seed.html",
    "water.html docs/water.html",
  ];
  const links = within(list).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual([
    "z garden.mddocs/z garden.md",
    "a plain.mddocs/a plain.md",
    "seed.htmldocs/seed.html",
    "water.htmldocs/water.html",
  ]);
  for (const name of names) expect(within(list).getByRole("link", { name })).toBeTruthy();
  expect(container.querySelector("iframe, [data-block-id]")).toBeNull();
  const href = new URL((links[0] as HTMLAnchorElement).href);
  expect(href.searchParams.get("rev")).toBe("1");
  expect(href.searchParams.get("doc")).toBe(gardenDoc.path);
  expect(href.searchParams.has("thread")).toBe(false);
  expect(href.hash).toBe("");
  const pane = screen.getByTestId("reading-pane");
  pane.scrollTop = 300;
  fireEvent.click(within(list).getByRole("link", { name: names[0] }));
  const heading = await screen.findByRole("heading", { name: "z garden.md" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(heading.getAttribute("title")).toBe(gardenDoc.path);
  expect(pane.scrollTop).toBe(0);
  expect(searchParams(history).get("doc")).toBe(gardenDoc.path);
  expect(container.querySelectorAll("[data-block-id]")).toHaveLength(3);
  expect(container.querySelector("iframe")).toBeNull();
  expect(screen.queryByText("Another doc")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "All docs" }));
  const row = await screen.findByRole("link", { name: names[0] });
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(scroll.mock.instances).toContain(row);
  expect(searchParams(history).get("doc")).toBeNull();
  expect(searchParams(history).get("rev")).toBe("1");
  fireEvent.click(screen.getByRole("link", { name: names[2] }));
  await screen.findByRole("heading", { name: "seed.html" });
  expect(container.querySelectorAll("iframe")).toHaveLength(1);
  expect(container.querySelector("[data-block-id]")).toBeNull();
  if (pixels === 390) expect(screen.queryByText("Sandboxed, scripts off")).toBeNull();
  else expect(screen.getByText("Sandboxed, scripts off")).toBeTruthy();
  act(() => history.back());
  const htmlRow = await screen.findByRole("link", { name: names[2] });
  await waitFor(() => expect(document.activeElement).toBe(htmlRow));
  expect(scroll.mock.instances).toContain(htmlRow);
  act(() => history.forward());
  const returnedHeading = await screen.findByRole("heading", { name: "seed.html" });
  await waitFor(() => expect(document.activeElement).toBe(returnedHeading));
  fireEvent.click(screen.getByRole("link", { name: "All docs" }));
  await screen.findByRole("link", { name: names[2] });
  act(() => history.back());
  await screen.findByRole("heading", { name: "seed.html" });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "seed.html" })));
});

test.each([gardenDoc, htmlDoc])("a sole $kind doc opens directly without All docs", async (doc) => {
  docsFixture();
  currentRevision.docs = [doc];
  const { history } = mount("?tab=docs");
  await screen.findByRole("heading", { name: doc.path.split("/").at(-1) });
  await waitFor(() => expect(searchParams(history).get("doc")).toBe(doc.path));
  expect(screen.queryByRole("heading", { name: "Docs" })).toBeNull();
  expect(screen.queryByRole("link", { name: "All docs" })).toBeNull();
});

test.each(["block", "heading", "doc", "html-doc", "doc-thread", "html-thread"])(
  "a %s target resolves and canonicalizes its doc",
  async (kind) => {
    docsFixture();
    const html = kind.startsWith("html");
    const path = html ? htmlDoc.path : gardenDoc.path;
    let elementId =
      kind === "block"
        ? `block-${docBlock.id}`
        : kind === "heading"
          ? `block-${gardenDoc.blocks[1]?.id}`
          : `${kind}-${path}`;
    if (kind.endsWith("thread")) {
      elementId = `thread-${id}`;
      currentRevision.threads = [
        {
          id,
          createdOn: 1,
          state: "open",
          comments: [],
          target: html
            ? { kind: "html-span", path, quote: "seed", prefix: "", suffix: "" }
            : { kind: "doc-span", path, blockId: docBlock.id, quote: docBlock.text, prefix: "", suffix: "" },
          placement: {
            status: "placed",
            location: html
              ? { kind: "html-span", path, start: 0, end: 4 }
              : { kind: "doc-span", path, blockId: docBlock.id, start: 0, end: docBlock.text.length },
          },
        },
      ];
    }
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { history } = mount(`?tab=docs#${elementId}`);
    await screen.findByRole("heading", { name: path.split("/").at(-1) });
    await waitFor(() => expect(searchParams(history).get("doc")).toBe(path));
    const scrollTarget = kind === "html-thread" ? `html-doc-${path}` : elementId;
    await waitFor(() => expect(scroll.mock.instances).toContain(document.getElementById(scrollTarget)));
    expect(history.length).toBe(1);
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: path.split("/").at(-1) }));
  },
);

test.each(["doc-span", "html-span"] as const)(
  "resuming a %s draft opens its doc and reaches the target",
  async (kind) => {
    docsFixture();
    const path = kind === "doc-span" ? gardenDoc.path : htmlDoc.path;
    const target =
      kind === "doc-span"
        ? { kind, path, blockId: docBlock.id, quote: docBlock.text, prefix: "", suffix: "" }
        : { kind, path, quote: "seed", prefix: "", suffix: "" };
    localStorage.setItem(draftKey(id, target), "Water carefully");
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { history } = mount("?tab=comments&doc=docs%2Fa%20plain.md");
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await screen.findByRole("heading", { name: path.split("/").at(-1) });
    expect(searchParams(history).get("doc")).toBe(path);
    const elementId = kind === "doc-span" ? `block-${docBlock.id}` : `html-doc-${path}`;
    await waitFor(() => expect(scroll.mock.instances).toContain(document.getElementById(elementId)));
    const editor = within(screen.getByRole("region", { name: "Resumed comment" })).getByLabelText(
      "Comment",
    ) as HTMLTextAreaElement;
    expect(editor.value).toBe("Water carefully");
    expect(document.activeElement).toBe(editor);
  },
);

test("a resumed Markdown editor leaves All docs and row navigation free to move focus", async () => {
  docsFixture();
  localStorage.setItem(
    draftKey(id, {
      kind: "doc-span",
      path: gardenDoc.path,
      blockId: docBlock.id,
      quote: docBlock.text,
      prefix: "",
      suffix: "",
    }),
    "Keep this editor open",
  );
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mount("?tab=comments");
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  const region = await screen.findByRole("region", { name: "Resumed comment" });
  const editor = within(region).getByLabelText("Comment") as HTMLTextAreaElement;
  expect(editor.value).toBe("Keep this editor open");
  expect(document.activeElement).toBe(editor);

  fireEvent.click(screen.getByRole("link", { name: "All docs" }));
  const row = await screen.findByRole("link", { name: "z garden.md docs/z garden.md" });
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(scroll.mock.instances).toContain(row);
  expect(within(screen.getByRole("region", { name: "Resumed comment" })).getByLabelText("Comment")).toBe(editor);

  fireEvent.click(screen.getByRole("link", { name: "a plain.md docs/a plain.md" }));
  const heading = await screen.findByRole("heading", { name: "a plain.md" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(within(screen.getByRole("region", { name: "Resumed comment" })).getByLabelText("Comment")).toBe(editor);
  expect(editor.value).toBe("Keep this editor open");
});

test("an unknown doc shows the index with a non-echoing notice", async () => {
  docsFixture();
  const { history, container } = mount("?tab=docs&doc=absent.md");
  await screen.findByRole("link", { name: "z garden.md docs/z garden.md" });
  expect(await screen.findByText("Document not found. Showing all docs.")).toBeTruthy();
  expect(container.querySelector("iframe, [data-block-id]")).toBeNull();
  expect(history.length).toBe(1);
});

test("an unknown doc stays at the index even with an unrelated block target", async () => {
  docsFixture();
  const { history } = mount(`?tab=docs&doc=absent.md#block-${docBlock.id}`);
  await screen.findByText("Document not found. Showing all docs.");
  expect(screen.queryByText("Water the seedlings")).toBeNull();
  expect(history.location.hash).toBe(`#block-${docBlock.id}`);
  expect(history.length).toBe(1);
});

test("an explicit doc takes precedence over a different doc's reading target", async () => {
  docsFixture();
  mount(`?tab=docs&doc=${encodeURIComponent(plainDoc.path)}#block-${docBlock.id}`);
  await screen.findByRole("heading", { name: "a plain.md" });
  expect(screen.queryByText("Water the seedlings")).toBeNull();
});

test("opening several docs with an empty writeup opens the first doc and writes its URL", async () => {
  docsFixture();
  currentRevision.main = null;
  currentRevision.writeupEmpty = true;
  currentRevision.writeup = { sections: [] };
  const { history } = mount("");
  await screen.findByRole("heading", { name: "z garden.md" });
  await waitFor(() => expect(searchParams(history).get("doc")).toBe(gardenDoc.path));
  expect(searchParams(history).has("tab")).toBe(false);
  expect(history.length).toBe(1);
});

test("doc selection survives tabs and revision changes without moving focus on refetch", async () => {
  docsFixture();
  currentReview.revisions.push({ seq: 2, createdAt: "2026-01-02T00:00:00.000Z" });
  currentReview.newestRevision = 2;
  const { history } = mount(`?rev=1&tab=docs&doc=${encodeURIComponent(plainDoc.path)}`);
  await screen.findByRole("heading", { name: "a plain.md" });
  fireEvent.click(screen.getByRole("tab", { name: "Writeup" }));
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  expect(searchParams(history).get("doc")).toBe(plainDoc.path);
  fireEvent.click(screen.getByRole("tab", { name: "Docs 4" }));
  await screen.findByRole("heading", { name: "a plain.md" });
  fireEvent.keyDown(screen.getByRole("button", { name: /^Revision 1/ }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Revision 2/ }));
  await waitFor(() => expect(searchParams(history).get("rev")).toBe("2"));
  const heading = await screen.findByRole("heading", { name: "a plain.md" });
  expect(searchParams(history).get("doc")).toBe(plainDoc.path);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  screen.getByTestId("reading-pane").scrollTop = 180;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["revision", id, 2] });
  });
  expect(document.activeElement).toBe(instructions);
  expect(screen.getByTestId("reading-pane").scrollTop).toBe(180);
  expect(screen.getByRole("heading", { name: "a plain.md" })).toBe(heading);
});

test("doc block links encode the path alongside the Docs tab", () => {
  const url = new URL(blockLink(id, 2, docBlock.id, gardenDoc.path), "http://localhost");
  expect(url.searchParams.get("doc")).toBe(gardenDoc.path);
  expect(url.searchParams.get("tab")).toBe("docs");
  expect(url.hash).toBe(`#block-${docBlock.id}`);
});

test("HTML doc messages navigate with history and fragment hand-off, and old windows lose authority", async () => {
  docsFixture();
  const { history, container } = mount(`?tab=docs&rev=1&doc=${encodeURIComponent(htmlDoc.path)}`);
  await screen.findByRole("heading", { name: "seed.html" });
  const { frame: first } = prepareFrame(htmlDoc.path);
  const fragment = "part é%#";
  frameMessage(first, { type: "emend:navigate", path: otherHtmlDoc.path, fragment });
  const nextHeading = await screen.findByRole("heading", { name: "water.html" });
  await waitFor(() => expect(document.activeElement).toBe(nextHeading));
  await waitFor(() =>
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      `${otherHtmlDoc.contentUrl}#${encodeURIComponent(fragment)}`,
    ),
  );
  expect(container.querySelectorAll("iframe")).toHaveLength(1);
  expect(first.isConnected).toBe(false);
  expect(searchParams(history).get("doc")).toBe(otherHtmlDoc.path);
  expect(searchParams(history).get("rev")).toBe("1");
  expect(history.length).toBe(2);
  const { frame: second } = prepareFrame(otherHtmlDoc.path);
  frameMessage(first, { type: "emend:navigate", path: gardenDoc.path, fragment: "" });
  frameMessage(first, { type: "emend:anchor", quote: "seed", prefix: "", suffix: "" });
  expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
  expect(searchParams(history).get("doc")).toBe(otherHtmlDoc.path);
  act(() => history.back());
  await screen.findByRole("heading", { name: "seed.html" });
  expect(container.querySelectorAll("iframe")).toHaveLength(1);
  expect(second.isConnected).toBe(false);
  const { frame: returned } = prepareFrame(htmlDoc.path);
  frameMessage(returned, { type: "emend:navigate", path: gardenDoc.path, fragment: "heading" });
  await screen.findByRole("heading", { name: "z garden.md" });
  expect(container.querySelector("iframe")).toBeNull();
});

test("HTML navigation rejects foreign windows, other revisions, malformed messages and departed frames", async () => {
  docsFixture();
  const { history, container } = mount(`?tab=docs&doc=${encodeURIComponent(htmlDoc.path)}`);
  await screen.findByRole("heading", { name: "seed.html" });
  const { frame } = prepareFrame(htmlDoc.path);
  const valid = { type: "emend:navigate", path: otherHtmlDoc.path, fragment: "seed" };
  frameMessage(frame, valid, window);
  for (const data of [
    { ...valid, path: "previous-revision.html" },
    { ...valid, path: "docs/asset.svg" },
    { ...valid, path: htmlDoc.path },
    { ...valid, fragment: "x".repeat(1025) },
    { ...valid, fragment: "\ud800" },
    { ...valid, extra: true },
  ])
    frameMessage(frame, data);
  fireEvent.load(frame);
  frameMessage(frame, valid);
  expect(screen.getByText("This doc navigated away.")).toBeTruthy();
  expect(history.length).toBe(1);
  expect(searchParams(history).get("doc")).toBe(htmlDoc.path);
  expect(container.querySelectorAll("iframe")).toHaveLength(1);
});

test("hostile doc titles and paths stay text in the list and doc bar", async () => {
  docsFixture();
  const hostile = '<img onerror="evil()"><svg onload="evil()">';
  const path = `docs/${hostile}.md`;
  const heading = { ...docBlock, kind: "heading" as const, text: hostile, html: "<h2>Safe synthetic heading</h2>" };
  currentRevision.docs = [{ kind: "markdown", path, title: hostile, blocks: [heading] }, htmlDoc];
  const { container } = mount("?tab=docs");
  fireEvent.click(await screen.findByRole("link", { name: `${hostile} ${path}` }));
  const bar = await screen.findByRole("heading", { name: hostile });
  expect(bar.textContent).toBe(hostile);
  expect(bar.getAttribute("title")).toBe(path);
  expect(container.querySelector("script, [onerror], [onload], a[href^='javascript:']")).toBeNull();
});

test("an unknown doc falls through to an HTML thread target", async () => {
  docsFixture();
  currentRevision.threads = [
    {
      id,
      createdOn: 1,
      state: "open",
      comments: [],
      target: { kind: "html-span", path: htmlDoc.path, quote: "seed", prefix: "", suffix: "" },
      placement: { status: "placed", location: { kind: "html-span", path: htmlDoc.path, start: 0, end: 4 } },
    },
  ];
  const { history, container } = mount(`?tab=docs&doc=absent.html#thread-${id}`);
  await screen.findByRole("heading", { name: "seed.html" });
  await waitFor(() => expect(searchParams(history).get("doc")).toBe(htmlDoc.path));
  expect(container.querySelector("iframe")?.title).toBe(htmlDoc.path);
  expect(history.location.hash).toBe(`#thread-${id}`);
  expect(history.length).toBe(1);
});

test("an unplaced Markdown draft still opens its doc", async () => {
  docsFixture();
  localStorage.setItem(
    draftKey(id, {
      kind: "doc-span",
      path: gardenDoc.path,
      blockId: "doc-12345678-87654321",
      quote: "Removed sentence",
      prefix: "",
      suffix: "",
    }),
    "Keep my draft",
  );
  const { history } = mount("?tab=comments");
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await screen.findByRole("heading", { name: "z garden.md" });
  expect(searchParams(history).get("doc")).toBe(gardenDoc.path);
  expect(screen.getByRole("region", { name: "Resumed comment" })).toBeTruthy();
});

test("a revision without the open doc shows the index and a missing-doc notice", async () => {
  docsFixture();
  currentReview.revisions.push({ seq: 2, createdAt: "2026-01-02T00:00:00.000Z" });
  const { history } = mount(`?rev=1&tab=docs&doc=${encodeURIComponent(plainDoc.path)}`);
  await screen.findByRole("heading", { name: "a plain.md" });
  currentRevision.docs = [gardenDoc, htmlDoc];
  fireEvent.keyDown(screen.getByRole("button", { name: /^Revision 1/ }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Revision 2/ }));
  await screen.findByRole("link", { name: "z garden.md docs/z garden.md" });
  expect(await screen.findByText("Document not found. Showing all docs.")).toBeTruthy();
  expect(searchParams(history).get("tab")).toBe("docs");
  expect(searchParams(history).get("rev")).toBe("2");
  expect(history.length).toBe(2);
});

test.each(["block", "doc-thread", "html-thread"])("a Comments URL with a %s hash stays on Comments", async (kind) => {
  docsFixture();
  const html = kind === "html-thread";
  const path = html ? htmlDoc.path : gardenDoc.path;
  currentRevision.threads = [
    {
      id,
      createdOn: 1,
      state: "open",
      comments: [],
      target: html
        ? { kind: "html-span", path, quote: "seed", prefix: "", suffix: "" }
        : { kind: "doc-span", path, blockId: docBlock.id, quote: docBlock.text, prefix: "", suffix: "" },
      placement: {
        status: "placed",
        location: html
          ? { kind: "html-span", path, start: 0, end: 4 }
          : { kind: "doc-span", path, blockId: docBlock.id, start: 0, end: docBlock.text.length },
      },
    },
  ];
  const hash = kind === "block" ? `block-${docBlock.id}` : `thread-${id}`;
  const { history, container } = mount(`?tab=comments#${hash}`);
  await screen.findByRole("tabpanel", { name: "Comments 0 unsent, 1 not resolved, 1 thread in all" });
  await waitFor(() => expect(document.getElementById(`thread-${id}`)).toBeTruthy());
  expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
  expect(searchParams(history).get("tab")).toBe("comments");
  expect(searchParams(history).has("doc")).toBe(false);
  expect(history.location.hash).toBe(`#${hash}`);
  expect(container.querySelector("iframe, [data-block-id]")).toBeNull();
});

test.each([gardenDoc, htmlDoc])("a direct $kind doc load does not take heading focus", async (doc) => {
  docsFixture();
  const { history } = mount(`?tab=docs&doc=${encodeURIComponent(doc.path)}`);
  const heading = await screen.findByRole("heading", { name: doc.path.split("/").at(-1) });
  expect(document.activeElement).not.toBe(heading);
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(document.activeElement).not.toBe(heading);
  expect(searchParams(history).get("doc")).toBe(doc.path);
});

test("switching from Writeup to Docs keeps focus on the tab", async () => {
  docsFixture();
  mount(`?tab=writeup&doc=${encodeURIComponent(gardenDoc.path)}`);
  const writeup = await screen.findByRole("tab", { name: "Writeup" });
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  fireEvent.keyDown(writeup, { key: "ArrowRight" });
  await screen.findByRole("heading", { name: "z garden.md" });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Docs 4" }));
});

test("a target inside the shown Docs tab does not take heading focus", async () => {
  docsFixture();
  const { history } = mount("?tab=docs");
  await screen.findByRole("link", { name: "z garden.md docs/z garden.md" });
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  act(() => history.push(`/r/${id}?tab=docs#block-${docBlock.id}`));
  await screen.findByRole("heading", { name: "z garden.md" });
  await waitFor(() => expect(searchParams(history).get("doc")).toBe(gardenDoc.path));
  expect(document.activeElement).toBe(instructions);
});

test("a data refresh that opens a sole doc does not take heading focus", async () => {
  docsFixture();
  mount("?tab=docs");
  await screen.findByRole("link", { name: "z garden.md docs/z garden.md" });
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  await act(async () => {
    client.setQueryData(["revision", id, 1], { ...currentRevision, docs: [plainDoc] });
  });
  await screen.findByRole("heading", { name: "a plain.md" });
  expect(document.activeElement).toBe(instructions);
});

function placedWriteupThread(): ThreadView {
  return {
    id,
    createdOn: 1,
    state: "sent",
    target: { kind: "writeup-span", blockId: "t-seed-body-12345678", quote: "Keep growing", prefix: "", suffix: "" },
    placement: {
      status: "placed",
      location: { kind: "writeup-span", blockId: "t-seed-body-12345678", start: 0, end: 12 },
    },
    comments: [{ id, author: "user", body: "A synthetic question", sent: true, sentOn: 1 }],
  };
}

describe("comment highlight navigation", () => {
  let highlights: Map<string, Set<Range>>;
  beforeEach(() => {
    highlights = new Map();
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal("Highlight", class extends Set<Range> {});
  });
  const ranges = (active = false) => [...(highlights.get(active ? "emend-comment-active" : "emend-comment") ?? [])];
  const quotes = (active = false) => ranges(active).map((range) => range.toString());

  test.each([1280, 390].flatMap((pixels) => ["writeup", "docs"].map((tab) => ({ pixels, tab }))))(
    "$tab hash/search targets, tab/doc/revision switches and unmount at $pixels px",
    async ({ pixels, tab }) => {
      width = pixels;
      const thread = placedWriteupThread();
      const blocks = currentRevision.writeup.sections.flatMap((section) => section.blocks);
      if (tab === "docs") {
        thread.target = {
          ...thread.target,
          kind: "doc-span",
          path: "seed.md",
          blockId: "t-seed-body-12345678",
          quote: "Keep growing",
          prefix: "",
          suffix: "",
        };
        thread.placement = {
          status: "placed",
          location: { kind: "doc-span", path: "seed.md", blockId: "t-seed-body-12345678", start: 0, end: 12 },
        };
        currentRevision.docs = [
          { kind: "markdown", path: "seed.md", blocks },
          { kind: "markdown", path: "water.md", blocks },
        ];
      }
      currentRevision.threads = [thread];
      const query = `?tab=${tab}${tab === "docs" ? "&doc=seed.md" : ""}`;
      const url = (tail = "") => `/r/${id}${query}&rev=1${tail}`;
      const view = mount(`${query}&rev=1#thread-${id}`);
      await waitFor(() => expect(quotes(true)).toEqual(["Keep growing"]));
      expect(quotes()).toEqual([]);

      await act(async () => view.history.push(url()));
      await waitFor(() => expect(quotes()).toEqual(["Keep growing"]));
      expect(quotes(true)).toEqual([]);
      await act(async () => view.history.push(url(`&thread=${id}`)));
      await waitFor(() => expect(quotes(true)).toEqual(["Keep growing"]));
      expect(quotes()).toEqual([]);

      if (tab === "docs") {
        const previous = ranges(true)[0];
        await act(async () => view.history.push(`/r/${id}?tab=docs&doc=water.md&rev=1`));
        await screen.findByRole("heading", { name: "water.md" });
        expect(quotes()).toEqual([]);
        expect(quotes(true)).toEqual([]);
        await act(async () => view.history.push(url()));
        await waitFor(() => expect(quotes()).toEqual(["Keep growing"]));
        expect(ranges()).not.toContain(previous);
      }

      await act(async () => view.history.push(`/r/${id}?tab=comments&rev=1`));
      await waitFor(() => expect(highlights.size).toBe(0));
      await act(async () => view.history.push(url()));
      await waitFor(() => expect(quotes()).toEqual(["Keep growing"]));
      const previous = ranges()[0];
      const nextBlocks = blocks.map((block) => ({ ...block, text: "Keep sowing!", html: "<p>Keep sowing!</p>" }));
      currentRevision = {
        ...currentRevision,
        writeup: { sections: currentRevision.writeup.sections.map((section) => ({ ...section, blocks: nextBlocks })) },
        docs: currentRevision.docs.map((doc) => (doc.kind === "markdown" ? { ...doc, blocks: nextBlocks } : doc)),
      };
      await act(async () => view.history.push(`/r/${id}${query}&rev=2`));
      await waitFor(() => expect(quotes()).toEqual(["Keep sowing!"]));
      expect(ranges()).not.toContain(previous);
      if (pixels === 390) {
        await act(async () => view.history.push(`/r/${id}?tab=diff&rev=2`));
        await waitFor(() => expect(highlights.size).toBe(0));
      }
      view.unmount();
      expect(highlights.size).toBe(0);
    },
  );
});
test.each(
  ["reply", "edit"].flatMap((kind) =>
    ["immediate", "regroup", "focus elsewhere", "navigate"].map((next) => ({ kind, next })),
  ),
)("fix2 phone $kind Save returns focus through a Comments regroup: $next", async ({ kind, next }) => {
  width = 390;
  const thread = placedWriteupThread();
  const editing = kind === "edit";
  if (editing) thread.comments = thread.comments.map((comment) => ({ ...comment, sent: false, sentOn: null }));
  const beforeGroup = editing ? "Unsent" : "Sent";
  const afterGroup = editing ? "Unplaced" : "Unsent";
  const action = editing ? "Edit" : "Reply";
  currentRevision.threads = [thread];
  const original = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (
      (path === `/api/v1/threads/${id}/comments` && init?.method === "POST") ||
      (path === `/api/v1/comments/${id}` && init?.method === "PATCH")
    )
      return Response.json({ commentId: "22222222-2222-4222-8222-222222222222" }, { status: 201 });
    return original?.(path, init) as Promise<Response>;
  });
  const { history } = mount("?tab=comments&rev=1");
  const before = within(await screen.findByRole("region", { name: beforeGroup }));
  const opener = before.getByRole("button", { name: action });
  const oldCard = opener.closest("[data-thread-card]");
  fireEvent.click(opener);
  const input = await screen.findByRole("textbox", { name: editing ? "Edit comment" : "Reply" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  fireEvent.change(input, { target: { value: "Check the seedlings" } });
  currentRevision.threads = [
    editing
      ? {
          ...thread,
          placement: { status: "unplaced", reason: "not-placed" },
          comments: thread.comments.map((comment) => ({ ...comment, body: "Check the seedlings" })),
        }
      : {
          ...thread,
          comments: [
            ...thread.comments,
            {
              id: "22222222-2222-4222-8222-222222222222",
              author: "user",
              body: "Check the seedlings",
              sent: false,
              sentOn: null,
            },
          ],
        },
  ];
  const refresh = Promise.withResolvers<Response>();
  revisionReply = refresh.promise;
  if (next === "immediate") refresh.resolve(Response.json(currentRevision));
  fireEvent.click(screen.getByRole("button", { name: editing ? "Save changes" : "Save comment" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  if (next !== "immediate") {
    const oldButton = before.getByRole("button", { name: action });
    await waitFor(() => expect(document.activeElement).toBe(oldButton));
  }
  const more = screen.getByRole("button", { name: "More" });
  if (next === "focus elsewhere") act(() => more.focus());
  if (next === "navigate") {
    // Programmatic navigation does not itself move focus. Return to the same
    // thread so a stale return intent would steal focus on its replacement.
    await act(async () => history.push(`/r/${id}?tab=writeup&rev=1`));
    await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
    await act(async () => history.push(`/r/${id}?tab=comments&rev=1`));
    await screen.findByRole("region", { name: beforeGroup });
  }
  await act(async () => refresh.resolve(Response.json(currentRevision)));
  const after = within(await screen.findByRole("region", { name: afterGroup }));
  const currentButton = after.getByRole("button", { name: action });
  expect(currentButton.closest("[data-thread-card]")).not.toBe(oldCard);
  expect(oldCard?.isConnected).toBe(false);
  if (next === "regroup" || next === "immediate")
    await waitFor(() => expect(document.activeElement).toBe(currentButton));
  else if (next === "focus elsewhere") expect(document.activeElement).toBe(more);
  else expect(document.activeElement).not.toBe(currentButton);
});
test.each([
  ...["Cancel", "Save"].flatMap((close) => ["pointer", "keyboard", "timeout"].map((next) => ({ close, next }))),
  ...["Cancel", "Escape", "Close"].map((close) => ({ close, next: "refresh" })),
])("fix3 phone Reply $close cannot reclaim focus on a later refresh after $next", async ({ close, next }) => {
  width = 390;
  const thread = placedWriteupThread();
  currentRevision.threads = [thread];
  const original = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (path === `/api/v1/threads/${id}/comments` && init?.method === "POST")
      return Response.json({ commentId: "22222222-2222-4222-8222-222222222222" }, { status: 201 });
    return original?.(path, init) as Promise<Response>;
  });
  mount("?tab=comments&rev=1");
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  const input = await screen.findByRole("textbox", { name: "Reply" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  if (close === "Save") {
    fireEvent.change(input, { target: { value: "Check the seedlings" } });
    currentRevision.threads = [
      {
        ...thread,
        comments: [
          ...thread.comments,
          {
            id: "22222222-2222-4222-8222-222222222222",
            author: "user",
            body: "Check the seedlings",
            sent: false,
            sentOn: null,
          },
        ],
      },
    ];
  }
  if (next === "timeout") vi.useFakeTimers();
  if (close === "Escape") fireEvent.keyDown(input, { key: "Escape" });
  else fireEvent.click(screen.getByRole("button", { name: close === "Save" ? "Save comment" : close }));
  if (next === "timeout") await act(async () => vi.advanceTimersByTimeAsync(20));
  else await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reply" })));
  expect(screen.queryByRole("dialog")).toBeNull();
  const returned = screen.getByRole("button", { name: "Reply" });
  expect(document.activeElement).toBe(returned);
  const content = screen.getByText("A synthetic question");
  if (next === "pointer") {
    fireEvent.pointerDown(content);
    // happy-dom does not perform the browser's blur on non-focusable content.
    act(() => returned.blur());
    fireEvent.click(content);
  } else if (next === "keyboard") {
    fireEvent.keyDown(document.body, { key: "Escape" });
    act(() => returned.blur());
  } else if (next === "timeout") {
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    act(() => returned.blur());
  }
  if (next !== "refresh") expect(document.activeElement).toBe(document.body);
  await act(async () => {
    client.setQueryData(["revision", id, 1], {
      ...currentRevision,
      threads: [
        {
          ...thread,
          state: "answered",
          comments: [
            ...(currentRevision.threads[0]?.comments ?? []).map((comment) => ({ ...comment, sent: true, sentOn: 1 })),
            {
              id: "33333333-3333-4333-8333-333333333333",
              author: "agent",
              body: "The seedlings are checked",
              sent: false,
              sentOn: null,
              outcome: "explained",
            },
          ],
        },
      ],
    });
    if (next === "timeout") await vi.advanceTimersByTimeAsync(20);
  });
  if (next === "timeout") expect(screen.getByRole("region", { name: "Answered" })).toBeTruthy();
  else await screen.findByRole("region", { name: "Answered" });
  expect(returned.isConnected).toBe(false);
  expect(document.activeElement).toBe(document.body);
});
test.each([1280, 768, 390])("Comment on review opens and saves Whole review at %s px", async (pixels) => {
  width = pixels;
  mount();
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  if (pixels === 390) {
    fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Comment on review" }));
    await screen.findByRole("dialog", { name: "New comment" });
  } else fireEvent.click(screen.getByRole("button", { name: "Comment on review" }));
  expect(await screen.findByText("Whole review")).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "Comment" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  fireEvent.change(input, { target: { value: "Review the whole garden" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/reviews/${id}/threads`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ revision: 1, target: { kind: "review" }, body: "Review the whole garden" }),
      }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull());
});
test("whole review threads appear in Comments without a Show in place link", async () => {
  currentRevision.threads = [
    {
      ...placedWriteupThread(),
      target: { kind: "review" },
      placement: { status: "placed", location: { kind: "review" } },
    },
  ];
  mount("?tab=comments");
  expect(await screen.findByText("Whole review")).toBeTruthy();
  expect(screen.getByText("A synthetic question")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Show in place" })).toBeNull();
});
test.each([1280, 390])("Show in place routes to and scrolls a writeup thread at %s px", async (pixels) => {
  width = pixels;
  currentRevision.threads = [placedWriteupThread()];
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history } = mount("?tab=comments&rev=1");
  fireEvent.click(await screen.findByRole("link", { name: "Show in place" }));
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  expect(searchParams(history).get("tab")).toBe("writeup");
  expect(history.location.hash).toBe(`#thread-${id}`);
  await waitFor(() => expect(scroll.mock.instances).toContain(document.getElementById(`thread-${id}`)));
  expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
});
test.each([1280, 390])("Show in place reaches a line thread, using the phone Diff tab at %s px", async (pixels) => {
  width = pixels;
  const target = {
    kind: "lines" as const,
    path: "seed.txt",
    side: "new" as const,
    start: 5,
    end: 5,
    lines: ["seed"],
    before: [],
    after: [],
  };
  currentRevision.files = currentRevision.files.map((file) => ({ ...file, hasNew: true }));
  currentRevision.threads = [{ ...placedWriteupThread(), target, placement: { status: "placed", location: target } }];
  const scroll = vi.spyOn(diffPresentation, "holdDiffTarget");
  const { history } = mount("?tab=comments&rev=1");
  fireEvent.click(await screen.findByRole("link", { name: "Show in place" }));
  await act(async () => loaded.resolve());
  await screen.findByTestId("diff-pane");
  expect(searchParams(history).get("tab")).toBe(pixels === 390 ? "diff" : "comments");
  await waitFor(() =>
    expect(scroll.mock.calls.map(([node]) => node)).toContain(document.getElementById(`diff-thread-${id}`)),
  );
});
test("desktop block composer is inline after the block's threads, with one quote", async () => {
  currentRevision.threads = [placedWriteupThread()];
  const { container } = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Comment on block" }));
  const input = screen.getByRole("textbox", { name: "Comment" });
  expect(document.activeElement).toBe(input);
  const block = container.querySelector("[data-commenting]");
  const thread = document.getElementById(`thread-${id}`);
  expect(block?.contains(input)).toBe(true);
  expect((thread?.compareDocumentPosition(input) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(input.closest("form")?.querySelectorAll("mark")).toHaveLength(1);
  expect(input.closest("form")?.querySelector("blockquote")).toBeNull();
});
test("task 1.13 at 390 × 844 portals the composer outside reading; Cancel leaves Send before the bottom tabs", async () => {
  width = 390;
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Comment on block" }));
  const reading = screen.getByTestId("reading-pane");
  const sheet = await screen.findByRole("dialog", { name: "New comment" });
  const input = within(sheet).getByRole("textbox", { name: "Comment" });
  expect(reading.contains(sheet)).toBe(false);
  expect(document.activeElement).toBe(input);
  expect(reading.querySelector("[data-commenting]")).toBeTruthy();
  expect(reading.querySelector("textarea")).toBeNull();
  fireEvent.change(input, { target: { value: "Keep the phone draft" } });
  fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const send = screen.getByRole("button", { name: /^Send/ });
  const tabs = screen.getByRole("navigation", { name: "Review tabs" });
  expect(reading.contains(send)).toBe(false);
  expect(reading.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(send.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(within(tabs).getByRole("link", { name: /Comments/ }));
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  expect(drafts.getByText("Keep the phone draft")).toBeTruthy();
});

test.each(["Comment on review", "Comment on block"])("fix1 %s scrolls its own composer into view", async (action) => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mount();
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  fireEvent.click(screen.getByRole("button", { name: action }));
  const editor = await screen.findByRole("textbox", { name: "Comment" });
  const call = scroll.mock.instances.findIndex((node) => {
    const element = node as HTMLElement;
    return element.classList.contains("em-composer") && element.contains(editor);
  });
  expect(call).toBeGreaterThanOrEqual(0);
  expect(scroll.mock.calls[call]).toEqual([{ block: "nearest" }]);
  if (action === "Comment on review") {
    const slot = screen.getByRole("region", { name: "Resumed comment" });
    expect(slot.classList.contains("sticky")).toBe(true);
    expect(slot.classList.contains("bottom-0")).toBe(true);
  }
});
test("fix1 blank Comment on review cancellation leaves no draft or editor after a tab switch", async () => {
  mount();
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  fireEvent.click(screen.getByRole("button", { name: "Comment on review" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(localStorage.getItem(draftKey(id, { kind: "review" }))).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: /^Comments/ }));
  await screen.findByText("No comments yet.");
  fireEvent.click(screen.getByRole("tab", { name: "Writeup" }));
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
});
test("fix1 an unplaced diff revision link preserves Instructions and creates a router intent", async () => {
  currentRevision.threads = [
    {
      ...placedWriteupThread(),
      target: { kind: "file", path: "removed.txt" },
      placement: { status: "unplaced", reason: "file-gone" },
    },
  ];
  currentReview.newestRevision = 2;
  currentReview.revisions.push({ seq: 2, createdAt: "2026-01-02T00:00:00.000Z" });
  const { history } = mount("?rev=2&tab=writeup");
  await act(async () => loaded.resolve());
  const diff = within(await screen.findByTestId("diff-pane"));
  const link = await diff.findByRole("link", { name: "revision 1" });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), {
    target: { value: "Keep these instructions" },
  });
  const click = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
  fireEvent(link, click);
  expect(click.defaultPrevented).toBe(true);
  await waitFor(() => expect(searchParams(history).get("rev")).toBe("1"));
  expect(searchParams(history).get("tab")).toBe("comments");
  expect(searchParams(history).get("thread")).toBe(id);
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe(
    "Keep these instructions",
  );
  const editor = await screen.findByRole("textbox", { name: "Reply" });
  expect(document.activeElement).toBe(editor);
});
test("fix1 Resume expands a resolved card and focuses its unsent edit", async () => {
  const thread = placedWriteupThread();
  currentRevision.threads = [
    {
      ...thread,
      state: "resolved",
      comments: thread.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })),
    },
  ];
  localStorage.setItem(`emend.draft.${id}.edit.${id}`, "Resume this edit");
  mount("?tab=comments");
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  const editor = await screen.findByRole("textbox", { name: "Edit comment" });
  expect((editor as HTMLTextAreaElement).value).toBe("Resume this edit");
  expect(document.activeElement).toBe(editor);
});
test("fix1 closing a phone selection sheet restores focus in the reading pane", async () => {
  width = 390;
  mount();
  const button = await screen.findByRole("button", { name: "Comment on block" });
  act(() => button.focus());
  fireEvent.click(button);
  const sheet = await screen.findByRole("dialog", { name: "New comment" });
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.getByTestId("reading-pane").contains(document.activeElement)).toBe(true));
});

test.each(["Cancel", "Save comment"])("fix1 Resume then %s closes replies in both real panes", async (action) => {
  const target = { kind: "file" as const, path: "seed.txt" };
  currentRevision.threads = [{ ...placedWriteupThread(), target, placement: { status: "placed", location: target } }];
  const request = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation((path, init) => {
    if (path === `/api/v1/threads/${id}/comments`)
      return Promise.resolve(Response.json({ commentId: id }, { status: 201 }));
    if (!request) throw new Error("Missing synthetic request handler");
    return request(path, init);
  });
  mount();
  await act(async () => loaded.resolve());
  const diff = within(await screen.findByTestId("diff-pane"));
  fireEvent.click(await diff.findByRole("button", { name: "Reply" }));
  fireEvent.change(diff.getByRole("textbox", { name: "Reply" }), { target: { value: "A reply in two panes" } });
  fireEvent.click(screen.getByRole("tab", { name: /^Comments/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  const comments = within(screen.getByTestId("reading-pane"));
  expect(document.activeElement).toBe(comments.getByRole("textbox", { name: "Reply" }));
  fireEvent.click(comments.getByRole("button", { name: action }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull());
  expect(diff.getByRole("button", { name: "Reply" }).hasAttribute("data-composer-placeholder")).toBe(false);
  expect(comments.getByRole("button", { name: "Reply" }).hasAttribute("data-composer-placeholder")).toBe(false);
  expect(localStorage.getItem(draftKey(id, target, id))).toBe(action === "Cancel" ? "A reply in two panes" : null);
});

test("fix1 a removed phone selection prompt returns focus to the reading pane", async () => {
  width = 390;
  mount();
  const text = await screen.findByText("Keep growing");
  const selection = window.getSelection();
  if (!selection || !text.firstChild) throw new Error("Missing synthetic selection");
  const range = document.createRange();
  range.selectNodeContents(text.firstChild);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(text);
  selection.removeAllRanges();
  const prompt = screen.getByRole("button", { name: "Comment on selection" });
  act(() => prompt.focus());
  fireEvent.click(prompt);
  const sheet = await screen.findByRole("dialog", { name: "New comment" });
  expect(prompt.isConnected).toBe(false);
  fireEvent.keyDown(within(sheet).getByRole("textbox", { name: "Comment" }), { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("reading-pane")));
});

test("R8 Files in diff expands a collapsed topic before scrolling, including a repeated link intent", async () => {
  const scroll = vi.spyOn(diffPresentation, "holdDiffTarget");
  mount();
  await act(async () => loaded.resolve());
  const diff = within(await screen.findByTestId("diff-pane"));
  for (let attempt = 0; attempt < 2; attempt++) {
    fireEvent.click(await diff.findByRole("button", { name: "Collapse topic" }));
    expect(diff.queryByRole("region", { name: "File seed.txt" })).toBeNull();
    scroll.mockClear();
    fireEvent.click(screen.getByRole("link", { name: "Files in diff: Plant a seed" }));
    await waitFor(() =>
      expect(diff.getByRole("button", { name: "Collapse topic" }).getAttribute("aria-expanded")).toBe("true"),
    );
    expect(diff.getByRole("region", { name: "File seed.txt" })).toBeTruthy();
    await waitFor(() =>
      expect(scroll.mock.calls.map(([node]) => node)).toContain(document.getElementById("diff-topic-seed")),
    );
  }
});

test.each(["file", "lines"] as const)(
  "R8 a Show in place %s thread link expands both containers and scrolls after expansion",
  async (kind) => {
    const target =
      kind === "file"
        ? { kind, path: "seed.txt" }
        : { kind, path: "seed.txt", side: "new" as const, start: 1, end: 1, lines: ["seed"], before: [], after: [] };
    currentRevision.files = currentRevision.files.map((file) => ({ ...file, hasNew: true }));
    currentRevision.threads = [{ ...placedWriteupThread(), target, placement: { status: "placed", location: target } }];
    const scrolled: { id: string; hidden: boolean; expanded: string | null | undefined }[] = [];
    vi.spyOn(diffPresentation, "holdDiffTarget").mockImplementation((element) => {
      scrolled.push({
        id: element.id,
        hidden: !!element.closest("[hidden]"),
        expanded: element
          .closest("[data-topic]")
          ?.querySelector('[aria-label="Collapse file"]')
          ?.getAttribute("aria-expanded"),
      });
      return () => {};
    });
    mount("?tab=comments&rev=1");
    await act(async () => loaded.resolve());
    const diff = within(await screen.findByTestId("diff-pane"));
    fireEvent.click(await diff.findByRole("button", { name: "Collapse file" }));
    fireEvent.click(diff.getByRole("button", { name: "Collapse topic" }));
    fireEvent.click(within(screen.getByTestId("reading-pane")).getByRole("link", { name: "Show in place" }));
    await waitFor(() => expect(scrolled).toContainEqual({ id: `diff-thread-${id}`, hidden: false, expanded: "true" }));
    expect(diff.getByRole("button", { name: "Collapse topic" }).getAttribute("aria-expanded")).toBe("true");
    // Refreshing unrelated data must not replay the completed intent.
    fireEvent.click(diff.getByRole("button", { name: "Collapse file" }));
    await act(async () => client.setQueryData(["revision", id, 1], { ...currentRevision }));
    expect(diff.getByRole("button", { name: "Expand file" })).toBeTruthy();
  },
);

test("R8 a file header URL expands its topic and file through the same route intent", async () => {
  const scroll = vi.spyOn(diffPresentation, "holdDiffTarget");
  const { history } = mount();
  await act(async () => loaded.resolve());
  const diff = within(await screen.findByTestId("diff-pane"));
  fireEvent.click(await diff.findByRole("button", { name: "Collapse file" }));
  fireEvent.click(diff.getByRole("button", { name: "Collapse topic" }));
  await act(async () => history.push(`/r/${id}?tab=writeup&rev=1#diff-file-${id}`));
  await waitFor(() =>
    expect(scroll.mock.calls.map(([node]) => node)).toContain(document.getElementById(`diff-file-${id}`)),
  );
  expect(diff.getByRole("button", { name: "Collapse file" }).getAttribute("aria-expanded")).toBe("true");
  expect(diff.getByRole("region", { name: "File seed.txt" })).toBeTruthy();
});

test.each(["file", "lines"] as const)("R8 Resume of a %s draft expands a collapsed topic and file", async (kind) => {
  const target =
    kind === "file"
      ? { kind, path: "seed.txt" }
      : { kind, path: "seed.txt", side: "new" as const, start: 1, end: 1, lines: ["seed"], before: [], after: [] };
  currentRevision.files = currentRevision.files.map((file) => ({ ...file, hasNew: true }));
  localStorage.setItem(draftKey(id, target), "Resume the seed review");
  mount("?tab=comments&rev=1");
  await act(async () => loaded.resolve());
  const diff = within(await screen.findByTestId("diff-pane"));
  fireEvent.click(await diff.findByRole("button", { name: "Collapse file" }));
  fireEvent.click(diff.getByRole("button", { name: "Collapse topic" }));
  fireEvent.click(within(screen.getByTestId("reading-pane")).getByRole("button", { name: "Resume" }));
  const editor = await diff.findByRole("textbox", { name: "Comment" });
  expect((editor as HTMLTextAreaElement).value).toBe("Resume the seed review");
  expect(editor.closest("[hidden]")).toBeNull();
  expect(diff.getByRole("button", { name: "Collapse file" }).getAttribute("aria-expanded")).toBe("true");
});

test.each([1280, 768, 390])(
  "R8 Writeup links follow pane visibility at %s px and use reading navigation",
  async (pixels) => {
    width = pixels;
    const { history } = mount(pixels < 1280 ? "?tab=diff&rev=1" : "?tab=writeup&rev=1");
    await act(async () => loaded.resolve());
    const diff = within(await screen.findByTestId("diff-pane"));
    await diff.findByRole("heading", { name: "Plant a seed" });
    if (pixels >= 1280) {
      expect(diff.queryByRole("link", { name: "Writeup" })).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: /^Comments/ }));
    }
    const link = await diff.findByRole("link", { name: "Writeup" });
    expect(new URL((link as HTMLAnchorElement).href).searchParams.get("rev")).toBe("1");
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    fireEvent.click(link);
    await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
    expect(searchParams(history).get("tab")).toBe("writeup");
    await waitFor(() => expect(scroll.mock.instances).toContain(document.getElementById("topic-seed")));
  },
);

test("R8 one writeup observer follows the top topic without scrolling the diff", async () => {
  currentRevision.topics.push({ slug: "water", title: "Water the garden", summary: "", importance: 2 });
  currentRevision.writeup.sections.push({ key: "t-water-body", topic: "water", label: "Water the garden", blocks: [] });
  const observers: {
    callback: () => void;
    options?: IntersectionObserverInit;
    elements: Element[];
    disconnected: boolean;
  }[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      entry: (typeof observers)[number];
      constructor(callback: () => void, options?: IntersectionObserverInit) {
        this.entry = { callback, options, elements: [], disconnected: false };
        observers.push(this.entry);
      }
      observe(element: Element) {
        this.entry.elements.push(element);
      }
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
  mount();
  await act(async () => loaded.resolve());
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  const reading = screen.getByTestId("reading-pane");
  const current = observers.filter((observer) => observer.options?.root === reading && !observer.disconnected);
  expect(current).toHaveLength(1);
  const observer = current[0];
  expect(observer?.elements.map((section) => section.id)).toEqual(["topic-seed", "topic-water"]);
  vi.spyOn(reading, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, 500));
  const seed = document.getElementById("topic-seed") as HTMLElement;
  const water = document.getElementById("topic-water") as HTMLElement;
  vi.spyOn(seed, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 80, 500, 500));
  const waterBounds = vi.spyOn(water, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 580, 500, 600));
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  act(() => observer?.callback());
  const seedHeader = document.querySelector("#diff-topic-seed [data-topic-header]");
  const waterHeader = document.querySelector("#diff-topic-water [data-topic-header]");
  expect(seedHeader?.getAttribute("aria-current")).toBe("true");
  expect(seedHeader?.querySelector(".bg-topic-solid")).toBeTruthy();
  expect(waterHeader?.hasAttribute("aria-current")).toBe(false);
  waterBounds.mockReturnValue(new DOMRect(0, 90, 500, 600));
  act(() => observer?.callback());
  expect(seedHeader?.hasAttribute("aria-current")).toBe(false);
  expect(waterHeader?.getAttribute("aria-current")).toBe("true");
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: /^Comments/ }));
  await screen.findByText("No comments yet.");
  expect(observer?.disconnected).toBe(true);
  expect(waterHeader?.hasAttribute("aria-current")).toBe(false);
});

test.each(["Show in place", "hash", "claim", "edit claim", "phone edit claim", "retry"])(
  "R8 fix1 %s waits for a lazy line-100 thread's final annotation slot",
  async (navigation) => {
    const phoneEdit = navigation === "phone edit claim";
    if (phoneEdit) width = 390;
    const old = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");
    const next = old.replace("line 100", "changed line 100");
    const target = {
      kind: "lines" as const,
      path: "seed.txt",
      side: "new" as const,
      start: 100,
      end: 100,
      lines: ["changed line 100"],
      before: [],
      after: [],
    };
    currentRevision.files = currentRevision.files.map((file) => ({ ...file, flag: null, hasOld: true, hasNew: true }));
    currentRevision.threads = [{ ...placedWriteupThread(), target, placement: { status: "placed", location: target } }];
    if (navigation === "edit claim" || phoneEdit)
      currentRevision.threads = currentRevision.threads.map((thread) => ({
        ...thread,
        target: { ...target, path: "previous/seed.txt" },
        comments: thread.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })),
      }));
    const sides = Promise.withResolvers<void>();
    const parsed = Promise.withResolvers<ParsedDiff>();
    const parser = vi.fn<DiffParser>(() => parsed.promise);
    loading.parser = parser;
    const fetchPrevious = vi.mocked(fetch).getMockImplementation();
    let failed = navigation === "retry";
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (typeof path === "string" && path.startsWith(`/api/v1/files/${id}/`)) {
        await sides.promise;
        if (failed && path.endsWith("/old"))
          return Response.json({ error: { code: "not_found", message: "Synthetic failure" } }, { status: 404 });
        return new Response(path.endsWith("/old") ? old : next);
      }
      if (!fetchPrevious) throw new Error("Missing request handler");
      return fetchPrevious(path, init);
    });
    const scroll = vi.spyOn(diffPresentation, "holdDiffTarget");
    const focused: { input: HTMLElement; pending: boolean }[] = [];
    const originalFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
      if (this instanceof HTMLTextAreaElement)
        focused.push({ input: this, pending: !!this.closest("[hidden], [data-slot-pending]") });
      originalFocus.call(this, options);
    });
    const { history } = mount(phoneEdit ? "?tab=diff&rev=1" : "?tab=comments&rev=1");
    await act(async () => loaded.resolve());
    const diff = within(await screen.findByTestId("diff-pane"));
    expect(await diff.findByText("Loads near viewport")).toBeTruthy();
    fireEvent.click(diff.getByRole("button", { name: "Collapse file" }));
    fireEvent.click(diff.getByRole("button", { name: "Collapse topic" }));
    if (navigation === "Show in place")
      fireEvent.click(within(screen.getByTestId("reading-pane")).getByRole("link", { name: "Show in place" }));
    else if (navigation === "claim") act(() => claimDraft(draftKey(id, target, id), "diff"));
    else if (navigation === "edit claim" || phoneEdit)
      act(() => {
        saveDraft(editDraftKey(id, id), "Edit the relocated comment");
        claimDraft(editDraftKey(id, id), "diff");
      });
    else await act(async () => history.push(`/r/${id}?tab=comments&rev=1#diff-thread-${id}`));
    await diff.findByText("Loading diff…");
    const fallback = document.getElementById(`diff-thread-${id}`);
    expect(fallback?.closest("[hidden]")).toBeNull();
    expect(fallback?.closest("[data-slot-pending]")).toBeTruthy();
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => sides.resolve());
    if (failed) {
      await diff.findByText("Could not load this diff.");
      expect(fallback?.closest("[data-slot-pending]")).toBeTruthy();
      expect(scroll).not.toHaveBeenCalled();
      failed = false;
      fireEvent.click(diff.getByRole("button", { name: "Retry" }));
    }
    await waitFor(() => expect(parser).toHaveBeenCalledOnce());
    expect(scroll).not.toHaveBeenCalled();
    await act(async () =>
      parsed.resolve(
        parsePair({ oldFile: { name: "seed.txt", contents: old }, newFile: { name: "seed.txt", contents: next } }),
      ),
    );
    await waitFor(() => expect(scroll).toHaveBeenCalledOnce());
    const final = document.getElementById(`diff-thread-${id}`);
    if (phoneEdit) {
      const input = screen.getByRole("textbox", { name: "Edit comment" });
      expect(document.activeElement).toBe(input);
      expect(focused.every(({ pending }) => !pending)).toBe(true);
      expect(scroll.mock.calls.at(-1)?.[0]).toBe(final);
    } else if (navigation === "claim" || navigation === "edit claim") {
      const input = within(final as HTMLElement).getByRole("textbox", {
        name: navigation === "claim" ? "Reply" : "Edit comment",
      });
      expect(scroll.mock.calls.at(-1)?.[0]).toBe(input.closest(".em-composer"));
      expect(document.activeElement).toBe(input);
      expect(focused).toEqual([{ input, pending: false }]);
    } else expect(scroll.mock.calls.at(-1)?.[0]).toBe(final);
    expect(final?.closest("diffs-container")).toBeTruthy();
    expect(final?.isConnected).toBe(true);
    expect(fallback?.isConnected).toBe(false);
    expect(final?.closest("[data-slot-pending]")).toBeNull();
    await act(async () => client.setQueryData(["revision", id, 1], { ...currentRevision }));
    expect(document.getElementById(`diff-thread-${id}`)).toBe(final);
    expect(scroll).toHaveBeenCalledOnce();
  },
);

test("R8 fix1 Resume reveals an already-mounted file composer before consuming its focus request", async () => {
  mount();
  await act(async () => loaded.resolve());
  const diff = within(await screen.findByTestId("diff-pane"));
  fireEvent.click(await diff.findByRole("button", { name: "Comment on file" }));
  const input = diff.getByRole("textbox", { name: "Comment" });
  fireEvent.change(input, { target: { value: "Retain the existing editor" } });
  fireEvent.click(diff.getByRole("button", { name: "Collapse topic" }));
  expect(input.closest("[hidden]")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: /^Comments/ }));
  const resume = await within(screen.getByTestId("reading-pane")).findByRole("button", { name: "Resume" });
  act(() => resume.focus());
  const focus = input.focus.bind(input);
  const hiddenAtFocus: boolean[] = [];
  vi.spyOn(input, "focus").mockImplementation((options) => {
    hiddenAtFocus.push(!!input.closest("[hidden]"));
    focus(options);
  });
  const scroll = vi.spyOn(diffPresentation, "holdDiffTarget");
  fireEvent.click(resume);
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(hiddenAtFocus).toEqual([false]);
  expect((input as HTMLTextAreaElement).value).toBe("Retain the existing editor");
  expect(input.closest("[hidden]")).toBeNull();
  expect(diff.getByRole("button", { name: "Collapse topic" }).getAttribute("aria-expanded")).toBe("true");
  expect(scroll).toHaveBeenCalledExactlyOnceWith(input.closest(".em-composer"));
});

test.each(["binary", "oversized", "lockfile", "large", "identical", "missing-line"])(
  "R8 fix1 %s line fallback completes navigation without waiting for a nonexistent slot",
  async (reason) => {
    const target = {
      kind: "lines" as const,
      path: reason === "lockfile" ? "pnpm-lock.yaml" : "seed.txt",
      side: "new" as const,
      start: 100,
      end: 100,
      lines: ["seed"],
      before: [],
      after: [],
    };
    currentRevision.files = currentRevision.files.map((file) => ({
      ...file,
      path: target.path,
      flag: reason === "binary" || reason === "oversized" ? reason : null,
      hasOld: true,
      hasNew: true,
    }));
    currentRevision.threads = [{ ...placedWriteupThread(), target, placement: { status: "placed", location: target } }];
    loading.parser = parsePair;
    const fetchPrevious = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (typeof path === "string" && path.startsWith(`/api/v1/files/${id}/`))
        return new Response(
          reason === "large"
            ? "seed\n".repeat(10001)
            : reason === "identical" || path.endsWith("/old")
              ? "same\n"
              : "changed\n",
        );
      if (!fetchPrevious) throw new Error("Missing request handler");
      return fetchPrevious(path, init);
    });
    const scroll = vi.spyOn(diffPresentation, "holdDiffTarget");
    mount("?tab=comments&rev=1");
    await act(async () => loaded.resolve());
    fireEvent.click(
      await within(await screen.findByTestId("reading-pane")).findByRole("link", { name: "Show in place" }),
    );
    await waitFor(() => expect(scroll).toHaveBeenCalledOnce());
    const card = document.getElementById(`diff-thread-${id}`);
    expect(card?.isConnected).toBe(true);
    expect(card?.closest("[data-slot-pending], diffs-container")).toBeNull();
    expect(scroll.mock.calls[0]?.[0]).toBe(card);
  },
);

test.each(["Comment on review", "Comment on file", "input", "textarea"])(
  "R8 fix2 a deferred Reply yields to newer focus in %s without losing its draft or open state",
  async (destination) => {
    const target = {
      kind: "lines" as const,
      path: "seed.txt",
      side: "new" as const,
      start: 2,
      end: 2,
      lines: ["new seed"],
      before: [],
      after: [],
    };
    currentRevision.files = currentRevision.files.map((file) => ({ ...file, flag: null, hasOld: true, hasNew: true }));
    currentRevision.threads = [{ ...placedWriteupThread(), target, placement: { status: "placed", location: target } }];
    const parsed = Promise.withResolvers<ParsedDiff>();
    const parser = vi.fn<DiffParser>(() => parsed.promise);
    loading.parser = parser;
    const fetchPrevious = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (typeof path === "string" && path.startsWith(`/api/v1/files/${id}/`))
        return new Response(path.endsWith("/old") ? "one\nold seed\n" : "one\nnew seed\n");
      if (!fetchPrevious) throw new Error("Missing request handler");
      return fetchPrevious(path, init);
    });
    mount();
    await act(async () => loaded.resolve());
    const diff = within(await screen.findByTestId("diff-pane"));
    const scroll = vi.spyOn(diffPresentation, "holdDiffTarget");
    const replyButton = await diff.findByRole("button", { name: "Reply" });
    const fallback = document.getElementById(`diff-thread-${id}`) as HTMLElement;
    fireEvent.click(replyButton);
    const reply = within(fallback).getByRole("textbox", { name: "Reply" });
    // Include an empty but explicitly open reply, which cannot be restored from text alone.
    const text = destination === "textarea" ? "" : "Keep this pending reply";
    fireEvent.change(reply, { target: { value: text } });
    await waitFor(() => expect(parser).toHaveBeenCalledOnce());
    expect(fallback.closest("[data-slot-pending]")).toBeTruthy();
    expect(scroll).not.toHaveBeenCalled();
    let newer: HTMLElement;
    if (destination === "Comment on review") {
      fireEvent.click(screen.getByRole("button", { name: destination }));
      newer = await within(screen.getByTestId("reading-pane")).findByRole("textbox", { name: "Comment" });
    } else if (destination === "Comment on file") {
      fireEvent.click(diff.getByRole("button", { name: destination }));
      newer = await diff.findByRole("textbox", { name: "Comment" });
    } else {
      render(destination === "input" ? <input aria-label="Newer field" /> : <textarea aria-label="Newer field" />);
      newer = screen.getByRole("textbox", { name: "Newer field" });
    }
    act(() => newer.focus());
    expect(document.activeElement).toBe(newer);
    scroll.mockClear();
    await act(async () =>
      parsed.resolve(
        parsePair({
          oldFile: { name: "seed.txt", contents: "one\nold seed\n" },
          newFile: { name: "seed.txt", contents: "one\nnew seed\n" },
        }),
      ),
    );
    await waitFor(() => expect(document.getElementById(`diff-thread-${id}`)?.closest("diffs-container")).toBeTruthy());
    const final = document.getElementById(`diff-thread-${id}`) as HTMLElement;
    expect(fallback.isConnected).toBe(false);
    expect((within(final).getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement).value).toBe(text);
    expect(document.activeElement).toBe(newer);
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => client.setQueryData(["revision", id, 1], { ...currentRevision }));
    expect(document.activeElement).toBe(newer);
    expect(scroll).not.toHaveBeenCalled();
  },
);

test("R8 fix2 a rendered diff with no annotation slot completes its intent at the fallback", async () => {
  const target = {
    kind: "lines" as const,
    path: "seed.txt",
    side: "new" as const,
    start: 2,
    end: 2,
    lines: ["new seed"],
    before: [],
    after: [],
  };
  currentRevision.files = currentRevision.files.map((file) => ({ ...file, flag: null, hasOld: true, hasNew: true }));
  currentRevision.threads = [{ ...placedWriteupThread(), target, placement: { status: "placed", location: target } }];
  loading.parser = parsePair;
  loading.rendering = "delayed";
  const fetchPrevious = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (typeof path === "string" && path.startsWith(`/api/v1/files/${id}/`))
      return new Response(path.endsWith("/old") ? "one\nold seed\n" : "one\nnew seed\n");
    if (!fetchPrevious) throw new Error("Missing request handler");
    return fetchPrevious(path, init);
  });
  const scroll = vi.spyOn(diffPresentation, "holdDiffTarget");
  mount("?tab=comments&rev=1");
  await act(async () => loaded.resolve());
  fireEvent.click(
    await within(await screen.findByTestId("reading-pane")).findByRole("link", { name: "Show in place" }),
  );
  // Parsed metadata has mounted DiffView, but Pierre has not rendered yet.
  await waitFor(() => expect(document.querySelector(".em-diff-code")).toBeTruthy());
  const fallback = document.getElementById(`diff-thread-${id}`) as HTMLElement;
  expect(document.querySelector("diffs-container")).toBeNull();
  expect(fallback.closest("[data-slot-pending]")).toBeTruthy();
  expect(scroll).not.toHaveBeenCalled();
  await act(async () => {
    loading.rendering = "without-slots";
    client.setQueryData(["revision", id, 1], { ...currentRevision });
  });
  await waitFor(() => expect(scroll).toHaveBeenCalledExactlyOnceWith(fallback));
  const shadow = document.querySelector("diffs-container")?.shadowRoot;
  expect(shadow?.querySelector("[data-line]")).toBeTruthy();
  expect(shadow?.querySelector('slot[name^="annotation-"]')).toBeNull();
  expect(fallback.isConnected).toBe(true);
  expect(fallback.closest("[data-slot-pending], diffs-container")).toBeNull();
  await act(async () => client.setQueryData(["revision", id, 1], { ...currentRevision }));
  expect(scroll).toHaveBeenCalledOnce();
});

test.each([false, true])(
  "R8 fix3 returning to a canceled Reply renews focus through its inline move (newer composer=%s)",
  async (newerComposer) => {
    const target = {
      kind: "lines" as const,
      path: "seed.txt",
      side: "new" as const,
      start: 2,
      end: 2,
      lines: ["new seed"],
      before: [],
      after: [],
    };
    currentRevision.files = currentRevision.files.map((file) => ({ ...file, flag: null, hasOld: true, hasNew: true }));
    currentRevision.threads = [{ ...placedWriteupThread(), target, placement: { status: "placed", location: target } }];
    const parsed = Promise.withResolvers<ParsedDiff>();
    const parser = vi.fn<DiffParser>(() => parsed.promise);
    loading.parser = parser;
    const fetchPrevious = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (typeof path === "string" && path.startsWith(`/api/v1/files/${id}/`))
        return new Response(path.endsWith("/old") ? "one\nold seed\n" : "one\nnew seed\n");
      if (!fetchPrevious) throw new Error("Missing request handler");
      return fetchPrevious(path, init);
    });
    mount();
    await act(async () => loaded.resolve());
    const diff = within(await screen.findByTestId("diff-pane"));
    fireEvent.click(await diff.findByRole("button", { name: "Reply" }));
    const fallback = document.getElementById(`diff-thread-${id}`) as HTMLElement;
    const reply = within(fallback).getByRole("textbox", { name: "Reply" });
    await waitFor(() => expect(parser).toHaveBeenCalledOnce());
    expect(fallback.closest("[data-slot-pending]")).toBeTruthy();

    render(<input aria-label="Other field" />);
    const other = screen.getByRole("textbox", { name: "Other field" });
    act(() => other.focus());
    expect(document.activeElement).toBe(other);
    act(() => reply.focus());
    fireEvent.change(reply, { target: { value: "Continue this reply after coming back" } });
    expect(document.activeElement).toBe(reply);

    let newer: HTMLElement | undefined;
    if (newerComposer) {
      fireEvent.click(screen.getByRole("button", { name: "Comment on review" }));
      newer = await within(screen.getByTestId("reading-pane")).findByRole("textbox", { name: "Comment" });
      expect(document.activeElement).toBe(newer);
    }
    const scroll = vi.spyOn(diffPresentation, "holdDiffTarget");
    await act(async () =>
      parsed.resolve(
        parsePair({
          oldFile: { name: "seed.txt", contents: "one\nold seed\n" },
          newFile: { name: "seed.txt", contents: "one\nnew seed\n" },
        }),
      ),
    );
    await waitFor(() => expect(document.getElementById(`diff-thread-${id}`)?.closest("diffs-container")).toBeTruthy());
    const final = document.getElementById(`diff-thread-${id}`) as HTMLElement;
    const moved = within(final).getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;
    expect(fallback.isConnected).toBe(false);
    expect(moved).not.toBe(reply);
    expect(moved.value).toBe("Continue this reply after coming back");
    expect(document.activeElement).toBe(newer ?? moved);
    if (newerComposer) expect(scroll).not.toHaveBeenCalled();
    else expect(scroll).toHaveBeenCalledExactlyOnceWith(moved.closest(".em-composer"));
  },
);

test.each(["hash", "map", "thread hash", "thread go to", "browser search"])(
  "%s reveals a folded skim topic before scrolling and repeated navigation reveals it again",
  async (navigation) => {
    currentRevision.topics = currentRevision.topics.map((topic) => ({ ...topic, attention: "skim" }));
    currentRevision.threads = [
      placedWriteupThread(),
      { ...placedWriteupThread(), id: "22222222-2222-4222-8222-222222222222", state: "resolved" },
    ];
    const targetId =
      navigation === "map"
        ? "topic-seed"
        : navigation === "thread hash"
          ? `thread-${id}`
          : "block-t-seed-body-12345678";
    let visibleAtScroll = false;
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      if (this.id === targetId) visibleAtScroll = !this.closest("[hidden]");
    });
    const { history } = mount(navigation === "thread go to" ? "?tab=comments&rev=1" : "?tab=writeup&rev=1");
    const navigate = async () => {
      if (navigation === "thread go to") {
        const link = await screen.findAllByRole("link", { name: "Show in place" });
        if (!link[0]) throw new Error("Missing thread link");
        fireEvent.click(link[0]);
      } else if (navigation === "map") {
        fireEvent.click(await screen.findByRole("link", { name: "Plant a seed" }));
      } else if (navigation === "browser search") {
        const block = document.getElementById(targetId);
        if (!block) throw new Error("Missing search target");
        fireEvent(block, new Event("beforematch", { bubbles: true }));
      } else {
        await act(async () => history.push(`/r/${id}?tab=writeup&rev=1#${targetId}`));
      }
    };
    if (navigation !== "thread go to") {
      const unfold = await screen.findByRole("button", { name: "Topic 1: Plant a seed", expanded: false });
      expect(unfold.getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByText("1 comment")).toBeTruthy();
      expect(document.getElementById("block-t-seed-body-12345678")?.closest("[hidden]")?.getAttribute("hidden")).toBe(
        "until-found",
      );
    }
    await navigate();
    const fold = await screen.findByRole("button", { name: "Topic 1: Plant a seed", expanded: true });
    expect(document.getElementById("block-t-seed-body-12345678")?.closest("[hidden]")).toBeNull();
    if (navigation !== "browser search") {
      expect(scroll).toHaveBeenCalled();
      // A thread's go-to link points to its block and may carry the thread hash instead.
      if (navigation !== "thread go to") expect(visibleAtScroll).toBe(true);
    }
    if (navigation === "map" || navigation === "browser search") {
      fireEvent.click(fold);
      await navigate();
      await screen.findByRole("button", { name: "Topic 1: Plant a seed", expanded: true });
      expect(document.getElementById("block-t-seed-body-12345678")?.closest("[hidden]")).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Topic 1: Plant a seed", expanded: true }));
    await act(async () => client.setQueryData(["revision", id, 1], { ...currentRevision }));
    expect(
      screen.getByRole("button", { name: "Topic 1: Plant a seed", expanded: false }).getAttribute("aria-expanded"),
    ).toBe("false");
  },
);

test.each(["hash", "browser search"])("%s opens the glossary before navigating to its block", async (navigation) => {
  const block: RenderedBlock = {
    id: "glossary-12345678",
    section: "glossary",
    kind: "item",
    text: "Seed: a start",
    html: "<ul><li>Seed: a start</li></ul>",
  };
  currentRevision.writeup.sections.unshift({ key: "glossary", label: "Glossary", topic: null, blocks: [block] });
  let openAtScroll = false;
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
    if (this.id === `block-${block.id}`) openAtScroll = this.closest("details")?.open === true;
  });
  const { history } = mount();
  const glossary = (await screen.findByText("Glossary · 1 term")).closest("details");
  expect(glossary?.open).toBe(false);
  if (navigation === "hash") {
    await act(async () => history.push(`/r/${id}?tab=writeup&rev=1#block-${block.id}`));
    await waitFor(() => expect(openAtScroll).toBe(true));
  } else {
    const target = document.getElementById(`block-${block.id}`);
    if (!target) throw new Error("Missing glossary target");
    fireEvent(target, new Event("beforematch", { bubbles: true }));
  }
  expect(glossary?.open).toBe(true);
  expect(glossary && within(glossary).getByRole("button", { name: "Comment on block" })).toBeTruthy();
});

test.each(["skim", "review"] as const)(
  "%s fold choice survives tabs and resets on revision change",
  async (attention) => {
    currentRevision.topics = currentRevision.topics.map((topic) => ({ ...topic, attention }));
    currentReview.revisions.push({ seq: 2, createdAt: "2026-01-02T00:00:00.000Z" });
    const { history } = mount();
    const name = "Topic 1: Plant a seed";
    const defaultOpen = attention !== "skim";
    const initial = await screen.findByRole("button", { name, expanded: defaultOpen });
    const stored = { ...localStorage };
    fireEvent.click(initial);
    expect(initial.getAttribute("aria-expanded")).toBe(String(!defaultOpen));
    fireEvent.click(screen.getByRole("tab", { name: /Comments/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name })).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Writeup" }));
    await screen.findByRole("button", { name, expanded: !defaultOpen });
    expect({ ...localStorage }).toEqual(stored);
    await act(async () => history.push(`/r/${id}?tab=writeup&rev=2`));
    await screen.findByRole("button", { name, expanded: defaultOpen });
    // Returning to the older revision also starts fresh; choices are confined to the current revision.
    await act(async () => history.push(`/r/${id}?tab=writeup&rev=1`));
    await screen.findByRole("button", { name, expanded: defaultOpen });
  },
);

test("glossary fold choice survives a tab switch and resets for a new revision", async () => {
  currentRevision.writeup.sections.unshift({ key: "glossary", label: "Glossary", topic: null, blocks: [] });
  currentReview.revisions.push({ seq: 2, createdAt: "2026-01-02T00:00:00.000Z" });
  const { history } = mount();
  const summary = await screen.findByText("Glossary · 0 terms");
  fireEvent.click(summary);
  await waitFor(() => expect(summary.closest("details")?.open).toBe(true));
  fireEvent.click(screen.getByRole("tab", { name: /Comments/ }));
  await waitFor(() => expect(screen.queryByText("Glossary · 0 terms")).toBeNull());
  fireEvent.click(screen.getByRole("tab", { name: "Writeup" }));
  expect((await screen.findByText("Glossary · 0 terms")).closest("details")?.open).toBe(true);
  await act(async () => history.push(`/r/${id}?tab=writeup&rev=2`));
  await waitFor(() => expect(screen.getByText("Glossary · 0 terms").closest("details")?.open).toBe(false));
});

test("Tabs preserves reading scroll, expanded regions and selection through Writeup to Diff to Writeup", async () => {
  width = 900;
  currentRevision.topics = currentRevision.topics.map((topic) => ({ ...topic, attention: "skim" }));
  mount();
  const expand = await screen.findByRole("button", { name: "Topic 1: Plant a seed", expanded: false });
  fireEvent.click(expand);
  await act(async () => loaded.resolve());
  const reading = screen.getByTestId("reading-pane");
  const text = within(reading).getByText("Keep growing").firstChild;
  if (!text) throw new Error("Missing reading text");
  const selection = document.getSelection();
  const range = document.createRange();
  range.selectNodeContents(text);
  selection?.removeAllRanges();
  selection?.addRange(range);
  reading.scrollTop = 180;
  const diff = screen.getByTestId("diff-pane");
  fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
  await waitFor(() => expect(reading.hidden).toBe(true));
  expect(screen.getByTestId("reading-pane")).toBe(reading);
  expect(diff.hidden).toBe(false);
  const collapse = await within(diff).findByRole("button", { name: "Collapse topic" });
  fireEvent.click(collapse);
  diff.scrollTop = 240;
  fireEvent.click(screen.getByRole("tab", { name: "Writeup" }));
  await waitFor(() => expect(reading.hidden).toBe(false));
  expect(screen.getByTestId("reading-pane")).toBe(reading);
  expect(reading.scrollTop).toBe(180);
  expect(within(reading).getByText("Keep growing").firstChild).toBe(text);
  expect(selection?.anchorNode).toBe(text);
  expect(expand.getAttribute("aria-expanded")).toBe("true");
  expect(diff.hidden).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
  await waitFor(() => expect(diff.hidden).toBe(false));
  expect(screen.getByTestId("diff-pane")).toBe(diff);
  expect(diff.scrollTop).toBe(240);
  expect(within(diff).getByRole("button", { name: "Expand topic" })).toBe(collapse);
  selection?.removeAllRanges();
});

test("Tabs retains the selected doc while Diff is visible and gives each panel a unique id", async () => {
  width = 900;
  const { container } = mount("?tab=docs&doc=seed.md&rev=1");
  const heading = await screen.findByRole("heading", { name: "seed.md" });
  const reading = screen.getByTestId("reading-pane");
  reading.scrollTop = 90;
  fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
  await waitFor(() => expect(reading.hidden).toBe(true));
  expect(reading.contains(heading)).toBe(true);
  const panels = [...container.querySelectorAll('[role="tabpanel"]')];
  expect(panels).toHaveLength(2);
  expect(new Set(panels.map((panel) => panel.id)).size).toBe(2);
  fireEvent.click(screen.getByRole("tab", { name: "Docs 2" }));
  await waitFor(() => expect(reading.hidden).toBe(false));
  expect(screen.getByRole("heading", { name: "seed.md" })).toBe(heading);
  expect(reading.scrollTop).toBe(90);
});

test.each([1280, 900, 390])("reading switches toggle independently on their tabs at %s px", async (pixels) => {
  width = pixels;
  if (pixels === 1280) {
    const bounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("em-panes")) return new DOMRect(0, 0, 1600, 800);
      if (this.querySelector(":scope > [data-reading-scroll]")) return new DOMRect(0, 0, 1200, 800);
      return bounds.call(this);
    });
  }
  if (pixels === 390) {
    layoutStore.update({ contents: true, compact: true });
    currentRevision.threads = [placedWriteupThread()];
  }
  mount();
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  const tabBar = document.querySelector(".em-review-tabs");
  expect(tabBar?.textContent ?? "").not.toContain("Focus");
  if (pixels === 390) {
    expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compact comments" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Writeup outline" })).toBeNull();
    expect(document.getElementById(`thread-${id}`)).toBeTruthy();
    expect(document.querySelector(".em-thread-pill")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Docs" }));
    await screen.findByRole("heading", { name: "Docs" });
    expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compact comments" })).toBeNull();
    return;
  }
  const contents = screen.getByRole("button", { name: "Contents", pressed: false });
  const compact = screen.getByRole("button", { name: "Compact comments", pressed: false });
  const saved = () => JSON.parse(localStorage.getItem(layoutKey) ?? "{}");
  const reading = screen.getByTestId("reading-pane");
  const contentsOffWidth = Number.parseFloat(reading.style.flexBasis);
  fireEvent.click(contents);
  if (pixels === 1280) {
    expect(contentsOffWidth).toBe(504);
    expect(Number.parseFloat(reading.style.flexBasis)).toBe(contentsOffWidth + OUTLINE_WIDTH);
  }
  expect(contents.getAttribute("aria-pressed")).toBe("true");
  expect(compact.getAttribute("aria-pressed")).toBe("false");
  expect(saved()).toMatchObject({ contents: true, compact: false });
  expect(screen.getByRole("navigation", { name: "Writeup outline" })).toBeTruthy();
  fireEvent.click(compact);
  expect(contents.getAttribute("aria-pressed")).toBe("true");
  expect(compact.getAttribute("aria-pressed")).toBe("true");
  expect(saved()).toMatchObject({ contents: true, compact: true });
  fireEvent.click(contents);
  if (pixels === 1280) expect(Number.parseFloat(reading.style.flexBasis)).toBe(contentsOffWidth);
  expect(contents.getAttribute("aria-pressed")).toBe("false");
  expect(compact.getAttribute("aria-pressed")).toBe("true");
  expect(saved()).toMatchObject({ contents: false, compact: true });
  expect(screen.queryByRole("navigation", { name: "Writeup outline" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Docs 2" }));
  await screen.findByRole("heading", { name: "Docs" });
  expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Compact comments" })).toBeNull();
  expect(tabBar?.children).toHaveLength(1);
  fireEvent.click(screen.getByRole("link", { name: "seed.md seed.md" }));
  await screen.findByRole("heading", { name: "seed.md" });
  expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Compact comments", pressed: true }));
  expect(saved()).toMatchObject({ contents: false, compact: false });
  expect(screen.getByRole("button", { name: "Compact comments", pressed: false })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: /^Comments/ }));
  await screen.findByText("No comments yet.");
  expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Compact comments" })).toBeNull();
  if (pixels === 1280) act(() => layoutStore.update({ pane: { desktop: "tabs", tablet: "tabs" } }));
  fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
  await waitFor(() => expect(screen.getByTestId("reading-pane").hidden).toBe(true));
  expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Compact comments" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Writeup" }));
  await screen.findByRole("button", { name: "Contents", pressed: false });
  expect(screen.getByRole("button", { name: "Compact comments", pressed: false })).toBeTruthy();
});

test.each<RevisionView["docs"][number]>([
  { kind: "source", path: "seed.txt", language: "text", lines: [[{ text: "Plant a seed" }]] },
  htmlDoc,
])("reading switches stay hidden for $kind docs", async (doc) => {
  currentRevision.docs.push(doc);
  layoutStore.update({ contents: true, compact: true });
  mount(`?tab=docs&doc=${doc.path}&rev=1`);
  await screen.findByRole("heading", { name: doc.path.split("/").at(-1) });
  expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Compact comments" })).toBeNull();
  expect(document.querySelector(".em-review-tabs")?.children).toHaveLength(1);
  fireEvent.click(screen.getByRole("link", { name: "All docs" }));
  await screen.findByRole("heading", { name: "Docs" });
  expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Compact comments" })).toBeNull();
  expect(document.querySelector(".em-review-tabs")?.children).toHaveLength(1);
  fireEvent.click(screen.getByRole("tab", { name: "Writeup" }));
  await screen.findByRole("button", { name: "Contents", pressed: true });
  expect(screen.getByRole("button", { name: "Compact comments", pressed: true })).toBeTruthy();
});

test.each([
  { contents: true, compact: false },
  { contents: false, compact: true },
  { contents: true, compact: true },
])("reading switches survive remount with contents=$contents compact=$compact", async ({ contents, compact }) => {
  const view = mount();
  await screen.findByRole("button", { name: "Contents", pressed: false });
  if (contents) fireEvent.click(screen.getByRole("button", { name: "Contents" }));
  if (compact) fireEvent.click(screen.getByRole("button", { name: "Compact comments" }));
  view.unmount();
  mount();
  await screen.findByRole("button", { name: "Contents", pressed: contents });
  expect(screen.getByRole("button", { name: "Compact comments", pressed: compact })).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(layoutKey) ?? "{}")).toMatchObject({ contents, compact });
});

test("legacy reading preference starts with both switches pressed", async () => {
  localStorage.setItem(layoutKey, '{"reading":"focus"}');
  currentRevision.threads = [placedWriteupThread()];
  mount();
  await screen.findByRole("button", { name: "Contents", pressed: true });
  expect(screen.getByRole("button", { name: "Compact comments", pressed: true })).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Writeup outline" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "1 comment", expanded: false })).toBeTruthy();
});

test.each(["hash", "Show in place", "initial hash"])(
  "compact %s opens a pill and its folded topic before scrolling the marked card",
  async (navigation) => {
    layoutStore.update({ compact: true });
    currentRevision.topics = currentRevision.topics.map((topic) => ({ ...topic, attention: "skim" }));
    currentRevision.threads = [placedWriteupThread()];
    const scrolled: { id: string; hidden: boolean; jumped: boolean }[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      scrolled.push({ id: this.id, hidden: !!this.closest("[hidden]"), jumped: this.hasAttribute("data-jump") });
    });
    const { history } = mount(
      navigation === "Show in place"
        ? "?tab=comments&rev=1"
        : `?tab=writeup&rev=1${navigation === "initial hash" ? `#thread-${id}` : ""}`,
    );
    if (navigation === "Show in place") {
      fireEvent.click(await screen.findByRole("link", { name: "Show in place" }));
    } else if (navigation === "hash") {
      await screen.findByRole("button", { name: "Topic 1: Plant a seed", expanded: false });
      expect(document.getElementById(`thread-${id}`)).toBeNull();
      await act(async () => history.push(`/r/${id}?tab=writeup&rev=1#thread-${id}`));
    }
    await waitFor(() => expect(scrolled).toContainEqual({ id: `thread-${id}`, hidden: false, jumped: true }));
    expect(screen.getByRole("button", { name: "Topic 1: Plant a seed", expanded: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(document.getElementById(`thread-${id}`)).toBeNull();
    scrolled.length = 0;
    await act(async () => history.push(`/r/${id}?tab=writeup&rev=1`));
    // Returning to the same thread is a fresh navigation and reopens the pill.
    await act(async () => history.push(`/r/${id}?tab=writeup&rev=1#thread-${id}`));
    await waitFor(() => expect(scrolled).toContainEqual({ id: `thread-${id}`, hidden: false, jumped: true }));
  },
);

test("Contents disconnects its observer while Tabs hides the mounted reading pane and resumes it", async () => {
  width = 900;
  layoutStore.update({ contents: true });
  const observers: {
    root?: Element | Document | null;
    disconnect: ReturnType<typeof vi.fn<() => void>>;
    callback: () => void;
  }[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      entry: (typeof observers)[number];
      constructor(callback: () => void, options?: IntersectionObserverInit) {
        this.entry = { root: options?.root, disconnect: vi.fn(), callback };
        observers.push(this.entry);
      }
      observe() {}
      disconnect() {
        this.entry.disconnect();
      }
    },
  );
  mount();
  const outline = await screen.findByRole("navigation", { name: "Writeup outline" });
  const pane = screen.getByTestId("reading-pane");
  const observer = observers.find((entry) => entry.root === pane);
  expect(observer).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
  await waitFor(() => expect(pane.hidden).toBe(true));
  expect(observer?.disconnect).toHaveBeenCalled();
  const bounds = vi.spyOn(pane, "getBoundingClientRect");
  act(() => observer?.callback());
  expect(bounds).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: "Writeup" }));
  await waitFor(() => expect(pane.hidden).toBe(false));
  expect(screen.getByRole("navigation", { name: "Writeup outline" })).toBe(outline);
  expect(observers.filter((entry) => entry.root === pane).length).toBeGreaterThan(1);
});

test("compact comments repeat an explicit Show in place intent with the same URL after Hide", async () => {
  layoutStore.update({ compact: true });
  currentRevision.threads = [placedWriteupThread()];
  const block = currentRevision.writeup.sections[0]?.blocks[0];
  if (!block) throw new Error("Missing synthetic block");
  // A persistent in-writeup link exercises the same route handler as Comments' Show in place.
  block.html = `<p>Keep growing <a href="/r/${id}?tab=writeup&amp;rev=1#thread-${id}">Show in place</a></p>`;
  block.text = "Keep growing Show in place";
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history } = mount();
  const link = await screen.findByRole("link", { name: "Show in place" });
  fireEvent.click(link);
  await screen.findByRole("button", { name: "Hide" });
  const url = history.location.href;
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(document.getElementById(`thread-${id}`)).toBeNull();
  scroll.mockClear();
  fireEvent.click(link);
  await screen.findByRole("button", { name: "Hide" });
  const card = document.getElementById(`thread-${id}`);
  expect(card?.hasAttribute("data-jump")).toBe(true);
  expect(history.location.href).toBe(url);
  await waitFor(() => expect(scroll.mock.instances).toContain(card));
});

test("an external _blank link is left to the browser while a same-review link still follows in place", async () => {
  layoutStore.update({ compact: true });
  currentRevision.threads = [placedWriteupThread()];
  const block = currentRevision.writeup.sections[0]?.blocks[0];
  if (!block) throw new Error("Missing synthetic block");
  block.html = `<p><a href="https://example.test/x" target="_blank" rel="noopener noreferrer nofollow">Out</a> <a href="/r/${id}?tab=writeup&amp;rev=1#thread-${id}">In</a></p>`;
  block.text = "Out In";
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  // Happy DOM would open the _blank link as a popup page and fetch it from the network; the test
  // only needs the click to stay unprevented, so the popup is switched off for this test.
  const navigation = (
    window as unknown as { happyDOM: { settings: { navigation: Record<string, boolean | undefined> } } }
  ).happyDOM.settings.navigation;
  const popups = navigation.disableChildPageNavigation;
  navigation.disableChildPageNavigation = true;
  onTestFinished(() => {
    navigation.disableChildPageNavigation = popups;
  });
  const { history } = mount();
  const out = await screen.findByRole("link", { name: "Out" });
  const before = history.location.href;
  let prevented = true;
  document.addEventListener(
    "click",
    (event) => {
      prevented = event.defaultPrevented;
    },
    { once: true },
  );
  fireEvent.click(out);
  expect(prevented).toBe(false);
  expect(history.location.href).toBe(before);
  fireEvent.click(screen.getByRole("link", { name: "In" }));
  await screen.findByRole("button", { name: "Hide" });
});

test.each(["tab", "doc", "revision", "no thread", "other thread"])(
  "compact comments keep a hidden pill closed after an unrelated %s navigation",
  async (navigation) => {
    width = 900;
    layoutStore.update({ compact: true });
    currentRevision.threads = [placedWriteupThread()];
    currentReview.revisions.push({ seq: 2, createdAt: "2026-01-02T00:00:00.000Z" });
    const { history } = mount(`?tab=writeup&rev=1#thread-${id}`);
    fireEvent.click(await screen.findByRole("button", { name: "Hide" }));
    const next =
      navigation === "tab"
        ? `?tab=diff&rev=1#thread-${id}`
        : navigation === "doc"
          ? `?tab=writeup&doc=seed.md&rev=1#thread-${id}`
          : navigation === "revision"
            ? `?tab=writeup&rev=2#thread-${id}`
            : navigation === "other thread"
              ? "?tab=writeup&rev=1#thread-22222222-2222-4222-8222-222222222222"
              : "?tab=writeup&rev=1";
    await act(async () => history.push(`/r/${id}${next}`));
    await waitFor(() => expect(document.querySelector(".em-thread-pill")?.textContent).toBe("1 comment"));
    expect(document.getElementById(`thread-${id}`)).toBeNull();
    if (navigation === "tab") {
      await waitFor(() => expect(screen.getByTestId("reading-pane").hidden).toBe(true));
      await act(async () => history.push(`/r/${id}?tab=writeup&rev=1#thread-${id}`));
      expect(document.getElementById(`thread-${id}`)).toBeNull();
    }
  },
);

test("a fulfilled compact comment jump does not reopen a hidden pill when the block remounts in the same navigation", async () => {
  layoutStore.update({ compact: true });
  currentRevision.threads = [placedWriteupThread()];
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history } = mount("?tab=comments&rev=1");
  fireEvent.click(await screen.findByRole("link", { name: "Show in place" }));
  await screen.findByRole("button", { name: "Hide" });
  const card = document.getElementById(`thread-${id}`);
  await waitFor(() => expect(scroll.mock.instances).toContain(card));
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(card?.isConnected).toBe(false);
  const url = history.location.href;
  const originalBlock = document.getElementById("block-t-seed-body-12345678");
  expect(originalBlock).toBeTruthy();
  // Remount the reader's blocks without replacing the route or creating another navigation intent.
  await act(async () => {
    client.setQueryData(["revision", id, 1], { ...currentRevision, writeup: { sections: [] } });
  });
  await waitFor(() => expect(originalBlock?.isConnected).toBe(false));
  scroll.mockClear();
  await act(async () => {
    client.setQueryData(["revision", id, 1], currentRevision);
  });
  await screen.findByRole("button", { name: "1 comment" });
  const newBlock = document.getElementById("block-t-seed-body-12345678");
  expect(newBlock).toBeTruthy();
  expect(newBlock).not.toBe(originalBlock);
  expect(document.getElementById(`thread-${id}`)).toBeNull();
  expect(history.location.href).toBe(url);
  expect(scroll).not.toHaveBeenCalled();
});

function navigationDocs() {
  currentRevision.docs = ["seed.md", "water.md"].map((path) => ({
    kind: "markdown",
    path,
    title: path === "seed.md" ? "Seeds" : "Water",
    headings: ["thread-pretend", "diff-pretend", "heading-third"].map((id, i) => ({
      level: i === 1 ? 3 : 2,
      id,
      text: `Section ${i}`,
    })),
    blocks: ["thread-pretend", "diff-pretend", "heading-third"].map((heading, i) => ({
      id: `doc-${path === "seed.md" ? "11111111" : "22222222"}-${String(i).padStart(8, "0")}`,
      section: `doc-${path === "seed.md" ? "11111111" : "22222222"}`,
      kind: "heading",
      text: `Section ${i}`,
      html: `<h${i === 1 ? 3 : 2} id="${heading}">Section ${i}</h${i === 1 ? 3 : 2}>`,
    })),
  }));
  const block = currentRevision.writeup.sections[0]?.blocks[0];
  if (block)
    block.html = `<h2 id="thread-pretend">Shared id</h2><p><a href="/r/${id}?tab=docs&amp;doc=seed.md#h-thread-pretend">Read seeds</a></p>`;
}
test("doc links push, Contents replaces, Back follows the real entry", async () => {
  navigationDocs();
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history } = mount();
  const initial = history.length;
  fireEvent.click(await screen.findByRole("link", { name: "Read seeds" }));
  await screen.findByRole("button", { name: "Back to Writeup" });
  expect(history.length).toBe(initial + 1);
  const doc = document.querySelector('[data-reading-section="seed.md"]');
  await waitFor(() => expect(scroll.mock.instances).toContain(doc?.querySelector("h2")));
  fireEvent.click(screen.getByRole("button", { name: "Contents" }));
  fireEvent.click(
    within(await screen.findByRole("dialog", { name: "Contents" })).getByRole("button", { name: "Section 1" }),
  );
  await waitFor(() => expect(history.location.hash).toBe("#h-diff-pretend"));
  expect(history.length).toBe(initial + 1);
  fireEvent.click(screen.getByRole("button", { name: "Back to Writeup" }));
  await screen.findByRole("link", { name: "Read seeds" });
});
test.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }])(
  "modified doc link keeps shown rev: %j",
  async (modifier) => {
    navigationDocs();
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    const link = await screen.findByRole("link", { name: "Read seeds" });
    if ("button" in modifier)
      fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, ...modifier }));
    else fireEvent.click(link, modifier);
    expect(opened).toHaveBeenCalledWith(expect.stringContaining("rev=1"), "_blank", "noopener");
  },
);
test.each(["?tab=docs&doc=SECRET.md", "?tab=docs&doc=seed.md#h-SECRET"])(
  "missing targets never echo the value: %s",
  async (query) => {
    navigationDocs();
    mount(query);
    await screen.findByText(/(?:Document|Heading) not found/);
    expect(document.body.textContent).not.toContain("SECRET");
  },
);
test("phone sheets close to their trigger or focus the selected heading", async () => {
  width = 390;
  navigationDocs();
  mount("?tab=docs&doc=seed.md&rev=1");
  const contents = await screen.findByRole("button", { name: "Contents" });
  fireEvent.click(contents);
  const sheet = await screen.findByRole("dialog", { name: "Contents" });
  expect(
    sheet.querySelector("[data-sheet-grab]") ?? sheet.parentElement?.querySelector("[data-sheet-grab]"),
  ).toBeTruthy();
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(document.activeElement).toBe(contents));
  fireEvent.click(contents);
  fireEvent.click(await screen.findByRole("button", { name: "Section 2" }));
  await waitFor(() => expect(document.activeElement?.id).toBe("heading-third"));
  fireEvent.click(screen.getByRole("button", { name: "Docs" }));
  const docs = await screen.findByRole("dialog", { name: "Docs" });
  fireEvent.click(within(docs).getByRole("button", { name: /Water/ }));
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Water"));
});

test("same-doc links replace history and Back to a doc names its server title", async () => {
  navigationDocs();
  const doc = currentRevision.docs[0];
  if (doc?.kind !== "markdown") throw new Error("missing doc");
  doc.blocks.push({
    id: "doc-11111111-99999999",
    section: "doc-11111111",
    kind: "paragraph",
    text: "Next heading",
    html: `<p><a href="/r/${id}?tab=docs&amp;doc=seed.md#h-heading-third">Next heading</a></p>`,
  });
  const { history } = mount("?tab=docs&doc=seed.md&rev=1");
  const initial = history.length;
  fireEvent.click(await screen.findByRole("link", { name: "Next heading" }));
  await waitFor(() => expect(history.location.hash).toBe("#h-heading-third"));
  expect(history.length).toBe(initial);
  expect(screen.queryByRole("button", { name: /Back to/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Docs" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Docs" })).getByRole("button", { name: /Water/ }));
  await screen.findByRole("button", { name: "Back to Seeds" });
  expect(history.length).toBe(initial + 1);
});
test("an unfinished doc comment survives the phone switcher", async () => {
  width = 390;
  navigationDocs();
  const doc = currentRevision.docs[0];
  if (doc?.kind !== "markdown") throw new Error("missing doc");
  doc.blocks.push({ ...docBlock, text: "A synthetic passage", html: "<p>A synthetic passage</p>" });
  mount("?tab=docs&doc=seed.md&rev=1");
  fireEvent.click(await screen.findByRole("button", { name: "Comment on block" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Comment" }), {
    target: { value: "Keep this unfinished thought" },
  });
  // Close the composer sheet; its draft remains attached to the original doc.
  const close = screen.queryByRole("button", { name: "Close" });
  if (close) fireEvent.click(close);
  fireEvent.click(screen.getByRole("button", { name: "Docs" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Docs" })).getByRole("button", { name: /Water/ }));
  await screen.findByRole("button", { name: "Back to Seeds" });
  fireEvent.click(screen.getByRole("button", { name: "Back to Seeds" }));
  const editor = screen.queryByRole("textbox", { name: "Comment" });
  if (!editor) fireEvent.click(await screen.findByRole("button", { name: "Comment on block" }));
  await waitFor(() =>
    expect((screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe(
      "Keep this unfinished thought",
    ),
  );
});
test("old revisions use filenames, with no inferred title or Contents", async () => {
  currentRevision.docs = [{ ...gardenDoc }];
  currentRevision.main = null;
  currentRevision.writeupEmpty = true;
  mount("");
  await screen.findByRole("heading", { name: "z garden.md" });
  expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Docs" })).toBeNull();
  expect(screen.queryByRole("link", { name: "All docs" })).toBeNull();
});

test("switcher keeps manifest order, disambiguates paths, marks the open doc and filters above eight", async () => {
  navigationDocs();
  const original = currentRevision.docs[0];
  if (!original) throw new Error("missing doc");
  currentRevision.docs = Array.from({ length: 9 }, (_, i) => ({
    ...original,
    path: `${i}/guide.md`,
    title: i < 2 ? "Guide" : `Guide ${i}`,
  }));
  currentRevision.threads = [
    {
      ...placedWriteupThread(),
      state: "open",
      target: {
        kind: "doc-span",
        path: "0/guide.md",
        blockId: "doc-11111111-00000000",
        quote: "Section 0",
        prefix: "",
        suffix: "",
      },
      placement: {
        status: "placed",
        location: { kind: "doc-span", path: "0/guide.md", blockId: "doc-11111111-00000000", start: 0, end: 9 },
      },
    },
  ];
  mount("?tab=docs&doc=0%2Fguide.md&rev=1");
  fireEvent.click(await screen.findByRole("button", { name: "Docs" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Docs" }));
  const options = dialog.getAllByRole("button").filter((button) => button.textContent?.includes("open comment"));
  expect(options.map((option) => option.querySelector("small")?.textContent)).toEqual(
    Array.from({ length: 9 }, (_, i) => `${i}/guide.md`),
  );
  expect(options[0]?.getAttribute("aria-current")).toBe("page");
  expect(options[0]?.textContent).toContain("1 open comment");
  expect(options[1]?.textContent).toContain("0 open comments");
  fireEvent.change(dialog.getByRole("textbox", { name: "Filter docs" }), { target: { value: "Guide 8" } });
  expect(dialog.queryByRole("button", { name: /Guide 7/ })).toBeNull();
  expect(dialog.getByRole("button", { name: /Guide 8/ })).toBeTruthy();
});

test("scrolling updates Contents without adding history or moving focus", async () => {
  navigationDocs();
  const { history } = mount("?tab=docs&doc=seed.md&rev=1");
  const trigger = await screen.findByRole("button", { name: "Contents" });
  const pane = screen.getByTestId("reading-pane");
  const doc = document.querySelector('[data-reading-section="seed.md"]');
  if (!doc) throw new Error("missing doc");
  const headings = [...doc.querySelectorAll("h2, h3")];
  headings.forEach((heading, i) => {
    vi.spyOn(heading, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, i * 100 - pane.scrollTop, 300, 50),
    );
  });
  act(() => trigger.focus());
  const before = history.location.href;
  pane.scrollTop = 150;
  fireEvent.scroll(pane);
  await waitFor(() =>
    expect(document.querySelector('.em-doc-contents [aria-current="location"]')?.textContent).toBe("Section 1"),
  );
  expect(document.activeElement).toBe(trigger);
  expect(history.location.href).toBe(before);
});

test.each([`thread-${id}`, `diff-thread-${id}`])(
  "a declared heading %s never becomes an app target",
  async (headingId) => {
    navigationDocs();
    currentRevision.threads = [placedWriteupThread()];
    const doc = currentRevision.docs[0];
    if (doc?.kind !== "markdown" || !doc.blocks[0]) throw new Error("missing doc");
    doc.headings = [{ level: 2, id: headingId, text: "A heading" }];
    doc.blocks[0] = { ...doc.blocks[0], html: `<h2 id="${headingId}">A heading</h2>` };
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { history } = mount(`?tab=docs&doc=seed.md&rev=1#h-${headingId}`);
    const heading = await screen.findByRole("heading", { name: "A heading" });
    await waitFor(() => expect(scroll.mock.instances).toContain(heading));
    expect(searchParams(history).get("tab")).toBe("docs");
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
  },
);

test("Back restores the source link's focus", async () => {
  navigationDocs();
  mount();
  const link = await screen.findByRole("link", { name: "Read seeds" });
  act(() => link.focus());
  fireEvent.click(link);
  fireEvent.click(await screen.findByRole("button", { name: "Back to Writeup" }));
  const returned = await screen.findByRole("link", { name: "Read seeds" });
  await waitFor(() => expect(document.activeElement).toBe(returned));
});

test("picking the already-open doc on the phone closes the sheet and focuses its title", async () => {
  width = 390;
  vi.stubGlobal("innerHeight", 844);
  navigationDocs();
  const { history } = mount("?tab=docs&doc=seed.md&rev=1");
  fireEvent.click(await screen.findByRole("button", { name: "Docs" }));
  const sheet = await screen.findByRole("dialog", { name: "Docs" });
  fireEvent.click(within(sheet).getByRole("button", { name: /Seeds/ }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Seeds" })));
  expect(history.length).toBe(1);
});

test("R1.1 existing topic hashes still scroll to their section", async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mount("?tab=writeup&rev=1#topic-seed");
  const heading = await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  const section = heading.closest("section");
  expect(section?.id).toBe("topic-seed");
  await waitFor(() => expect(scroll.mock.instances).toContain(section));
});

test("R2.1 Alt-click leaves the doc link to the browser", async () => {
  navigationDocs();
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { history } = mount();
  const href = history.location.href;
  expect(fireEvent.click(await screen.findByRole("link", { name: "Read seeds" }), { altKey: true })).toBe(true);
  expect(open).not.toHaveBeenCalled();
  expect(history.location.href).toBe(href);
});

test("R3.2 a missing declared heading completes in the commit without a timer", async () => {
  navigationDocs();
  const ready = structuredClone(currentRevision);
  const doc = currentRevision.docs[0];
  if (doc?.kind !== "markdown") throw new Error("missing doc");
  doc.blocks = [];
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history } = mount("?tab=docs&doc=seed.md&rev=1");
  await screen.findByRole("heading", { name: "Seeds" });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => history.push(`/r/${id}?tab=docs&doc=seed.md&rev=1#h-heading-third`));
  expect(screen.getByText("Heading not found. Showing the top of the document.")).toBeTruthy();
  await act(async () => {
    client.setQueryData(["revision", id, 1], ready);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("heading", { name: "Section 2" })).toBeTruthy();
  expect(scroll).not.toHaveBeenCalled();
});

test("R1.6 Back restores a collapsed topic while the writeup stays mounted", async () => {
  currentRevision.topics = currentRevision.topics.map((topic) => ({ ...topic, attention: "skim" }));
  const { history } = mount();
  const folded = await screen.findByRole("button", { name: "Topic 1: Plant a seed", expanded: false });
  const section = folded.closest("section");
  fireEvent.click(screen.getByRole("link", { name: "Plant a seed" }));
  await screen.findByRole("button", { name: "Topic 1: Plant a seed", expanded: true });
  await act(async () => history.back());
  const returned = await screen.findByRole("button", { name: "Topic 1: Plant a seed", expanded: false });
  expect(returned.closest("section")).toBe(section);
  expect(section?.querySelector('[hidden="until-found"]')).toBeTruthy();
});

test("R1.7 Back focuses the remounted heading when navigation preserves focus", async () => {
  navigationDocs();
  const { history } = mount("?tab=docs&doc=seed.md&rev=1");
  fireEvent.click(await screen.findByRole("button", { name: "Contents" }));
  fireEvent.click(
    within(await screen.findByRole("dialog", { name: "Contents" })).getByRole("button", { name: "Section 2" }),
  );
  const first = await screen.findByRole("heading", { name: "Section 2" });
  await waitFor(() => expect(document.activeElement).toBe(first));
  await act(async () => history.push(`/r/${id}?tab=docs&doc=water.md&rev=1`));
  await screen.findByRole("heading", { name: "Water" });
  await act(async () => history.back());
  const returned = await screen.findByRole("heading", { name: "Section 2" });
  expect(returned).not.toBe(first);
  await waitFor(() => expect(returned.getAttribute("tabindex")).toBe("-1"));
  expect(document.activeElement).toBe(returned);
});

test("R3.5 a doc switcher control clears the earlier heading focus before Back", async () => {
  navigationDocs();
  const { history } = mount("?tab=docs&doc=seed.md&rev=1");
  fireEvent.click(await screen.findByRole("button", { name: "Contents" }));
  fireEvent.click(
    within(await screen.findByRole("dialog", { name: "Contents" })).getByRole("button", { name: "Section 2" }),
  );
  const first = await screen.findByRole("heading", { name: "Section 2" });
  await waitFor(() => expect(document.activeElement).toBe(first));
  fireEvent.click(screen.getByRole("button", { name: "Docs" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Docs" })).getByRole("button", { name: /Water/ }));
  await screen.findByRole("heading", { name: "Water" });
  await act(async () => history.back());
  const returned = await screen.findByRole("heading", { name: "Section 2" });
  expect(returned).not.toBe(first);
  expect(returned.getAttribute("tabindex")).toBeNull();
  expect(document.activeElement).not.toBe(returned);
});

test("R2.4 Back to the writeup entry left at its top resets the shared scroller", async () => {
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
    if (this.id === "topic-seed") screen.getByTestId("reading-pane").scrollTop = 400;
  });
  const { history } = mount();
  const link = await screen.findByRole("link", { name: "Plant a seed" });
  expect(screen.getByTestId("reading-pane").scrollTop).toBe(0);
  fireEvent.click(link);
  await waitFor(() => expect(screen.getByTestId("reading-pane").scrollTop).toBe(400));
  await act(async () => history.back());
  await waitFor(() => expect(screen.getByTestId("reading-pane").scrollTop).toBe(0));
});

test("R2.5 Back restores the second link after keyboard focus moves without a scroll", async () => {
  navigationDocs();
  const block = currentRevision.writeup.sections[0]?.blocks[0];
  if (!block) throw new Error("missing block");
  block.html += `<p><a href="/r/${id}?tab=docs&amp;doc=water.md">Read water</a></p>`;
  const { history } = mount();
  const first = await screen.findByRole("link", { name: "Read seeds" });
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "Tab" });
  const second = screen.getByRole("link", { name: "Read water" });
  act(() => second.focus());
  fireEvent.keyDown(second, { key: "Enter" });
  fireEvent.click(second);
  await screen.findByRole("heading", { name: "Water" });
  await act(async () => history.back());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: "Read water" })));
});

test.each(["empty", "wrong tag", "wrong id"])(
  "R2.6 a declared heading that never renders completes: %s",
  async (kind) => {
    navigationDocs();
    const doc = currentRevision.docs[0];
    if (doc?.kind !== "markdown") throw new Error("missing doc");
    doc.blocks =
      kind === "empty"
        ? []
        : doc.blocks.map((block) => ({
            ...block,
            html: kind === "wrong tag" ? '<p id="heading-third">Wrong tag</p>' : '<h2 id="other">Wrong id</h2>',
          }));
    const { history } = mount("?tab=docs&doc=seed.md&rev=1");
    await screen.findByRole("heading", { name: "Seeds" });
    const pane = screen.getByTestId("reading-pane");
    pane.scrollTop = 300;
    await act(async () => history.push(`/r/${id}?tab=docs&doc=seed.md&rev=1#h-heading-third`));
    await screen.findByText("Heading not found. Showing the top of the document.");
    expect(pane.scrollTop).toBe(0);
    // A later data render cannot re-activate a completed navigation.
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    navigationDocs();
    await act(async () => client.setQueryData(["revision", id, 1], structuredClone(currentRevision)));
    await screen.findByRole("heading", { name: "Section 2" });
    expect(scroll).not.toHaveBeenCalled();
  },
);

test.each(["link", "Contents", "restore"])("R2.7 %s ignores a placed comment's duplicate heading", async (mode) => {
  navigationDocs();
  const doc = currentRevision.docs[0];
  if (doc?.kind !== "markdown" || !doc.blocks[0] || !doc.blocks[2] || !doc.headings?.[2])
    throw new Error("missing doc");
  const setup = "user-content-setup";
  doc.headings[2].id = setup;
  doc.blocks[2].html = `<h2 id="${setup}">Section 2</h2>`;
  currentRevision.threads = [
    {
      id,
      createdOn: 1,
      state: "sent",
      target: {
        kind: "doc-span",
        path: doc.path,
        blockId: doc.blocks[0].id,
        quote: "Section 0",
        prefix: "",
        suffix: "",
      },
      placement: {
        status: "placed",
        location: { kind: "doc-span", path: doc.path, blockId: doc.blocks[0].id, start: 0, end: 9 },
      },
      comments: [
        {
          id,
          author: "user",
          body: "Synthetic reply heading",
          html: `<h2 id="${setup}">Reply heading</h2>`,
          sent: true,
          sentOn: 1,
        },
      ],
    },
  ];
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches("[data-reading-scroll]")) return new DOMRect(0, 0, 600, 600);
    const scroll = document.querySelector<HTMLElement>("[data-reading-scroll]")?.scrollTop ?? 0;
    if (this.id === setup) return new DOMRect(0, (this.closest(".em-comment-html") ? 100 : 300) - scroll, 400, 50);
    if (this.id === "diff-pretend") return new DOMRect(0, 200 - scroll, 400, 50);
    return bounds.call(this);
  });
  if (mode === "restore")
    readingPosition.saveReadingPosition(readingPosition.readingPositionKey(id, "docs", doc.path, 1), {
      id: `h-${setup}`,
      fraction: 0,
    });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history } = mount(`?tab=docs&doc=seed.md&rev=1${mode === "link" ? `#h-${setup}` : ""}`);
  const heading = await screen.findByRole("heading", { name: "Section 2" });
  const reply = screen.getByRole("heading", { name: "Reply heading" });
  if (mode === "Contents") {
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Contents" })).getByRole("button", { name: "Section 2" }),
    );
  }
  if (mode === "restore") await waitFor(() => expect(screen.getByTestId("reading-pane").scrollTop).toBe(300));
  else await waitFor(() => expect(scroll.mock.instances).toContain(heading));
  expect(scroll.mock.instances).not.toContain(reply);
  // At 250 the doc's second heading is current; the earlier reply must not mark Setup current.
  const pane = screen.getByTestId("reading-pane");
  fireEvent.wheel(pane);
  pane.scrollTop = 250;
  fireEvent.scroll(pane);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Section 1" }).getAttribute("aria-current")).toBe("location"),
  );
  expect(history.length).toBe(1);
});

const htmlReadingDoc = {
  kind: "html" as const,
  path: "seed.html",
  title: "Seed guide",
  contentUrl: `/content/${"c".repeat(75)}/seed.html`,
  headings: [
    { level: 2 as const, text: "First" },
    { level: 3 as const, text: "Second" },
    { level: 2 as const, text: "Third" },
  ],
};
function htmlReadingFixture() {
  currentRevision.docs = [structuredClone(htmlReadingDoc), { kind: "markdown", path: "water.md", blocks: [] }];
  currentRevision.files = [];
}

test.each(["reading", "original", "source", "invalid", "", 1, null])("C3 validates view %j", (view) => {
  expect(validateReviewSearch({ view }).view).toBe(
    view === "reading" || view === "original" || view === "source" ? view : undefined,
  );
});

test.each([390, 1280])("C3 HTML fills the pane with app-owned controls and drawers at %s px", async (pixels) => {
  width = pixels;
  htmlReadingFixture();
  mount("?tab=docs&doc=seed.html&rev=1&view=reading");
  await screen.findByRole("heading", { name: "Seed guide" });
  const { frame } = prepareFrame("seed.html");
  expect(frame.style.height).not.toBe("70vh");
  expect(screen.getByTestId("reading-pane").getAttribute("data-reading-layout")).toBe("original");
  expect(screen.getByTestId("reading-pane").classList.contains("overflow-y-auto")).toBe(false);
  if (pixels === 1280) {
    expect(screen.getByText("Sandboxed, scripts off").closest(".em-doc-bar")).toBeTruthy();
  } else {
    expect(screen.queryByText("Sandboxed, scripts off")).toBeNull();
    expect(document.querySelector(".em-doc-bar p")).toBeNull();
  }
  for (const name of ["Docs", "Contents", "Comments (0)"]) {
    const button = screen.getByRole("button", { name });
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: name.startsWith("Comments") ? "Comments" : name });
    expect(dialog.contains(frame)).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(button));
  }
});

test.each([390, 768, 1280])(
  "an HTML doc drops its sandbox note on a phone and keeps it on tablet and desktop at %s px",
  async (pixels) => {
    width = pixels;
    htmlReadingFixture();
    mount("?tab=docs&doc=seed.html&rev=1&view=reading");
    await screen.findByRole("heading", { name: "Seed guide" });
    const { frame } = prepareFrame("seed.html");
    const bar = document.querySelector(".em-doc-bar");
    if (!bar) throw new Error("Missing doc bar");
    if (pixels === 390) {
      expect(screen.queryByText("Sandboxed, scripts off")).toBeNull();
      expect(bar.querySelector("p")).toBeNull();
    } else {
      const note = screen.getByText("Sandboxed, scripts off");
      expect(bar.contains(note)).toBe(true);
      expect(note.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  },
);

test("C3 HTML Contents gates goto on ready, replaces history and marks position without changing the URL", async () => {
  width = 1280;
  htmlReadingFixture();
  const { history } = mount("?tab=docs&doc=seed.html&rev=1&view=original");
  await screen.findByRole("heading", { name: "Seed guide" });
  const { frame, post } = prepareFrame("seed.html");
  const length = history.length;
  fireEvent.click(screen.getByRole("button", { name: "Contents" }));
  fireEvent.click(
    within(await screen.findByRole("dialog", { name: "Contents" })).getByRole("button", { name: "Second" }),
  );
  await waitFor(() => expect(history.location.hash).toBe("#h-1"));
  expect(history.length).toBe(length);
  expect(post.mock.calls.some(([data]) => data.type === "emend:goto")).toBe(false);
  frameMessage(frame, { type: "emend:ready" });
  await waitFor(() => expect(post).toHaveBeenCalledWith({ type: "emend:goto", heading: 1, label: "Second" }, "*"));
  const href = history.location.href;
  frameMessage(frame, { type: "emend:position", heading: 2, fraction: 0.25 });
  expect(history.location.href).toBe(href);
  fireEvent.click(screen.getByRole("button", { name: "Contents" }));
  expect(
    within(await screen.findByRole("dialog", { name: "Contents" }))
      .getByRole("button", { name: "Third" })
      .getAttribute("aria-current"),
  ).toBe("location");
});

test("C3 HTML positions reject untrusted messages and survive Back and reload without stored text", async () => {
  width = 1280;
  htmlReadingFixture();
  let app = mount("?tab=docs&doc=seed.html&rev=1&view=original");
  await screen.findByRole("heading", { name: "Seed guide" });
  const key = readingPosition.readingPositionKey(id, "docs", "seed.html", 1, "original");
  let { frame, post } = prepareFrame("seed.html");
  const message = { type: "emend:position", heading: 1, fraction: 0.4 };
  frameMessage(frame, message);
  expect(readingPosition.loadReadingPosition(key)).toBeUndefined();
  frameMessage(frame, { type: "emend:ready" });
  for (const invalid of [
    { ...message, heading: -1 },
    { ...message, heading: 3 },
    { ...message, heading: 0.5 },
    { ...message, fraction: 2 },
    { ...message, fraction: NaN },
    { ...message, quote: "secret" },
  ])
    frameMessage(frame, invalid);
  frameMessage(frame, message, window);
  expect(readingPosition.loadReadingPosition(key)).toBeUndefined();
  frameMessage(frame, message);
  expect(readingPosition.loadReadingPosition(key)).toEqual({ id: "h-1", fraction: 0.4 });
  const stored = localStorage.getItem(readingPosition.readingKey);
  for (const forbidden of ["Second", "Seed guide", "/content/", "quote"]) expect(stored).not.toContain(forbidden);
  fireEvent.load(frame);
  frameMessage(frame, { type: "emend:position", heading: 0, fraction: 0 });
  frameMessage(frame, { type: "emend:ready" });
  expect(localStorage.getItem(readingPosition.readingKey)).toBe(stored);
  fireEvent.click(screen.getByRole("button", { name: "Docs" }));
  fireEvent.click(
    within(await screen.findByRole("dialog", { name: "Docs" })).getByRole("button", { name: /water.md/ }),
  );
  await screen.findByRole("heading", { name: "water.md" });
  expect(searchParams(app.history).get("view")).toBe("original");
  await act(async () => app.history.back());
  await screen.findByRole("heading", { name: "Seed guide" });
  const stale = frame;
  ({ frame, post } = prepareFrame("seed.html"));
  frameMessage(stale, { type: "emend:position", heading: 0, fraction: 0 });
  frameMessage(frame, { type: "emend:ready" });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith({ type: "emend:goto", heading: 1, label: "Second", fraction: 0.4 }, "*"),
  );
  app.unmount();
  app = mount("?tab=docs&doc=seed.html&rev=1&view=original");
  await screen.findByRole("heading", { name: "Seed guide" });
  ({ frame, post } = prepareFrame("seed.html"));
  frameMessage(frame, { type: "emend:ready" });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith({ type: "emend:goto", heading: 1, label: "Second", fraction: 0.4 }, "*"),
  );
});

test.each([390, 1280])("C3 HTML selection draft survives drawer close and Back at %s px", async (pixels) => {
  width = pixels;
  htmlReadingFixture();
  const { history } = mount("?tab=docs&doc=seed.html&rev=1");
  await screen.findByRole("heading", { name: "Seed guide" });
  const { frame } = prepareFrame("seed.html");
  frameMessage(frame, { type: "emend:ready" });
  frameMessage(frame, { type: "emend:anchor", quote: "A seed", prefix: "", suffix: "" });
  fireEvent.click(await screen.findByRole("button", { name: "Comment on selection" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Comment" }), { target: { value: "Keep this draft" } });
  // A phone composer is its own sheet above the Comments sheet.
  if (pixels === 390)
    fireEvent.click(within(screen.getByRole("dialog", { name: "New comment" })).getByRole("button", { name: "Close" }));
  const comments = await screen.findByRole("dialog", { name: "Comments" });
  fireEvent.click(within(comments).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Comments (0)" }));
  await screen.findByRole("dialog", { name: "Comments" });
  if (pixels === 390) fireEvent.click(screen.getByRole("button", { name: "Resume selection comment" }));
  expect(((await screen.findByRole("textbox", { name: "Comment" })) as HTMLTextAreaElement).value).toBe(
    "Keep this draft",
  );
  await act(async () => history.push(`/r/${id}?tab=docs&doc=water.md&rev=1`));
  await screen.findByRole("heading", { name: "water.md" });
  await act(async () => history.back());
  await screen.findByRole("heading", { name: "Seed guide" });
  fireEvent.click(screen.getByRole("button", { name: "Comments (0)" }));
  await screen.findByRole("dialog", { name: "Comments" });
  fireEvent.click(screen.getByRole("button", { name: "Resume selection comment" }));
  expect(((await screen.findByRole("textbox", { name: "Comment" })) as HTMLTextAreaElement).value).toBe(
    "Keep this draft",
  );
});

test("C3 HTML heading targets beat storage, but Back keeps the entry passage without repeating its target", async () => {
  width = 1280;
  htmlReadingFixture();
  const key = readingPosition.readingPositionKey(id, "docs", "seed.html", 1, "original");
  readingPosition.saveReadingPosition(key, { id: "h-0", fraction: 0.2 });
  const { history } = mount("?tab=docs&doc=seed.html&rev=1#h-1");
  await screen.findByRole("heading", { name: "Seed guide" });
  let { frame, post } = prepareFrame("seed.html");
  frameMessage(frame, { type: "emend:ready" });
  await waitFor(() => expect(post).toHaveBeenCalledWith({ type: "emend:goto", heading: 1, label: "Second" }, "*"));
  frameMessage(frame, { type: "emend:position", heading: 2, fraction: 0.6 });
  post.mockClear();
  frameMessage(frame, { type: "emend:position", heading: 2, fraction: 0.6 });
  expect(post.mock.calls.filter(([message]) => message.type === "emend:goto")).toEqual([]);
  await act(async () => history.push(`/r/${id}?tab=docs&doc=water.md&rev=1`));
  await screen.findByRole("heading", { name: "water.md" });
  await act(async () => history.back());
  await screen.findByRole("heading", { name: "Seed guide" });
  ({ frame, post } = prepareFrame("seed.html"));
  frameMessage(frame, { type: "emend:ready" });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith({ type: "emend:goto", heading: 2, label: "Third", fraction: 0.6 }, "*"),
  );
});

test.each([390, 1280])(
  "C3 HTML drawer keeps replies and unsent comments; Show in place reaches the frame at %s px",
  async (pixels) => {
    width = pixels;
    htmlReadingFixture();
    const thread: ThreadView = {
      id,
      createdOn: 1,
      state: "open",
      target: { kind: "html-span", path: "seed.html", quote: "seed", prefix: "", suffix: "" },
      placement: { status: "placed", location: { kind: "html-span", path: "seed.html", start: 0, end: 4 } },
      comments: [
        { id, author: "user", body: "Sent seed question", sent: true, sentOn: 1 },
        {
          id: "22222222-2222-4222-8222-222222222222",
          author: "user",
          body: "Unsent seed question",
          sent: false,
          sentOn: null,
        },
      ],
    };
    currentRevision.threads = [thread];
    mount("?tab=comments&rev=1&view=reading");
    fireEvent.click(await screen.findByRole("link", { name: "Show in place" }));
    await screen.findByRole("heading", { name: "Seed guide" });
    const { frame, post } = prepareFrame("seed.html");
    frameMessage(frame, { type: "emend:ready" });
    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: "emend:scroll", threadId: id }, "*"));
    fireEvent.click(screen.getByRole("button", { name: "Comments (1)" }));
    const drawer = await screen.findByRole("dialog", { name: "Comments" });
    expect(within(drawer).getByText("Unsent seed question")).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "Reply" }));
    const reply = await screen.findByRole("textbox", { name: "Reply" });
    fireEvent.change(reply, { target: { value: "Keep this reply" } });
    if (pixels === 390)
      fireEvent.click(within(screen.getByRole("dialog", { name: "Reply" })).getByRole("button", { name: "Close" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Comments (1)" }));
    // Remounting the thread resumes its saved reply, in a sheet above Comments on phones.
    expect(((await screen.findByRole("textbox", { name: "Reply" })) as HTMLTextAreaElement).value).toBe(
      "Keep this reply",
    );
  },
);

test("C3 HTML restore rejects an undeclared saved index and keeps view positions separate", async () => {
  width = 1280;
  htmlReadingFixture();
  const original = readingPosition.readingPositionKey(id, "docs", "seed.html", 1, "original");
  const reading = readingPosition.readingPositionKey(id, "docs", "seed.html", 1, "reading");
  readingPosition.saveReadingPosition(original, { id: "h-999", fraction: 0.8 });
  readingPosition.saveReadingPosition(reading, { id: "h-1", fraction: 0.3 });
  const { history } = mount("?tab=docs&doc=seed.html&rev=1");
  await screen.findByRole("heading", { name: "Seed guide" });
  const { frame, post } = prepareFrame("seed.html");
  frameMessage(frame, { type: "emend:ready" });
  expect(post.mock.calls.some(([message]) => message.type === "emend:goto")).toBe(false);
  await act(async () => history.push(`/r/${id}?tab=docs&doc=seed.html&rev=1&view=reading`));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith({ type: "emend:goto", heading: 1, label: "Second", fraction: 0.3 }, "*"),
  );
  fireEvent.load(frame);
  post.mockClear();
  await act(async () => history.push(`/r/${id}?tab=docs&doc=seed.html&rev=1&view=reading#h-2`));
  expect(post).not.toHaveBeenCalled();
});

test("C3 R1.3 returning to the introduction clears position and Contents, including Back and reload", async () => {
  width = 1280;
  htmlReadingFixture();
  const key = readingPosition.readingPositionKey(id, "docs", "seed.html", 1, "original");
  readingPosition.saveReadingPosition(key, { id: "h-1", fraction: 0.4 });
  let app = mount("?tab=docs&doc=seed.html&rev=1");
  await screen.findByRole("heading", { name: "Seed guide" });
  let { frame, post } = prepareFrame("seed.html");
  frameMessage(frame, { type: "emend:ready" });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith({ type: "emend:goto", heading: 1, label: "Second", fraction: 0.4 }, "*"),
  );
  frameMessage(frame, { type: "emend:position", heading: 1, fraction: 0.4 });
  fireEvent.click(screen.getByRole("button", { name: "Contents" }));
  const contents = await screen.findByRole("dialog", { name: "Contents" });
  expect(within(contents).getByRole("button", { name: "Second" }).getAttribute("aria-current")).toBe("location");
  frameMessage(frame, { type: "emend:position", heading: null, fraction: 0 });
  expect(readingPosition.loadReadingPosition(key)).toBeUndefined();
  expect(contents.querySelector('[aria-current="location"]')).toBeNull();
  fireEvent.click(within(contents).getByRole("button", { name: "Close" }));
  await act(async () => app.history.push(`/r/${id}?tab=docs&doc=water.md&rev=1`));
  await screen.findByRole("heading", { name: "water.md" });
  await act(async () => app.history.back());
  await screen.findByRole("heading", { name: "Seed guide" });
  ({ frame, post } = prepareFrame("seed.html"));
  frameMessage(frame, { type: "emend:ready" });
  expect(post.mock.calls.some(([message]) => message.type === "emend:goto")).toBe(false);
  expect(document.querySelector('.em-doc-view [aria-current="location"]')).toBeNull();
  app.unmount();
  app = mount("?tab=docs&doc=seed.html&rev=1");
  await screen.findByRole("heading", { name: "Seed guide" });
  ({ frame, post } = prepareFrame("seed.html"));
  frameMessage(frame, { type: "emend:ready" });
  expect(post.mock.calls.some(([message]) => message.type === "emend:goto")).toBe(false);
  expect(document.querySelector('.em-doc-view [aria-current="location"]')).toBeNull();
});

test.each(["Contents", "restore"])("C3 R1.4 %s posts nothing after an unexpected frame load", async (kind) => {
  width = 1280;
  htmlReadingFixture();
  const { history } = mount("?tab=docs&doc=seed.html&rev=1");
  await screen.findByRole("heading", { name: "Seed guide" });
  const { frame, post } = prepareFrame("seed.html");
  frameMessage(frame, { type: "emend:ready" });
  fireEvent.load(frame);
  post.mockClear();
  frameMessage(frame, { type: "emend:ready" });
  if (kind === "Contents") {
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Contents" })).getByRole("button", { name: "Second" }),
    );
    await waitFor(() => expect(history.location.hash).toBe("#h-1"));
  } else {
    readingPosition.saveReadingPosition(readingPosition.readingPositionKey(id, "docs", "seed.html", 1, "reading"), {
      id: "h-1",
      fraction: 0.4,
    });
    await act(async () => history.push(`/r/${id}?tab=docs&doc=seed.html&rev=1&view=reading`));
  }
  expect(post).not.toHaveBeenCalled();
});

test.each(["Contents", "restore"])(
  "R2.4 a second ready locks %s and all messages before the next load",
  async (kind) => {
    width = 1280;
    htmlReadingFixture();
    const { history } = mount("?tab=docs&doc=seed.html&rev=1");
    await screen.findByRole("heading", { name: "Seed guide" });
    const { frame, post } = prepareFrame("seed.html");
    const key = readingPosition.readingPositionKey(id, "docs", "seed.html", 1, "original");
    frameMessage(frame, { type: "emend:ready" });
    frameMessage(frame, { type: "emend:position", heading: 1, fraction: 0.4 });
    frameMessage(frame, { type: "emend:anchor", quote: "seed", prefix: "", suffix: "" });
    expect(screen.getByRole("button", { name: "Comment on selection" })).toBeTruthy();
    post.mockClear();
    // No load event: the replacement document's bridge runs before its resources finish loading.
    frameMessage(frame, { type: "emend:ready" });
    frameMessage(frame, { type: "emend:position", heading: 2, fraction: 0.8 });
    expect(readingPosition.loadReadingPosition(key)).toEqual({ id: "h-1", fraction: 0.4 });
    frameMessage(frame, { type: "emend:anchor", quote: "replacement", prefix: "", suffix: "" });
    frameMessage(frame, { type: "emend:navigate", path: "water.md", fragment: "" });
    frameMessage(frame, { type: "emend:ready" });
    expect(screen.getByText("This doc navigated away.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
    expect(searchParams(history).get("doc")).toBe("seed.html");
    if (kind === "Contents") {
      fireEvent.click(screen.getByRole("button", { name: "Contents" }));
      fireEvent.click(
        within(await screen.findByRole("dialog", { name: "Contents" })).getByRole("button", { name: "Third" }),
      );
      await waitFor(() => expect(history.location.hash).toBe("#h-2"));
    } else {
      readingPosition.saveReadingPosition(readingPosition.readingPositionKey(id, "docs", "seed.html", 1, "reading"), {
        id: "h-2",
        fraction: 0.5,
      });
      await act(async () => history.push(`/r/${id}?tab=docs&doc=seed.html&rev=1&view=reading`));
    }
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload seed.html" }));
    const next = prepareFrame("seed.html");
    expect(next.frame).not.toBe(frame);
    frameMessage(next.frame, { type: "emend:ready" });
    expect(screen.queryByText("This doc navigated away.")).toBeNull();
    expect(next.post).toHaveBeenCalledWith({ type: "emend:docs", paths: ["seed.html", "water.md"] }, "*");
    frameMessage(frame, { type: "emend:position", heading: 0, fraction: 0 });
    expect(readingPosition.loadReadingPosition(key)).toEqual({ id: "h-1", fraction: 0.4 });
  },
);

test("R4 an actual inset bridge report keeps the picked Contents marker and saved position", async () => {
  width = 1280;
  htmlReadingFixture();
  mount("?tab=docs&doc=seed.html&rev=1");
  await screen.findByRole("heading", { name: "Seed guide" });
  const { frame, post } = prepareFrame("seed.html");
  const content = new BridgeWindow({ settings: { enableJavaScriptEvaluation: false } });
  content.document.write("<main><h2>First</h2><h3>Second</h3><h2>Third</h2></main>");
  Object.defineProperty(content, "innerHeight", { value: 400 });
  const headings = [...content.document.querySelectorAll("h2,h3")];
  const offsets = [300, 900, 1500];
  let scrollTop = 0;
  const rect = content.Element.prototype.getBoundingClientRect;
  const scroll = content.Element.prototype.scrollIntoView;
  const visible = content.Element.prototype.checkVisibility;
  const slot = Object.getOwnPropertyDescriptor(content.Element.prototype, "assignedSlot");
  if (!slot) Object.defineProperty(content.Element.prototype, "assignedSlot", { configurable: true, get: () => null });
  vi.spyOn(content.Element.prototype, "getBoundingClientRect").mockImplementation(function (this: BridgeElement) {
    const index = headings.indexOf(this);
    return index < 0 ? rect.call(this) : new content.DOMRect(0, (offsets[index] ?? 0) - scrollTop + 43, 400, 20);
  });
  vi.spyOn(content.Element.prototype, "scrollIntoView").mockImplementation(function (this: BridgeElement, options) {
    const index = headings.indexOf(this);
    if (index < 0) scroll.call(this, options);
    else scrollTop = offsets[index] ?? 0;
  });
  vi.spyOn(content.Element.prototype, "checkVisibility").mockImplementation(function (this: BridgeElement) {
    return headings.includes(this) || visible.call(this);
  });
  const parent = { postMessage: (data: unknown) => frameMessage(frame, data) };
  Object.defineProperty(content, "parent", { value: parent });
  post.mockImplementation((data) =>
    content.dispatchEvent(new content.MessageEvent("message", { data, source: parent as unknown as BridgeWindow })),
  );
  try {
    const source = readFileSync(join(import.meta.dirname, "../../emend/src/server/content/bridge.ts"), "utf8");
    const script = runInNewContext(`${source.replace("export const", "const")}; BRIDGE_SOURCE;`);
    runInNewContext(script, { window: content, document: content.document });
    content.document.dispatchEvent(new content.Event("DOMContentLoaded"));
    await act(async () => content.happyDOM.waitUntilComplete());
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Contents" })).getByRole("button", { name: "First" }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: "emend:goto", heading: 0, label: "First" }, "*"));
    await act(async () => content.happyDOM.waitUntilComplete());
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    const contents = await screen.findByRole("dialog", { name: "Contents" });
    expect(within(contents).getByRole("button", { name: "First" }).getAttribute("aria-current")).toBe("location");
    const key = readingPosition.readingPositionKey(id, "docs", "seed.html", 1, "original");
    expect(readingPosition.loadReadingPosition(key)).toEqual({ id: "h-0", fraction: 0 });
    // The view moves with no input event (Show in doc, find-in-page): the pin ends at the new heading.
    scrollTop = 900;
    content.dispatchEvent(new content.Event("scroll"));
    await waitFor(() => expect(readingPosition.loadReadingPosition(key)?.id).toBe("h-1"));
    expect(readingPosition.loadReadingPosition(key)?.fraction).toBeCloseTo(57 / 600);
  } finally {
    await content.happyDOM.close();
    if (!slot) Reflect.deleteProperty(content.Element.prototype, "assignedSlot");
  }
});

test("R5.1 stored zero fraction is explicitly sent on reload and Back", async () => {
  width = 1280;
  htmlReadingFixture();
  const key = readingPosition.readingPositionKey(id, "docs", "seed.html", 1, "original");
  readingPosition.saveReadingPosition(key, { id: "h-0", fraction: 0 });
  const { history } = mount("?tab=docs&doc=seed.html&rev=1");
  await screen.findByRole("heading", { name: "Seed guide" });
  let { frame, post } = prepareFrame("seed.html");
  frameMessage(frame, { type: "emend:ready" });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith({ type: "emend:goto", heading: 0, label: "First", fraction: 0 }, "*"),
  );
  frameMessage(frame, { type: "emend:position", heading: 0, fraction: 0 });
  await act(async () => history.push(`/r/${id}?tab=docs&doc=water.md&rev=1`));
  await screen.findByRole("heading", { name: "water.md" });
  await act(async () => history.back());
  await screen.findByRole("heading", { name: "Seed guide" });
  ({ frame, post } = prepareFrame("seed.html"));
  frameMessage(frame, { type: "emend:ready" });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith({ type: "emend:goto", heading: 0, label: "First", fraction: 0 }, "*"),
  );
});
