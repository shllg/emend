// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FilePath, LIMITS, type ThreadView } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HtmlDocFrame } from "./components/reading/HtmlDocFrame.tsx";
import { draftKey } from "./lib/drafts.ts";
import { type DocNavigation, FrameToParent, ParentToFrame } from "./lib/frame-messages.ts";
import { defaultLayout, type LayoutPreferences, layoutStore } from "./lib/layout-store.ts";

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

test.each(
  (["emend", "custom", undefined] as const).flatMap((look) =>
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
  expect(frame.classList.contains("bg-reading")).toBe(look === "emend" && colorScheme !== "light");
  expect(frame.classList.contains("bg-[#fff]")).toBe(look !== "emend" || colorScheme === "light");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
});

test.each(
  [true, false].flatMap((initialWide) =>
    (["emend", "custom", undefined] as const).map((look) => ({ initialWide, look })),
  ),
)("$look layout precedes restore on every ready and follows app width (wide=$initialWide)", ({ initialWide, look }) => {
  layoutStore.update({ readingWidth: "narrow", proseSize: 17, codePx: 15 });
  const layoutMessage = (wide: boolean) => {
    const { readingWidth: width, proseSize: prose, codePx: code } = layoutStore.getSnapshot();
    return look === "emend" ? { type: "emend:layout", wide, width, prose, code } : { type: "emend:layout", wide };
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
  fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { type: "emend:ready" } }));
  expect(post.mock.calls).toEqual([
    [layoutMessage(initialWide), "*"],
    [{ type: "emend:highlight", anchors: [] }, "*"],
    [{ type: "emend:docs", paths: [path] }, "*"],
    [{ type: "emend:goto", heading: 0, label: "Part", fraction: 0.5 }, "*"],
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
  fireEvent(window, new MessageEvent("message", { source: next.contentWindow, data: { type: "emend:ready" } }));
  expect(nextPost.mock.calls).toEqual([
    [layoutMessage(!initialWide), "*"],
    [{ type: "emend:highlight", anchors: [] }, "*"],
    [{ type: "emend:docs", paths: [path] }, "*"],
    [{ type: "emend:goto", heading: 0, label: "Part", fraction: 0.5 }, "*"],
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
}: {
  values: ThreadView[];
  docNavigation?: DocNavigation;
  navigation?: { threadId: string; intent: unknown };
  images?: readonly string[];
  look?: "emend" | "custom";
}) {
  const [open, setOpen] = useState(values.length > 0);
  return (
    <HtmlDocFrame
      reviewId={id}
      revision={2}
      changedBlocks={[]}
      path={path}
      contentUrl={doc.contentUrl}
      images={images}
      look={look}
      threads={values}
      navigation={navigation}
      docNavigation={docNavigation}
      commentsOpen={open}
      onCommentsOpenChange={setOpen}
    />
  );
}
function mount(
  threads: ThreadView[] = [],
  navigation?: { threadId: string; intent: unknown },
  images?: readonly string[],
  look?: "emend" | "custom",
) {
  const ui = (values: ThreadView[], docNavigation?: DocNavigation) => (
    <QueryClientProvider client={client}>
      <FrameContent values={values} docNavigation={docNavigation} navigation={navigation} images={images} look={look} />
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
    fragment: (fragment: string) => view.rerender(ui(threads, { type: "emend:navigate", path, fragment })),
  };
}

const preferenceChanges: Partial<LayoutPreferences>[] = [
  ...(["comfortable", "wide", "narrow"] as const).map((readingWidth) => ({ readingWidth })),
  ...([15, 16, 17, 18] as const).map((proseSize) => ({ proseSize })),
  ...([12, 13, 14, 15] as const).map((codePx) => ({ codePx })),
];

test.each(preferenceChanges)("emend layout applies %j live and sends stored values on a fresh mount", (patch) => {
  layoutStore.update({
    readingWidth: patch.readingWidth === "comfortable" ? "wide" : "comfortable",
    proseSize: patch.proseSize === 16 ? 15 : 16,
    codePx: patch.codePx === 13 ? 12 : 13,
  });
  const layoutMessage = () => {
    const { readingWidth: width, proseSize: prose, codePx: code } = layoutStore.getSnapshot();
    return { type: "emend:layout", wide: window.matchMedia("(min-width: 768px)").matches, width, prose, code };
  };
  const view = mount([], undefined, undefined, "emend");
  const src = view.frame.src;
  fireEvent.load(view.frame);
  expect(view.post).not.toHaveBeenCalled();
  view.message({ type: "emend:ready" });
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
  const fresh = mount([], undefined, undefined, "emend");
  fireEvent.load(fresh.frame);
  fresh.message({ type: "emend:ready" });
  expect(fresh.post.mock.calls[0]).toEqual([layoutMessage(), "*"]);
});

test.each(["custom", undefined] as const)("%s look ignores View width and size changes", (look) => {
  const view = mount([], undefined, undefined, look);
  const src = view.frame.src;
  fireEvent.load(view.frame);
  view.message({ type: "emend:ready" });
  expect(view.post.mock.calls[0]).toEqual([
    { type: "emend:layout", wide: window.matchMedia("(min-width: 768px)").matches },
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
    { type: "emend:ready", extra: true },
    { type: "size", height: 400 },
    { type: "emend:anchor", ...anchor, quote: "x".repeat(2001) },
    { type: "emend:anchor", ...anchor, prefix: "x".repeat(33) },
    { type: "emend:anchor", ...anchor, suffix: "x".repeat(33) },
    { type: "emend:anchor", ...anchor, quote: "" },
    { type: "emend:anchor", ...anchor, body: "extra" },
    { type: "emend:navigate", path: "other.html", fragment: "x".repeat(1025) },
    { type: "emend:navigate", path: "../other.html", fragment: "" },
    { type: "emend:navigate", path: "/other.html", fragment: "" },
    { type: "emend:navigate", path: "other.html", fragment: "", body: "extra" },
    { type: "emend:navigate", path: "other.html" },
    { type: "emend:navigate", path: "other.html", fragment: null },
    { type: "emend:navigate", path: "other.html", fragment: "\ud800" },
  ])
    expect(FrameToParent.safeParse(data).success).toBe(false);
  expect(FrameToParent.safeParse({ type: "emend:anchor", ...anchor, quote: "x".repeat(2000) }).success).toBe(true);
  expect(
    ParentToFrame.safeParse({ type: "emend:highlight", anchors: [{ threadId: id, ...anchor, state: "open" }] }).success,
  ).toBe(false);
  expect(ParentToFrame.safeParse({ type: "emend:scroll", threadId: id }).success).toBe(true);
  for (const fragment of ["", "x".repeat(1024)])
    expect(FrameToParent.safeParse({ type: "emend:navigate", path: "other.html", fragment }).success).toBe(true);
});

test("layout messages accept exactly the legacy shape or all three valid preferences", () => {
  const full = { type: "emend:layout", wide: true, width: "comfortable", prose: 16, code: 13 };
  for (const wide of [true, false]) {
    expect(ParentToFrame.parse({ type: "emend:layout", wide })).toEqual({ type: "emend:layout", wide });
    for (const width of ["comfortable", "wide", "narrow"])
      for (const prose of [15, 16, 17, 18])
        for (const code of [12, 13, 14, 15]) {
          const message = { ...full, wide, width, prose, code };
          expect(ParentToFrame.parse(message)).toEqual(message);
        }
  }
  for (const wide of [undefined, null, "wide", "true", 0, 1, {}, []]) {
    expect(ParentToFrame.safeParse({ type: "emend:layout", wide }).success).toBe(false);
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
    expect(ParentToFrame.safeParse({ type: "emend:layout", wide: true, ...partial }).success).toBe(false);
  expect(ParentToFrame.safeParse({ type: "emend:layout", wide: true, extra: true }).success).toBe(false);
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
  message({ type: "emend:ready" });
  expect(screen.getByText("Private synthetic comment")).toBeTruthy();
  expect(screen.getByText(/The block this comment was on is gone\./)).toBeTruthy();
  expect(screen.queryByText("Another doc's comment")).toBeNull();
  expect(screen.queryByRole("button", { name: "Show in doc" })).toBeNull();
  expect(screen.queryByText("No comments on this doc yet.")).toBeNull();
  expect(post).toHaveBeenCalledWith({ type: "emend:highlight", anchors: [] }, "*");
});

test("parent fragment changes and Reload establish fresh baselines; unexpected loads still lock the frame", () => {
  const { fragment: navigateFragment, frame } = mount();
  fireEvent.load(frame);
  const original = frame;
  for (const fragment of ["first", "second", "second"]) {
    navigateFragment(fragment);
    const target = frameByTitle() as HTMLIFrameElement;
    const post = vi.fn();
    Object.defineProperty(target, "contentWindow", { value: { postMessage: post } });
    fireEvent.load(target);
    fireEvent(window, new MessageEvent("message", { source: target.contentWindow, data: { type: "emend:ready" } }));
    expect(post).toHaveBeenCalledWith({ type: "emend:highlight", anchors: [] }, "*");
    expect(screen.queryByText("This doc navigated away.")).toBeNull();
    expect(target.getAttribute("src")).toBe(`${doc.contentUrl}#${fragment}`);
  }
  fireEvent(
    window,
    new MessageEvent("message", { source: original.contentWindow, data: { type: "emend:anchor", ...anchor } }),
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
    message({ type: "emend:ready" });
    expect(post).toHaveBeenCalledWith({ type: "emend:scroll", threadId: id }, "*");
  }
  fragment("new-heading");
  const target = frameByTitle() as HTMLIFrameElement;
  const nextPost = vi.fn();
  Object.defineProperty(target, "contentWindow", { value: { postMessage: nextPost } });
  fireEvent.load(target);
  fireEvent(window, new MessageEvent("message", { source: target.contentWindow, data: { type: "emend:ready" } }));
  expect(nextPost).toHaveBeenCalledWith({ type: "emend:highlight", anchors: [{ threadId: id, ...anchor }] }, "*");
  expect(nextPost.mock.calls.filter(([data]) => data.type === "emend:scroll")).toEqual([]);
  expect(target.getAttribute("src")).toBe(`${doc.contentUrl}#new-heading`);
});
test("only this frame proposes anchors; composer freezes the quote and only reviewer save creates a thread", async () => {
  const { frame, message } = mount();
  message({ type: "emend:anchor", ...anchor }, window);
  message({ type: "emend:anchor", ...anchor, quote: "x".repeat(2001) });
  expect(screen.queryByText("Comment on selection")).toBeNull();
  message({ type: "emend:anchor", ...anchor });
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Comment on selection"));
  expect(screen.getByText("seeds").tagName).toBe("MARK");
  message({ type: "emend:anchor", ...anchor, quote: "replacement" });
  expect(screen.queryByText("replacement")).toBeNull();
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
  message({ type: "emend:ready" });
  expect(post).toHaveBeenCalledWith({ type: "emend:highlight", anchors: [{ threadId: id, ...anchor }] }, "*");
  expect(JSON.stringify(post.mock.calls)).not.toContain("Private synthetic comment");
  expect(JSON.stringify(post.mock.calls)).not.toContain("state");
  fireEvent.click(screen.getByText("Show in doc"));
  expect(outerScroll).not.toHaveBeenCalled();
  expect(post).toHaveBeenLastCalledWith({ type: "emend:scroll", threadId: id }, "*");
  update([]);
  expect(post).toHaveBeenLastCalledWith({ type: "emend:highlight", anchors: [] }, "*");
  expect(post.mock.calls.filter(([data]) => data.type === "emend:highlight")).toHaveLength(2);
});
test("a second load permanently stops messages and anchors until explicit Reload mounts a fresh frame", () => {
  const { frame, message, post, container, update } = mount([thread]);
  fireEvent.load(frame);
  message({ type: "emend:ready" });
  fireEvent.load(frame);
  post.mockClear();
  expect(screen.getByText("This doc navigated away.")).toBeTruthy();
  message({ type: "emend:anchor", ...anchor });
  message({ type: "emend:ready" });
  fireEvent.click(screen.getByText("Show in doc"));
  update([]);
  expect(post).not.toHaveBeenCalled();
  expect(screen.queryByText("Comment on selection")).toBeNull();
  fireEvent.click(screen.getByText(`Reload ${path}`));
  const next = container.querySelector("iframe");
  expect(next).not.toBe(frame);
  expect(next?.getAttribute("src")).toBe(doc.contentUrl);
  expect(screen.queryByText("This doc navigated away.")).toBeNull();
  message({ type: "emend:anchor", ...anchor });
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
  expect(FrameToParent.safeParse({ type: "emend:position", heading: null, fraction: 0 }).success).toBe(true);
  expect(ParentToFrame.safeParse({ type: "emend:goto", heading: null, fraction: 0, label: "" }).success).toBe(false);
});

test("R5.1 goto distinguishes a pick without fraction from a restore including zero", () => {
  const pick = { type: "emend:goto", heading: 0, label: "First" };
  expect(ParentToFrame.parse(pick)).toEqual(pick);
  for (const fraction of [0, 0.5, 1]) expect(ParentToFrame.parse({ ...pick, fraction })).toEqual({ ...pick, fraction });
  for (const fraction of [null, -1, 2, NaN, Infinity, "0"])
    expect(ParentToFrame.safeParse({ ...pick, fraction }).success).toBe(false);
  expect(ParentToFrame.safeParse({ ...pick, extra: true }).success).toBe(false);
});

const pubImages = ["images/a #é.png", "images/b%2F.png", "images/c.png"];
const imageMessage = {
  type: "emend:image",
  images: pubImages.map((path, index) => ({ path, caption: index === 2 ? "" : `Caption ${index + 1}` })),
  index: 0,
};
function lightboxImage() {
  const image = screen.getByRole("dialog").querySelector("img");
  if (!image) throw new Error("Missing lightbox image");
  return image;
}

test.each(["emend", "custom"] as const)(
  "%s pub images open in order without comments and preserve the frame on close",
  async (look) => {
    const { frame, message, container, post } = mount([], undefined, pubImages, look);
    fireEvent.load(frame);
    message({ type: "emend:ready" });
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
  message({ type: "emend:ready" });
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
  message({ type: "emend:ready" });
  message(imageMessage);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("unknown non-clicked entries are dropped and duplicate paths keep the clicked occurrence", () => {
  const { message } = mount([], undefined, pubImages);
  message({ type: "emend:ready" });
  message({
    type: "emend:image",
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
    message({ type: "emend:ready" });
    expect(FilePath.safeParse(path).success).toBe(false);
    const gallery = {
      type: "emend:image",
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
    message({ type: "emend:ready" });
    message(imageMessage);
    expect(screen.getByRole("dialog")).toBeTruthy();
    if (change === "load") fireEvent.load(frame);
    else if (change === "ready") message({ type: "emend:ready" });
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
  message({ type: "emend:ready" });
  const gallery = { ...imageMessage, images: [imageMessage.images[0], { path, caption: "Unknown" }] };
  expect(FrameToParent.safeParse(gallery).success).toBe(false);
  message(gallery);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("image messages over the total character budget open nothing, even with allowed paths", () => {
  const path = "image.png";
  const { message } = mount([], undefined, [path]);
  message({ type: "emend:ready" });
  const images = Array.from({ length: 500 }, () => ({ path, caption: "x".repeat(2000 - path.length) }));
  const atLimit = { type: "emend:image", images, index: 0 };
  expect(FrameToParent.safeParse(atLimit).success).toBe(true);
  const overLimit = { ...atLimit, images: [{ path, caption: "x".repeat(2001 - path.length) }, ...images.slice(1)] };
  expect(FrameToParent.safeParse(overLimit).success).toBe(false);
  message(overLimit);
  expect(screen.queryByRole("dialog")).toBeNull();
});
