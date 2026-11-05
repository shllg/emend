import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FileView, RevisionView, Target, ThreadView } from "@emend/contract";
import type { GetHoveredLineResult } from "@pierre/diffs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { draftKey } from "../../lib/drafts.ts";
import { layoutStore } from "../../lib/layout-store.ts";
import { Panes } from "../layout/Panes.tsx";
import { DiffPane, type DiffPaneProps } from "./DiffPane.tsx";
import { parsePair } from "./parse.worker.ts";
import type { DiffParser } from "./parse-client.ts";

type Selection = { side?: "additions" | "deletions"; endSide?: "additions" | "deletions"; start: number; end: number };
type Annotation = { side: string; lineNumber: number; metadata: ReactNode };
type RenderProps = {
  options: { diffStyle: string; overflow: string; onLineSelectionEnd: (range: Selection | null) => void };
  lineAnnotations: Annotation[];
  renderAnnotation: (annotation: Annotation) => ReactNode;
  renderGutterUtility: (getHoveredLine: () => GetHoveredLineResult<"diff">) => ReactNode;
};
const renderer = vi.hoisted(() => ({ props: [] as RenderProps[], fileStyles: [] as string[] }));
vi.mock("./FileDiff.tsx", async (original) => {
  const actual = await original<typeof import("./FileDiff.tsx")>();
  return {
    ...actual,
    FileDiff: (props: Parameters<typeof actual.FileDiff>[0]) => {
      renderer.fileStyles.push(props.diffStyle);
      return <actual.FileDiff {...props} />;
    },
  };
});
vi.mock("@pierre/diffs/react", () => ({
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => children,
  FileDiff: (props: RenderProps) => {
    renderer.props.push(props);
    return (
      <div data-testid="rendered-diff" data-style={props.options.diffStyle} data-overflow={props.options.overflow}>
        {props.renderGutterUtility(() => ({ side: "deletions", lineNumber: 2 }))}
        {props.lineAnnotations?.map((annotation) => (
          <div
            key={`${annotation.side}:${annotation.lineNumber}`}
            data-side={annotation.side}
            data-line={annotation.lineNumber}
          >
            {props.renderAnnotation(annotation)}
          </div>
        ))}
      </div>
    );
  },
}));
const reviewId = "11111111-1111-4111-8111-111111111111";
const file = (path = "source.ts", values: Partial<FileView> = {}): FileView => ({
  id: crypto.randomUUID(),
  path,
  oldPath: null,
  role: "diff",
  status: "modified",
  topic: "first",
  order: 0,
  mediaType: "text/plain",
  flag: null,
  hasOld: true,
  hasNew: true,
  ...values,
});
const revision = (files: FileView[], values: Partial<RevisionView> = {}): RevisionView => ({
  seq: 2,
  base: null,
  head: null,
  main: null,
  writeupEmpty: false,
  topics: [{ slug: "first", title: "First", importance: 10, summary: "Synthetic summary" }],
  files,
  threads: [],
  docs: [],
  writeup: { sections: [] },
  changedBlocks: [],
  ...values,
});
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
let parser: ReturnType<typeof vi.fn<DiffParser>>;
let paneWidth: number;
let firstMeasuredStyles: string[] | undefined;
let resizePane: (width: number, contentWidth?: number) => void;
let disconnectPane: ReturnType<typeof vi.fn<() => void>>;
const boundsDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
const originalBounds = HTMLElement.prototype.getBoundingClientRect;
let observers: {
  element: Element;
  options?: IntersectionObserverInit;
  callback: (entries: Partial<IntersectionObserverEntry>[]) => void;
}[];
function near(path: string, value = true) {
  const section = screen.getByRole("region", { name: `File ${path}` });
  const observer = observers.find((o) => o.element === section);
  expect(observer).toBeDefined();
  act(() => observer?.callback([{ isIntersecting: value, target: section }]));
}
async function mount(view: RevisionView, props: Partial<DiffPaneProps> = {}) {
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Panes
          inbox={null}
          header={null}
          reading={null}
          phoneTabs={null}
          tab="diff"
          hasDiff
          diff={<DiffPane reviewId={reviewId} revision={view} parser={parser} {...props} />}
        />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const result = render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Diff" });
  return result;
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  observers = [];
  renderer.props = [];
  renderer.fileStyles = [];
  paneWidth = 900;
  firstMeasuredStyles = undefined;
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      if (this.classList.contains("em-diff-pane")) firstMeasuredStyles ??= [...renderer.fileStyles];
      return this.classList.contains("em-diff-pane") ? new DOMRect(0, 0, paneWidth, 600) : originalBounds.call(this);
    },
  });
  localStorage.clear();
  disconnectPane = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(element: Element) {
        if (!element.classList.contains("em-diff-pane")) return;
        resizePane = (width, contentWidth = width) => {
          paneWidth = width;
          this.callback(
            [{ target: element, contentRect: { width: contentWidth } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        };
      }
      unobserve() {}
      disconnect() {
        disconnectPane();
      }
    },
  );
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private callback: (entries: Partial<IntersectionObserverEntry>[]) => void;
      private options?: IntersectionObserverInit;
      constructor(
        callback: (entries: Partial<IntersectionObserverEntry>[]) => void,
        options?: IntersectionObserverInit,
      ) {
        this.callback = callback;
        this.options = options;
      }
      observe(element: Element) {
        observers.push({ element, options: this.options, callback: this.callback });
      }
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)",
    addEventListener() {},
    removeEventListener() {},
  }));
  fetchMock = vi.fn(async (_path: string, init?: RequestInit) =>
    init?.method === "POST" ? Response.json({}, { status: 201 }) : new Response("one\ntwo\nthree\n"),
  );
  vi.stubGlobal("fetch", fetchMock);
  parser = vi.fn<DiffParser>(parsePair);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  if (boundsDescriptor) Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", boundsDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
  vi.unstubAllGlobals();
});
test("topics sort ascending stably, Other last, files by order, empty headers and metadata are text", async () => {
  const files = [
    file("later.ts", { order: 8 }),
    file("earlier.ts", { order: 1 }),
    file("unknown.ts", { topic: "missing" }),
    file("null.ts", { topic: null }),
    file("doc.md", { role: "doc" }),
    file("asset.png", { role: "asset" }),
  ];
  await mount(
    revision(files, {
      topics: [
        { slug: "low", title: "Low", importance: 1, summary: "", attention: "skim" },
        { slug: "other", title: "Other changes", importance: 100, summary: "" },
        {
          slug: "first",
          title: "First",
          importance: 10,
          summary: "<img src=x onerror=alert(1)>",
          attention: "critical",
          door: "one-way",
          blastRadius: { scope: "local", note: "A synthetic note" },
        },
        { slug: "tie", title: "Tie", importance: 10, summary: "", door: "two-way", attention: "review" },
      ],
    }),
  );
  expect(screen.getAllByRole("heading", { level: 3 }).map((e) => e.textContent)).toEqual([
    "Low",
    "First",
    "Tie",
    "Other changes",
  ]);
  expect(screen.getAllByRole("heading", { level: 4 }).map((e) => e.textContent)).toEqual([
    "earlier.ts",
    "later.ts",
    "unknown.ts",
    "null.ts",
  ]);
  for (const text of ["One-way door", "Two-way door", "<img src=x onerror=alert(1)>"])
    expect(screen.getByText(text)).toBeTruthy();
  expect(screen.getByText("local").parentElement?.textContent).toBe("Blast radius local · A synthetic note");
  for (const [title, attention] of [
    ["Low", "SKIM"],
    ["First", "CRITICAL"],
    ["Tie", "REVIEW"],
  ]) {
    const header = screen.getByRole("heading", { name: title }).closest("header");
    expect(header?.querySelectorAll("[data-attention]")).toHaveLength(1);
    expect(header?.querySelector("[data-attention]")?.textContent).toBe(attention);
  }
  expect(document.querySelector("img")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
test("flagged files never fetch and renamed paths and status stay visible", async () => {
  await mount(
    revision([
      file("binary", { flag: "binary" }),
      file("big", { flag: "oversized" }),
      file("new.ts", { oldPath: "old.ts", status: "renamed" }),
    ]),
  );
  near("binary");
  near("big");
  expect(screen.getByText("Not shown: binary file")).toBeTruthy();
  expect(screen.getByText("Not shown: larger than 1 MiB")).toBeTruthy();
  expect(screen.getByTitle("Renamed from old.ts").textContent).toBe("Renamed from old.ts");
  expect(screen.getByText("renamed")).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(parser).not.toHaveBeenCalled();
});
test("near sections alone load, immutable sides cache across remount and absent sides are skipped", async () => {
  const added = file("added.ts", { hasOld: false, status: "added" });
  const view = revision([added, file("far.ts")]);
  const mounted = await mount(view);
  expect(parser).not.toHaveBeenCalled();
  near("added.ts");
  await screen.findByTestId("rendered-diff");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/files/${added.id}/new`);
  expect(client.getQueryData(["file", added.id, "new"])).toBe("one\ntwo\nthree\n");
  expect(parser.mock.calls[0]?.[0]).toMatchObject({ oldFile: null, newFile: { name: "added.ts" } });
  near("added.ts", false);
  expect(screen.queryByTestId("rendered-diff")).toBeNull();
  mounted.unmount();
  await mount(view);
  near("added.ts");
  await screen.findByTestId("rendered-diff");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
test.each([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "pubspec.lock",
  "mix.lock",
  "Podfile.lock",
])("lockfile %s waits for Show diff", async (name) => {
  await mount(revision([file(`nested/${name}`)]));
  near(`nested/${name}`);
  expect(await screen.findByText("Collapsed: lockfile")).toBeTruthy();
  expect(parser).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Comment on file" }));
  expect(screen.getByLabelText("Comment")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show diff" }));
  await screen.findByTestId("rendered-diff");
  expect(parser).toHaveBeenCalledTimes(1);
});
test("over 20000 combined lines collapses after fetch and before parse", async () => {
  fetchMock.mockResolvedValue(new Response("x\n".repeat(10001)));
  // Responses are consumed once, including when both sides share bytes.
  fetchMock.mockImplementation(async () => new Response("x\n".repeat(10001)));
  await mount(revision([file()]));
  near("source.ts");
  expect(await screen.findByText("Collapsed: 20002 lines")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(parser).not.toHaveBeenCalled();
  parser.mockImplementation(() => parsePair({ oldFile: null, newFile: { name: "source.ts", contents: "x\n" } }));
  fireEvent.click(screen.getByRole("button", { name: "Show diff" }));
  await screen.findByTestId("rendered-diff");
  expect(parser).toHaveBeenCalledTimes(1);
});
test("file and topic buttons save their targets and reopening preserves one draft", async () => {
  await mount(revision([file("source.ts", { flag: "binary" })]));
  for (const [name, target] of [
    ["Comment on topic", { kind: "topic", slug: "first" }],
    ["Comment on file", { kind: "file", path: "source.ts" }],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name }));
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getAllByLabelText("Comment")).toHaveLength(1);
    expect(localStorage.getItem(draftKey(reviewId, target))).toBe(name);
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/reviews/${reviewId}/threads`,
        expect.objectContaining({ body: JSON.stringify({ revision: 2, target, body: name }) }),
      ),
    );
    await waitFor(() => expect(screen.queryByLabelText("Comment")).toBeNull());
  }
});
test("selection maps deletions/additions, refuses mixed sides, and shows range errors", async () => {
  fetchMock.mockImplementation(async () => new Response("x\n".repeat(1100)));
  await mount(revision([file("source.ts", { oldPath: "old.ts" })]));
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  const select = (range: Selection | null) => act(() => renderer.props.at(-1)?.options.onLineSelectionEnd(range));
  select({ side: "additions", start: 10, end: 12 });
  expect(screen.getByText("source.ts · lines 10–12")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "New selection" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([, init]) => init?.body?.toString().includes('"side":"new"'))).toBe(true),
  );
  select({ side: "deletions", start: 12, end: 10 });
  expect(screen.getByText("old.ts · lines 10–12 (old)")).toBeTruthy();
  select({ side: "deletions", endSide: "additions", start: 1, end: 2 });
  expect(screen.getByRole("alert").textContent).toBe("Select lines on one side.");
  expect(screen.queryByLabelText("Comment")).toBeNull();
  select({ side: "additions", start: 1, end: 1001 });
  expect(screen.getByRole("alert").textContent).toBe("Select at most 1000 lines.");
});
test.each([
  [false, "unified"],
  [true, "split"],
])("layout tablet=%s renders %s", async (tablet, style) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: tablet && query === "(min-width: 768px)",
    addEventListener() {},
    removeEventListener() {},
  }));
  await mount(revision([file()]));
  near("source.ts");
  expect((await screen.findByTestId("rendered-diff")).getAttribute("data-style")).toBe(style);
  expect(screen.queryByRole("radiogroup", { name: "Diff layout" }) !== null).toBe(tablet);
  expect(document.querySelector("[data-diff-toolbar]") !== null).toBe(tablet);
});

