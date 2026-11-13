import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FileView, RevisionView, Target, ThreadView } from "@emend/contract";
import type { GetHoveredLineResult } from "@pierre/diffs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claimDraft } from "../../lib/composer-owner.ts";
import type { NavigateDiff } from "../../lib/diff-navigation.ts";
import { draftKey, isAnyDraftSaving, saveDraft } from "../../lib/drafts.ts";
import { layoutStore } from "../../lib/layout-store.ts";
import { viewedState } from "../../lib/viewed-state.ts";
import { Panes } from "../layout/Panes.tsx";
import { DiffPane, type DiffPaneProps } from "./DiffPane.tsx";
import type { DiffPostRender, ParsedDiff } from "./FileDiff.tsx";
import { parsePair } from "./parse.worker.ts";
import type { DiffParser } from "./parse-client.ts";
import { diffHoldQuietMs, useFileOrder } from "./presentation.ts";

type Selection = { side?: "additions" | "deletions"; endSide?: "additions" | "deletions"; start: number; end: number };
type Annotation = { side: string; lineNumber: number; metadata: ReactNode };
type RenderProps = {
  fileDiff: ParsedDiff;
  options: {
    diffStyle: string;
    overflow: string;
    onLineSelectionEnd: (range: Selection | null) => void;
    onPostRender: DiffPostRender;
  };
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
function postRender(rendered: boolean, failed = false) {
  const host = screen.getByTestId("rendered-diff");
  const phase = host.shadowRoot ? "update" : "mount";
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  if (rendered) {
    const line = document.createElement("div");
    line.dataset.line = "1";
    shadow.append(line);
  }
  if (failed) {
    const error = document.createElement("div");
    error.dataset.errorWrapper = "";
    shadow.append(error);
  }
  const props = renderer.props.at(-1);
  if (!props) throw new Error("Missing renderer props");
  const instance = { expandHunk: vi.fn(), getLineIndex: vi.fn() } as unknown as Parameters<DiffPostRender>[1];
  act(() => props.options.onPostRender(host, instance, phase));
}
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
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
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
  if (execCommandDescriptor) Object.defineProperty(document, "execCommand", execCommandDescriptor);
  else Reflect.deleteProperty(document, "execCommand");
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  layoutStore.update({ fileOrder: "topics" });
});
test.each([true, false])("topic totals precede parsing and survive folding (counted: %s)", async (counted) => {
  await mount(
    revision([
      file("a.ts", { counts: counted ? { additions: 2, deletions: 3 } : undefined }),
      file("b.ts", { counts: counted ? { additions: 4, deletions: 1 } : undefined }),
      file("c.ts", { topic: null, counts: counted ? { additions: 7, deletions: 8 } : undefined }),
    ]),
  );
  for (const [name, added, removed] of [
    ["Topic First", "+6", "−4"],
    ["Topic Other changes", "+7", "−8"],
  ] as const) {
    const section = screen.getByRole("region", { name });
    const header = section.querySelector<HTMLElement>("[data-topic-header]");
    if (!header) throw new Error("Missing topic header");
    if (counted) {
      expect(within(header).getByText(added)).toBeTruthy();
      expect(within(header).getByText(removed)).toBeTruthy();
    } else expect(header.querySelector(".text-diff-add-fg, .text-diff-del-fg")).toBeNull();
    fireEvent.click(within(header).getByRole("button", { name: "Collapse topic" }));
    if (counted) expect(within(header).getByText(added)).toBeTruthy();
  }
  expect(parser).not.toHaveBeenCalled();
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
test("a file marks its mounted body while fetching and parsing, then clears the loading mark", async () => {
  const response = Promise.withResolvers<Response>();
  const parsed = Promise.withResolvers<ReturnType<typeof parsePair>>();
  fetchMock.mockReturnValue(response.promise);
  parser.mockReturnValue(parsed.promise);
  await mount(revision([file("loading.ts", { hasOld: false, status: "added" })]));
  const section = screen.getByRole("region", { name: "File loading.ts" });
  expect(section.hasAttribute("data-diff-loading")).toBe(false);
  near("loading.ts");
  expect(section.hasAttribute("data-diff-loading")).toBe(true);
  response.resolve(new Response("one\ntwo\n"));
  await waitFor(() => expect(parser).toHaveBeenCalledOnce());
  expect(section.hasAttribute("data-diff-loading")).toBe(true);
  parsed.resolve(parsePair({ oldFile: null, newFile: { name: "loading.ts", contents: "one\ntwo\n" } }));
  await screen.findByTestId("rendered-diff");
  postRender(true);
  await waitFor(() => expect(section.hasAttribute("data-diff-loading")).toBe(false));
});
test("a parsed diff stays marked as loading until Pierre draws its first lines", async () => {
  await mount(revision([file("delayed.ts", { hasOld: false, status: "added" })]));
  near("delayed.ts");
  const host = await screen.findByTestId("rendered-diff");
  const section = screen.getByRole("region", { name: "File delayed.ts" });
  expect(renderer.props.at(-1)?.fileDiff.hunks.length).toBeGreaterThan(0);
  postRender(false);
  expect(host.shadowRoot?.querySelector("[data-line]")).toBeNull();
  expect(section.hasAttribute("data-diff-loading")).toBe(true);
  postRender(true);
  expect(host.shadowRoot?.querySelector("[data-line]")).toBeTruthy();
  expect(section.hasAttribute("data-diff-loading")).toBe(false);
});
test("a parsed diff clears its loading marker when Pierre fails to render", async () => {
  await mount(revision([file("failed.ts", { hasOld: false, status: "added" })]));
  near("failed.ts");
  const host = await screen.findByTestId("rendered-diff");
  const section = screen.getByRole("region", { name: "File failed.ts" });
  expect(renderer.props.at(-1)?.fileDiff.hunks.length).toBeGreaterThan(0);
  postRender(false);
  expect(section.hasAttribute("data-diff-loading")).toBe(true);
  postRender(false, true);
  expect(host.shadowRoot?.querySelector("[data-error-wrapper]")).toBeTruthy();
  expect(host.shadowRoot?.querySelector("[data-line]")).toBeNull();
  expect(section.hasAttribute("data-diff-loading")).toBe(false);
});
test("a parsed diff with no hunks clears its loading marker without drawing lines", async () => {
  await mount(revision([file("identical.ts")]));
  near("identical.ts");
  const host = await screen.findByTestId("rendered-diff");
  const section = screen.getByRole("region", { name: "File identical.ts" });
  expect(renderer.props.at(-1)?.fileDiff.hunks).toHaveLength(0);
  postRender(false);
  expect(host.shadowRoot?.querySelector("[data-line]")).toBeNull();
  expect(section.hasAttribute("data-diff-loading")).toBe(false);
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
  const offset = vi.spyOn(pane, "scrollTo").mockImplementation((options?: number | ScrollToOptions) => {
    if (options && typeof options === "object") pane.scrollTop = options.top ?? 0;
  });
  Object.defineProperties(pane, { scrollHeight: { value: 3000 }, clientHeight: { value: 600 } });
  if (!header) throw new Error("Missing file header");
  const section = screen.getByRole("region", { name: "File src/nested/source.ts" });
  vi.spyOn(section, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 1200 - pane.scrollTop, 400, 1000));
  vi.spyOn(header, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, Math.max(151, section.getBoundingClientRect().top), 400, 40),
  );
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
  const value = file("src/added.ts", { hasOld: false, status: "added" });
  await mount(revision([value]));
  const jump = screen.getByRole("button", { name: "1 topic · 1 file" });
  expect(within(screen.getByRole("region", { name: "Topic First" })).getByText("1 file")).toBeTruthy();
  expect(screen.queryByText("+3")).toBeNull();
  near("src/added.ts");
  await within(document.getElementById(`diff-file-${value.id}`) as HTMLElement).findByText("+3");
  fireEvent.keyDown(jump, { key: "ArrowDown" });
  expect(await screen.findByRole("menuitem", { name: "added.ts +3" })).toBeTruthy();
});

