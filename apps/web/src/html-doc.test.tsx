// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadView } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HtmlDocFrame } from "./components/reading/HtmlDocFrame.tsx";
import { draftKey } from "./lib/drafts.ts";
import { type DocNavigation, FrameToParent, ParentToFrame } from "./lib/frame-messages.ts";

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
function FrameContent({
  values,
  docNavigation,
  navigation,
}: {
  values: ThreadView[];
  docNavigation?: DocNavigation;
  navigation?: { threadId: string; intent: unknown };
}) {
  const [open, setOpen] = useState(values.length > 0);
  return (
    <HtmlDocFrame
      reviewId={id}
      revision={2}
      changedBlocks={[]}
      path={path}
      contentUrl={doc.contentUrl}
      threads={values}
      navigation={navigation}
      docNavigation={docNavigation}
      commentsOpen={open}
      onCommentsOpenChange={setOpen}
    />
  );
}
function mount(threads: ThreadView[] = [], navigation?: { threadId: string; intent: unknown }) {
  const ui = (values: ThreadView[], docNavigation?: DocNavigation) => (
    <QueryClientProvider client={client}>
      <FrameContent values={values} docNavigation={docNavigation} navigation={navigation} />
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