test("a failed side can retry without reloading the successful side", async () => {
  const source = file();
  let failed = true;
  fetchMock.mockImplementation(async (path: string) =>
    path.endsWith("/old") && failed
      ? Response.json({ error: { code: "not_found", message: "Missing" } }, { status: 404 })
      : new Response("one\ntwo\n"),
  );
  await mount(revision([source]));
  near("source.ts");
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(parser).not.toHaveBeenCalled();
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByTestId("rendered-diff");
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith("/new"))).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith("/old"))).toHaveLength(2);
});
test("long selected text shows the exact refusal and never opens a clipped draft", async () => {
  fetchMock.mockImplementation(async () => new Response("x".repeat(65537)));
  await mount(revision([file()]));
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  act(() => renderer.props.at(-1)?.options.onLineSelectionEnd({ side: "additions", start: 1, end: 1 }));
  expect(screen.getByRole("alert").textContent).toBe("This selection is too long. Select fewer lines.");
  expect(screen.queryByLabelText("Comment")).toBeNull();
});
test("leaving the viewport cancels parsing and re-entry can complete", async () => {
  let signal: AbortSignal | undefined;
  parser.mockImplementationOnce((_pair, abort?: AbortSignal) => {
    signal = abort;
    return new Promise((_resolve, reject) =>
      abort?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }),
    );
  });
  await mount(revision([file()]));
  near("source.ts");
  await waitFor(() => expect(parser).toHaveBeenCalledTimes(1));
  near("source.ts", false);
  expect(signal?.aborted).toBe(true);
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("an open line editor pins its file beyond the viewport margin", async () => {
  await mount(revision([file()]));
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  act(() => renderer.props.at(-1)?.options.onLineSelectionEnd({ side: "additions", start: 1, end: 2 }));
  const input = screen.getByLabelText("Comment");
  input.focus();
  fireEvent.change(input, { target: { value: "Keep focus" } });
  near("source.ts", false);
  expect(screen.getByTestId("rendered-diff")).toBeTruthy();
  expect(screen.getByLabelText("Comment")).toBe(input);
  expect(document.activeElement).toBe(input);
});
test.each([false, true])("viewport margin is relative to the scrolling diff pane (split=%s)", async (split) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: split && query === "(min-width: 768px)",
    addEventListener() {},
    removeEventListener() {},
  }));
  await mount(revision([file("above.ts"), file("far.ts")]));
  const pane = screen.getByTestId("diff-pane");
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, 400));
  for (const [name, top] of [
    ["above.ts", 32],
    ["far.ts", -1000],
  ] as const) {
    const section = screen.getByRole("region", { name: `File ${name}` });
    vi.spyOn(section, "getBoundingClientRect").mockReturnValue(new DOMRect(0, top, 500, 20));
    const observer = observers.find((entry) => entry.element === section);
    expect(observer?.options?.root).toBe(pane);
    expect(observer?.options?.rootMargin).toBe("800px");
    // Model intersection using the configured root and margin; Happy DOM has no layout engine.
    const root = observer?.options?.root;
    if (!(root instanceof Element)) throw new Error("Expected the pane as observer root");
    const bounds = root.getBoundingClientRect();
    const margin = Number.parseInt(observer?.options?.rootMargin ?? "0", 10);
    const rect = section.getBoundingClientRect();
    act(() =>
      observer?.callback([
        { target: section, isIntersecting: rect.bottom >= bounds.top - margin && rect.top <= bounds.bottom + margin },
      ]),
    );
  }
  await screen.findByTestId("rendered-diff");
  expect(parser).toHaveBeenCalledTimes(1);
  expect(parser.mock.calls[0]?.[0].newFile?.name).toBe("above.ts");
});

