// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { LIMITS, type ReviewView, RevisionView, type ThreadView } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { threadPlaceLink } from "./components/threads/ThreadCard.tsx";
import { draftKey, saveDraft } from "./lib/drafts.ts";
import * as readingPosition from "./lib/reading-position.ts";
import { validateReviewSearch } from "./router.tsx";
import { stubIntersectionObserver } from "./test/intersection.ts";

const id = "11111111-1111-4111-8111-111111111111";
const path = "notes.md";
const review: ReviewView = {
  id,
  title: "Synthetic source",
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
  activeUntil: null,
  releasedAt: null,
  pickedUpAt: null,
  kind: "review",
  importedAt: null,
  revisions: [{ seq: 1, createdAt: "2026-01-01T00:00:00.000Z" }],
};
const source: Extract<RevisionView["docs"][number], { kind: "source" }> = {
  kind: "source",
  path,
  title: "Source notes",
  language: "md",
  lines: Array.from({ length: 9 }, (_, index) => [{ text: `line ${index + 1}`, light: "#123456", dark: "#abcdef" }]),
};
const rendered: RevisionView["docs"][number] = {
  kind: "markdown",
  path,
  title: "Rendered notes",
  blocks: [
    {
      id: "doc-12345678-12345678",
      section: "doc-12345678",
      kind: "paragraph",
      text: "Rendered paragraph",
      html: "<p>Rendered paragraph</p>",
    },
  ],
};
const thread: ThreadView = {
  id,
  createdOn: 1,
  state: "open",
  target: {
    kind: "source-lines",
    path,
    start: 3,
    end: 5,
    lines: ["line 3", "line 4", "line 5"],
    before: ["line 1", "line 2"],
    after: ["line 6", "line 7", "line 8"],
  },
  placement: { status: "placed", location: { kind: "source-lines", path, start: 4, end: 6 } },
  comments: [{ id, author: "user", body: "Check these lines", sent: true, sentOn: 1 }],
};
let revision: RevisionView;
let client: QueryClient;
beforeEach(() => {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  revision = {
    seq: 1,
    base: null,
    head: null,
    main: null,
    writeupEmpty: true,
    topics: [],
    files: [],
    writeup: { sections: [] },
    docs: [structuredClone(source), rendered],
    threads: [],
    changedBlocks: [],
  };
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: 1280 >= Number(query.match(/\d+/)?.[0] ?? Infinity),
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `/api/v1/reviews/${id}/threads` && init?.method === "POST")
        return Response.json({ threadId: id, commentId: id }, { status: 201 });
      if (url === "/api/v1/session") return new Response(null, { status: 204 });
      if (url === "/api/v1/reviews")
        return Response.json({ serverTime: new Date(Date.now()).toISOString(), items: [review] });
      if (url === `/api/v1/reviews/${id}`) return Response.json(review);
      if (url === `/api/v1/reviews/${id}/revisions/1`) return Response.json(revision);
      throw new Error(`Unexpected synthetic request: ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});
function mount(search = `?tab=docs&doc=${path}&view=source`) {
  RevisionView.parse(revision);
  const history = createMemoryHistory({ initialEntries: [`/r/${id}${search}`] });
  return { ...render(<App queryClient={client} history={history} />), history };
}

test.each(["placed", "unplaced"] as const)(
  "counts %s comments separately for rendered and source twins",
  async (status) => {
    revision.docs = [
      source,
      { kind: "html", path, title: "Rendered notes", contentUrl: `/content/${"a".repeat(75)}/notes.md` },
    ];
    const renderedThread: ThreadView = {
      ...thread,
      id: "22222222-2222-4222-8222-222222222222",
      target: { kind: "html-span", path, quote: "Rendered paragraph", prefix: "", suffix: "" },
      placement: { status: "placed", location: { kind: "html-span", path, start: 0, end: 18 } },
      comments: [],
    };
    revision.threads = [thread, renderedThread].map((item) =>
      status === "placed" ? item : { ...item, placement: { status: "unplaced", reason: "file-gone" } },
    );
    mount(`?tab=docs&doc=${path}`);
    await screen.findByRole("button", { name: "Comments (1)" });
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    const menu = within(screen.getByRole("dialog", { name: "Docs" }));
    expect(menu.getByRole("button", { name: /Rendered notes.*1 open comment$/ })).toBeTruthy();
    fireEvent.click(menu.getByRole("button", { name: /Source notes.*Source 1 open comment$/ }));
    await screen.findByRole("button", { name: "Comment on line 3" });
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    expect(within(screen.getByRole("dialog", { name: "Docs" })).getAllByText("1 open comment")).toHaveLength(2);
  },
);

test.each(["placed", "unplaced"] as const)(
  "excludes %s diff and Markdown threads from an HTML doc row and badge",
  async (status) => {
    if (thread.target.kind !== "source-lines") throw new Error("missing source target");
    revision.docs = [
      source,
      { kind: "html", path, title: "Rendered notes", contentUrl: `/content/${"a".repeat(75)}/notes.md` },
    ];
    const others: ThreadView[] = [
      {
        ...thread,
        target: { ...thread.target, kind: "lines", side: "new" },
        placement: { status: "placed", location: { kind: "lines", side: "new", path, start: 4, end: 6 } },
      },
      {
        ...thread,
        id: "22222222-2222-4222-8222-222222222222",
        target: { kind: "file", path },
        placement: { status: "placed", location: { kind: "file", path } },
      },
      {
        ...thread,
        id: "33333333-3333-4333-8333-333333333333",
        target: {
          kind: "doc-span",
          path,
          blockId: "doc-12345678-12345678",
          quote: "Rendered paragraph",
          prefix: "",
          suffix: "",
        },
        placement: {
          status: "placed",
          location: { kind: "doc-span", path, blockId: "doc-12345678-12345678", start: 0, end: 18 },
        },
      },
    ];
    revision.threads = others.map((item) =>
      status === "placed" ? item : { ...item, placement: { status: "unplaced", reason: "file-gone" } },
    );
    mount(`?tab=docs&doc=${path}`);
    await screen.findByRole("button", { name: "Comments (0)" });
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    expect(within(screen.getByRole("dialog", { name: "Docs" })).getAllByText("0 open comments")).toHaveLength(2);
  },
);

test.each(["placed", "unplaced"] as const)("resolved %s threads do not count on doc rows or badges", async (status) => {
  revision.docs = [
    source,
    { kind: "html", path, title: "Rendered notes", contentUrl: `/content/${"a".repeat(75)}/notes.md` },
  ];
  const renderedThread: ThreadView = {
    ...thread,
    id: "22222222-2222-4222-8222-222222222222",
    target: { kind: "html-span", path, quote: "Rendered paragraph", prefix: "", suffix: "" },
    placement: { status: "placed", location: { kind: "html-span", path, start: 0, end: 18 } },
  };
  revision.threads = [thread, renderedThread].map((item) => ({
    ...item,
    state: "resolved",
    placement: status === "placed" ? item.placement : { status: "unplaced", reason: "file-gone" },
  }));
  mount(`?tab=docs&doc=${path}`);
  await screen.findByRole("button", { name: "Comments (0)" });
  fireEvent.click(screen.getByRole("button", { name: "Docs" }));
  expect(within(screen.getByRole("dialog", { name: "Docs" })).getAllByText("0 open comments")).toHaveLength(2);
});

test("lists rendered and source rows for one path and opens each view", async () => {
  const { history } = mount("?tab=docs");
  const link = await screen.findByRole("link", { name: /Source notes.*notes.md.*Source/ });
  expect(new URL((link as HTMLAnchorElement).href).searchParams.get("view")).toBe("source");
  expect(screen.getByRole("link", { name: /Rendered notes.*notes.md/ })).toBeTruthy();
  fireEvent.click(link);
  await screen.findByRole("button", { name: "Comment on line 3" });
  expect(history.location.search).toContain("view=source");
  fireEvent.click(screen.getByRole("link", { name: "All docs" }));
  const renderedLink = await screen.findByRole("link", { name: /Rendered notes.*notes.md/ });
  expect(new URL((renderedLink as HTMLAnchorElement).href).searchParams.has("view")).toBe(false);
  fireEvent.click(renderedLink);
  await screen.findByText("Rendered paragraph");
  expect(screen.queryByRole("button", { name: "Comment on line 3" })).toBeNull();
});
test.each([undefined, "reading", "original"])("view %s prefers rendered even when source comes first", async (view) => {
  mount(`?tab=docs&doc=${path}${view ? `&view=${view}` : ""}`);
  await screen.findByText("Rendered paragraph");
  expect(screen.queryByRole("button", { name: "Comment on line 3" })).toBeNull();
});
test.each([undefined, "reading", "original"])(
  "a source-only path with view %s opens source and canonicalizes the URL",
  async (view) => {
    revision.docs = [source];
    const { history } = mount(`?tab=docs&doc=${path}${view ? `&view=${view}` : ""}`);
    await screen.findByRole("button", { name: "Comment on line 3" });
    await waitFor(() => expect(history.location.search).toContain("view=source"));
  },
);
test("renders hostile tokens only as text with theme color properties", async () => {
  const texts = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '<a href="javascript:alert(1)">link</a>',
    '<svg onload="alert(1)"></svg>',
    'click A "javascript:alert(1)"',
  ];
  revision.docs = [{ ...source, lines: texts.map((text) => [{ text, light: "#123456", dark: "#abcdef" }]) }];
  const { container } = mount();
  await screen.findByText(texts[0] as string);
  const view = container.querySelector(".em-source");
  expect(view?.querySelector("script, img, svg, a")).toBeNull();
  for (const text of texts) {
    const token = screen.getByText(text);
    expect(token.textContent).toBe(text);
    expect(token.getAttribute("style")).toBe("--shiki-light: #123456; --shiki-dark: #abcdef;");
  }
});
test("selects line 3 then shift-selects 5 and saves its exact target and context", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Comment on line 3" }));
  fireEvent.click(screen.getByRole("button", { name: "Comment on line 5" }), { shiftKey: true });
  const input = screen.getByRole("textbox", { name: "Comment" });
  expect(input.closest("[data-source-end]")?.getAttribute("data-source-end")).toBe("5");
  fireEvent.change(input, { target: { value: "Review this range" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/reviews/${id}/threads`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ revision: 1, target: thread.target, body: "Review this range" }),
      }),
    ),
  );
});
test.each([
  { lines: Array.from({ length: 1001 }, () => [{ text: "x" }]), end: 1001, error: "Select at most 1000 lines." },
  {
    lines: [[{ text: "x".repeat(LIMITS.targetTextChars + 1) }]],
    end: 1,
    error: "This selection is too long. Select fewer lines.",
  },
])("refuses a selection: $error", async ({ lines, end, error }) => {
  const observer = stubIntersectionObserver();
  revision.docs = [{ ...source, lines }];
  const { container } = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Comment on line 1" }));
  if (end > 400)
    act(() =>
      observer.intersect(container.querySelector(`[data-source-chunk="${Math.floor((end - 1) / 200) * 200 + 1}"]`)),
    );
  fireEvent.click(screen.getByRole("button", { name: `Comment on line ${end}` }), { shiftKey: true });
  expect(screen.getByRole("alert").textContent).toBe(error);
  expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
});
test("places a thread after its current end line and marks the current range", async () => {
  revision.threads = [thread];
  const { container } = mount();
  const comment = await screen.findByText("Check these lines");
  const group = comment.closest("[data-source-end]");
  expect(group?.getAttribute("data-source-end")).toBe("6");
  expect(group?.previousElementSibling?.getAttribute("data-source-line")).toBe("6");
  expect(group?.nextElementSibling?.getAttribute("data-source-line")).toBe("7");
  expect(
    [...container.querySelectorAll("[data-source-line][data-commented]")].map((line) =>
      line.getAttribute("data-source-line"),
    ),
  ).toEqual(["4", "5", "6"]);
});
test("source thread links and Comments jumps open source and focus its card", async () => {
  revision.threads = [thread];
  const link = threadPlaceLink(id, thread, { rev: 1 }, false);
  expect(link).toBe(`/r/${id}?rev=1&tab=docs&doc=notes.md&view=source#thread-${id}`);
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history } = mount("?tab=comments");
  fireEvent.click(await screen.findByRole("link", { name: "Show in place" }));
  await screen.findByRole("button", { name: "Comment on line 6" });
  await waitFor(() => expect(document.activeElement?.id).toBe(`thread-${id}`));
  expect(scroll.mock.contexts.some((element) => (element as HTMLElement).id === `thread-${id}`)).toBe(true);
  expect(history.location.search).toContain("view=source");
});
test("a direct thread intent selects source and an unplaced thread stays in Comments", async () => {
  revision.threads = [thread];
  const { history } = mount(`?tab=writeup#thread-${id}`);
  await screen.findByRole("button", { name: "Comment on line 6" });
  await waitFor(() => expect(history.location.search).toContain("view=source"));
  revision.threads = [{ ...thread, placement: { status: "unplaced", reason: "lines-gone" } }];
  await act(async () => {
    client.setQueryData(["revision", id, 1], revision);
    history.push(`/r/${id}?tab=comments`);
  });
  const group = await screen.findByRole("region", { name: "Unplaced" });
  expect(within(group).getByText("Check these lines")).toBeTruthy();
});
test("resumes a saved source draft on its source doc", async () => {
  saveDraft(draftKey(id, thread.target), "Saved source draft");
  const { history } = mount("?tab=comments");
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await screen.findByRole("button", { name: "Comment on line 5" });
  expect((screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe("Saved source draft");
  expect(history.location.search).toContain("view=source");
  expect(new URLSearchParams(history.location.search).get("doc")).toBe(path);
  expect(history.location.hash).toBe("");
});
test.each(["direct", "Show in place"])("an unrendered source thread stays visible in Comments via %s", async (jump) => {
  revision.docs = [{ ...source, lines: [], unrendered: true }];
  revision.threads = [thread];
  const { history } = mount(jump === "direct" ? `?tab=docs&doc=${path}&view=source#thread-${id}` : "?tab=comments");
  if (jump === "Show in place") fireEvent.click(await screen.findByRole("link", { name: jump }));
  await waitFor(() => expect(new URLSearchParams(history.location.search).get("tab")).toBe("comments"));
  expect(within(screen.getByTestId("reading-pane")).getByText("Check these lines")).toBeTruthy();
  expect(screen.queryByText("This file could not be shown.")).toBeNull();
});
test("shows a short fallback for unrendered source", async () => {
  revision.docs = [{ ...source, lines: [], unrendered: true }];
  mount();
  expect(await screen.findByText("This file could not be shown.")).toBeTruthy();
});
test("validates view and keeps rendered and source reading keys separate", () => {
  for (const view of ["reading", "original", "source"]) expect(validateReviewSearch({ view }).view).toBe(view);
  for (const view of ["rendered", "invalid", ["source"], 1, null])
    expect(validateReviewSearch({ view }).view).toBeUndefined();
  const sourceKey = readingPosition.readingPositionKey(id, "docs", path, 1, "source");
  expect(sourceKey.endsWith("\nsource")).toBe(true);
  for (const view of ["reading", "original"] as const)
    expect(sourceKey).not.toBe(readingPosition.readingPositionKey(id, "docs", path, 1, view));
});

test("an explicit source view never falls back to the rendered entry", async () => {
  revision.docs = [rendered];
  const { container } = mount();
  await screen.findByText("Document not found. Showing all docs.");
  expect(screen.queryByText("Rendered paragraph")).toBeNull();
  expect(container.querySelector(".em-source")).toBeNull();
});

test("an HTML source entry uses SourceView inside the doc bar without Contents or a content frame", async () => {
  revision.docs = [
    { ...source, path: "page.html", language: "html" },
    {
      kind: "html",
      path: "page.html",
      contentUrl: `/content/${"a".repeat(75)}/page.html`,
      headings: [1, 2, 3].map((n) => ({ level: 2, text: `Heading ${n}` })),
    },
  ];
  const { container } = mount("?tab=docs&doc=page.html&view=source");
  await screen.findByRole("button", { name: "Comment on line 3" });
  expect(container.querySelector(".em-doc-view .em-doc-body .em-source")).toBeTruthy();
  expect(container.querySelector(".em-doc-bar")).toBeTruthy();
  expect(container.querySelector("iframe")).toBeNull();
  expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/content/"))).toBe(false);
});

test.each([path, "other.md"])(
  "the doc switcher opens rendered %s from source and keeps entries distinct",
  async (destination) => {
    if (destination !== path)
      revision.docs.push({ ...source, path: destination }, { ...rendered, path: destination, title: "Other notes" });
    const { container, history } = mount();
    await screen.findByRole("button", { name: "Comment on line 3" });
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    const selected = screen.getByRole("button", { name: /Source notes.*notes.md.*Source/ });
    expect(selected.getAttribute("aria-current")).toBe("page");
    const target = screen.getByRole("button", {
      name: destination === path ? /Rendered notes.*notes.md/ : /Other notes.*other.md/,
    });
    expect(target.getAttribute("aria-current")).toBeNull();
    fireEvent.click(target);
    await screen.findByText("Rendered paragraph");
    expect(new URLSearchParams(history.location.search).get("doc")).toBe(destination);
    expect(new URLSearchParams(history.location.search).has("view")).toBe(false);
    expect(container.querySelector(".em-source")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    fireEvent.click(screen.getByRole("button", { name: /Source notes.*notes.md.*Source/ }));
    await screen.findByRole("button", { name: "Comment on line 3" });
    expect(new URLSearchParams(history.location.search).get("view")).toBe("source");
  },
);

test.each(["reading", "original"])("doc switching and list links carry the %s display mode", async (view) => {
  revision.docs.push({ ...rendered, path: "other.md", title: "Other notes" });
  const { history } = mount(`?tab=docs&doc=${path}&view=${view}`);
  await screen.findByText("Rendered paragraph");
  fireEvent.click(screen.getByRole("button", { name: "Docs" }));
  fireEvent.click(screen.getByRole("button", { name: /Other notes.*other.md/ }));
  await screen.findByRole("heading", { name: "Other notes" });
  expect(new URLSearchParams(history.location.search).get("view")).toBe(view);
  fireEvent.click(screen.getByRole("link", { name: "All docs" }));
  const link = await screen.findByRole("link", { name: /Rendered notes.*notes.md/ });
  expect(new URLSearchParams(history.location.search).get("view")).toBe(view);
  expect(new URL((link as HTMLAnchorElement).href).searchParams.get("view")).toBe(view);
});

test.each([false, true])("a hardened doc link drops a carried source view (modified click: %s)", async (modified) => {
  revision.writeupEmpty = false;
  revision.writeup.sections = [
    {
      key: "overview",
      label: "Overview",
      topic: null,
      blocks: [
        {
          id: "overview-12345678",
          section: "overview",
          kind: "paragraph",
          text: "Read notes",
          html: '<p><a href="?tab=docs&amp;doc=notes.md">Read notes</a></p>',
        },
      ],
    },
  ];
  window.history.replaceState(null, "", `/r/${id}`);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { history } = mount();
  await screen.findByRole("button", { name: "Comment on line 3" });
  fireEvent.click(screen.getByRole("tab", { name: "Writeup" }));
  const link = await screen.findByRole("link", { name: "Read notes" });
  expect(new URLSearchParams(history.location.search).get("view")).toBe("source");
  fireEvent.click(link, { ctrlKey: modified });
  if (modified) {
    expect(open).toHaveBeenCalledWith(expect.any(String), "_blank", "noopener");
    const url = new URL(open.mock.calls[0]?.[0] as string, window.location.origin);
    expect(url.searchParams.get("doc")).toBe(path);
    expect(url.searchParams.has("view")).toBe(false);
  } else {
    await screen.findByText("Rendered paragraph");
    expect(new URLSearchParams(history.location.search).has("view")).toBe(false);
  }
});

test("source docs never load or save reading positions", async () => {
  revision.threads = [thread];
  const key = readingPosition.readingPositionKey(id, "docs", path, 1, "source");
  readingPosition.saveReadingPosition(key, { id: `thread-${id}`, fraction: 0.5 });
  const load = vi.spyOn(readingPosition, "loadReadingPosition");
  const save = vi.spyOn(readingPosition, "saveReadingPosition");
  const { container } = mount();
  await screen.findByText("Check these lines");
  const scroller = container.querySelector<HTMLElement>("[data-reading-scroll]");
  if (!scroller) throw new Error("missing reading scroller");
  fireEvent.wheel(scroller);
  scroller.scrollTop = 100;
  fireEvent.scroll(scroller);
  fireEvent(window, new Event("pagehide"));
  fireEvent.click(screen.getByRole("link", { name: "All docs" }));
  await screen.findByRole("link", { name: /Rendered notes.*notes.md/ });
  expect(load.mock.calls.some(([storageKey]) => storageKey === key)).toBe(false);
  expect(save.mock.calls.some(([storageKey]) => storageKey === key)).toBe(false);
});

test.each([false, true])(
  "switching source docs resets scroll only without a thread target (targeted: %s)",
  async (targeted) => {
    if (thread.target.kind !== "source-lines") throw new Error("missing source target");
    revision.docs = [source, { ...source, path: "other.txt", title: "Other source" }];
    revision.threads = [
      {
        ...thread,
        target: { ...thread.target, path: "other.txt" },
        placement: { status: "placed", location: { kind: "source-lines", path: "other.txt", start: 4, end: 6 } },
      },
    ];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { history } = mount();
    await screen.findByRole("button", { name: "Comment on line 3" });
    const scroller = screen.getByTestId("reading-pane");
    scroller.scrollTop = 1000;
    if (targeted) {
      await act(async () => history.push(`/r/${id}?tab=docs&doc=other.txt&view=source#thread-${id}`));
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Docs" }));
      fireEvent.click(screen.getByRole("button", { name: /Other source.*other.txt.*Source/ }));
    }
    await screen.findByRole("heading", { name: "Other source" });
    if (targeted) await waitFor(() => expect(document.activeElement?.id).toBe(`thread-${id}`));
    expect(scroller.scrollTop).toBe(targeted ? 1000 : 0);
  },
);

test("a frame navigate message cannot open a source-only doc", async () => {
  revision.docs = [source, { kind: "html", path: "page.html", contentUrl: `/content/${"a".repeat(75)}/page.html` }];
  const { container, history } = mount("?tab=docs&doc=page.html");
  await screen.findByRole("heading", { name: "page.html" });
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("missing content frame");
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: vi.fn() } });
  fireEvent.load(frame);
  const href = history.location.href;
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "emend:navigate", path, fragment: "" },
      }),
    );
  });
  expect(history.location.href).toBe(href);
  expect(history.length).toBe(1);
  expect(container.querySelector("iframe")).toBe(frame);
  expect(container.querySelector(".em-source")).toBeNull();
});

