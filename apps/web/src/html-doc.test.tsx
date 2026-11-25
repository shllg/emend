// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FilePath, type HtmlDocChanges, LIMITS, type ThreadView } from "@recense/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HtmlDocFrame } from "./components/reading/HtmlDocFrame.tsx";
import { DIAGRAM_DRAW_TIMEOUT_MS } from "./components/reading/MermaidBlock.tsx";
import * as mermaidColors from "./components/reading/mermaid-colors.ts";
import { draftKey } from "./lib/drafts.ts";
import { type DocNavigation, FrameToParent, ParentToFrame } from "./lib/frame-messages.ts";
import { defaultLayout, type LayoutPreferences, layoutStore } from "./lib/layout-store.ts";
import { selectCustomTheme, setThemePick, startThemeSync, themeColors } from "./lib/theme.ts";
import { customTheme } from "./test/themes.ts";

const id = "11111111-1111-4111-8111-111111111111";
const path = "docs/seed.html";
const doc = { kind: "html" as const, path, contentUrl: `/content/${"a".repeat(75)}/${path}` };
const anchor = { quote: "seeds", prefix: "dry ", suffix: " grow" };
const thread: ThreadView = {
  id,
  target: { kind: "html-span", path, ...anchor },
  state: "open",
  createdOn: 1,
  placement: { status: "placed", location: { kind: "html-span", path, start: 4, end: 9 } },
  comments: [{ id, author: "user", body: "Private synthetic comment", sent: true, sentOn: 1 }],
};
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  setThemePick("system");
  layoutStore.update(defaultLayout);
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  fetchMock = vi.fn(async () => Response.json({ threadId: id, commentId: id }, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function frameByTitle() {
  const frame = screen.getAllByTitle(path).find((node) => node instanceof HTMLIFrameElement);
  if (!frame) throw new Error("Missing titled frame");
  return frame;
}

function mountRepo(repoUrl?: string | null) {
  const content = (threads: ThreadView[] = []) => (
    <QueryClientProvider client={client}>
      <HtmlDocFrame
        reviewId={id}
        revision={2}
        changedBlocks={[]}
        path={path}
        contentUrl={doc.contentUrl}
        repoUrl={repoUrl}
        threads={threads}
        changes={{ parts: 1, marks: [] }}
      />
    </QueryClientProvider>
  );
  const view = render(content());
  const frame = frameByTitle();
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  fireEvent.load(frame);
  const message = (data: unknown, source = frame.contentWindow) =>
    fireEvent(window, new MessageEvent("message", { source, data }));
  return { frame, post, message, update: (threads: ThreadView[]) => view.rerender(content(threads)) };
}

test.each(["https://github.com/o/r", undefined, null, "javascript:alert(1)"])(
  "repository URL %s is sent once after ready, before highlights and changed parts",
  (repoUrl) => {
    const view = mountRepo(repoUrl);
    expect(view.post).not.toHaveBeenCalled();
    view.message({ type: "recense:ready" });
    const messages = () => view.post.mock.calls.filter(([data]) => data.type === "recense:repo");
    if (repoUrl === "https://github.com/o/r") {
      expect(messages()).toEqual([[{ type: "recense:repo", url: repoUrl }, "*"]]);
      expect(ParentToFrame.parse(messages()[0]?.[0])).toEqual({ type: "recense:repo", url: repoUrl });
      const types = view.post.mock.calls.map(([data]) => data.type);
      expect(types.indexOf("recense:repo")).toBeLessThan(types.indexOf("recense:highlight"));
      expect(types.indexOf("recense:repo")).toBeLessThan(types.indexOf("recense:changed"));
      view.update([thread]);
      expect(messages()).toHaveLength(1);
      fireEvent.load(view.frame);
      fireEvent.click(screen.getByText(`Reload ${path}`));
      const next = frameByTitle();
      const post = vi.fn();
      Object.defineProperty(next, "contentWindow", { value: { postMessage: post } });
      fireEvent.load(next);
      expect(post).not.toHaveBeenCalled();
      view.message({ type: "recense:ready" }, next.contentWindow);
      expect(post.mock.calls.filter(([data]) => data.type === "recense:repo")).toEqual([
        [{ type: "recense:repo", url: repoUrl }, "*"],
      ]);
    } else {
      expect(messages()).toEqual([]);
    }
  },
);

test.each([1, 12, 9999999])(
  "a ready frame's issue number %s opens the parent's repository URL in a new tab",
  (number) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = mountRepo("https://github.com/o/r");
    view.message({ type: "recense:ready" });
    view.message({ type: "recense:issue", number });
    expect(open).toHaveBeenCalledExactlyOnceWith(
      `https://github.com/o/r/issues/${number}`,
      "_blank",
      "noopener,noreferrer",
    );
  },
);

test.each([
  { name: "no repository URL", repoUrl: undefined },
  { name: "null repository URL", repoUrl: null },
  { name: "invalid repository URL", repoUrl: "javascript:alert(1)" },
])("an issue cannot open a tab with $name", ({ repoUrl }) => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const view = mountRepo(repoUrl);
  view.message({ type: "recense:ready" });
  view.message({ type: "recense:issue", number: 12 });
  expect(open).not.toHaveBeenCalled();
});

test("issue messages require the current ready frame and stop after navigation away", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const view = mountRepo("https://github.com/o/r");
  view.message({ type: "recense:issue", number: 12 });
  expect(open).not.toHaveBeenCalled();
  view.message({ type: "recense:ready" });
  view.message({ type: "recense:issue", number: 12 }, window);
  expect(open).not.toHaveBeenCalled();
  fireEvent.load(view.frame);
  view.message({ type: "recense:issue", number: 12 });
  expect(open).not.toHaveBeenCalled();
});

test.each([
  { type: "recense:issue", number: 0 },
  { type: "recense:issue", number: 10000000 },
  { type: "recense:issue", number: 1.5 },
  { type: "recense:issue", number: "12" },
  { type: "recense:issue", number: 12, extra: true },
  { type: "recense:issue", number: 12, url: "https://example.test/other/repo/issues/12" },
])("invalid issue message %j cannot open a tab", (data) => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const view = mountRepo("https://github.com/o/r");
  view.message({ type: "recense:ready" });
  view.message(data);
  expect(FrameToParent.safeParse(data).success).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

test.each([false, true])("HTML changes are posted only when supplied and after ready (supplied=%s)", (supplied) => {
  const changes: HtmlDocChanges = { parts: 3, marks: [{ index: 1, revision: 2 }] };
  const content = (changes?: HtmlDocChanges) => (
    <QueryClientProvider client={client}>
      <HtmlDocFrame
        reviewId={id}
        revision={2}
        changedBlocks={[]}
        path={path}
        contentUrl={doc.contentUrl}
        threads={[]}
        changes={changes}
      />
    </QueryClientProvider>
  );
  const view = render(content(supplied ? changes : undefined));
  const frame = frameByTitle();
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  fireEvent.load(frame);
  expect(post).not.toHaveBeenCalled();
  fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { type: "recense:ready" } }));
  const messages = () => post.mock.calls.filter(([data]) => data.type === "recense:changed");
  expect(messages()).toEqual(supplied ? [[{ type: "recense:changed", ...changes }, "*"]] : []);
  if (!supplied) return;
  expect(ParentToFrame.parse(messages()[0]?.[0])).toEqual({ type: "recense:changed", ...changes });
  view.rerender(content({ parts: 3, marks: [{ index: 1, revision: 2 }] }));
  expect(messages()).toHaveLength(1);
  view.rerender(content({ parts: 3, marks: [] }));
  expect(messages()).toHaveLength(2);
  expect(messages().at(-1)).toEqual([{ type: "recense:changed", parts: 3, marks: [] }, "*"]);
  fireEvent.load(frame);
  view.rerender(content(changes));
  expect(messages()).toHaveLength(2);
});