test("toolbar counts exclude Other, pluralize, and jump menu reveals a collapsed file below sticky rows", async () => {
  const source = file("src/nested/source.ts");
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  await mount(revision([source, file("other.txt", { topic: null })]));
  const topic = screen.getByRole("region", { name: "Topic First" });
  const header = document.getElementById(`diff-file-${source.id}`);
  const toolbar = document.querySelector("[data-diff-toolbar]");
  const topicHeader = topic.querySelector("[data-topic-header]");
  const pane = screen.getByTestId("diff-pane");
  const offset = vi.spyOn(pane, "scrollTo").mockImplementation(() => {});
  Object.defineProperties(pane, { scrollHeight: { value: 3000 }, clientHeight: { value: 600 } });
  if (!header) throw new Error("Missing file header");
  vi.spyOn(header, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 1200, 400, 40));
  if (!toolbar || !topicHeader) throw new Error("Missing toolbar/topic");
  vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 41));
  vi.spyOn(topicHeader, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 41, 400, 110));
  fireEvent.click(within(topic).getByRole("button", { name: "Collapse file" }));
  fireEvent.click(within(topic).getByRole("button", { name: "Collapse topic" }));
  expect(screen.queryByRole("region", { name: "File src/nested/source.ts" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "1 topic · 2 files" }), { key: "ArrowDown" });
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("01 First")).toBeTruthy();
  expect(within(menu).getByText("Other changes")).toBeTruthy();
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["source.ts", "other.txt"]);
  const item = within(menu).getByRole("menuitem", { name: "source.ts" });
  expect(item.title).toBe(source.path);
  fireEvent.click(item);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(within(topic).getByRole("button", { name: "Collapse topic" }).getAttribute("aria-expanded")).toBe("true");
  expect(within(topic).getByRole("button", { name: "Collapse file" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("region", { name: "File src/nested/source.ts" })).toBeTruthy();
  expect(scroll).not.toHaveBeenCalled();
  expect(offset).toHaveBeenCalledExactlyOnceWith({ top: 1041, behavior: "instant" });
});

