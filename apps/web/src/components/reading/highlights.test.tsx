// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { ok } from "node:assert/strict";
import { type RenderedBlock, RenderedWriteup, type RevisionView, type ThreadView } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderWriteup } from "../../../../../packages/core/src/render/writeup.ts";
import * as blockRanges from "../../lib/block-ranges.ts";
import { registerCommentRanges, trackCommentCard } from "../../lib/comment-highlights.ts";
import { draftKey } from "../../lib/drafts.ts";
import { layoutStore } from "../../lib/layout-store.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { ToastProvider } from "../ui/Toast.tsx";
import { BlockReader } from "./BlockReader.tsx";
import { DocView } from "./DocView.tsx";
import { Writeup } from "./Writeup.tsx";

const reviewId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const block: RenderedBlock = {
  id: "overview-12345678",
  section: "overview",
  kind: "paragraph",
  text: "Plant a seed today.",
  html: "<p>Plant a <strong>seed</strong> today.</p>",
};
const thread: ThreadView = {
  id: reviewId,
  createdOn: 1,
  state: "open",
  target: { kind: "writeup-span", blockId: block.id, quote: "seed", prefix: "Plant a ", suffix: " today." },
  placement: { status: "placed", location: { kind: "writeup-span", blockId: block.id, start: 8, end: 12 } },
  comments: [{ id: reviewId, author: "user", body: "A synthetic comment", sent: false, sentOn: null }],
};
const props = { reviewId, revision: 1, threads: [thread], changedBlocks: [] };
function writeup(value = block): RenderedWriteup {
  return { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [value] }] };
}
function docThread(path: string): ThreadView {
  return {
    ...thread,
    id: secondId,
    target: { ...thread.target, kind: "doc-span", path, blockId: block.id, quote: "seed", prefix: "", suffix: "" },
    placement: { status: "placed", location: { kind: "doc-span", path, blockId: block.id, start: 8, end: 12 } },
  };
}
let client: QueryClient;
let highlights: Map<string, Set<Range>>;
class MockHighlight extends Set<Range> {
  priority = 0;
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  localStorage.clear();
  highlights = new Map();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", MockHighlight);
});
afterEach(() => {
  cleanup();
  expect(highlights.has("emend-comment")).toBe(false);
  expect(highlights.has("emend-comment-active")).toBe(false);
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function ranges(active = false) {
  return [...(highlights.get(active ? "emend-comment-active" : "emend-comment") ?? [])];
}
function quotes(active = false) {
  return ranges(active).map((range) => range.toString());
}
function required<T>(value: T | null | undefined): T {
  ok(value != null);
  return value;
}
function mount(ui: ReactNode) {
  const wrap = (children: ReactNode) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const view = render(wrap(ui));
  return { ...view, rerender: (next: ReactNode) => view.rerender(wrap(next)) };
}

test("an unsent writeup thread marks exactly its quote, and unmount deletes both names", () => {
  const view = mount(<Writeup {...props} writeup={writeup()} />);
  expect(quotes()).toEqual(["seed"]);
  expect(quotes(true)).toEqual([]);
  expect(view.container.querySelector("[data-block-id]")?.contains(ranges()[0]?.startContainer ?? null)).toBe(true);
  view.unmount();
  expect(highlights.size).toBe(0);
});

test("composer hover and focus never add a draft key to the writeup active set", () => {
  const key = draftKey(reviewId, thread.target);
  const view = mount(<Composer reviewId={reviewId} revision={1} target={thread.target} />);
  const input = view.getByRole("textbox");
  const form = required(input.closest("form"));
  const range = document.createRange();
  range.selectNodeContents(form);
  // A sentinel under the actual draft key reveals any accidental active-set entry.
  const reader = required(registerCommentRanges([new Map([[key, range]])]));
  const set = vi.spyOn(highlights, "set");
  try {
    fireEvent.pointerEnter(form, { pointerType: "mouse" });
    expect(ranges(true)).toEqual([]);
    act(() => input.focus());
    fireEvent.pointerLeave(form, { pointerType: "mouse" });
    expect(ranges(true)).toEqual([]);
    expect(ranges()).toEqual([range]);
    expect(set).not.toHaveBeenCalled();
  } finally {
    reader.unregister();
  }
});

test.each(["resolved", "unplaced", "wrong-kind", "missing-block", "outside", "mismatch", "diagram"])(
  "%s threads/blocks produce no marks",
  (reason) => {
    let value = thread;
    let content = block;
    if (reason === "resolved") value = { ...thread, state: "resolved" };
    if (reason === "unplaced") value = { ...thread, placement: { status: "unplaced", reason: "block-gone" } };
    if (reason === "wrong-kind") value = docThread("seed.md");
    if (reason === "missing-block") content = { ...block, id: "overview-87654321" };
    if (reason === "outside")
      value = {
        ...thread,
        placement: { status: "placed", location: { kind: "writeup-span", blockId: block.id, start: 8, end: 100 } },
      };
    if (reason === "mismatch") content = { ...block, html: "<p>Different text</p>" };
    if (reason === "diagram") content = { ...block, kind: "diagram", source: "graph TD; A-->B" };
    mount(<Writeup {...props} threads={[value]} writeup={writeup(content)} />);
    expect(quotes()).toEqual([]);
    expect(quotes(true)).toEqual([]);
  },
);

test("new, resolved, reopened and removed threads replace the registered ranges", () => {
  const view = mount(<Writeup {...props} threads={[]} writeup={writeup()} />);
  expect(quotes()).toEqual([]);
  view.rerender(<Writeup {...props} writeup={writeup()} />);
  const original = ranges()[0];
  expect(quotes()).toEqual(["seed"]);
  view.rerender(<Writeup {...props} threads={[{ ...thread, state: "resolved" }]} writeup={writeup()} />);
  expect(quotes()).toEqual([]);
  view.rerender(<Writeup {...props} writeup={writeup()} />);
  expect(quotes()).toEqual(["seed"]);
  expect(ranges()).not.toContain(original);
  view.rerender(<Writeup {...props} threads={[]} writeup={writeup()} />);
  expect(quotes()).toEqual([]);
});

test("only the open Markdown doc's placements are marked, even with identical block ids", () => {
  const docs: RevisionView["docs"] = [
    { kind: "markdown", path: "seed.md", blocks: [block] },
    { kind: "markdown", path: "water.md", blocks: [block] },
  ];
  const ui = (index: number) => (
    <DocView
      {...props}
      threads={[thread, docThread("seed.md")]}
      docs={[required(docs[index])]}
      openDoc={docs[index]}
      search={{ tab: "docs", doc: docs[index]?.path }}
      targeted={false}
      onOpenDoc={() => {}}
    />
  );
  const view = mount(ui(0));
  const first = ranges()[0];
  expect(quotes()).toEqual(["seed"]);
  view.rerender(ui(1));
  expect(quotes()).toEqual([]);
  view.rerender(ui(0));
  expect(quotes()).toEqual(["seed"]);
  expect(ranges()).not.toContain(first);
});

test("two mounted readers contribute ranges independently and keep unrelated highlights", () => {
  const other = new MockHighlight();
  highlights.set("other-feature", other);
  const first = mount(<Writeup {...props} writeup={writeup()} />);
  const second = mount(<Writeup {...props} writeup={writeup()} />);
  expect(quotes()).toEqual(["seed", "seed"]);
  const secondRange = ranges()[1];
  first.unmount();
  expect(ranges()).toEqual([secondRange]);
  second.unmount();
  expect([...highlights]).toEqual([["other-feature", other]]);
});

test("writeup and Markdown readers divide active and ordinary ranges without overwriting each other", () => {
  const first = mount(<Writeup {...props} writeup={writeup()} />);
  const second = mount(
    <BlockReader
      {...props}
      threads={[docThread("seed.md")]}
      groups={[{ key: "seed.md", path: "seed.md", blocks: [block] }]}
      activeThreadId={secondId}
    />,
  );
  expect(quotes()).toEqual(["seed"]);
  expect(quotes(true)).toEqual(["seed"]);
  const active = ranges(true)[0];
  expect(ranges()).not.toContain(active);
  expect(required(highlights.get("emend-comment-active") as MockHighlight | undefined).priority).toBe(1);
  first.unmount();
  expect(quotes()).toEqual([]);
  expect(ranges(true)).toEqual([active]);
  second.unmount();
  expect(highlights.size).toBe(0);
});

test("hover and focus each keep a card active until both have left, including focus within it", () => {
  const view = mount(<Writeup {...props} writeup={writeup()} />);
  const card = required(view.container.querySelector<HTMLElement>("[data-thread-card]"));
  const edit = within(card).getByRole("button", { name: "Edit" });
  const remove = within(card).getByRole("button", { name: "Delete" });
  const original = ranges()[0];
  fireEvent.pointerEnter(card);
  expect(ranges(true)).toEqual([original]);
  expect(ranges()).toEqual([]);
  act(() => edit.focus());
  fireEvent.pointerLeave(card);
  expect(quotes(true)).toEqual(["seed"]);
  act(() => remove.focus());
  expect(quotes(true)).toEqual(["seed"]);
  act(() => remove.blur());
  expect(ranges()).toEqual([original]);
  expect(ranges(true)).toEqual([]);
  act(() => edit.focus());
  expect(ranges(true)).toEqual([original]);
  fireEvent.pointerEnter(card);
  act(() => edit.blur());
  expect(ranges(true)).toEqual([original]);
  fireEvent.pointerLeave(card);
  expect(ranges()).toEqual([original]);
});

test("a card copy on another surface activates all reader copies and cleans up on removal", () => {
  const reader = mount(<Writeup {...props} writeup={writeup()} />);
  const second = mount(<ThreadCard {...props} thread={thread} surface="comments" />);
  const firstCard = required(reader.container.querySelector<HTMLElement>("[data-thread-card]"));
  const secondCard = required(second.container.querySelector<HTMLElement>("[data-thread-card]"));
  fireEvent.pointerEnter(firstCard);
  fireEvent.pointerEnter(secondCard);
  fireEvent.pointerLeave(firstCard);
  expect(quotes(true)).toEqual(["seed"]);
  second.unmount();
  expect(quotes(true)).toEqual([]);
  expect(quotes()).toEqual(["seed"]);
});

test("URL intent and card activity combine, and clearing either preserves the other", () => {
  const view = mount(<Writeup {...props} writeup={writeup()} activeThreadId={thread.id} />);
  expect(quotes(true)).toEqual(["seed"]);
  expect(quotes()).toEqual([]);
  const card = required(view.container.querySelector<HTMLElement>("[data-thread-card]"));
  fireEvent.pointerEnter(card);
  fireEvent.pointerLeave(card);
  expect(quotes(true)).toEqual(["seed"]);
  fireEvent.pointerEnter(card);
  view.rerender(<Writeup {...props} writeup={writeup()} />);
  expect(quotes(true)).toEqual(["seed"]);
  fireEvent.pointerLeave(card);
  expect(quotes()).toEqual(["seed"]);
  expect(quotes(true)).toEqual([]);
});

test("revision changes retire ranges even when blocks and threads reuse their references", () => {
  const groups = [{ key: "overview", blocks: [block] }];
  const view = mount(<BlockReader {...props} groups={groups} />);
  const original = ranges()[0];
  view.rerender(<BlockReader {...props} groups={groups} revision={2} />);
  expect(quotes()).toEqual(["seed"]);
  expect(ranges()).not.toContain(original);
  const replaced = ranges()[0];
  view.rerender(
    <BlockReader
      {...props}
      groups={[{ key: "overview", blocks: [{ ...block, html: "<p>changed</p>" }] }]}
      revision={2}
    />,
  );
  expect(ranges()).not.toContain(replaced);
  expect(quotes()).toEqual([]);
});

test("opening a composer or rerendering unchanged props keeps ranges on the current text nodes", () => {
  const groups = [{ key: "overview", blocks: [block] }];
  const view = mount(<BlockReader {...props} groups={groups} />);
  view.rerender(<BlockReader {...props} groups={groups} />);
  expect(quotes()).toEqual(["seed"]);
  fireEvent.click(within(view.container).getByRole("button", { name: "Comment on block" }));
  expect(quotes()).toEqual(["seed"]);
  expect(ranges().every((range) => range.startContainer.isConnected && range.endContainer.isConnected)).toBe(true);
});

test.each(["CSS", "highlights", "Highlight", "Intl.Segmenter"])("missing %s means no errors or marks", (missing) => {
  if (missing === "CSS") vi.stubGlobal("CSS", undefined);
  else if (missing === "highlights") vi.stubGlobal("CSS", {});
  else if (missing === "Intl.Segmenter")
    vi.stubGlobal("Intl", Object.assign(Object.create(Intl), { Segmenter: undefined }));
  else vi.stubGlobal("Highlight", undefined);
  const view = mount(<Writeup {...props} writeup={writeup()} activeThreadId={thread.id} />);
  const card = required(view.container.querySelector<HTMLElement>("[data-thread-card]"));
  fireEvent.pointerEnter(card);
  act(() => within(card).getByRole("button", { name: "Edit" }).focus());
  view.unmount();
  expect(highlights.size).toBe(0);
});

test("removing a focused comment control deactivates on refresh and stays inactive on outside focus", () => {
  const content = writeup();
  const parent = { ...required(thread.comments[0]), sent: true, sentOn: 1 };
  const reply = { ...required(thread.comments[0]), id: secondId };
  const ui = (comments: ThreadView["comments"]) => (
    <>
      <button type="button">Outside</button>
      <Writeup {...props} threads={[{ ...thread, comments }]} writeup={content} />
    </>
  );
  const view = mount(ui([parent, reply]));
  const card = required(view.container.querySelector<HTMLElement>("[data-thread-card]"));
  const control = within(card).getByRole("button", { name: "Delete" });
  act(() => control.focus());
  expect(quotes(true)).toEqual(["seed"]);
  view.rerender(ui([parent]));
  expect(control.isConnected).toBe(false);
  expect(view.container.querySelector("[data-thread-card]")).toBe(card);
  expect(card.contains(document.activeElement)).toBe(false);
  expect(quotes(true)).toEqual([]);
  expect(quotes()).toEqual(["seed"]);
  act(() => within(view.container).getByRole("button", { name: "Outside" }).focus());
  expect(quotes(true)).toEqual([]);
  expect(quotes()).toEqual(["seed"]);
});

test("document focusin reconciles a removed control even without a reader refresh", () => {
  mount(<Writeup {...props} writeup={writeup()} />);
  const parent = { ...required(thread.comments[0]), sent: true, sentOn: 1 };
  const reply = { ...required(thread.comments[0]), id: secondId };
  const ui = (comments: ThreadView["comments"]) => (
    <>
      <ThreadCard {...props} thread={{ ...thread, comments }} surface="comments" />
      <button type="button">Outside</button>
    </>
  );
  const view = mount(ui([parent, reply]));
  const control = within(view.container).getByRole("button", { name: "Delete" });
  act(() => control.focus());
  expect(quotes(true)).toEqual(["seed"]);
  view.rerender(ui([parent]));
  expect(control.isConnected).toBe(false);
  act(() => within(view.container).getByRole("button", { name: "Outside" }).focus());
  expect(quotes(true)).toEqual([]);
  expect(quotes()).toEqual(["seed"]);
});

test.each(["writeup", "doc"])("%s parent renders and URL activation reuse mapped ranges", (kind) => {
  const map = vi.spyOn(blockRanges, "mapBlockText");
  const content = writeup();
  const doc: RevisionView["docs"][number] = { kind: "markdown", path: "seed.md", blocks: [block] };
  const threads = kind === "doc" ? [docThread(doc.path)] : props.threads;
  const ui = (activeThreadId?: string) =>
    kind === "writeup" ? (
      <Writeup
        {...props}
        writeup={{ ...content }}
        search={{ tab: "writeup", thread: activeThreadId }}
        activeThreadId={activeThreadId}
        onCurrentTopic={() => {}}
      />
    ) : (
      <DocView
        {...props}
        threads={threads}
        docs={[doc]}
        openDoc={doc}
        search={{ tab: "docs", doc: doc.path, thread: activeThreadId }}
        activeThreadId={activeThreadId}
        targeted={!!activeThreadId}
        onOpenDoc={() => {}}
      />
    );
  const view = mount(ui());
  const original = ranges()[0];
  expect(map).toHaveBeenCalled();
  map.mockClear();
  view.rerender(ui());
  expect(map).not.toHaveBeenCalled();
  expect(ranges()).toEqual([original]);
  view.rerender(ui(required(threads[0]).id));
  expect(map).not.toHaveBeenCalled();
  expect(ranges(true)).toEqual([original]);
  expect(ranges()).toEqual([]);
  view.rerender(ui());
  expect(map).not.toHaveBeenCalled();
  expect(ranges()).toEqual([original]);
  expect(ranges(true)).toEqual([]);
});

test("marker and composer updates retain nodes, while a changed group structure remaps them", () => {
  const map = vi.spyOn(blockRanges, "mapBlockText");
  const groups = [{ key: "overview", blocks: [block] }];
  const view = mount(<BlockReader {...props} groups={groups} />);
  const original = required(ranges()[0]);
  const node = original.startContainer;
  map.mockClear();
  view.rerender(
    <BlockReader
      {...props}
      groups={groups}
      changedBlocks={[{ blockId: block.id, revision: 2 }]}
      resumedBlockId={block.id}
    />,
  );
  expect(map).not.toHaveBeenCalled();
  expect(node.isConnected).toBe(true);
  expect(ranges()).toEqual([original]);
  view.rerender(
    <BlockReader
      {...props}
      groups={[
        {
          key: "overview",
          blocks: [],
          subsections: [{ key: "details", heading: "Details", kind: "body", blocks: [block] }],
        },
      ]}
    />,
  );
  expect(map).toHaveBeenCalledOnce();
  expect(node.isConnected).toBe(false);
  expect(quotes()).toEqual(["seed"]);
  expect(ranges()).not.toContain(original);
  expect(ranges().every((range) => range.startContainer.isConnected && range.endContainer.isConnected)).toBe(true);
});

test("mounting and removing inactive cards performs no highlight writes", () => {
  mount(<Writeup {...props} writeup={writeup()} />);
  const set = vi.spyOn(highlights, "set");
  const copies = Array.from({ length: 8 }, (_, index) => ({ ...thread, id: `inactive-${index}` }));
  const view = mount(copies.map((copy) => <ThreadCard key={copy.id} {...props} thread={copy} surface="comments" />));
  expect(set).not.toHaveBeenCalled();
  const card = required(view.container.querySelector<HTMLElement>("[data-thread-card]"));
  fireEvent.pointerLeave(card);
  fireEvent.focusOut(card);
  expect(set).not.toHaveBeenCalled();
  view.unmount();
  expect(set).not.toHaveBeenCalled();
});

test("card events rebuild only on an active thread transition", () => {
  const view = mount(<Writeup {...props} writeup={writeup()} />);
  const card = required(view.container.querySelector<HTMLElement>("[data-thread-card]"));
  const set = vi.spyOn(highlights, "set");
  fireEvent.pointerEnter(card);
  expect(set).toHaveBeenCalledTimes(2);
  set.mockClear();
  fireEvent.pointerEnter(card);
  act(() => within(card).getByRole("button", { name: "Edit" }).focus());
  act(() => within(card).getByRole("button", { name: "Delete" }).focus());
  fireEvent.pointerLeave(card);
  expect(set).not.toHaveBeenCalled();
  act(() => within(card).getByRole("button", { name: "Delete" }).blur());
  expect(set).toHaveBeenCalledTimes(2);
});

test("an active URL or another card copy makes redundant card activity free of registry writes", () => {
  const content = writeup();
  const view = mount(<Writeup {...props} writeup={content} activeThreadId={thread.id} />);
  const card = required(view.container.querySelector<HTMLElement>("[data-thread-card]"));
  const set = vi.spyOn(highlights, "set");
  fireEvent.pointerEnter(card);
  fireEvent.pointerLeave(card);
  expect(set).not.toHaveBeenCalled();
  fireEvent.pointerEnter(card);
  view.rerender(<Writeup {...props} writeup={content} />);
  const copy = mount(<ThreadCard {...props} thread={thread} surface="comments" />);
  set.mockClear();
  fireEvent.pointerEnter(required(copy.container.querySelector<HTMLElement>("[data-thread-card]")));
  fireEvent.pointerLeave(card);
  expect(set).not.toHaveBeenCalled();
  expect(quotes(true)).toEqual(["seed"]);
});

test("all cards share one document focus listener, removed with the last registration", () => {
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  const first = required(trackCommentCard(document.createElement("article"), reviewId));
  const second = required(trackCommentCard(document.createElement("article"), secondId));
  const listeners = add.mock.calls.filter(([type]) => type === "focusin");
  expect(listeners).toHaveLength(1);
  const listener = required(listeners[0])[1];
  first();
  expect(remove.mock.calls.filter(([type]) => type === "focusin")).toHaveLength(0);
  second();
  expect(remove).toHaveBeenCalledWith("focusin", listener, true);
});

test.each(["mapping", "range", "registration"])(
  "a %s error skips the whole block and preserves another block",
  (failure) => {
    const originalMap = blockRanges.mapBlockText;
    if (failure !== "registration")
      vi.spyOn(blockRanges, "mapBlockText").mockImplementation((node) => {
        if (node.dataset.blockId !== block.id) return originalMap(node);
        if (failure === "mapping") throw new Error("Synthetic mapping failure");
        const map = originalMap(node);
        return (start, end) => {
          if (start === 0) throw new Error("Synthetic range failure");
          return map?.(start, end);
        };
      });
    else {
      const add = MockHighlight.prototype.add;
      vi.spyOn(MockHighlight.prototype, "add").mockImplementation(function (this: MockHighlight, range) {
        if (range.toString() === "Plant") throw new Error("Synthetic registration failure");
        return add.call(this, range);
      });
    }
    const other = { ...block, id: "overview-87654321", text: "soil", html: "<p>soil</p>" };
    const threads: ThreadView[] = [
      thread,
      {
        ...thread,
        id: secondId,
        placement: { status: "placed", location: { kind: "writeup-span", blockId: block.id, start: 0, end: 5 } },
      },
      {
        ...thread,
        id: "33333333-3333-4333-8333-333333333333",
        placement: { status: "placed", location: { kind: "writeup-span", blockId: other.id, start: 0, end: 4 } },
      },
    ];
    const view = mount(
      <BlockReader {...props} threads={threads} groups={[{ key: "overview", blocks: [block, other] }]} />,
    );
    expect(view.container.querySelectorAll("[data-block-id]")).toHaveLength(2);
    expect(quotes()).toEqual(["soil"]);
    expect(quotes(true)).toEqual([]);
  },
);

test("a registry write failure clears partial highlights without interrupting the reader", () => {
  const set = highlights.set.bind(highlights);
  vi.spyOn(highlights, "set").mockImplementation((name, value) => {
    if (name === "emend-comment-active") throw new Error("Synthetic registry failure");
    return set(name, value);
  });
  const view = mount(<Writeup {...props} writeup={writeup()} />);
  expect(within(view.container).getByRole("button", { name: "Comment on block" })).toBeTruthy();
  expect(highlights.size).toBe(0);
});

test("marking hostile literal text preserves every element and the block's HTML byte for byte", () => {
  const text =
    '<script>evil()</script><img onerror="evil()"><svg onload="evil()"> [bad](javascript:evil()) Raw <b>HTML</b>';
  const hostile = {
    ...block,
    text,
    html: `<p>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`,
  };
  const value: ThreadView = {
    ...thread,
    target: { kind: "writeup-span", blockId: block.id, quote: text, prefix: "", suffix: "" },
    placement: { status: "unplaced", reason: "not-placed" },
  };
  const place = (end: number): ThreadView => ({
    ...value,
    placement: { status: "placed", location: { kind: "writeup-span", blockId: block.id, start: 0, end } },
  });
  const view = mount(<Writeup {...props} threads={[place(text.length + 1)]} writeup={writeup(hostile)} />);
  expect(quotes()).toEqual([]);
  const serialize = () =>
    new XMLSerializer().serializeToString(required(view.container.querySelector("[data-block-id]")));
  const html = serialize();
  const elements = [...document.querySelectorAll("*")];
  view.rerender(<Writeup {...props} threads={[place(text.length)]} writeup={writeup(hostile)} />);
  expect(quotes()).toEqual([text]);
  expect(serialize()).toBe(html);
  expect([...document.querySelectorAll("*")]).toEqual(elements);
  expect(view.container.querySelector("script, img, svg[onload], [onerror], a[href^='javascript:']")).toBeNull();
});

test("sanitized Markdown and glossary remain inert while marked, and Mermaid click blocks are skipped", async () => {
  const hostile = '<script>evil()</script><img src=x onerror="evil()"><svg onload="evil()"></svg>';
  const markdown = `${hostile}\n\n[bad](javascript:evil())\n\nRaw <b>HTML</b>\n\n\`<script> and <img onerror>\`\n\n\`\`\`mermaid\ngraph TD; A-->B; click A evil "click"\n\`\`\``;
  const content = RenderedWriteup.parse(
    await renderWriteup({ overview: markdown, tldr: "", glossary: markdown, decisions: null, topics: {} }, []),
  );
  const blocks = content.sections.flatMap((section) => section.blocks).filter((block) => block.text.length);
  const threads = blocks.map(
    (block, index): ThreadView => ({
      ...thread,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      target: { kind: "writeup-span", blockId: block.id, quote: block.text, prefix: "", suffix: "" },
      placement: {
        status: "placed",
        location: { kind: "writeup-span", blockId: block.id, start: 0, end: block.text.length },
      },
    }),
  );
  const view = mount(<Writeup {...props} threads={threads} writeup={content} />);
  expect(quotes()).toContain("<script> and <img onerror>");
  expect(quotes()).toContain("Raw HTML");
  expect(quotes().some((text) => text.includes("click A"))).toBe(false);
  expect(view.container.querySelectorAll('[data-block-kind="diagram"]')).toHaveLength(2);
  expect(view.container.querySelector("script, img, svg[onload], [onerror], a[href^='javascript:']")).toBeNull();
  for (const frame of view.container.querySelectorAll("iframe"))
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
});

test("compact comments keep quoted ranges while closed, tracks opened cards and unregisters them on Hide", () => {
  layoutStore.update({ compact: true });
  const sent = { ...thread, comments: thread.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 })) };
  const view = mount(<Writeup {...props} threads={[sent]} writeup={writeup()} />);
  expect(quotes()).toEqual(["seed"]);
  const originalRange = ranges()[0];
  expect(view.container.querySelector("[data-thread-card]")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "1 comment" }));
  const card = required(view.container.querySelector<HTMLElement>("[data-thread-card]"));
  fireEvent.pointerEnter(card, { pointerType: "mouse" });
  expect(quotes(true)).toEqual(["seed"]);
  fireEvent.pointerLeave(card, { pointerType: "mouse" });
  const reply = within(card).getByRole("button", { name: "Reply" });
  act(() => reply.focus());
  expect(card.hasAttribute("data-focus-within")).toBe(true);
  expect(quotes(true)).toEqual(["seed"]);
  fireEvent.click(view.getByRole("button", { name: "Hide" }));
  expect(card.isConnected).toBe(false);
  expect(card.hasAttribute("data-focus-within")).toBe(false);
  expect(quotes(true)).toEqual([]);
  expect(ranges()).toEqual([originalRange]);
  fireEvent.pointerEnter(card, { pointerType: "mouse" });
  expect(quotes(true)).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: "1 comment" }));
  const reopened = required(view.container.querySelector<HTMLElement>("[data-thread-card]"));
  fireEvent.pointerEnter(reopened, { pointerType: "mouse" });
  expect(quotes(true)).toEqual(["seed"]);
});