test.each(
  (["recense", "custom", undefined] as const).flatMap((look) =>
    (["light", undefined] as const).map((colorScheme) => ({ look, colorScheme })),
  ),
)("$look look, $colorScheme colour scheme uses the matching loading background", ({ look, colorScheme }) => {
  render(
    <QueryClientProvider client={client}>
      <HtmlDocFrame
        reviewId={id}
        revision={2}
        changedBlocks={[]}
        path={path}
        contentUrl={doc.contentUrl}
        threads={[]}
        look={look}
        colorScheme={colorScheme}
      />
    </QueryClientProvider>,
  );
  const frame = frameByTitle();
  expect(frame.classList.contains("bg-reading")).toBe(look === "recense" && colorScheme !== "light");
  expect(frame.classList.contains("bg-[#fff]")).toBe(look !== "recense" || colorScheme === "light");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
});

test.each(
  [true, false].flatMap((initialWide) =>
    (["recense", "custom", undefined] as const).map((look) => ({ initialWide, look })),
  ),
)("$look layout precedes restore on every ready and follows app width (wide=$initialWide)", ({ initialWide, look }) => {
  layoutStore.update({ readingWidth: "narrow", proseSize: 17, codePx: 15 });
  const layoutMessage = (wide: boolean) => {
    const { readingWidth: width, proseSize: prose, codePx: code } = layoutStore.getSnapshot();
    return look === "recense" ? { type: "recense:layout", wide, width, prose, code } : { type: "recense:layout", wide };
  };
  let width = initialWide ? 820 : 700;
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal("matchMedia", (query: string) => {
    const changes = listeners.get(query) ?? new Set<() => void>();
    listeners.set(query, changes);
    return {
      matches: width >= Number(query.match(/\d+/)?.[0] ?? Infinity),
      addEventListener: (_type: string, notify: () => void) => changes.add(notify),
      removeEventListener: (_type: string, notify: () => void) => changes.delete(notify),
    };
  });
  const resize = (wide: boolean) =>
    act(() => {
      width = wide ? 820 : 700;
      for (const changes of listeners.values()) for (const notify of changes) notify();
    });
  const reading = {
    key: "layout",
    entry: {
      title: "Synthetic",
      revision: 2,
      folds: new Map<string, boolean>(),
      positions: new Map([["layout", { id: "h-0", fraction: 0.5 }]]),
    },
    returning: true,
    visit: {},
  };
  const view = render(
    <QueryClientProvider client={client}>
      <HtmlDocFrame
        reviewId={id}
        revision={2}
        changedBlocks={[]}
        path={path}
        contentUrl={doc.contentUrl}
        threads={[]}
        look={look}
        headings={[{ level: 2, text: "Part" }]}
        docPaths={[path]}
        reading={reading}
      />
    </QueryClientProvider>,
  );
  const frame = frameByTitle();
  frame.setAttribute("width", initialWide ? "740" : "900");
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  fireEvent.load(frame);
  expect(post).not.toHaveBeenCalled();
  fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { type: "recense:ready" } }));
  expect(post.mock.calls).toEqual([
    [layoutMessage(initialWide), "*"],
    ...(look === "recense" ? [[{ type: "recense:theme", mode: "light", scales: {}, tokens: {} }, "*"]] : []),
    [{ type: "recense:highlight", anchors: [] }, "*"],
    [{ type: "recense:docs", paths: [path] }, "*"],
    [{ type: "recense:goto", heading: 0, label: "Part", fraction: 0.5 }, "*"],
  ]);
  post.mockClear();
  resize(!initialWide);
  expect(post.mock.calls).toEqual([[layoutMessage(!initialWide), "*"]]);
  fireEvent.load(frame);
  post.mockClear();
  resize(initialWide);
  act(() => layoutStore.update({ readingWidth: "wide", proseSize: 18, codePx: 12 }));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText(`Reload ${path}`));
  const next = frameByTitle();
  expect(next).not.toBe(frame);
  const nextPost = vi.fn();
  Object.defineProperty(next, "contentWindow", { value: { postMessage: nextPost } });
  fireEvent.load(next);
  resize(!initialWide);
  expect(nextPost).not.toHaveBeenCalled();
  fireEvent(window, new MessageEvent("message", { source: next.contentWindow, data: { type: "recense:ready" } }));
  expect(nextPost.mock.calls).toEqual([
    [layoutMessage(!initialWide), "*"],
    ...(look === "recense" ? [[{ type: "recense:theme", mode: "light", scales: {}, tokens: {} }, "*"]] : []),
    [{ type: "recense:highlight", anchors: [] }, "*"],
    [{ type: "recense:docs", paths: [path] }, "*"],
    [{ type: "recense:goto", heading: 0, label: "Part", fraction: 0.5 }, "*"],
  ]);
  nextPost.mockClear();
  view.unmount();
  resize(initialWide);
  expect(nextPost).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

function FrameContent({
  values,
  docNavigation,
  navigation,
  images,
  look,
  colorScheme,
}: {
  values: ThreadView[];
  docNavigation?: DocNavigation;
  navigation?: { threadId: string; intent: unknown };
  images?: readonly string[];
  look?: "recense" | "custom";
  colorScheme?: "light";
}) {
  const [open, setOpen] = useState(values.length > 0);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open panel
      </button>
      <HtmlDocFrame
        reviewId={id}
        revision={2}
        changedBlocks={[]}
        path={path}
        contentUrl={doc.contentUrl}
        images={images}
        look={look}
        colorScheme={colorScheme}
        threads={values}
        navigation={navigation}
        docNavigation={docNavigation}
        commentsOpen={open}
        onCommentsOpenChange={setOpen}
      />
    </>
  );
}
function mount(
  threads: ThreadView[] = [],
  navigation?: { threadId: string; intent: unknown },
  images?: readonly string[],
  look?: "recense" | "custom",
  colorScheme?: "light",
) {
  const ui = (values: ThreadView[], docNavigation?: DocNavigation) => (
    <QueryClientProvider client={client}>
      <FrameContent
        values={values}
        docNavigation={docNavigation}
        navigation={navigation}
        images={images}
        look={look}
        colorScheme={colorScheme}
      />
    </QueryClientProvider>
  );
  const view = render(ui(threads));
  const frame = view.container.querySelector("iframe");
  if (!frame) throw new Error("Missing frame");
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  const message = (data: unknown, source = frame.contentWindow) =>
    fireEvent(window, new MessageEvent("message", { source, data }));
  return {
    ...view,
    frame,
    post,
    message,
    update: (values: ThreadView[]) => view.rerender(ui(values)),
    fragment: (fragment: string) => view.rerender(ui(threads, { type: "recense:navigate", path, fragment })),
  };
}

function systemTheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-color-scheme: dark)" && dark,
    addEventListener: (_type: string, notify: () => void) => {
      if (query === "(prefers-color-scheme: dark)") listeners.add(notify);
    },
    removeEventListener: (_type: string, notify: () => void) => listeners.delete(notify),
  }));
  return (next: boolean) =>
    act(() => {
      dark = next;
      for (const notify of listeners) notify();
    });
}