test("single topic/file counts and parsed additions in the jump menu", async () => {
  await mount(revision([file("src/added.ts", { hasOld: false, status: "added" })]));
  const jump = screen.getByRole("button", { name: "1 topic · 1 file" });
  expect(within(screen.getByRole("region", { name: "Topic First" })).getByText("1 file")).toBeTruthy();
  expect(screen.queryByText("+3")).toBeNull();
  near("src/added.ts");
  await screen.findByText("+3");
  fireEvent.keyDown(jump, { key: "ArrowDown" });
  expect(await screen.findByRole("menuitem", { name: "added.ts +3" })).toBeTruthy();
});

test("Split and Unified change renderer options and survive remount; phone keeps its unified layout", async () => {
  const value = revision([file()]);
  let mounted = await mount(value);
  near("source.ts");
  expect((await screen.findByTestId("rendered-diff")).getAttribute("data-style")).toBe("split");
  fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
  expect(screen.getByTestId("rendered-diff").getAttribute("data-style")).toBe("unified");
  expect(screen.getByRole("radio", { name: "Unified" }).getAttribute("aria-checked")).toBe("true");
  mounted.unmount();
  mounted = await mount(value);
  near("source.ts");
  expect((await screen.findByTestId("rendered-diff")).getAttribute("data-style")).toBe("unified");
  fireEvent.click(screen.getByRole("radio", { name: "Split" }));
  expect(screen.getByTestId("rendered-diff").getAttribute("data-style")).toBe("split");
  mounted.unmount();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  await mount(value);
  near("source.ts");
  expect((await screen.findByTestId("rendered-diff")).getAttribute("data-style")).toBe("unified");
  expect(screen.queryByRole("radiogroup", { name: "Diff layout" })).toBeNull();
  expect(JSON.parse(localStorage.getItem("emend.layout.v1") ?? "{}").diffStyle).toBe("split");
});

test("disabled storage still allows layout changes", async () => {
  layoutStore.getSnapshot();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Disabled");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Disabled");
  });
  await mount(revision([file()]));
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
  expect(screen.getByTestId("rendered-diff").getAttribute("data-style")).toBe("unified");
  fireEvent.click(screen.getByRole("button", { name: "Wrap" }));
  expect(screen.getByTestId("rendered-diff").getAttribute("data-overflow")).toBe("wrap");
});