test("A to Z flattens files and keeps topic folds when switching back", async () => {
  const last = file("src/z.ts", { flag: "binary" });
  const first = file("src/a/b.ts", { flag: "binary", order: 1 });
  const other = file("src/m.ts", { flag: "binary", topic: null });
  await mount(revision([last, first, other, file("doc.md", { role: "doc" })]));
  const ids = () => [...document.querySelectorAll('[id^="diff-file-"]')].map((element) => element.id);
  expect(ids()).toEqual([last, first, other].map((file) => `diff-file-${file.id}`));
  const topic = screen.getByRole("region", { name: "Topic First" });
  fireEvent.click(within(topic).getByRole("button", { name: "Collapse topic" }));
  expect(screen.queryByRole("region", { name: `File ${first.path}` })).toBeNull();
  act(() => layoutStore.update({ fileOrder: "path" }));
  expect(screen.queryByRole("region", { name: /^Topic / })).toBeNull();
  expect(document.querySelector("[data-topic]")).toBeNull();
  expect(ids()).toEqual([first, other, last].map((file) => `diff-file-${file.id}`));
  for (const source of [first, other, last]) {
    const section = screen.getByRole("region", { name: `File ${source.path}` });
    expect(section.closest("[hidden]")).toBeNull();
    expect(within(section).getByText("Not shown: binary file")).toBeTruthy();
  }
  act(() => layoutStore.update({ fileOrder: "topics" }));
  expect(screen.getByRole("region", { name: "Topic Other changes" })).toBeTruthy();
  const restored = screen.getByRole("region", { name: "Topic First" });
  expect(within(restored).getByRole("button", { name: "Expand topic" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("region", { name: `File ${first.path}` })).toBeNull();
  fireEvent.click(within(restored).getByRole("button", { name: "Expand topic" }));
  expect(ids()).toEqual([last, first, other].map((file) => `diff-file-${file.id}`));
});

test("the jump menu switches order without closing and lists full paths in A to Z", async () => {
  const last = file("apps/web-x/a.ts", { flag: "binary" });
  const second = file("apps/web/y.ts", { order: 1 });
  const first = file("apps/web/x.ts", { flag: "binary", topic: null });
  await mount(revision([last, second, first]));
  near(second.path);
  await within(document.getElementById(`diff-file-${second.id}`) as HTMLElement).findByText("+0");
  fireEvent.keyDown(screen.getByRole("button", { name: "1 topic · 3 files" }), { key: "ArrowDown" });
  const menu = await screen.findByRole("menu");
  const order = within(menu).getByLabelText("File order");
  const heading = within(menu).getByText("01 First");
  expect(order.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(order).getByRole("menuitemradio", { name: "Topics" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(order).getByRole("menuitemradio", { name: "A to Z" }));
  expect(screen.getByRole("menu")).toBe(menu);
  expect(within(order).getByRole("menuitemradio", { name: "A to Z" }).getAttribute("aria-checked")).toBe("true");
  expect(layoutStore.getSnapshot().fileOrder).toBe("path");
  expect(within(menu).queryByText("01 First")).toBeNull();
  expect(within(menu).queryByText("Other changes")).toBeNull();
  const items = within(menu).getAllByRole("menuitem");
  expect(items.map((item) => item.title)).toEqual([first.path, second.path, last.path]);
  expect(items.map((item) => item.textContent)).toEqual([first.path, `${second.path}+0`, last.path]);
  for (const item of items) expect(item.querySelector("svg")).not.toBeNull();
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(screen.getByRole("button", { name: "3 files" })).toBeTruthy();
});

test.each(["topics", "path"] as const)("file and line-thread jumps reveal files in %s order", async (order) => {
  layoutStore.update({ fileOrder: order });
  const source = file("src/source.ts", { viewed: "viewed", viewedOn: 2 });
  const thread = placedThread(
    { kind: "lines", path: source.path, side: "new", start: 1, end: 1, lines: ["one"], before: [], after: [] },
    "Line discussion",
  );
  let navigate: NavigateDiff | null = null;
  await mount(revision([file("z.ts", { flag: "binary" }), source], { threads: [thread] }), {
    onNavigator: (value) => {
      navigate = value;
    },
  });
  const pane = screen.getByTestId("diff-pane");
  const section = screen.getByRole("region", { name: `File ${source.path}` });
  const header = document.getElementById(`diff-file-${source.id}`);
  if (!header) throw new Error("Missing file header");
  Object.defineProperties(pane, { scrollHeight: { value: 3000 }, clientHeight: { value: 600 } });
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 900, 600));
  vi.spyOn(section, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 900, 900, 1000));
  vi.spyOn(header, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 900, 900, 40));
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation(() => {});
  expect(within(section).getByRole("button", { name: "Expand file" })).toBeTruthy();
  act(() => expect(navigate?.({ elementId: header.id })).toBe(false));
  act(() => expect(navigate?.({ elementId: header.id })).toBe(true));
  expect(scroll).toHaveBeenLastCalledWith({ top: 892, behavior: "instant" });
  expect(within(section).getByRole("button", { name: "Collapse file" })).toBeTruthy();
  await screen.findByTestId("rendered-diff");
  const card = document.getElementById(`diff-thread-${thread.id}`);
  if (!card) throw new Error("Missing line thread");
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 1100, 900, 100));
  expect(section.contains(card)).toBe(true);
  await waitFor(() => expect(card.closest("[data-slot-pending]")).toBeNull());
  fireEvent.click(within(section).getByRole("button", { name: "Collapse file" }));
  act(() => expect(navigate?.({ elementId: card.id })).toBe(false));
  await screen.findByTestId("rendered-diff");
  act(() => expect(navigate?.({ elementId: card.id })).toBe(true));
  expect(scroll).toHaveBeenLastCalledWith({ top: 1052, behavior: "instant" });
  expect(within(section).getByRole("button", { name: "Collapse file" })).toBeTruthy();
});