test.each([
  { pick: "dark", osDark: false, mode: "dark" },
  { pick: "light", osDark: true, mode: "light" },
  { pick: "system", osDark: false, mode: "light" },
  { pick: "system", osDark: true, mode: "dark" },
] as const)("HTML recense look follows $pick with OS dark=$osDark without reloading", ({ pick, osDark, mode }) => {
  const changeOS = systemTheme(osDark);
  setThemePick(pick);
  const view = mount([], undefined, undefined, "recense");
  const src = `${doc.contentUrl}?theme=${mode}`;
  expect(view.frame.getAttribute("src")).toBe(src);
  expect(view.post).not.toHaveBeenCalled();
  fireEvent.load(view.frame);
  view.message({ type: "recense:ready" });
  expect(view.post.mock.calls.slice(0, 2)).toEqual([
    [{ type: "recense:layout", wide: false, width: "comfortable", prose: 16, code: 13 }, "*"],
    [{ type: "recense:theme", mode, scales: {}, tokens: {} }, "*"],
  ]);
  view.post.mockClear();
  const nextMode = mode === "dark" ? "light" : "dark";
  if (pick === "system") changeOS(!osDark);
  else act(() => setThemePick(nextMode));
  expect(view.post.mock.calls).toEqual([[{ type: "recense:theme", mode: nextMode, scales: {}, tokens: {} }, "*"]]);
  expect(frameByTitle()).toBe(view.frame);
  expect(view.frame.getAttribute("src")).toBe(src);
  view.post.mockClear();
  if (pick !== "system") {
    changeOS(!osDark);
    expect(view.post).not.toHaveBeenCalled();
  }
  fireEvent.load(view.frame);
  act(() => setThemePick(mode));
  expect(view.post).not.toHaveBeenCalled();
});

test.each(["recense", "custom", undefined] as const)(
  "%s URLs use the current mode on navigation and Reload",
  (look) => {
    setThemePick("dark");
    const view = mount([], undefined, undefined, look);
    const query = (mode: string) => (look === "recense" ? `?theme=${mode}` : "");
    expect(view.frame.getAttribute("src")).toBe(`${doc.contentUrl}${query("dark")}`);
    fireEvent.load(view.frame);
    view.message({ type: "recense:ready" });
    act(() => setThemePick("light"));
    fireEvent.load(view.frame);
    fireEvent.click(screen.getByText(`Reload ${path}`));
    const reloaded = frameByTitle();
    expect(reloaded.getAttribute("src")).toBe(`${doc.contentUrl}${query("light")}`);
    act(() => setThemePick("dark"));
    expect(frameByTitle()).toBe(reloaded);
    view.fragment("part #é");
    expect(frameByTitle().getAttribute("src")).toBe(`${doc.contentUrl}${query("dark")}#part%20%23%C3%A9`);
  },
);

test("resetting a recense doc to the top uses the current mode", () => {
  setThemePick("dark");
  const reading = {
    key: "theme-top",
    entry: { title: "Synthetic", revision: 2, folds: new Map<string, boolean>(), positions: new Map() },
    returning: false,
    visit: {},
  };
  const ui = (target?: string) => (
    <QueryClientProvider client={client}>
      <HtmlDocFrame
        reviewId={id}
        revision={2}
        changedBlocks={[]}
        path={path}
        contentUrl={doc.contentUrl}
        threads={[]}
        look="recense"
        reading={{ ...reading, target }}
      />
    </QueryClientProvider>
  );
  const view = render(ui());
  const frame = frameByTitle();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: vi.fn() } });
  fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { type: "recense:ready" } }));
  act(() => setThemePick("light"));
  expect(frameByTitle()).toBe(frame);
  view.rerender(ui("top"));
  expect(frameByTitle()).not.toBe(frame);
  expect(frameByTitle().getAttribute("src")).toBe(`${doc.contentUrl}?theme=light`);
});

test.each(["custom", undefined] as const)("%s look never receives colours or theme messages", (look) => {
  const changeOS = systemTheme(false);
  const view = mount([], undefined, undefined, look);
  view.message({ type: "recense:ready" });
  expect(view.post.mock.calls.map(([message]) => message.type)).toEqual([
    "recense:layout",
    "recense:highlight",
    "recense:docs",
  ]);
  view.post.mockClear();
  for (const pick of ["dark", "light", "system"] as const) act(() => setThemePick(pick));
  changeOS(true);
  act(() => selectCustomTheme(customTheme));
  expect(view.post).not.toHaveBeenCalled();
  expect(frameByTitle()).toBe(view.frame);
  expect(view.frame.getAttribute("src")).toBe(doc.contentUrl);
});

test("themeColors filters names and unsafe values without modifying the theme", () => {
  const theme = Object.freeze({
    ...customTheme,
    scales: Object.freeze({ ...customTheme.scales, unknown: "#112233", "n-25": "url(x)" }),
    tokens: Object.freeze({ ...customTheme.tokens, unknown: "#112233", accent: "red", "fg-2": "unknown" }),
  });
  expect(themeColors(theme)).toEqual({ scales: customTheme.scales, tokens: customTheme.tokens });
});

test("an open HTML frame receives filtered custom colours and live colour updates", async () => {
  const entry = {
    ...customTheme,
    name: "html-colors",
    scales: { ...customTheme.scales, unknown: "#aabbcc" },
    tokens: { ...customTheme.tokens, unknown: "#aabbcc" },
  };
  selectCustomTheme(entry);
  const view = mount([], undefined, undefined, "recense");
  const src = view.frame.src;
  view.message({ type: "recense:ready" });
  expect(view.post.mock.calls[1]).toEqual([
    { type: "recense:theme", mode: "dark", scales: customTheme.scales, tokens: customTheme.tokens },
    "*",
  ]);
  view.post.mockClear();
  const updated = { ...entry, scales: { "n-950": "#223344" }, tokens: { "fg-1": "#abcdef" } };
  fetchMock.mockResolvedValue(Response.json({ themes: [updated], folderError: false }));
  let stop = () => {};
  await act(async () => {
    stop = startThemeSync();
  });
  try {
    await waitFor(() =>
      expect(view.post.mock.calls).toEqual([
        [{ type: "recense:theme", mode: "dark", scales: updated.scales, tokens: updated.tokens }, "*"],
      ]),
    );
    expect(frameByTitle()).toBe(view.frame);
    expect(view.frame.src).toBe(src);
    view.post.mockClear();
    act(() => setThemePick("dark"));
    expect(view.post.mock.calls).toEqual([[{ type: "recense:theme", mode: "dark", scales: {}, tokens: {} }, "*"]]);
  } finally {
    stop();
  }
});

test.each(["dark", "light"] as const)("light-only docs take colours only from a light base (%s)", (base) => {
  selectCustomTheme({ ...customTheme, name: `html-${base}`, base });
  const view = mount([], undefined, undefined, "recense", "light");
  view.message({ type: "recense:ready" });
  expect(view.post.mock.calls[1]).toEqual([
    {
      type: "recense:theme",
      mode: "light",
      scales: base === "light" ? customTheme.scales : {},
      tokens: base === "light" ? customTheme.tokens : {},
    },
    "*",
  ]);
  expect(view.frame.getAttribute("src")).toBe(doc.contentUrl);
  view.post.mockClear();
  act(() => setThemePick("dark"));
  if (base === "light")
    expect(view.post.mock.calls).toEqual([[{ type: "recense:theme", mode: "light", scales: {}, tokens: {} }, "*"]]);
  else expect(view.post).not.toHaveBeenCalled();
  view.fragment("part");
  expect(frameByTitle().getAttribute("src")).toBe(`${doc.contentUrl}#part`);
});