test("Wrap persists across mounts, controls overflow, and follows the preference on phones", async () => {
  const value = revision([file()]);
  let mounted = await mount(value);
  near("source.ts");
  expect((await screen.findByTestId("rendered-diff")).getAttribute("data-overflow")).toBe("scroll");
  fireEvent.click(screen.getByRole("button", { name: "Wrap" }));
  expect(screen.getByRole("button", { name: "Wrap" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTestId("rendered-diff").getAttribute("data-overflow")).toBe("wrap");
  expect(JSON.parse(localStorage.getItem("emend.layout.v1") ?? "{}").wrap).toBe(true);
  mounted.unmount();
  mounted = await mount(value);
  near("source.ts");
  expect((await screen.findByTestId("rendered-diff")).getAttribute("data-overflow")).toBe("wrap");
  fireEvent.click(screen.getByRole("button", { name: "Wrap" }));
  mounted.unmount();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  mounted = await mount(value);
  near("source.ts");
  expect((await screen.findByTestId("rendered-diff")).getAttribute("data-overflow")).toBe("scroll");
  expect(screen.queryByRole("button", { name: "Wrap" })).toBeNull();
  expect(JSON.parse(localStorage.getItem("emend.layout.v1") ?? "{}").wrap).toBe(false);
  mounted.unmount();
  localStorage.setItem("emend.layout.v1", JSON.stringify({ wrap: true }));
  await mount(value);
  near("source.ts");
  expect((await screen.findByTestId("rendered-diff")).getAttribute("data-overflow")).toBe("wrap");
});

test("Wrap pressed styling follows the toggle state", async () => {
  await mount(revision([file()]));
  const button = screen.getByRole("button", { name: "Wrap" });
  for (const pressed of [false, true, false]) {
    expect(button.getAttribute("aria-pressed")).toBe(String(pressed));
    expect(button.classList.contains("bg-raised")).toBe(pressed);
    expect(button.classList.contains("text-fg-1")).toBe(pressed);
    fireEvent.click(button);
  }
});

test.each([
  { width: 1200, style: "split" },
  { width: 600, style: "unified" },
])("first file render at $width px is only $style after measurement", async ({ width, style }) => {
  paneWidth = width;
  await mount(revision([file()]));
  expect(firstMeasuredStyles).toEqual([]);
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  expect(renderer.fileStyles.length).toBeGreaterThan(0);
  expect(new Set(renderer.fileStyles)).toEqual(new Set([style]));
  expect(new Set(renderer.props.map((props) => props.options.diffStyle))).toEqual(new Set([style]));
});

test("pane uses border-box width for both initial measurement and resize", async () => {
  paneWidth = 760;
  await mount(revision([file()]));
  near("source.ts");
  expect((await screen.findByTestId("rendered-diff")).getAttribute("data-style")).toBe("split");
  act(() => resizePane(760, 720));
  expect(screen.getByTestId("rendered-diff").getAttribute("data-style")).toBe("split");
  act(() => resizePane(759, 720));
  expect(screen.getByTestId("rendered-diff").getAttribute("data-style")).toBe("unified");
});

test.each(["split", "unified"])("missing ResizeObserver immediately uses stored %s", async (style) => {
  vi.stubGlobal("ResizeObserver", undefined);
  paneWidth = 0;
  localStorage.setItem("emend.layout.v1", JSON.stringify({ diffStyle: style }));
  await mount(revision([file()]));
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  expect(new Set(renderer.fileStyles)).toEqual(new Set([style]));
  expect((screen.getByRole("radio", { name: "Split" }) as HTMLButtonElement).disabled).toBe(false);
});

test("pane width forces Unified below 760px without overwriting Split; disabled Split is skipped by keys", async () => {
  localStorage.setItem("emend.layout.v1", JSON.stringify({ diffStyle: "split" }));
  const mounted = await mount(revision([file()]));
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  act(() => resizePane(759));
  expect(screen.getByTestId("rendered-diff").getAttribute("data-style")).toBe("unified");
  let split = screen.getByRole<HTMLButtonElement>("radio", { name: "Split" });
  const unified = screen.getByRole("radio", { name: "Unified" });
  expect(split.disabled).toBe(true);
  expect(split.parentElement?.title).toBe("Widen the diff pane for Split");
  expect(split.parentElement?.classList.contains("pointer-events-none")).toBe(false);
  expect(split.classList.contains("pointer-events-none")).toBe(true);
  expect(document.getElementById(split.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
    "Widen the diff pane for Split",
  );
  fireEvent.click(split);
  unified.focus();
  fireEvent.keyDown(unified, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(unified);
  expect(JSON.parse(localStorage.getItem("emend.layout.v1") ?? "{}").diffStyle).toBe("split");
  act(() => resizePane(760));
  split = screen.getByRole<HTMLButtonElement>("radio", { name: "Split" });
  expect(split.disabled).toBe(false);
  expect(split.getAttribute("aria-describedby")).toBeNull();
  expect(screen.getByTestId("rendered-diff").getAttribute("data-style")).toBe("split");
  fireEvent.click(unified);
  act(() => resizePane(600));
  act(() => resizePane(900));
  expect(screen.getByTestId("rendered-diff").getAttribute("data-style")).toBe("unified");
  mounted.unmount();
  expect(disconnectPane).toHaveBeenCalled();
});

test("gutter comment opens and saves the same old-side line target as number selection", async () => {
  await mount(revision([file("source.ts", { oldPath: "old.ts" })]));
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  const button = screen.getByRole("button", { name: "Comment on line" });
  expect(button.tabIndex).toBe(-1);
  fireEvent.pointerEnter(button);
  fireEvent.click(button);
  expect(screen.getByText("old.ts · line 2 (old)")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "One line" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([, init]) => {
        if (!init?.body) return false;
        const target = JSON.parse(String(init.body)).target;
        return (
          target?.kind === "lines" &&
          target.path === "old.ts" &&
          target.side === "old" &&
          target.start === 2 &&
          target.end === 2
        );
      }),
    ).toBe(true),
  );
});

function placedThread(target: Extract<Target, { kind: "topic" | "file" | "lines" }>, body: string): ThreadView {
  return {
    id: crypto.randomUUID(),
    target,
    placement: { status: "placed", location: target },
    state: "open",
    createdOn: 2,
    comments: [{ id: crypto.randomUUID(), author: "user", body, sent: false, sentOn: null }],
  };
}

test("topic and file counts include placed threads only; collapse keeps topic discussion and restores file state", async () => {
  const topicThread = placedThread({ kind: "topic", slug: "first" }, "Topic discussion");
  const fileThread = placedThread({ kind: "file", path: "source.ts" }, "File discussion");
  const lineThread = placedThread(
    { kind: "lines", path: "source.ts", side: "new", start: 1, end: 1, lines: ["one"], before: [], after: [] },
    "Line discussion",
  );
  const unplaced: ThreadView = {
    ...placedThread({ kind: "file", path: "source.ts" }, "Unplaced discussion"),
    placement: { status: "unplaced", reason: "file-gone" },
  };
  await mount(revision([file()], { threads: [topicThread, fileThread, lineThread, unplaced] }));
  const topic = screen.getByRole("region", { name: "Topic First" });
  const fileRegion = screen.getByRole("region", { name: "File source.ts" });
  expect(topic.querySelector("[data-topic-header]")?.textContent).toContain("3 threads");
  expect(fileRegion.querySelector("[data-file-header]")?.textContent).toContain("2 threads");
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  fireEvent.click(within(fileRegion).getByRole("button", { name: "Collapse file" }));
  expect(within(fileRegion).getByRole("button", { name: "Expand file" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByTestId("rendered-diff")).toBeNull();
  expect(within(fileRegion).getByText("File discussion")).toBeTruthy();
  expect(within(fileRegion).getByText("Line discussion")).toBeTruthy();
  fireEvent.click(within(topic).getByRole("button", { name: "Comment on topic" }));
  fireEvent.click(within(topic).getByRole("button", { name: "Collapse topic" }));
  expect(within(topic).getByRole("button", { name: "Expand topic" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("region", { name: "File source.ts" })).toBeNull();
  expect(screen.getByText("Topic discussion")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Comment" })).toBeTruthy();
  expect(topic.querySelector("[data-topic-header]")?.querySelector("textarea")).toBeNull();
  fireEvent.click(within(topic).getByRole("button", { name: "Expand topic" }));
  expect(within(fileRegion).getByRole("button", { name: "Expand file" })).toBeTruthy();
  fireEvent.click(within(fileRegion).getByRole("button", { name: "Expand file" }));
  await screen.findByTestId("rendered-diff");
  expect(parser).toHaveBeenCalledTimes(1);
});

test.each([
  ["added", "A"],
  ["modified", "M"],
  ["deleted", "D"],
  ["renamed", "R"],
  ["mode-changed", "T"],
] as const)("file header announces %s, with status letter %s", async (status, letter) => {
  const value = file("src/name.ts", { status, oldPath: status === "renamed" ? "old/name.ts" : null });
  await mount(revision([value]));
  const header = document.getElementById(`diff-file-${value.id}`);
  expect(header).toBeTruthy();
  const statusMark = within(header as HTMLElement).getByTitle(status.replaceAll("-", " "));
  expect(within(statusMark).getByText(letter).getAttribute("aria-hidden")).toBe("true");
  expect(within(statusMark).getByText(status.replaceAll("-", " "))).toBeTruthy();
  expect(within(header as HTMLElement).getByRole("heading", { name: "src/name.ts" }).title).toBe("src/name.ts");
  if (status === "renamed")
    expect(within(header as HTMLElement).getByTitle("Renamed from old/name.ts").textContent).toBe(
      "Renamed from old/name.ts",
    );
});

test("file +/- counts come from changed hunk lines, persist after collapse, and binary has none", async () => {
  fetchMock.mockImplementation(
    async (path: string) => new Response(path.endsWith("/old") ? "same\nold\ntail\n" : "same\nnew\nextra\ntail\n"),
  );
  const value = file();
  const binary = file("binary", { flag: "binary" });
  const onParsed = vi.fn();
  await mount(revision([value, binary]), { onParsed });
  const header = document.getElementById(`diff-file-${value.id}`) as HTMLElement;
  expect(within(header).queryByText(/^\+/)).toBeNull();
  near("source.ts");
  expect(await within(header).findByText("+2")).toBeTruthy();
  expect(within(header).getByText("−1")).toBeTruthy();
  expect(onParsed).toHaveBeenCalledWith(value.id, { additions: 2, deletions: 1 });
  fireEvent.click(within(header).getByRole("button", { name: "Collapse file" }));
  expect(within(header).getByText("+2")).toBeTruthy();
  expect(within(document.getElementById(`diff-file-${binary.id}`) as HTMLElement).queryByText(/^[+−]\d/)).toBeNull();
});

test("Other keeps its unranked header, files and comments but never a Writeup link", async () => {
  await mount(revision([file("misc.txt", { topic: null })], { topics: [] }), { writeupVisible: false });
  const topic = screen.getByRole("region", { name: "Topic Other changes" });
  expect(screen.getByRole("button", { name: "0 topics · 1 file" })).toBeTruthy();
  expect(within(topic).getByText("—").getAttribute("aria-hidden")).toBe("true");
  expect(within(topic).queryByRole("link", { name: "Writeup" })).toBeNull();
  fireEvent.click(within(topic).getByRole("button", { name: "Comment on topic" }));
  expect(screen.getByRole("textbox", { name: "Comment" })).toBeTruthy();
});

test.each([390, 768, 1280])("R8 fix1 deep paths and rename labels remain complete at %s px", async (width) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(query.match(/\d+/)?.[0] ?? Infinity),
    addEventListener() {},
    removeEventListener() {},
  }));
  const path = "source/very/deep/important/directory/tree/with/a/long/module-name.ts";
  const oldPath = "previous/equally/deep/directory/tree/old-module-name.ts";
  await mount(revision([file(path, { oldPath, status: "renamed", flag: "binary" })]));
  const heading = screen.getByRole("heading", { level: 4, name: path });
  expect(heading.textContent).toBe(path);
  expect(heading.querySelector("bdi")?.textContent).toBe(path);
  expect(heading.querySelectorAll("wbr")).toHaveLength(path.split("/").length - 1);
  const renamed = screen.getByTitle(`Renamed from ${oldPath}`);
  expect(renamed.textContent).toBe(`Renamed from ${oldPath}`);
  expect(renamed.querySelector("bdi")?.textContent).toBe(oldPath);
});

test.each([390, 1280])("R8 fix1 a revision without a writeup has no Writeup link at %s px", async (width) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(query.match(/\d+/)?.[0] ?? Infinity),
    addEventListener() {},
    removeEventListener() {},
  }));
  await mount(revision([file()], { writeupEmpty: true, main: "diff" }), { writeupVisible: false });
  expect(screen.queryByRole("link", { name: "Writeup" })).toBeNull();
});