test.each(["elementId", "target"] as const)("topic %s jumps to its first A to Z file and keeps folds", async (via) => {
  const last = file("z.ts", { flag: "binary" });
  const first = file("a.ts", { flag: "binary", order: 1, viewed: "viewed", viewedOn: 2 });
  let navigate: NavigateDiff | null = null;
  await mount(
    revision([last, first, file("0.ts", { flag: "binary", topic: null })], {
      topics: [
        { slug: "first", title: "First", importance: 10, summary: "" },
        { slug: "empty", title: "Empty", importance: 20, summary: "" },
      ],
    }),
    {
      onNavigator: (value) => {
        navigate = value;
      },
    },
  );
  const topic = screen.getByRole("region", { name: "Topic First" });
  fireEvent.click(within(topic).getByRole("button", { name: "Collapse topic" }));
  act(() => layoutStore.update({ fileOrder: "path" }));
  const pane = screen.getByTestId("diff-pane");
  const section = screen.getByRole("region", { name: `File ${first.path}` });
  Object.defineProperties(pane, { scrollHeight: { value: 3000 }, clientHeight: { value: 600 } });
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 900, 600));
  vi.spyOn(section, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 900, 900, 1000));
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation(() => {});
  const destination =
    via === "elementId" ? { elementId: "diff-topic-first" } : { target: { kind: "topic" as const, slug: "first" } };
  act(() => expect(navigate?.(destination)).toBe(false));
  act(() => expect(navigate?.(destination)).toBe(true));
  expect(scroll).toHaveBeenLastCalledWith({ top: 892, behavior: "instant" });
  expect(within(section).getByRole("button", { name: "Collapse file" })).toBeTruthy();
  act(() => expect(navigate?.({ elementId: "diff-topic-empty" })).toBe(false));
  act(() => expect(navigate?.({ target: { kind: "topic", slug: "missing" } })).toBe(false));
  act(() => layoutStore.update({ fileOrder: "topics" }));
  const restored = screen.getByRole("region", { name: "Topic First" });
  expect(within(restored).getByRole("button", { name: "Expand topic" })).toBeTruthy();
});

test("A to Z keeps placed topic threads in topic order between unplaced comments and files", async () => {
  layoutStore.update({ fileOrder: "path" });
  const first = placedThread({ kind: "topic", slug: "first" }, "First discussion");
  const second = placedThread({ kind: "topic", slug: "second" }, "Second discussion");
  const missing = placedThread({ kind: "topic", slug: "missing" }, "Missing topic");
  let navigate: NavigateDiff | null = null;
  await mount(
    revision([file("source.ts", { flag: "binary" })], {
      topics: [
        { slug: "second", title: "Second", importance: 20, summary: "" },
        { slug: "first", title: "First", importance: 10, summary: "" },
      ],
      threads: [second, missing, first],
    }),
    {
      onNavigator: (value) => {
        navigate = value;
      },
    },
  );
  const comments = screen.getByRole("region", { name: "Topic comments" });
  expect(within(comments).getByRole("heading", { name: "Topic comments" })).toBeTruthy();
  expect([...comments.querySelectorAll("[data-thread-card]")].map((card) => card.id)).toEqual([
    `diff-thread-${first.id}`,
    `diff-thread-${second.id}`,
  ]);
  expect(within(comments).getByText("First discussion")).toBeTruthy();
  expect(within(comments).getByText("Second discussion")).toBeTruthy();
  expect(within(comments).queryByText("Missing topic")).toBeNull();
  const unplaced = screen.getByRole("region", { name: "Unplaced comments" });
  expect(within(unplaced).getByText("Missing topic")).toBeTruthy();
  expect(unplaced.compareDocumentPosition(comments) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const files = screen.getByRole("region", { name: "File source.ts" });
  expect(comments.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const pane = screen.getByTestId("diff-pane");
  const card = document.getElementById(`diff-thread-${second.id}`);
  if (!card) throw new Error("Missing topic thread");
  Object.defineProperties(pane, { scrollHeight: { value: 3000 }, clientHeight: { value: 600 } });
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 900, 600));
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 700, 900, 100));
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation(() => {});
  act(() => expect(navigate?.({ elementId: card.id })).toBe(true));
  expect(scroll).toHaveBeenLastCalledWith({ top: 692, behavior: "instant" });
  expect(document.querySelector("[data-topic]")).toBeNull();
});