test("theme messages reuse strict contract colours and mode", () => {
  const valid = { type: "recense:theme", mode: "dark", scales: customTheme.scales, tokens: customTheme.tokens };
  expect(ParentToFrame.parse(valid)).toEqual(valid);
  expect(ParentToFrame.parse({ ...valid, mode: "light", scales: {}, tokens: {} })).toEqual({
    ...valid,
    mode: "light",
    scales: {},
    tokens: {},
  });
  for (const patch of [
    { extra: true },
    { fonts: {} },
    { mode: "system" },
    { mode: "DARK" },
    { mode: undefined },
    { scales: [] },
    { scales: null },
    { scales: { "n-950": "red" } },
    { tokens: { "fg-1": "url(x)" } },
    { tokens: { "bg-app": "unknown" } },
  ])
    expect(ParentToFrame.safeParse({ ...valid, ...patch }).success).toBe(false);
});

const preferenceChanges: Partial<LayoutPreferences>[] = [
  ...(["comfortable", "wide", "narrow"] as const).map((readingWidth) => ({ readingWidth })),
  ...([15, 16, 17, 18] as const).map((proseSize) => ({ proseSize })),
  ...([12, 13, 14, 15] as const).map((codePx) => ({ codePx })),
];

test.each(preferenceChanges)("recense layout applies %j live and sends stored values on a fresh mount", (patch) => {
  layoutStore.update({
    readingWidth: patch.readingWidth === "comfortable" ? "wide" : "comfortable",
    proseSize: patch.proseSize === 16 ? 15 : 16,
    codePx: patch.codePx === 13 ? 12 : 13,
  });
  const layoutMessage = () => {
    const { readingWidth: width, proseSize: prose, codePx: code } = layoutStore.getSnapshot();
    return { type: "recense:layout", wide: window.matchMedia("(min-width: 768px)").matches, width, prose, code };
  };
  const view = mount([], undefined, undefined, "recense");
  const src = view.frame.src;
  fireEvent.load(view.frame);
  expect(view.post).not.toHaveBeenCalled();
  view.message({ type: "recense:ready" });
  expect(view.post.mock.calls[0]).toEqual([layoutMessage(), "*"]);
  view.post.mockClear();
  act(() => layoutStore.update(patch));
  expect(view.post.mock.calls).toEqual([[layoutMessage(), "*"]]);
  expect(view.container.querySelector("iframe")).toBe(view.frame);
  expect(view.frame.src).toBe(src);
  view.post.mockClear();
  act(() => layoutStore.update({ hideResolved: true }));
  expect(view.post).not.toHaveBeenCalled();
  view.unmount();
  const fresh = mount([], undefined, undefined, "recense");
  fireEvent.load(fresh.frame);
  fresh.message({ type: "recense:ready" });
  expect(fresh.post.mock.calls[0]).toEqual([layoutMessage(), "*"]);
});

test.each(["custom", undefined] as const)("%s look ignores View width and size changes", (look) => {
  const view = mount([], undefined, undefined, look);
  const src = view.frame.src;
  fireEvent.load(view.frame);
  view.message({ type: "recense:ready" });
  expect(view.post.mock.calls[0]).toEqual([
    { type: "recense:layout", wide: window.matchMedia("(min-width: 768px)").matches },
    "*",
  ]);
  view.post.mockClear();
  for (const patch of preferenceChanges) act(() => layoutStore.update(patch));
  expect(view.post).not.toHaveBeenCalled();
  expect(view.container.querySelector("iframe")).toBe(view.frame);
  expect(view.frame.src).toBe(src);
});

test.each(["reply", "edit"])(
  "HTML docs retain draft-based %s restoration after dismissal and remount",
  async (kind) => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const placed = {
      ...thread,
      comments: thread.comments.map((comment) => ({
        ...comment,
        sent: kind === "reply",
        sentOn: kind === "reply" ? 1 : null,
      })),
    };
    const first = mount([placed]);
    fireEvent.click(screen.getByRole("button", { name: kind === "reply" ? "Reply" : "Edit" }));
    const label = kind === "reply" ? "Reply" : "Edit comment";
    const editor = screen.getByRole("textbox", { name: label });
    fireEvent.change(editor, { target: { value: "Retained HTML draft" } });
    if (kind === "reply") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    else fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: label })).toBeNull();
    await act(async () => first.unmount());
    mount([placed]);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: label }).value).toBe("Retained HTML draft");
  },
);
test("all production web frames use the exact sandbox without DOM string insertion", () => {
  for (const file of readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" }).filter(
    (file) => /\.[jt]sx?$/.test(file) && !file.includes(".test."),
  )) {
    const text = readFileSync(join(import.meta.dirname, file), "utf8");
    for (const forbidden of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms"])
      expect(text, file).not.toContain(forbidden);
  }
  const { frame } = mount();
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toBe(doc.contentUrl);
  expect(frame.getAttribute("title")).toBe(path);
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(frame.hasAttribute("allow")).toBe(false);
  expect(frame.classList.contains("h-full")).toBe(true);
  expect(frame.style.height).toBe("");
  expect(frame.style.minHeight).toBe("");
});
test("closed strict message schemas enforce every contract limit", () => {
  for (const data of [
    { type: "recense:ready", extra: true },
    { type: "recense:deselect", extra: true },
    { type: "size", height: 400 },
    { type: "recense:anchor", ...anchor, quote: "x".repeat(2001) },
    { type: "recense:anchor", ...anchor, prefix: "x".repeat(33) },
    { type: "recense:anchor", ...anchor, suffix: "x".repeat(33) },
    { type: "recense:anchor", ...anchor, quote: "" },
    { type: "recense:anchor", ...anchor, body: "extra" },
    { type: "recense:navigate", path: "other.html", fragment: "x".repeat(1025) },
    { type: "recense:navigate", path: "../other.html", fragment: "" },
    { type: "recense:navigate", path: "/other.html", fragment: "" },
    { type: "recense:navigate", path: "other.html", fragment: "", body: "extra" },
    { type: "recense:navigate", path: "other.html" },
    { type: "recense:navigate", path: "other.html", fragment: null },
    { type: "recense:navigate", path: "other.html", fragment: "\ud800" },
  ])
    expect(FrameToParent.safeParse(data).success).toBe(false);
  expect(FrameToParent.parse({ type: "recense:deselect" })).toEqual({ type: "recense:deselect" });
  expect(FrameToParent.safeParse({ type: "recense:anchor", ...anchor, quote: "x".repeat(2000) }).success).toBe(true);
  expect(
    ParentToFrame.safeParse({ type: "recense:highlight", anchors: [{ threadId: id, ...anchor, state: "open" }] })
      .success,
  ).toBe(false);
  expect(ParentToFrame.safeParse({ type: "recense:scroll", threadId: id }).success).toBe(true);
  for (const fragment of ["", "x".repeat(1024)])
    expect(FrameToParent.safeParse({ type: "recense:navigate", path: "other.html", fragment }).success).toBe(true);
});