test("dragging reading across the 760px diff threshold switches presentation without remounting", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("em-diff-pane")) {
      const reading = document.querySelector<HTMLElement>("[data-reading-scroll]");
      return new DOMRect(0, 0, 1400 - Number.parseFloat(reading?.style.flexBasis ?? "588") - 8, 600);
    }
    return new DOMRect(0, 0, 1400, 600);
  });
  await mount(revision([file()]));
  near("source.ts");
  const rendered = await screen.findByTestId("rendered-diff");
  expect(rendered.getAttribute("data-style")).toBe("split");
  const handle = screen.getByRole("separator", { name: "Resize reading pane" });
  Object.assign(handle, { setPointerCapture() {}, hasPointerCapture: () => false });
  const write = vi.spyOn(localStorage, "setItem");
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 588 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 });
  act(() => resizePane(692));
  expect(screen.getByTestId("rendered-diff")).toBe(rendered);
  expect(rendered.getAttribute("data-style")).toBe("unified");
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500 });
  act(() => resizePane(892));
  expect(screen.getByTestId("rendered-diff")).toBe(rendered);
  expect(rendered.getAttribute("data-style")).toBe("split");
  expect(write).not.toHaveBeenCalled();
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 500 });
  expect(write).toHaveBeenCalledTimes(1);
  expect(layoutStore.getSnapshot().diffStyle).toBe("split");
});

test("a hidden pane's zero-width resize keeps its last diff style", async () => {
  await mount(revision([file()]));
  near("source.ts");
  const rendered = await screen.findByTestId("rendered-diff");
  expect(rendered.getAttribute("data-style")).toBe("split");
  act(() => resizePane(0));
  expect(rendered.getAttribute("data-style")).toBe("split");
  act(() => resizePane(600));
  expect(rendered.getAttribute("data-style")).toBe("unified");
  act(() => resizePane(0));
  expect(rendered.getAttribute("data-style")).toBe("unified");
  expect(screen.getByTestId("rendered-diff")).toBe(rendered);
  act(() => resizePane(900));
  expect(rendered.getAttribute("data-style")).toBe("split");
});

test("a diff starting hidden waits for its first positive measurement then mounts its files", async () => {
  paneWidth = 0;
  await mount(revision([file()]));
  expect(screen.queryByTestId("rendered-diff")).toBeNull();
  expect(renderer.fileStyles).toEqual([]);
  act(() => resizePane(0));
  expect(screen.queryByTestId("rendered-diff")).toBeNull();
  act(() => resizePane(900));
  near("source.ts");
  expect((await screen.findByTestId("rendered-diff")).getAttribute("data-style")).toBe("split");
});

test("a viewed file parses counts while collapsed without rendering its body, and counts survive a remount", async () => {
  fetchMock.mockImplementation(async (path: string) => new Response(path.endsWith("/old") ? "old\n" : "new\nextra\n"));
  const value = file("counted.ts", { viewed: "viewed", viewedOn: 1 });
  const onParsed = vi.fn();
  const mounted = await mount(revision([value]), { onParsed });
  const header = within(document.getElementById(`diff-file-${value.id}`) as HTMLElement);
  expect(await header.findByText("+2")).toBeTruthy();
  expect(header.getByText("−1")).toBeTruthy();
  expect(header.getByRole("button", { name: "Expand file" })).toBeTruthy();
  expect(screen.queryByTestId("rendered-diff")).toBeNull();
  expect(onParsed).toHaveBeenCalledWith(value.id, { additions: 2, deletions: 1 });
  expect(parser).toHaveBeenCalledOnce();
  mounted.unmount();
  client.removeQueries({ queryKey: ["file-diff", value.id] });
  await mount(revision([value]));
  expect(screen.getByText("+2")).toBeTruthy();
  expect(parser).toHaveBeenCalledOnce();
});