test.each(["save", "cancel"])("a topic composer moves to A to Z once and closes on %s", async (action) => {
  await mount(revision([file("source.ts", { flag: "binary" })]));
  fireEvent.click(screen.getByRole("button", { name: "Comment on topic" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Topic draft" } });
  act(() => layoutStore.update({ fileOrder: "path" }));
  const comments = screen.getByRole("region", { name: "Topic comments" });
  expect(screen.getAllByRole("textbox", { name: "Comment" })).toHaveLength(1);
  expect((within(comments).getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe("Topic draft");
  fireEvent.click(within(comments).getByRole("button", { name: action === "save" ? "Save comment" : "Cancel" }));
  if (action === "save") {
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/reviews/${reviewId}/threads`,
        expect.objectContaining({
          body: JSON.stringify({ revision: 2, target: { kind: "topic", slug: "first" }, body: "Topic draft" }),
        }),
      ),
    );
  }
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull());
  expect(screen.queryByRole("region", { name: "Topic comments" })).toBeNull();
});

test.each([false, true])("a resumed A to Z topic draft focuses its composer (has files: %s)", async (hasFiles) => {
  layoutStore.update({ fileOrder: "path" });
  const target = { kind: "topic", slug: "first" } as const;
  const key = draftKey(reviewId, target);
  saveDraft(key, "Resumed topic draft");
  claimDraft(key, "diff");
  const first = file("a.ts", { flag: "binary", viewed: "viewed", viewedOn: 2 });
  let navigate: NavigateDiff | null = null;
  await mount(revision(hasFiles ? [file("z.ts", { flag: "binary" }), first] : []), {
    resume: { key, target },
    onNavigator: (value) => {
      navigate = value;
    },
  });
  const comments = screen.getByRole("region", { name: "Topic comments" });
  const input = within(comments).getByRole("textbox", { name: "Comment" });
  expect((input as HTMLTextAreaElement).value).toBe("Resumed topic draft");
  await waitFor(() => expect(document.activeElement).toBe(input));
  const editor = input.closest<HTMLElement>(".em-composer");
  if (!editor) throw new Error("Missing topic composer");
  act(() => expect(navigate?.({ target, element: editor })).toBe(true));
  if (hasFiles) {
    const section = screen.getByRole("region", { name: `File ${first.path}` });
    expect(within(section).getByRole("button", { name: "Expand file" })).toBeTruthy();
    expect(within(section).queryByRole("button", { name: "Collapse file" })).toBeNull();
    expect(parser).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  }
  expect(document.activeElement).toBe(input);
});

test.each(["file", "topic"])("file order stays locked until a %s comment save closes its composer", async (kind) => {
  const save = Promise.withResolvers<Response>();
  const fallback = fetchMock.getMockImplementation() as
    | ((path: string, init?: RequestInit) => Promise<Response>)
    | undefined;
  fetchMock.mockImplementation((path: string, init?: RequestInit) =>
    path.endsWith("/threads") ? save.promise : fallback?.(path, init),
  );
  const { result } = renderHook(() => useFileOrder());
  const setOrder = result.current[1];
  try {
    await mount(revision([file("source.ts", { flag: "binary" })]));
    fireEvent.click(screen.getByRole("button", { name: `Comment on ${kind}` }));
    const input = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(input, { target: { value: "Pending comment" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(isAnyDraftSaving()).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/reviews/${reviewId}/threads`,
      expect.objectContaining({ method: "POST" }),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "1 topic · 1 file" }), { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    const order = within(menu).getByLabelText("File order");
    for (const option of within(order).getAllByRole("menuitemradio"))
      expect(option.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(order).getByRole("menuitemradio", { name: "A to Z" }));
    act(() => setOrder("path"));
    expect(layoutStore.getSnapshot().fileOrder).toBe("topics");
    expect(input.isConnected).toBe(true);
    await act(async () => save.resolve(Response.json({}, { status: 201 })));
    await waitFor(() => expect(input.isConnected).toBe(false));
    expect(document.querySelector(".em-composer")).toBeNull();
    for (const option of within(order).getAllByRole("menuitemradio"))
      expect(option.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(within(order).getByRole("menuitemradio", { name: "A to Z" }));
    expect(layoutStore.getSnapshot().fileOrder).toBe("path");
  } finally {
    await act(async () => save.resolve(Response.json({}, { status: 201 })));
    await waitFor(() => expect(isAnyDraftSaving()).toBe(false));
  }
});

test("an A to Z topic draft without a section uses only the fallback composer", async () => {
  layoutStore.update({ fileOrder: "path" });
  const target = { kind: "topic", slug: "missing" } as const;
  await mount(revision([file("source.ts", { flag: "binary" })]), {
    resume: { key: draftKey(reviewId, target), target },
  });
  expect(screen.getAllByRole("textbox", { name: "Comment" })).toHaveLength(1);
  expect(screen.queryByRole("region", { name: "Topic comments" })).toBeNull();
});

test("the phone renders saved A to Z order without topic sections or a toolbar", async () => {
  stubWidth(320);
  layoutStore.update({ fileOrder: "path" });
  const last = file("z.ts", { flag: "binary" });
  const first = file("a.ts", { flag: "binary", topic: null });
  await mount(revision([last, first]));
  expect([...document.querySelectorAll('[id^="diff-file-"]')].map((element) => element.id)).toEqual([
    `diff-file-${first.id}`,
    `diff-file-${last.id}`,
  ]);
  expect(screen.queryByRole("region", { name: /^Topic / })).toBeNull();
  expect(document.querySelector("[data-topic], [data-phone], [data-diff-toolbar]")).toBeNull();
  expect(screen.getAllByRole("region", { name: /^File / })).toHaveLength(2);
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

test("TopicSection shows a quoted topic thread and counts it while collapsed", async () => {
  const quoted: ThreadView = {
    ...placedThread(
      { kind: "topic", slug: "first", part: "summary", quote: "Synthetic", prefix: "", suffix: " summary" },
      "Quoted topic discussion",
    ),
    placement: { status: "placed", location: { kind: "topic", slug: "first", part: "summary", start: 0, end: 9 } },
  };
  await mount(revision([file()], { threads: [quoted] }));
  const topic = screen.getByRole("region", { name: "Topic First" });
  expect(topic.querySelector("[data-topic-header]")?.textContent).toContain("1 thread");
  fireEvent.click(within(topic).getByRole("button", { name: "Collapse topic" }));
  const discussion = topic.querySelector(".em-diff-discussion");
  expect(discussion?.querySelector(".em-thread-quote")?.textContent).toBe("Synthetic");
  expect(within(topic).getByText("Quoted topic discussion").closest("[hidden]")).toBeNull();
});

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
  layoutStore.update({ pane: { desktop: "split", tablet: "split" } });
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
  expect(within(document.getElementById(`diff-file-${value.id}`) as HTMLElement).getByText("+2")).toBeTruthy();
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
  expect(path?.querySelector(".em-file-path-button")?.textContent).toBe("src/a.ts");
  expect(diffStylesheet).toMatch(
    /@media \(max-width: 767px\)\s*\{[^{}]*\.em-file \.em-file-path-button\s*\{[^}]*display:\s*block;[^}]*width:\s*100%;[^}]*direction:\s*rtl;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/,
  );
  expect(document.querySelector("[data-file-header] p")?.getAttribute("title")).toBe("Renamed from src/b.ts");
});

test.each([390, 800, 1280])("clicking a file path opens its full text and Copy path (%s px)", async (width) => {
  stubWidth(width);
  const path = "src/components/a-long-directory-name/another-directory/a-long-file-name.ts";
  await mount(revision([file(path)]));
  const button = screen.getByRole("button", { name: path });
  fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
  fireEvent.click(button, { detail: 1 });
  const menu = await screen.findByRole("menu");
  const pathBlock = menu.querySelector("bdi")?.parentElement;
  expect(pathBlock?.textContent).toBe(path);
  expect(pathBlock?.getAttribute("aria-hidden")).toBe("true");
  expect(pathBlock?.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
  expect(pathBlock?.classList.contains("whitespace-pre-wrap")).toBe(true);
  expect(menu.classList.contains("max-w-[min(36rem,var(--radix-dropdown-menu-content-available-width))]")).toBe(true);
  // The computed description separates the path's segment spans with spaces.
  const copy = within(menu).getByRole("menuitem", { name: "Copy path", description: path.replaceAll("/", "/ ") });
  expect(copy.getAttribute("aria-describedby")?.split(/\s+/)).toEqual([pathBlock?.id]);
  expect(document.getElementById(copy.getAttribute("aria-describedby") ?? "")?.textContent).toBe(path);
});

test("a click without a pointer gesture opens the path menu", async () => {
  await mount(detailed());
  fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
  expect(await screen.findByRole("menu")).toBeTruthy();
});

test("an unarmed pointer click does not open the path menu", async () => {
  await mount(detailed());
  fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }), { detail: 1 });
  expect(screen.queryByRole("menu")).toBeNull();
});

test.each(["touch", "pen"])("a %s opens a file path only on click, not pointerdown", async (pointerType) => {
  stubWidth(390);
  await mount(detailed());
  const button = screen.getByRole("button", { name: "src/a.ts" });
  expect(fireEvent.pointerDown(button, { button: 0, pointerType })).toBe(false);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.pointerCancel(button, { pointerType });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.pointerDown(button, { button: 0, pointerType });
  fireEvent.click(button, { detail: 1 });
  expect(await screen.findByRole("menu")).toBeTruthy();
});

test("Copy path writes the exact path, announces success, stays open and resets after two seconds", async () => {
  const path = "src/a long directory/file.ts";
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await mount(revision([file(path)]));
  fireEvent.pointerDown(screen.getByRole("button", { name: path }), { button: 0, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  vi.useFakeTimers();
  await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" })));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(path);
  expect(within(menu).getByRole("menuitem", { name: "Copied" })).toBeTruthy();
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Path copied");
  expect(status.classList.contains("sr-only")).toBe(true);
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(status.closest('[aria-hidden="true"]')).toBeNull();
  expect(menu.querySelector('[role="status"]')).toBeNull();
  expect(document.querySelector("[data-file-header] h4")?.nextElementSibling).toBe(status);
  expect(screen.getByRole("menu")).toBe(menu);
  act(() => vi.advanceTimersByTime(1999));
  expect(within(menu).getByRole("menuitem", { name: "Copied" })).toBeTruthy();
  act(() => vi.advanceTimersByTime(1));
  expect(within(menu).getByRole("menuitem", { name: "Copy path" })).toBeTruthy();
  expect(status.textContent).toBe("");
});

test.each(["Enter", " "])("the focused Copy item copies with %s and keeps the menu open", async (key) => {
  const path = "src/keyboard.ts";
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await mount(revision([file(path)]));
  const button = screen.getByRole("button", { name: path });
  act(() => button.focus());
  fireEvent.keyDown(button, { key: "Enter" });
  const menu = await screen.findByRole("menu");
  const copy = within(menu).getByRole("menuitem", { name: "Copy path" });
  await waitFor(() => expect(document.activeElement).toBe(copy));
  fireEvent.keyDown(copy, { key });
  expect(await within(menu).findByRole("menuitem", { name: "Copied" })).toBe(copy);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(path);
  expect(screen.getByRole("status").textContent).toBe("Path copied");
  expect(screen.getByRole("menu")).toBe(menu);
});

test.each(["resolve", "reject"])("an older copy's late %s leaves the latest success intact", async (settlement) => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const writeText = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const execCommand = vi.fn(() => false);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  await mount(detailed());
  fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
  const menu = await screen.findByRole("menu");
  const copy = within(menu).getByRole("menuitem", { name: "Copy path" });
  fireEvent.click(copy);
  fireEvent.click(copy);
  expect(writeText).toHaveBeenCalledTimes(2);
  await act(async () => second.resolve());
  await act(async () => {
    if (settlement === "resolve") first.resolve();
    else first.reject(new Error("denied"));
  });
  expect(within(menu).getByRole("menuitem", { name: "Copied" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Path copied");
  expect(execCommand).not.toHaveBeenCalled();
  expect(window.getSelection()?.toString()).toBe("");
});

test("each successful copy keeps Copied for two seconds after its own completion", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const writeText = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await mount(detailed());
  fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
  const menu = await screen.findByRole("menu");
  const copy = within(menu).getByRole("menuitem", { name: "Copy path" });
  vi.useFakeTimers();
  fireEvent.click(copy);
  await act(async () => first.resolve());
  act(() => vi.advanceTimersByTime(1500));
  fireEvent.click(copy);
  await act(async () => second.resolve());
  act(() => vi.advanceTimersByTime(500));
  expect(within(menu).getByRole("menuitem", { name: "Copied" })).toBeTruthy();
  act(() => vi.advanceTimersByTime(1499));
  expect(within(menu).getByRole("menuitem", { name: "Copied" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Path copied");
  act(() => vi.advanceTimersByTime(1));
  expect(within(menu).getByRole("menuitem", { name: "Copy path" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("");
});

test("closing a copied path clears its live region and reopening starts with Copy path", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await mount(detailed());
  const button = screen.getByRole("button", { name: "src/a.ts" });
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("");
  fireEvent.click(button);
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" }));
  await waitFor(() => expect(status.textContent).toBe("Path copied"));
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(screen.getByRole("status")).toBe(status);
  expect(status.textContent).toBe("");
  fireEvent.click(button);
  expect(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Copy path" })).toBeTruthy();
  expect(status.textContent).toBe("");
});

test.each(["resolve", "reject"])(
  "closing the menu ignores a pending copy's late %s after reopening",
  async (settlement) => {
    const pending = Promise.withResolvers<void>();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(() => pending.promise) } });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    await mount(detailed());
    const button = screen.getByRole("button", { name: "src/a.ts" });
    fireEvent.click(button);
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" }));
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(button);
    const reopened = await screen.findByRole("menu");
    await act(async () => {
      if (settlement === "resolve") pending.resolve();
      else pending.reject(new Error("denied"));
    });
    expect(within(reopened).getByRole("menuitem", { name: "Copy path" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(execCommand).not.toHaveBeenCalled();
  },
);

test.each(["reject", "resolve"])("unmounting the tree ignores a pending copy's late %s", async (settlement) => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const pending = Promise.withResolvers<void>();
  const writeText = vi.fn(() => pending.promise);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const execCommand = vi.fn(() => false);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  const { unmount } = await mount(detailed());
  fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith("src/a.ts");
  unmount();
  expect(screen.queryByRole("menu")).toBeNull();
  await act(async () => {
    if (settlement === "reject") pending.reject(new Error("denied"));
    else pending.resolve();
  });
  expect(execCommand).not.toHaveBeenCalled();
  expect(window.getSelection()?.toString()).toBe("");
  expect(error).not.toHaveBeenCalled();
});

test.each(["missing", "throws", "rejects"])(
  "a clipboard that %s selects only the path and reports copy failure",
  async (failure) => {
    const writeText = vi.fn(() => {
      if (failure === "throws") throw new Error("denied");
      return Promise.reject(new Error("denied"));
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: failure === "missing" ? undefined : { writeText } });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    await mount(detailed());
    const button = screen.getByRole("button", { name: "src/a.ts" });
    fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" }));
    const status = screen.getByRole("status");
    await waitFor(() => expect(status.textContent).toBe("Select and copy the path"));
    expect(status.classList.contains("sr-only")).toBe(true);
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.closest('[aria-hidden="true"]')).toBeNull();
    expect(menu.querySelector('[role="status"]')).toBeNull();
    const visibleFailure = within(menu).getByText("Select and copy the path");
    expect(visibleFailure.hasAttribute("role")).toBe(false);
    expect(visibleFailure.getAttribute("aria-hidden")).toBe("true");
    expect(visibleFailure.classList.contains("sr-only")).toBe(false);
    expect(window.getSelection()?.toString()).toBe("src/a.ts");
    expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" }));
    await waitFor(() => expect(status.textContent).toBe(`Select and copy the path${String.fromCharCode(0xa0)}`));
    expect(visibleFailure.textContent).toBe("Select and copy the path");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("");
    fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
    await screen.findByRole("menu");
    expect(status.textContent).toBe("");
  },
);

test("a successful fallback copy selects only the new path and reports Copied", async () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
  const execCommand = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  await mount(detailed());
  fireEvent.pointerDown(screen.getByRole("button", { name: "src/a.ts" }), { button: 0, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" }));
  expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
  expect(window.getSelection()?.toString()).toBe("src/a.ts");
  expect(within(menu).getByRole("menuitem", { name: "Copied" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Path copied");
});

test("fallback copying preserves consecutive and leading spaces in the path", async () => {
  const path = "src/a  b/ c.ts";
  const oldPath = "src/old  dir/ previous.ts";
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
  let selected: string | undefined;
  const execCommand = vi.fn(() => {
    selected = window.getSelection()?.toString();
    return false;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  await mount(revision([file(path, { oldPath })]));
  // Accessible names collapse spaces; the displayed and copied path must preserve them.
  const button = screen.getByRole("button", { name: "src/a b/ c.ts" });
  expect(button.getAttribute("aria-label")).toBe(path);
  fireEvent.click(button);
  const menu = await screen.findByRole("menu");
  const paths = [...menu.querySelectorAll("bdi")];
  expect(paths.map((node) => node.textContent)).toEqual([path, oldPath]);
  for (const node of paths) {
    expect(node.parentElement?.classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(node.parentElement?.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
  }
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" }));
  expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
  expect(selected).toBe(path);
});

test.each(["Enter", " ", "ArrowDown"])(
  "%s opens the path menu with Copy focused; Escape restores focus",
  async (key) => {
    await mount(detailed());
    const button = screen.getByRole("button", { name: "src/a.ts" });
    // A cancelled touch gesture must not affect the next keyboard opening.
    fireEvent.pointerDown(button, { button: 0, pointerType: "touch" });
    act(() => button.focus());
    expect(fireEvent.keyDown(button, { key })).toBe(false);
    const menu = await screen.findByRole("menu");
    const copy = within(menu).getByRole("menuitem", { name: "Copy path" });
    await waitFor(() => expect(document.activeElement).toBe(copy));
    fireEvent.keyDown(copy, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  },
);

test("an outside tap closes the path menu and returns focus to the path", async () => {
  stubWidth(390);
  await mount(detailed());
  const button = screen.getByRole("button", { name: "src/a.ts" });
  fireEvent.pointerDown(button, { button: 0, pointerType: "touch" });
  fireEvent.click(button, { detail: 1 });
  await screen.findByRole("menu");
  fireEvent.pointerDown(document.body, { button: 0, pointerType: "touch" });
  fireEvent.click(document.body);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(button));
});

test("an outside touch that closes the menu cannot reopen it when its click lands on the path", async () => {
  stubWidth(390);
  await mount(detailed());
  const button = screen.getByRole("button", { name: "src/a.ts" });
  fireEvent.pointerDown(button, { button: 0, pointerType: "touch" });
  fireEvent.click(button, { detail: 1 });
  await screen.findByRole("menu");
  fireEvent.pointerDown(document.body, { button: 0, pointerType: "touch" });
  fireEvent.click(button, { detail: 1 });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(button.getAttribute("aria-expanded")).toBe("false");
  await waitFor(() => expect(document.activeElement).toBe(button));
});

test("a renamed file shows both paths in its menu but copies only the new path", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await mount(detailed());
  fireEvent.pointerDown(screen.getByRole("button", { name: "src/a.ts" }), { button: 0, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  expect([...menu.querySelectorAll("bdi")].map((node) => node.textContent)).toEqual(["src/a.ts", "src/b.ts"]);
  expect(within(menu).getByText("Renamed from").textContent).toBe("Renamed from src/b.ts");
  const copy = within(menu).getByRole("menuitem", {
    name: "Copy path",
    description: "src/ a.ts Renamed from src/ b.ts",
  });
  const descriptions = copy.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
  expect(descriptions).toHaveLength(2);
  expect(descriptions.map((id) => document.getElementById(id)?.textContent)).toEqual([
    "src/a.ts",
    "Renamed from src/b.ts",
  ]);
  fireEvent.click(copy);
  await within(menu).findByRole("menuitem", { name: "Copied" });
  expect(writeText).toHaveBeenCalledExactlyOnceWith("src/a.ts");
});

test("menu text outside Copy is aria-hidden while the live region announces copy failure", async () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
  await mount(detailed());
  fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
  const menu = await screen.findByRole("menu");
  const expectTextHidden = () => {
    for (const element of menu.querySelectorAll("*")) {
      if (!element.textContent?.trim() || element.closest('[role="menuitem"]')) continue;
      expect(element.closest('[aria-hidden="true"]'), element.textContent).not.toBeNull();
    }
  };
  expect(menu.querySelector("bdi")?.textContent).toBe("src/a.ts");
  const rename = within(menu).getByText("Renamed from");
  expect(rename.textContent).toBe("Renamed from src/b.ts");
  expect(rename.getAttribute("aria-hidden")).toBe("true");
  expectTextHidden();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" }));
  expect(within(menu).getByText("Select and copy the path").getAttribute("aria-hidden")).toBe("true");
  expectTextHidden();
  expect(window.getSelection()?.toString()).toBe("src/a.ts");
  const status = screen.getByRole("status");
  expect(menu.contains(status)).toBe(false);
  expect(status.closest('[aria-hidden="true"]')).toBeNull();
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(status.textContent).toBe("Select and copy the path");
});

test("a hostile path stays text in the header and the popover", async () => {
  const path = "src/<img src=x onerror=alert(1)>.ts";
  await mount(revision([file(path, { oldPath: path })]));
  const button = screen.getByRole("button", { name: path });
  expect(button.textContent).toBe(path);
  fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  expect([...menu.querySelectorAll("bdi")].map((node) => node.textContent)).toEqual([path, path]);
  expect(document.querySelector("img")).toBeNull();
});

test("Collapse, Comment on file and Viewed still work beside the path button", async () => {
  const onViewed = vi.fn();
  await mount(revision([file("source.ts")]), { onViewed });
  const button = screen.getByRole("button", { name: "source.ts" });
  fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
  fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(button));
  fireEvent.click(screen.getByRole("button", { name: "Collapse file" }));
  expect(screen.getByRole("button", { name: "Expand file" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Expand file" }));
  expect(screen.getByRole("button", { name: "Collapse file" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Comment on file" }));
  expect(screen.getByLabelText("Comment")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Mark source.ts as viewed" }));
  expect(onViewed).toHaveBeenCalledExactlyOnceWith(["source.ts"], true);
  expect(screen.queryByRole("menu")).toBeNull();
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

test("the compact meta row wraps whole items in a narrow pane", () => {
  expect(diffStylesheet).toMatch(
    /\.em-topic-meta\s*\{[^}]*flex-wrap:\s*wrap;[^}]*row-gap:\s*2px;[^}]*overflow:\s*hidden;[^}]*white-space:\s*nowrap;/,
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

test.each(["toolbar", "navigator"])("a %s stuck file jump follows growth and cancels on unmount", async (via) => {
  const above = file("above.ts");
  const destination = file("destination.ts", { flag: "binary", order: 1 });
  let navigate: NavigateDiff | null = null;
  const { unmount } = await mount(revision([above, destination]), {
    onNavigator: (value) => {
      navigate = value;
    },
  });
  const pane = screen.getByTestId("diff-pane");
  const header = document.getElementById(`diff-file-${destination.id}`);
  const toolbar = pane.querySelector("[data-diff-toolbar]");
  const topicHeader = pane.querySelector("[data-topic-header]");
  if (!header || !toolbar || !topicHeader) throw new Error("Missing jump destination");
  const section = screen.getByRole("region", { name: "File destination.ts" });
  let targetTop = 1300;
  Object.defineProperties(pane, { scrollHeight: { value: 10000 }, clientHeight: { value: 600 } });
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 900, 600));
  vi.spyOn(section, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, targetTop - pane.scrollTop, 900, 5000),
  );
  vi.spyOn(header, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, Math.max(141, section.getBoundingClientRect().top), 900, 40),
  );
  vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 900, 41));
  vi.spyOn(topicHeader, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 41, 900, 100));
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation((options?: number | ScrollToOptions) => {
    if (options && typeof options === "object") pane.scrollTop = options.top ?? 0;
  });
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  pane.scrollTop = 4000;
  expect(header.getBoundingClientRect().top).toBe(141);
  if (via === "toolbar") {
    fireEvent.keyDown(screen.getByRole("button", { name: "1 topic · 2 files" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "destination.ts" }));
  } else {
    act(() => expect(navigate?.({ elementId: header.id })).toBe(false));
    act(() => expect(navigate?.({ elementId: header.id })).toBe(true));
  }
  expect(header.getBoundingClientRect().top).toBe(149);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 1151, behavior: "instant" });
  act(() => vi.advanceTimersByTime(500));
  expect(scroll).toHaveBeenCalledTimes(1);
  near("above.ts");
  await screen.findByTestId("rendered-diff");
  targetTop += 1800;
  act(() => vi.advanceTimersToNextFrame());
  expect(header.getBoundingClientRect().top).toBe(149);
  expect(scroll).toHaveBeenLastCalledWith({ top: 2951, behavior: "instant" });
  unmount();
  scroll.mockClear();
  targetTop += 1800;
  act(() => vi.advanceTimersToNextFrame());
  expect(scroll).not.toHaveBeenCalled();
});

function foldLayout(bodyHeights: Record<string, number>) {
  const pane = screen.getByTestId("diff-pane");
  const paneTop = 50;
  const paneHeight = 600;
  const topicHeight = 100;
  const toolbar = pane.querySelector<HTMLElement>("[data-diff-toolbar]");
  const toolbarHeight = toolbar ? 41 : 0;
  const layout = () => {
    const rects = new Map<Element, DOMRect>();
    const rect = (top: number, height: number) => new DOMRect(0, paneTop + top - pane.scrollTop, paneWidth, height);
    rects.set(pane, new DOMRect(0, paneTop, paneWidth, paneHeight));
    if (toolbar) rects.set(toolbar, new DOMRect(0, paneTop, paneWidth, toolbarHeight));
    let top = toolbarHeight;
    for (const topic of pane.querySelectorAll<HTMLElement>("[data-topic]")) {
      const start = top;
      const topicHeader = topic.querySelector<HTMLElement>("[data-topic-header]");
      if (!topicHeader) throw new Error("Missing topic header");
      const phone = topic.hasAttribute("data-phone");
      top += topicHeight;
      const details = topic.querySelector<HTMLElement>("[data-topic-details]");
      if (details) {
        const height = details.hidden ? 0 : 80;
        rects.set(details, rect(top, height));
        top += height;
      }
      for (const section of topic.querySelectorAll<HTMLElement>("[data-diff-file]")) {
        const header = section.querySelector<HTMLElement>("[data-file-header]");
        if (!header) throw new Error("Missing file header");
        const path = section.getAttribute("aria-label")?.slice("File ".length) ?? "";
        const height = 40 + (header.hasAttribute("data-collapsed") ? 0 : (bodyHeights[path] ?? 240));
        top += 12;
        const box = rect(top, height);
        rects.set(section, box);
        const line = paneTop + toolbarHeight + (phone ? 0 : topicHeight);
        rects.set(header, new DOMRect(0, Math.min(Math.max(line, box.top), box.bottom - 40), paneWidth, 40));
        top += height;
      }
      top += 12;
      rects.set(topic, rect(start, top - start));
      const headerTop = phone ? start : Math.min(Math.max(start, pane.scrollTop + toolbarHeight), top - topicHeight);
      rects.set(topicHeader, rect(headerTop, topicHeight));
    }
    return { rects, height: top };
  };
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return layout().rects.get(this) ?? bounds.call(this);
  });
  Object.defineProperties(pane, {
    clientHeight: { value: paneHeight },
    scrollHeight: { get: () => layout().height },
  });
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation((options?: number | ScrollToOptions) => {
    if (options && typeof options === "object")
      pane.scrollTop = Math.max(0, Math.min(options.top ?? 0, Math.max(0, pane.scrollHeight - pane.clientHeight)));
  });
  const section = (path: string) => screen.getByRole("region", { name: `File ${path}` });
  const header = (path: string) => {
    const element = section(path).querySelector<HTMLElement>("[data-file-header]");
    if (!element) throw new Error("Missing file header");
    return element;
  };
  return {
    pane,
    scroll,
    section,
    header,
    stickyLine: paneTop + toolbarHeight + (toolbar ? topicHeight : 0),
    end: (path: string) => {
      pane.scrollTo({ top: pane.scrollTop + section(path).getBoundingClientRect().bottom - paneTop - paneHeight });
      scroll.mockClear();
    },
    grow: (path: string, delta: number) => {
      bodyHeights[path] = (bodyHeights[path] ?? 240) + delta;
    },
  };
}

test.each([1280, 390].flatMap((width) => ["long file", "small files", "next topic"].map((next) => ({ width, next }))))(
  "marking Viewed lands before the next $next ($width px)",
  async ({ width, next }) => {
    stubWidth(width);
    fetchMock.mockImplementation(async (path: string) => new Response(path.endsWith("/old") ? "before\n" : "after\n"));
    const following =
      next === "small files"
        ? Array.from({ length: 12 }, (_, index) => file(`small-${index + 1}.ts`, { order: index + 1 }))
        : [file("long-b.ts", { order: 1, topic: next === "next topic" ? "second" : "first" })];
    const view = revision([file("long-a.ts"), ...following]);
    if (next === "next topic")
      view.topics.push({ slug: "second", title: "Second", importance: 20, summary: "Second summary" });
    await mount(view, {
      onViewed: (paths, viewed) => viewedState(client).start(reviewId, { revision: view.seq, paths, viewed }),
    });
    if (width === 390) fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0] as HTMLElement);
    near("long-a.ts");
    await screen.findByTestId("rendered-diff");
    const { pane, header, section, stickyLine, end, grow } = foldLayout({ "long-a.ts": 3000, "long-b.ts": 4000 });
    end("long-a.ts");
    const marked = header("long-a.ts");
    expect(marked.getBoundingClientRect().top).toBe(stickyLine);
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Mark long-a.ts as viewed" })));
    const landing = () => {
      expect(marked.hasAttribute("data-collapsed")).toBe(true);
      expect(section("long-a.ts").querySelector(".em-diff-body")).toBeNull();
      expect(marked.getBoundingClientRect().top).toBe(stickyLine);
      expect(section("long-a.ts").getBoundingClientRect().top).toBe(stickyLine);
      const bottom = marked.getBoundingClientRect().bottom;
      if (next === "next topic") {
        const firstTopic = screen.getByRole("region", { name: "Topic First" });
        const secondTopic = screen.getByRole("region", { name: "Topic Second" });
        const title = within(secondTopic).getByRole("heading", { name: "Second" }).closest("[data-topic-header]");
        const details = within(secondTopic).getByText("Second summary").closest<HTMLElement>("[data-topic-details]");
        expect(firstTopic.getBoundingClientRect().bottom).toBe(bottom + 12);
        expect(title?.getBoundingClientRect().top).toBe(firstTopic.getBoundingClientRect().bottom);
        expect(details?.hidden).toBe(false);
        expect(details?.getBoundingClientRect().top).toBe(title?.getBoundingClientRect().bottom);
        expect(details?.getBoundingClientRect().bottom).toBeLessThan(pane.getBoundingClientRect().bottom);
      } else {
        const firstPath = next === "small files" ? "small-1.ts" : "long-b.ts";
        expect(section(firstPath).getBoundingClientRect().top).toBe(bottom + 12);
        expect(header(firstPath).getBoundingClientRect().top).toBe(bottom + 12);
      }
    };
    landing();
    act(() => vi.advanceTimersToNextFrame());
    landing();
    const nextPath = next === "small files" ? "small-1.ts" : "long-b.ts";
    near(nextPath);
    await screen.findByTestId("rendered-diff");
    expect(section(nextPath).hasAttribute("data-diff-loading")).toBe(true);
    act(() => vi.advanceTimersByTime(diffHoldQuietMs + 500));
    grow(nextPath, 600);
    // Content loading below can also move the browser's scroll anchor.
    pane.scrollTop += 120;
    act(() => vi.advanceTimersToNextFrame());
    landing();
  },
);

test.each([1280, 390])("a wheel immediately after marking Viewed stops the hold (%s px)", async (width) => {
  stubWidth(width);
  const view = revision([file("long-a.ts"), file("long-b.ts", { order: 1 })]);
  await mount(view, {
    onViewed: (paths, viewed) => viewedState(client).start(reviewId, { revision: view.seq, paths, viewed }),
  });
  const { pane, scroll, end, grow } = foldLayout({ "long-a.ts": 3000, "long-b.ts": 4000 });
  end("long-a.ts");
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Mark long-a.ts as viewed" })));
  expect(scroll).toHaveBeenCalledTimes(1);
  fireEvent.wheel(pane, { deltaY: 200 });
  pane.scrollTop += 200;
  const top = pane.scrollTop;
  grow("long-b.ts", 600);
  act(() => vi.advanceTimersByTime(500));
  expect(pane.scrollTop).toBe(top);
  expect(scroll).toHaveBeenCalledTimes(1);
});

test.each([1280, 390])("a later chevron fold discards an unused Viewed spot (%s px)", async (width) => {
  stubWidth(width);
  const onViewed = vi.fn();
  await mount(revision([file("long-a.ts"), file("long-b.ts", { order: 1 })]), { onViewed });
  const { pane, header, scroll, end } = foldLayout({ "long-a.ts": 3000, "long-b.ts": 4000 });
  end("long-a.ts");
  const top = pane.scrollTop;
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  fireEvent.click(screen.getByRole("button", { name: "Mark long-a.ts as viewed" }));
  expect(onViewed).toHaveBeenCalledExactlyOnceWith(["long-a.ts"], true);
  expect(header("long-a.ts").hasAttribute("data-collapsed")).toBe(false);
  act(() => vi.advanceTimersByTime(diffHoldQuietMs));
  fireEvent.click(within(header("long-a.ts")).getByRole("button", { name: "Collapse file" }));
  expect(header("long-a.ts").hasAttribute("data-collapsed")).toBe(true);
  act(() => vi.advanceTimersByTime(500));
  expect(pane.scrollTop).toBe(top);
  expect(scroll).not.toHaveBeenCalled();
});