test("layout messages accept exactly the legacy shape or all three valid preferences", () => {
  const full = { type: "recense:layout", wide: true, width: "comfortable", prose: 16, code: 13 };
  for (const wide of [true, false]) {
    expect(ParentToFrame.parse({ type: "recense:layout", wide })).toEqual({ type: "recense:layout", wide });
    for (const width of ["comfortable", "wide", "narrow"])
      for (const prose of [15, 16, 17, 18])
        for (const code of [12, 13, 14, 15]) {
          const message = { ...full, wide, width, prose, code };
          expect(ParentToFrame.parse(message)).toEqual(message);
        }
  }
  for (const wide of [undefined, null, "wide", "true", 0, 1, {}, []]) {
    expect(ParentToFrame.safeParse({ type: "recense:layout", wide }).success).toBe(false);
    expect(ParentToFrame.safeParse({ ...full, wide }).success).toBe(false);
  }
  for (const width of [undefined, null, "unknown", "1024px", 0, {}, []])
    expect(ParentToFrame.safeParse({ ...full, width }).success).toBe(false);
  for (const prose of [undefined, null, 14, 19, 16.5, "17", {}, [], true, NaN, Infinity])
    expect(ParentToFrame.safeParse({ ...full, prose }).success).toBe(false);
  for (const code of [undefined, null, 11, 16, 13.5, "13", {}, [], true, NaN, Infinity])
    expect(ParentToFrame.safeParse({ ...full, code }).success).toBe(false);
  for (const partial of [
    { width: "wide" },
    { prose: 17 },
    { code: 14 },
    { width: "wide", prose: 17 },
    { width: "wide", code: 14 },
    { prose: 17, code: 14 },
  ])
    expect(ParentToFrame.safeParse({ type: "recense:layout", wide: true, ...partial }).success).toBe(false);
  expect(ParentToFrame.safeParse({ type: "recense:layout", wide: true, extra: true }).success).toBe(false);
  expect(ParentToFrame.safeParse({ ...full, extra: true }).success).toBe(false);
});

test("the drawer includes this doc's unplaced threads without offering a frame jump", () => {
  const unplaced: ThreadView = { ...thread, placement: { status: "unplaced", reason: "block-gone" } };
  const other: ThreadView = {
    ...unplaced,
    id: "22222222-2222-4222-8222-222222222222",
    target: { kind: "html-span", path: "other.html", ...anchor },
    comments: [{ id, author: "user", body: "Another doc's comment", sent: true, sentOn: 1 }],
  };
  const { message, post } = mount([unplaced, other]);
  message({ type: "recense:ready" });
  expect(screen.getByText("Private synthetic comment")).toBeTruthy();
  expect(screen.getByText(/The block this comment was on is gone\./)).toBeTruthy();
  expect(screen.queryByText("Another doc's comment")).toBeNull();
  expect(screen.queryByRole("button", { name: "Show in doc" })).toBeNull();
  expect(screen.queryByText("No comments on this doc yet.")).toBeNull();
  expect(post).toHaveBeenCalledWith({ type: "recense:highlight", anchors: [] }, "*");
});

test("parent fragment changes and Reload establish fresh baselines; unexpected loads still lock the frame", () => {
  const { fragment: navigateFragment, frame, message } = mount();
  fireEvent.load(frame);
  message({ type: "recense:anchor", ...anchor });
  expect(screen.getByText("Comment on selection")).toBeTruthy();
  const original = frame;
  for (const fragment of ["first", "second", "second"]) {
    navigateFragment(fragment);
    expect(screen.queryByText("Comment on selection")).toBeNull();
    const target = frameByTitle() as HTMLIFrameElement;
    const post = vi.fn();
    Object.defineProperty(target, "contentWindow", { value: { postMessage: post } });
    fireEvent.load(target);
    fireEvent(window, new MessageEvent("message", { source: target.contentWindow, data: { type: "recense:ready" } }));
    expect(post).toHaveBeenCalledWith({ type: "recense:highlight", anchors: [] }, "*");
    expect(screen.queryByText("This doc navigated away.")).toBeNull();
    expect(target.getAttribute("src")).toBe(`${doc.contentUrl}#${fragment}`);
  }
  fireEvent(
    window,
    new MessageEvent("message", { source: original.contentWindow, data: { type: "recense:anchor", ...anchor } }),
  );
  expect(screen.queryByText("Comment on selection")).toBeNull();
  const target = frameByTitle() as HTMLIFrameElement;
  fireEvent.load(target);
  expect(screen.getByText("This doc navigated away.")).toBeTruthy();
  fireEvent.click(screen.getByText(`Reload ${path}`));
  const restored = frameByTitle();
  expect(restored.getAttribute("src")).toBe(doc.contentUrl);
  fireEvent.load(restored);
  expect(screen.queryByText("This doc navigated away.")).toBeNull();
  fireEvent.load(restored);
  expect(screen.getByText("This doc navigated away.")).toBeTruthy();
});

test.each([false, true])("opening a doc fragment replaces an earlier thread scroll (ready=%s)", (ready) => {
  const { frame, message, post, fragment } = mount([thread], { threadId: id, intent: "initial" });
  fireEvent.load(frame);
  if (ready) {
    message({ type: "recense:ready" });
    expect(post).toHaveBeenCalledWith({ type: "recense:scroll", threadId: id }, "*");
  }
  fragment("new-heading");
  const target = frameByTitle() as HTMLIFrameElement;
  const nextPost = vi.fn();
  Object.defineProperty(target, "contentWindow", { value: { postMessage: nextPost } });
  fireEvent.load(target);
  fireEvent(window, new MessageEvent("message", { source: target.contentWindow, data: { type: "recense:ready" } }));
  expect(nextPost).toHaveBeenCalledWith({ type: "recense:highlight", anchors: [{ threadId: id, ...anchor }] }, "*");
  expect(nextPost.mock.calls.filter(([data]) => data.type === "recense:scroll")).toEqual([]);
  expect(target.getAttribute("src")).toBe(`${doc.contentUrl}#new-heading`);
});
test("only this frame proposes anchors; composer freezes the quote and only reviewer save creates a thread", async () => {
  const { frame, message } = mount();
  message({ type: "recense:anchor", ...anchor }, window);
  message({ type: "recense:anchor", ...anchor, quote: "x".repeat(2001) });
  expect(screen.queryByText("Comment on selection")).toBeNull();
  message({ type: "recense:anchor", ...anchor });
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Comment on selection"));
  expect(screen.getByText("seeds").tagName).toBe("MARK");
  message({ type: "recense:anchor", ...anchor, quote: "replacement" });
  expect(screen.queryByText("replacement")).toBeNull();
  expect(screen.queryByText("Comment on selection")).toBeNull();
  message({ type: "recense:deselect" });
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Please explain" } });
  expect(localStorage.getItem(draftKey(id, thread.target))).toBe("Please explain");
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Save comment"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/v1/reviews/${id}/threads`,
    expect.objectContaining({ body: JSON.stringify({ revision: 2, target: thread.target, body: "Please explain" }) }),
  );
  expect(frame.isConnected).toBe(true);
});
test("only the current frame can retire its selection prompt", () => {
  const { message } = mount();
  message({ type: "recense:anchor", ...anchor });
  const prompt = screen.getByRole("button", { name: "Comment on selection" });
  message({ type: "recense:deselect" }, window);
  expect(prompt.isConnected).toBe(true);
  message({ type: "recense:deselect" });
  expect(screen.queryByText("Comment on selection")).toBeNull();
});