test("counts-only loading respects the line limit, lockfiles and flagged content", async () => {
  const large = file("large.ts", { viewed: "viewed", viewedOn: 2 });
  const lock = file("pnpm-lock.yaml", { viewed: "viewed", viewedOn: 2 });
  const flagged = file("binary.dat", { viewed: "viewed", viewedOn: 2, flag: "binary" });
  fetchMock.mockImplementation(
    async (path: string) => new Response(path.endsWith("/old") ? "line\n".repeat(20001) : ""),
  );
  await mount(revision([large, lock, flagged]));
  await waitFor(() => expect(client.getQueryState(["file-counts", large.id])?.status).toBe("success"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.every(([path]) => String(path).includes(large.id))).toBe(true);
  expect(parser).not.toHaveBeenCalled();
  expect(screen.queryByTestId("rendered-diff")).toBeNull();
  expect(client.getQueryData(["file-counts", large.id])).toBeNull();
});

test("counts wait for visible diffs and never exceed three concurrent background loads", async () => {
  const visible = file("visible.ts");
  const background = Array.from({ length: 12 }, (_, index) =>
    file(`file-${index}.ts`, { viewed: "viewed", viewedOn: 2 }),
  );
  const visibleLoads: (() => void)[] = [];
  const loads: (() => void)[] = [];
  let active = 0,
    maximum = 0;
  fetchMock.mockImplementation(
    (path: string) =>
      new Promise<Response>((resolve) => {
        const body = path.endsWith("/old") ? "before\n" : "after\n";
        if (path.includes(visible.id)) visibleLoads.push(() => resolve(new Response(body)));
        else {
          active++;
          maximum = Math.max(maximum, active);
          loads.push(() => {
            active--;
            resolve(new Response(body));
          });
        }
      }),
  );
  await mount(revision([visible, ...background]));
  near(visible.path);
  await waitFor(() => expect(visibleLoads).toHaveLength(2));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(loads).toHaveLength(0);
  await act(async () => {
    for (const release of visibleLoads) release();
  });
  await screen.findByTestId("rendered-diff");
  await waitFor(() => expect(loads).toHaveLength(3));
  let released = 0;
  while (released < background.length * 2) {
    await waitFor(() => expect(loads.length).toBeGreaterThan(released));
    await act(async () => {
      const next = loads.length;
      for (const release of loads.slice(released, next)) release();
      released = next;
    });
  }
  await waitFor(() => expect(parser).toHaveBeenCalledTimes(background.length + 1));
  expect(maximum).toBe(3);
  expect(active).toBe(0);
});

function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? width >= 768 : query === "(min-width: 1280px)" ? width >= 1280 : false,
    addEventListener() {},
    removeEventListener() {},
  }));
}
const detailed = () =>
  revision([file("src/a.ts", { oldPath: "src/b.ts" })], {
    topics: [
      {
        slug: "first",
        title: "A long topic title that has to be cut to one line on a phone",
        importance: 10,
        summary: "Synthetic summary",
        attention: "review",
        door: "one-way",
        blastRadius: { scope: "local", note: "A synthetic note" },
      },
    ],
  });
const detailsButton = () =>
  within(screen.getByRole("region", { name: /^Topic / })).getByRole("button", { name: "Details" });
const savedDetails = () => JSON.parse(localStorage.getItem("emend.layout.v1") ?? "{}").details;
const diffStylesheet = readFileSync(resolve(import.meta.dirname, "../../styles/diff.css"), "utf8");

test.each([
  [1280, true],
  [800, true],
  [390, false],
])("topic headers start full or compact by device class (%s px)", async (width, full) => {
  stubWidth(width);
  await mount(detailed());
  expect(detailsButton().getAttribute("aria-pressed")).toBe(String(full));
  expect(screen.getByText("Synthetic summary").closest("[hidden]") === null).toBe(full);
  expect(screen.getByText(/A synthetic note/).closest("[hidden]") === null).toBe(full);
  // The second line stays in both modes: attention, door, file count.
  expect(screen.getByText("One-way door")).toBeTruthy();
  expect(screen.getByText("1 file")).toBeTruthy();
});

test("the compact title is one cut line with the full title in its title attribute", async () => {
  stubWidth(390);
  const view = detailed();
  await mount(view);
  const title = screen.getByRole("heading", { level: 3 });
  expect(title.getAttribute("title")).toBe(view.topics[0]?.title);
  expect(title.classList.contains("truncate")).toBe(true);
});

test("Details flips one preference per device class for every topic header and saves it", async () => {
  stubWidth(390);
  const view = revision([file("a.ts"), file("b.ts", { topic: "second" })], {
    topics: [
      { slug: "first", title: "First", importance: 10, summary: "First summary" },
      { slug: "second", title: "Second", importance: 20, summary: "Second summary" },
    ],
  });
  await mount(view);
  const buttons = screen.getAllByRole("button", { name: "Details" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0] as HTMLElement);
  for (const button of screen.getAllByRole("button", { name: "Details" }))
    expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("Second summary").closest("[hidden]")).toBeNull();
  expect(savedDetails()).toEqual({ phone: true, tablet: true, desktop: true });
  fireEvent.click(screen.getAllByRole("button", { name: "Details" })[1] as HTMLElement);
  expect(savedDetails().phone).toBe(false);
  expect(screen.getByText("Second summary").closest("[hidden]")).not.toBeNull();
});

test("the tablet preference is separate from the phone one", async () => {
  stubWidth(800);
  await mount(detailed());
  fireEvent.click(detailsButton());
  expect(savedDetails()).toEqual({ phone: false, tablet: false, desktop: true });
  expect(screen.getByText("Synthetic summary").closest("[hidden]")).not.toBeNull();
  expect(screen.getByText(/A synthetic note/).closest("[hidden]")).not.toBeNull();
});