test("a jump to a distant source thread mounts its chunk before scrolling the card", async () => {
  const observer = stubIntersectionObserver();
  revision.docs = [{ ...source, lines: Array.from({ length: 100000 }, (_, i) => [{ text: `line ${i + 1}` }]) }];
  revision.threads = [
    { ...thread, placement: { status: "placed", location: { kind: "source-lines", path, start: 90000, end: 90000 } } },
  ];
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { container, history } = mount();
  await screen.findByRole("button", { name: "Comment on line 1" });
  expect(container.querySelector('[data-source-line="90000"]')).toBeNull();
  expect(screen.queryByText("Check these lines")).toBeNull();
  await act(async () => history.push(`/r/${id}?tab=comments`));
  fireEvent.click(await screen.findByRole("link", { name: "Show in place" }));
  await screen.findByRole("button", { name: "Comment on line 90000" });
  await waitFor(() => expect(document.activeElement?.id).toBe(`thread-${id}`));
  expect(scroll.mock.contexts.some((element) => (element as HTMLElement).id === `thread-${id}`)).toBe(true);
  act(() => observer.intersect(container.querySelector('[data-source-chunk="89801"]'), false));
  expect(document.activeElement?.id).toBe(`thread-${id}`);
  expect(container.querySelector('[data-source-line="90000"]')).toBeTruthy();
  expect(container.querySelectorAll("[data-source-line]").length).toBeLessThanOrEqual(600);
});