test("Cancel retires the selection prompt until the frame proposes a new anchor", () => {
  const { message } = mount();
  message({ type: "recense:anchor", ...anchor });
  fireEvent.click(screen.getByText("Comment on selection"));
  expect(screen.getByText(anchor.quote, { selector: "mark" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText("Comment on selection")).toBeNull();
  message({ type: "recense:anchor", ...anchor, quote: "roots" });
  expect(screen.getByText("Comment on selection")).toBeTruthy();
});

describe("pressing Comment on selection", () => {
  const touch = { pointerType: "touch", pointerId: 1 };
  const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function pressSelection(message: ReturnType<typeof mount>["message"]) {
    const prompt = screen.getByRole("button", { name: "Comment on selection" });
    fireEvent.pointerDown(prompt, touch);
    message({ type: "recense:deselect" });
    advance(120);
    return prompt;
  }

  function openSelection(message: ReturnType<typeof mount>["message"]) {
    const prompt = pressSelection(message);
    expect(prompt.hasPointerCapture(touch.pointerId)).toBe(true);
    fireEvent.pointerUp(prompt, touch);
    fireEvent.mouseUp(prompt);
    fireEvent.click(prompt);
  }

  test.each(["Escape", "Close", "outside press"])(
    "closing Comments with %s preserves the form and allows a new quote",
    (dismiss) => {
      const { message } = mount();
      const closePanel = () => {
        if (dismiss === "Escape")
          fireEvent.keyDown(screen.getByRole("dialog", { name: "Comments" }), { key: "Escape" });
        else if (dismiss === "Close") fireEvent.click(screen.getByRole("button", { name: "Close" }));
        else {
          // Radix installs its outside-press listener in a timer and dismisses on the ensuing click.
          advance(1);
          fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
          fireEvent.pointerUp(document.body, { button: 0, pointerType: "mouse" });
          fireEvent.click(document.body);
        }
        expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
      };
      message({ type: "recense:anchor", ...anchor });
      openSelection(message);
      fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Keep this draft" } });
      closePanel();
      const next = { type: "recense:anchor", ...anchor, quote: "roots" };
      message(next);
      const offeredSelection = !!screen.queryByRole("button", { name: "Comment on selection" });
      fireEvent.click(screen.getByRole("button", { name: "Open panel" }));
      const draft = screen.queryByRole<HTMLTextAreaElement>("textbox", { name: "Comment" })?.value;
      expect({ offeredSelection, draft }).toEqual({ offeredSelection: true, draft: "Keep this draft" });
      expect(screen.queryByText("Comment on selection")).toBeNull();
      expect(screen.getByText(anchor.quote, { selector: "mark" })).toBeTruthy();
      closePanel();
      message(next);
      openSelection(message);
      expect(screen.getByText(next.quote, { selector: "mark" })).toBeTruthy();
      expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }).value).toBe("");
      expect(localStorage.getItem(draftKey(id, thread.target))).toBe("Keep this draft");
    },
  );

  test.each(["pointerup", "pointercancel", "lostpointercapture"])(
    "%s without a click retires the prompt after one frame deselection",
    (release) => {
      const { message } = mount();
      message({ type: "recense:anchor", ...anchor });
      const prompt = pressSelection(message);
      if (release === "lostpointercapture") fireEvent.lostPointerCapture(prompt, touch);
      else if (release === "pointercancel") fireEvent.pointerCancel(document, { ...touch, pointerId: 2 });
      else fireEvent.pointerUp(document, touch);
      advance(599);
      expect(prompt.isConnected).toBe(true);
      advance(1);
      expect(screen.queryByText("Comment on selection")).toBeNull();
    },
  );

  test("a newer frame selection supersedes the pending deselection and opens with its own quote", () => {
    const { message } = mount();
    message({ type: "recense:anchor", ...anchor });
    const prompt = pressSelection(message);
    fireEvent.pointerUp(prompt, touch);
    advance(599);
    message({ type: "recense:anchor", ...anchor, quote: "roots" });
    advance(1);
    openSelection(message);
    expect(screen.getByText("roots", { selector: "mark" })).toBeTruthy();
  });
});
test("ready and changed threads post only placed anchors for this doc; Show in doc scrolls", () => {
  const outerScroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const other = {
    ...thread,
    id: "22222222-2222-4222-8222-222222222222",
    placement: {
      status: "placed" as const,
      location: { kind: "html-span" as const, path: "other.html", start: 0, end: 5 },
    },
  };
  const unplaced = {
    ...thread,
    id: "33333333-3333-4333-8333-333333333333",
    placement: { status: "unplaced" as const, reason: "block-gone" as const },
  };
  const { message, post, update } = mount([other, thread, unplaced]);
  expect(post).not.toHaveBeenCalled();
  message({ type: "recense:ready" });
  expect(post).toHaveBeenCalledWith({ type: "recense:highlight", anchors: [{ threadId: id, ...anchor }] }, "*");
  expect(JSON.stringify(post.mock.calls)).not.toContain("Private synthetic comment");
  expect(JSON.stringify(post.mock.calls)).not.toContain("state");
  fireEvent.click(screen.getByText("Show in doc"));
  expect(outerScroll).not.toHaveBeenCalled();
  expect(post).toHaveBeenLastCalledWith({ type: "recense:scroll", threadId: id }, "*");
  update([]);
  expect(post).toHaveBeenLastCalledWith({ type: "recense:highlight", anchors: [] }, "*");
  expect(post.mock.calls.filter(([data]) => data.type === "recense:highlight")).toHaveLength(2);
});
test("a second load permanently stops messages and anchors until explicit Reload mounts a fresh frame", () => {
  const { frame, message, post, container, update } = mount([thread]);
  fireEvent.load(frame);
  message({ type: "recense:ready" });
  fireEvent.load(frame);
  post.mockClear();
  expect(screen.getByText("This doc navigated away.")).toBeTruthy();
  message({ type: "recense:anchor", ...anchor });
  message({ type: "recense:ready" });
  fireEvent.click(screen.getByText("Show in doc"));
  update([]);
  expect(post).not.toHaveBeenCalled();
  expect(screen.queryByText("Comment on selection")).toBeNull();
  fireEvent.click(screen.getByText(`Reload ${path}`));
  const next = container.querySelector("iframe");
  expect(next).not.toBe(frame);
  expect(next?.getAttribute("src")).toBe(doc.contentUrl);
  expect(screen.queryByText("This doc navigated away.")).toBeNull();
  message({ type: "recense:anchor", ...anchor });
  expect(screen.queryByText("Comment on selection")).toBeNull();
});
test("HTML cards use placement order", () => {
  const late = {
    ...thread,
    id: "22222222-2222-4222-8222-222222222222",
    placement: { status: "placed" as const, location: { kind: "html-span" as const, path, start: 50, end: 55 } },
  };
  mount([late, thread]);
  expect([...document.querySelectorAll("[data-thread-card]")].map((node) => node.id)).toEqual([
    `thread-${id}`,
    `thread-${late.id}`,
  ]);
});

test("R1.3 only position messages accept the introduction; goto still requires a heading", () => {
  expect(FrameToParent.safeParse({ type: "recense:position", heading: null, fraction: 0 }).success).toBe(true);
  expect(ParentToFrame.safeParse({ type: "recense:goto", heading: null, fraction: 0, label: "" }).success).toBe(false);
});

test("R5.1 goto distinguishes a pick without fraction from a restore including zero", () => {
  const pick = { type: "recense:goto", heading: 0, label: "First" };
  expect(ParentToFrame.parse(pick)).toEqual(pick);
  for (const fraction of [0, 0.5, 1]) expect(ParentToFrame.parse({ ...pick, fraction })).toEqual({ ...pick, fraction });
  for (const fraction of [null, -1, 2, NaN, Infinity, "0"])
    expect(ParentToFrame.safeParse({ ...pick, fraction }).success).toBe(false);
  expect(ParentToFrame.safeParse({ ...pick, extra: true }).success).toBe(false);
});

const pubImages = ["images/a #é.png", "images/b%2F.png", "images/c.png"];
const imageMessage = {
  type: "recense:image",
  images: pubImages.map((path, index) => ({ path, caption: index === 2 ? "" : `Caption ${index + 1}` })),
  index: 0,
};
function lightboxImage() {
  const image = screen.getByRole("dialog").querySelector("img");
  if (!image) throw new Error("Missing lightbox image");
  return image;
}