test("the phone topic header scrolls with the page; the file header sticks inside its own file", async () => {
  stubWidth(390);
  await mount(detailed());
  expect(screen.getByRole("region", { name: /^Topic / }).hasAttribute("data-phone")).toBe(true);
  expect(diffStylesheet).toMatch(/\.em-diff-topic\[data-phone\] \.em-topic\s*\{[^}]*position:\s*static;/);
  const header = document.querySelector("[data-file-header]");
  expect(header?.closest(".em-diff-file")).not.toBeNull();
  const rule = diffStylesheet.match(/\.em-file\s*\{([^}]+)\}/)?.[1] ?? "";
  expect(rule).toMatch(/position:\s*sticky;/);
  expect(rule).toMatch(/top:\s*calc\(var\(--diff-toolbar-height\) \+ var\(--em-topic-height, 0px\)\);/);
  expect(rule).toMatch(/z-index:\s*calc\(var\(--z-sticky\) - 1\);/);
  expect(rule).toMatch(/background:\s*var\(--bg-sunken\);/);
  expect(diffStylesheet).toMatch(/\.em-diff-file\s*\{[^}]*isolation:\s*isolate;/);
});

test("the file header keeps the full path readable while the phone cuts it from the left", async () => {
  stubWidth(390);
  await mount(detailed());
  const path = document.querySelector("[data-file-header] h4");
  expect(path?.getAttribute("title")).toBe("src/a.ts");
  expect(path?.getAttribute("aria-label")).toBe("src/a.ts");
  expect(diffStylesheet).toMatch(/\.em-file-path\s*\{[^}]*direction:\s*rtl;[^}]*text-overflow:\s*ellipsis;/);
  expect(document.querySelector("[data-file-header] p")?.getAttribute("title")).toBe("Renamed from src/b.ts");
});

test("desktop sets the topic height on its section so the file header sticks right below it", async () => {
  stubWidth(1280);
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-topic-header") ? new DOMRect(0, 0, 400, 92) : bounds.call(this);
  });
  await mount(detailed());
  const section = screen.getByRole("region", { name: /^Topic / });
  expect(section.hasAttribute("data-phone")).toBe(false);
  expect(section.style.getPropertyValue("--em-topic-height")).toBe("92px");
  expect(diffStylesheet).toMatch(
    /\.em-diff-file\s*\{[^}]*scroll-margin-top:\s*calc\([^;]*var\(--em-topic-height, 0px\)/,
  );
});

test("the details sit outside the sticky header, and Details controls that one element", async () => {
  stubWidth(1280);
  await mount(detailed());
  const header = document.querySelector("[data-topic-header]") as HTMLElement;
  const details = document.querySelector("[data-topic-details]") as HTMLElement;
  expect(header.contains(details)).toBe(false);
  expect(header.nextElementSibling).toBe(details);
  expect(details.id).not.toBe("");
  expect(detailsButton().getAttribute("aria-controls")).toBe(details.id);
  expect(details.textContent).toContain("Synthetic summary");
  expect(details.textContent).toContain("Blast radius");
  expect(details.textContent).toContain("A synthetic note");
  // The sticky part keeps only the title, buttons and the meta row.
  expect(header.textContent).not.toContain("Synthetic summary");
  expect(header.textContent).not.toContain("Blast radius");
  expect(header.contains(screen.getByText("One-way door"))).toBe(true);
});

test("the compact meta row stays one line and is cut from its end", () => {
  expect(diffStylesheet).toMatch(
    /\.em-topic-meta\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow:\s*hidden;[^}]*white-space:\s*nowrap;/,
  );
});

test("Details keeps the toggled header where the reader saw it", async () => {
  stubWidth(390);
  await mount(detailed());
  const pane = screen.getByTestId("diff-pane");
  const header = document.querySelector("[data-topic-header]") as HTMLElement;
  const details = document.querySelector("[data-topic-details]") as HTMLElement;
  pane.scrollTop = 1000;
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 50, 400, 600));
  // Opening the details above the header pushes it down by 120px.
  vi.spyOn(header, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, details.hidden ? 450 : 570, 400, 60),
  );
  fireEvent.click(detailsButton());
  expect(details.hidden).toBe(false);
  expect(pane.scrollTop).toBe(1120);
  fireEvent.click(detailsButton());
  expect(pane.scrollTop).toBe(1000);
});

test("paths keep their order in an isolated left-to-right run, and the rename source is cut from the left", async () => {
  stubWidth(390);
  await mount(detailed());
  for (const bdi of document.querySelectorAll("[data-file-header] bdi")) expect(bdi.getAttribute("dir")).toBe("ltr");
  const from = document.querySelector("[data-file-header] p .em-file-from");
  expect(from?.textContent).toBe("src/b.ts");
  expect(document.querySelector("[data-file-header] p .em-file-from-label")?.textContent).toBe("Renamed from");
  expect(diffStylesheet).toMatch(/\.em-file-from\s*\{[^}]*direction:\s*rtl;[^}]*text-overflow:\s*ellipsis;/);
  expect(diffStylesheet).toMatch(/\.em-file-from-label\s*\{[^}]*flex-shrink:\s*0;/);
});

test("the toolbar offset is 0px on the phone, where the toolbar is hidden, and 41px beside it", async () => {
  expect(diffStylesheet).toMatch(/\.em-diff-pane\s*\{[^}]*--diff-toolbar-height:\s*0px;/);
  expect(diffStylesheet).toMatch(/\.em-diff-pane\[data-toolbar\]\s*\{[^}]*--diff-toolbar-height:\s*41px;/);
  stubWidth(390);
  const phone = await mount(detailed());
  expect(document.querySelector(".em-diff-pane")?.hasAttribute("data-toolbar")).toBe(false);
  expect(document.querySelector("[data-diff-toolbar]")).toBeNull();
  phone.unmount();
  stubWidth(800);
  await mount(detailed());
  expect(document.querySelector(".em-diff-pane")?.hasAttribute("data-toolbar")).toBe(true);
});

test("the phone leaves the topic height at zero because that header does not stick", async () => {
  stubWidth(390);
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-topic-header") ? new DOMRect(0, 0, 400, 92) : bounds.call(this);
  });
  await mount(detailed());
  expect(screen.getByRole("region", { name: /^Topic / }).style.getPropertyValue("--em-topic-height")).toBe("0px");
});