test.each(["recense", "custom"] as const)(
  "%s pub images open in order without comments and preserve the frame on close",
  async (look) => {
    const { frame, message, container, post } = mount([], undefined, pubImages, look);
    fireEvent.load(frame);
    message({ type: "recense:ready" });
    frame.focus();
    const focus = vi.spyOn(frame, "focus");
    const src = frame.getAttribute("src");
    post.mockClear();
    message(imageMessage);
    expect(screen.getByRole("dialog", { name: "Caption 1" })).toBeTruthy();
    expect(lightboxImage().getAttribute("src")).toBe(`/content/${"a".repeat(75)}/images/a%20%23%C3%A9.png`);
    expect(screen.queryByRole("button", { name: /comment/i })).toBeNull();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next screenshot" }));
    expect(screen.getByRole("dialog", { name: "Caption 2" })).toBeTruthy();
    expect(lightboxImage().getAttribute("src")).toBe(`/content/${"a".repeat(75)}/images/b%252F.png`);
    fireEvent.click(screen.getByRole("button", { name: "Next screenshot" }));
    expect(screen.getByRole("dialog", { name: "Screenshot" })).toBeTruthy();
    expect(lightboxImage().getAttribute("src")).toBe(`/content/${"a".repeat(75)}/images/c.png`);
    expect(screen.getByText("3 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe(src);
    expect(post).not.toHaveBeenCalled();
    await waitFor(() => expect(focus).toHaveBeenCalledWith({ preventScroll: true }));
  },
);

test("image messages require the ready current frame and a clicked path in this doc's allowlist", () => {
  const { message } = mount([], undefined, pubImages);
  message(imageMessage);
  expect(screen.queryByRole("dialog")).toBeNull();
  message({ type: "recense:ready" });
  message(imageMessage, window);
  expect(screen.queryByRole("dialog")).toBeNull();
  for (const path of ["other-doc/image.png", "style.css", "other.html"])
    message({ ...imageMessage, images: [{ path, caption: "Unknown" }] });
  expect(screen.queryByRole("dialog")).toBeNull();
  message({ ...imageMessage, index: 1 });
  expect(screen.getByRole("dialog", { name: "Caption 2" })).toBeTruthy();
});

test("legacy docs without an image allowlist open no gallery", () => {
  const { message } = mount();
  message({ type: "recense:ready" });
  message(imageMessage);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("unknown non-clicked entries are dropped and duplicate paths keep the clicked occurrence", () => {
  const { message } = mount([], undefined, pubImages);
  message({ type: "recense:ready" });
  message({
    type: "recense:image",
    images: [
      { path: "other.png", caption: "Unknown" },
      { path: pubImages[0], caption: "First occurrence" },
      { path: "other-doc/image.png", caption: "Unknown" },
      { path: pubImages[0], caption: "Clicked occurrence" },
      imageMessage.images[2],
    ],
    index: 3,
  });
  expect(screen.getByRole("dialog", { name: "Clicked occurrence" })).toBeTruthy();
  expect(screen.getByText("2 of 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Previous screenshot" }));
  expect(screen.getByRole("dialog", { name: "First occurrence" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next screenshot" }));
  fireEvent.click(screen.getByRole("button", { name: "Next screenshot" }));
  expect(screen.getByRole("dialog", { name: "Screenshot" })).toBeTruthy();
});

test.each(["images/pending\u200b.png", "../outside.png", "/content/other/image.png"])(
  "a non-FilePath entry %j is dropped without blocking listed images",
  (path) => {
    const { message } = mount([], undefined, pubImages);
    message({ type: "recense:ready" });
    expect(FilePath.safeParse(path).success).toBe(false);
    const gallery = {
      type: "recense:image",
      images: [{ path, caption: "Unknown" }, imageMessage.images[0], imageMessage.images[2]],
      index: 0,
    };
    expect(FrameToParent.safeParse(gallery).success).toBe(true);
    message(gallery);
    expect(screen.queryByRole("dialog")).toBeNull();
    message({ ...gallery, index: 1 });
    expect(screen.getByRole("dialog", { name: "Caption 1" })).toBeTruthy();
    expect(lightboxImage().getAttribute("src")).toBe(`/content/${"a".repeat(75)}/images/a%20%23%C3%A9.png`);
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next screenshot" }));
    expect(screen.getByRole("dialog", { name: "Screenshot" })).toBeTruthy();
    expect(lightboxImage().getAttribute("src")).toBe(`/content/${"a".repeat(75)}/images/c.png`);
    expect(screen.getByText("2 of 2")).toBeTruthy();
  },
);

test.each(["load", "ready", "generation"])(
  "a %s change closes the gallery and refuses stale frame messages",
  (change) => {
    const { frame, message, fragment, container } = mount([], undefined, pubImages);
    fireEvent.load(frame);
    message({ type: "recense:ready" });
    message(imageMessage);
    expect(screen.getByRole("dialog")).toBeTruthy();
    if (change === "load") fireEvent.load(frame);
    else if (change === "ready") message({ type: "recense:ready" });
    else fragment("part");
    expect(screen.queryByRole("dialog")).toBeNull();
    message(imageMessage);
    expect(screen.queryByRole("dialog")).toBeNull();
    if (change === "generation") expect(container.querySelector("iframe")).not.toBe(frame);
    else expect(screen.getByText("This doc navigated away.")).toBeTruthy();
  },
);

test("image messages enforce strict objects, bounded well-formed captions, paths and gallery indices", () => {
  expect(FrameToParent.parse(imageMessage)).toEqual(imageMessage);
  const image = { path: "image.png", caption: "" };
  expect(
    FrameToParent.safeParse({ ...imageMessage, images: [{ ...image, caption: "x".repeat(LIMITS.quoteChars) }] })
      .success,
  ).toBe(true);
  for (const path of [
    "",
    "../outside.png",
    "/content/other/image.png",
    "images/pending\u200b.png",
    "x".repeat(LIMITS.pathChars),
  ])
    expect(FrameToParent.safeParse({ ...imageMessage, images: [{ ...image, path }] }).success).toBe(true);
  expect(
    FrameToParent.safeParse({
      ...imageMessage,
      images: Array.from({ length: LIMITS.filesPerRevision }, () => image),
      index: LIMITS.filesPerRevision - 1,
    }).success,
  ).toBe(true);
  for (const data of [
    { ...imageMessage, extra: true },
    ...[-1, 3, 0.5, "0", NaN, Infinity].map((index) => ({ ...imageMessage, index })),
    { ...imageMessage, images: [] },
    { ...imageMessage, images: Array.from({ length: LIMITS.filesPerRevision + 1 }, () => image) },
    ...[
      { ...image, extra: true },
      { ...image, path: "x".repeat(LIMITS.pathChars + 1) },
      { ...image, path: "\ud800" },
      { ...image, path: undefined },
      { ...image, path: 42 },
      { ...image, caption: "x".repeat(LIMITS.quoteChars + 1) },
      { ...image, caption: "\ud800" },
      { ...image, caption: undefined },
    ].map((image) => ({ ...imageMessage, images: [image] })),
  ])
    expect(FrameToParent.safeParse(data).success).toBe(false);
});

test.each([
  { name: "overlong", path: "x".repeat(LIMITS.pathChars + 1) },
  { name: "ill-formed", path: "image\ud800.png" },
])("an $name path rejects the whole gallery before allowlist filtering", ({ path }) => {
  const { message } = mount([], undefined, pubImages);
  message({ type: "recense:ready" });
  const gallery = { ...imageMessage, images: [imageMessage.images[0], { path, caption: "Unknown" }] };
  expect(FrameToParent.safeParse(gallery).success).toBe(false);
  message(gallery);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("image messages over the total character budget open nothing, even with allowed paths", () => {
  const path = "image.png";
  const { message } = mount([], undefined, [path]);
  message({ type: "recense:ready" });
  const images = Array.from({ length: 500 }, () => ({ path, caption: "x".repeat(2000 - path.length) }));
  const atLimit = { type: "recense:image", images, index: 0 };
  expect(FrameToParent.safeParse(atLimit).success).toBe(true);
  const overLimit = { ...atLimit, images: [{ path, caption: "x".repeat(2001 - path.length) }, ...images.slice(1)] };
  expect(FrameToParent.safeParse(overLimit).success).toBe(false);
  message(overLimit);
  expect(screen.queryByRole("dialog")).toBeNull();
});

const diagramsJob = {
  type: "recense:diagrams",
  request: 1,
  diagrams: [
    { source: "\n    graph LR\n      A --> B\n    ", mode: "light", width: 100 },
    { source: "graph TD; C --> D", mode: "dark", width: 10000 },
  ],
};
const svgAnswer = { type: "svg", svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', width: 320, height: 160 };
function renderFrame() {
  const frame = screen.getByTitle("HTML diagram renderer");
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("Missing render frame");
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: post } });
  const reply = (data: unknown = svgAnswer) =>
    fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data }));
  return { frame, post, reply };
}

test.each(["recense", "custom", undefined] as const)(
  "%s diagrams render sequentially with matching theme colours only",
  (look) => {
    setThemePick("light");
    const colors = {
      background: "#ffffff",
      surface: "#eeeeee",
      text: "#111111",
      text2: "#222222",
      line: "#333333",
      border: "#444444",
      accentBg: "#555555",
      accent: "#666666",
    };
    const read = vi.spyOn(mermaidColors, "readMermaidColors").mockReturnValue(colors);
    const view = mount([], undefined, undefined, look);
    view.message(diagramsJob);
    expect(screen.queryByTitle("HTML diagram renderer")).toBeNull();
    view.message({ type: "recense:ready" });
    view.message(diagramsJob, null);
    expect(screen.queryByTitle("HTML diagram renderer")).toBeNull();
    view.message(diagramsJob);
    const draw = renderFrame();
    expect(draw.frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(draw.frame.getAttribute("aria-hidden")).toBe("true");
    expect(draw.frame.tabIndex).toBe(-1);
    expect(draw.frame.hasAttribute("loading")).toBe(false);
    expect(draw.frame.style).toMatchObject({
      visibility: "hidden",
      position: "fixed",
      pointerEvents: "none",
      width: "240px",
    });
    expect(draw.frame.style.display).not.toBe("none");
    view.post.mockClear();
    draw.reply(); // No request before load.
    expect(view.post).not.toHaveBeenCalled();
    fireEvent.load(draw.frame);
    expect(draw.post).toHaveBeenCalledExactlyOnceWith(
      {
        type: "render",
        source: "graph LR\n  A --> B",
        theme: "light",
        reply: "svg",
        ...(look === "recense" ? { colors } : {}),
      },
      "*",
    );
    view.message(svgAnswer);
    for (const data of [
      { type: "size", height: 100 },
      { ...svgAnswer, extra: true },
      { ...svgAnswer, width: 1.5 },
      { ...svgAnswer, svg: "<script/>" },
    ])
      draw.reply(data);
    expect(view.post).not.toHaveBeenCalled();
    draw.reply();
    expect(view.post).toHaveBeenCalledExactlyOnceWith(
      { ...svgAnswer, type: "recense:diagram", request: 1, index: 0 },
      "*",
    );
    expect(screen.getByTitle("HTML diagram renderer")).toBe(draw.frame);
    expect(draw.frame.style.width).toBe("2400px");
    expect(draw.post).toHaveBeenLastCalledWith(
      { type: "render", source: "graph TD; C --> D", theme: "dark", reply: "svg" },
      "*",
    );
    expect(read).toHaveBeenCalledTimes(look === "recense" ? 1 : 0);
    draw.reply({ type: "svg", svg: null });
    expect(view.post).toHaveBeenLastCalledWith({ type: "recense:diagram", request: 1, index: 1, svg: null }, "*");
    expect(screen.queryByTitle("HTML diagram renderer")).toBeNull();
    expect(view.container.querySelector("svg:not([class])")).toBeNull();
  },
);

test("diagram timeout reports null and gives the next diagram a fresh frame", () => {
  vi.useFakeTimers();
  try {
    const view = mount();
    view.message({ type: "recense:ready" });
    view.message(diagramsJob);
    const first = renderFrame();
    act(() => vi.advanceTimersByTime(DIAGRAM_DRAW_TIMEOUT_MS - 1));
    fireEvent.load(first.frame);
    view.post.mockClear();
    act(() => vi.advanceTimersByTime(1));
    expect(view.post).toHaveBeenCalledExactlyOnceWith(
      { type: "recense:diagram", request: 1, index: 0, svg: null },
      "*",
    );
    const next = renderFrame();
    expect(next.frame).not.toBe(first.frame);
    first.reply();
    expect(view.post).toHaveBeenCalledTimes(1);
    fireEvent.load(next.frame);
    expect(next.post).toHaveBeenLastCalledWith(
      { type: "render", source: diagramsJob.diagrams[1]?.source, theme: "dark", reply: "svg" },
      "*",
    );
    next.reply();
    act(() => vi.advanceTimersByTime(DIAGRAM_DRAW_TIMEOUT_MS));
    expect(view.post).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test.each(["request", "mode", "theme"])("a new diagram %s restarts the whole job", (change) => {
  setThemePick("light");
  const view = mount([], undefined, undefined, "recense");
  view.message({ type: "recense:ready" });
  view.message(diagramsJob);
  const first = renderFrame();
  fireEvent.load(first.frame);
  first.reply();
  if (change === "request") view.message({ ...diagramsJob, request: 2 });
  else if (change === "mode") act(() => setThemePick("dark"));
  else act(() => selectCustomTheme({ ...customTheme, base: "light" }));
  const next = renderFrame();
  expect(next.frame).not.toBe(first.frame);
  view.post.mockClear();
  first.reply();
  expect(view.post).not.toHaveBeenCalled();
  fireEvent.load(next.frame);
  expect(next.post).toHaveBeenLastCalledWith(
    expect.objectContaining({ source: "graph LR\n  A --> B", reply: "svg" }),
    "*",
  );
  next.reply();
  expect(view.post).toHaveBeenLastCalledWith(
    { ...svgAnswer, type: "recense:diagram", request: change === "request" ? 2 : 1, index: 0 },
    "*",
  );
});

test.each(["away", "generation", "unmount"])("diagram jobs stop on content %s", (change) => {
  const view = mount();
  fireEvent.load(view.frame);
  view.message({ type: "recense:ready" });
  view.message(diagramsJob);
  const draw = renderFrame();
  fireEvent.load(draw.frame);
  if (change === "away") fireEvent.load(view.frame);
  else if (change === "generation") view.fragment("new");
  else view.unmount();
  view.post.mockClear();
  draw.reply();
  expect(view.post).not.toHaveBeenCalled();
  expect(screen.queryByTitle("HTML diagram renderer")).toBeNull();
  if (change === "away") {
    view.message(diagramsJob);
    expect(screen.queryByTitle("HTML diagram renderer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `Reload ${path}` }));
    expect(screen.queryByTitle("HTML diagram renderer")).toBeNull();
  }
});
