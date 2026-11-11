// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { ok } from "node:assert/strict";
import type { RenderedBlock, RevisionView, Target, ThreadView } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BlockReader } from "./components/reading/BlockReader.tsx";
import { DocView } from "./components/reading/DocView.tsx";
import { Writeup } from "./components/reading/Writeup.tsx";
import { SendBar } from "./components/send/SendBar.tsx";
import { Composer } from "./components/threads/Composer.tsx";
import { DraftList } from "./components/threads/DraftList.tsx";
import { ThreadCard } from "./components/threads/ThreadCard.tsx";
import { ThreadList } from "./components/threads/ThreadList.tsx";
import { ToastProvider } from "./components/ui/Toast.tsx";
import { claimDraft } from "./lib/composer-owner.ts";
import { clearDraftIfUnchanged, draftKey, hasDraft, isDraftSaving, loadDraft, saveDraft } from "./lib/drafts.ts";

const id = "11111111-1111-4111-8111-111111111111";
const target: Target = { kind: "writeup-span", blockId: "overview-12345678", quote: "seed", prefix: "", suffix: "" };
const block: RenderedBlock = {
  id: target.blockId,
  section: "overview",
  kind: "paragraph",
  text: "seed",
  html: "<p>seed</p>",
};
const thread: ThreadView = {
  id,
  target,
  createdOn: 1,
  state: "open",
  placement: { status: "placed", location: { kind: "writeup-span", blockId: block.id, start: 0, end: 4 } },
  comments: [{ id, author: "user", body: "Synthetic comment", sent: false, sentOn: null }],
};
function required<T>(value: T | undefined | null): T {
  ok(value != null);
  return value;
}
test.each([
  { revisions: [2, 2, 2], labels: [2], continuations: [false, true, true] },
  { revisions: [2, undefined, 2], labels: [2, 2], continuations: [false, false, false] },
  { revisions: [2, 3, 3], labels: [2, 3], continuations: [false, false, true] },
])(
  "changed block runs include headings and split at gaps or revisions: $revisions",
  ({ revisions, labels, continuations }) => {
    const blocks = revisions.map((_, index) => ({
      ...block,
      id: `overview-${String(index).padStart(8, "0")}`,
      ...(index === 1 ? { kind: "heading" as const, text: "Growing", html: "<h2>Growing</h2>" } : {}),
    }));
    const { container } = mount(
      <BlockReader
        reviewId={id}
        revision={3}
        changedBlocks={blocks.flatMap((block, index) => {
          const revision = revisions[index];
          return revision === undefined ? [] : [{ blockId: block.id, revision }];
        })}
        threads={[]}
        groups={[{ key: "overview", blocks }]}
      />,
    );
    expect(screen.getAllByText(/^Changed in rev \d+$/).map((label) => label.textContent)).toEqual(
      labels.map((revision) => `Changed in rev ${revision}`),
    );
    expect(screen.getAllByText(/^Changed in revision \d+$/).map((label) => label.textContent)).toEqual(
      labels.map((revision) => `Changed in revision ${revision}`),
    );
    expect(container.querySelectorAll(".bg-changed-line")).toHaveLength(
      revisions.filter((revision) => revision !== undefined).length,
    );
    for (const bar of container.querySelectorAll(".em-reading-block__change")) {
      expect([...bar.classList].filter((name) => /(?:^|:)[!-]?(?:inset|top|bottom)-/.test(name))).toEqual([]);
    }
    expect(
      [...container.querySelectorAll(".em-reading-block")].map((block) =>
        block.hasAttribute("data-change-continuation"),
      ),
    ).toEqual(continuations);
  },
);

test("changed runs restart for each group and subsection", () => {
  const blocks = [0, 1, 2, 3].map((index) => ({ ...block, id: `overview-${String(index).padStart(8, "0")}` }));
  const { container } = mount(
    <BlockReader
      reviewId={id}
      revision={2}
      changedBlocks={blocks.map((block) => ({ blockId: block.id, revision: 2 }))}
      threads={[]}
      groups={[
        { key: "overview", blocks: blocks.slice(0, 1) },
        {
          key: "topic",
          blocks: blocks.slice(1, 2),
          subsections: [
            { key: "why", heading: "Why", kind: "why", blocks: blocks.slice(2, 3) },
            { key: "body", heading: "Details", kind: "body", blocks: blocks.slice(3) },
          ],
        },
      ]}
    />,
  );
  expect(screen.getAllByText("Changed in rev 2")).toHaveLength(4);
  expect(container.querySelectorAll(".bg-changed-line")).toHaveLength(4);
  expect(container.querySelector("[data-change-continuation]")).toBeNull();
});

test.each(["mouseup", "keyup"])("collapsing a selection on %s retires its comment prompt", (event) => {
  const { container } = mount(
    <BlockReader
      reviewId={id}
      revision={1}
      changedBlocks={[]}
      threads={[]}
      groups={[{ key: "overview", blocks: [block] }]}
    />,
  );
  const paragraph = required(container.querySelector("[data-block-id] p"));
  const text = required(paragraph.firstChild);
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 4);
  const selection = required(window.getSelection());
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(paragraph);
  expect(screen.getByRole("button", { name: "Comment on selection" })).toBeTruthy();
  selection.collapse(text, 0);
  fireEvent(paragraph, new Event(event, { bubbles: true }));
  expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  selection.removeAllRanges();
});
test.each(["mouseup", "keyup"])(
  "fix1 the selection prompt keeps its original target through its own %s",
  async (event) => {
    const { container } = mount(
      <BlockReader
        reviewId={id}
        revision={1}
        changedBlocks={[]}
        threads={[]}
        groups={[{ key: "overview", blocks: [block] }]}
      />,
    );
    const paragraph = required(container.querySelector("[data-block-id] p"));
    const text = required(paragraph.firstChild);
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 3);
    const selection = required(window.getSelection());
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(paragraph);
    const prompt = screen.getByRole("button", { name: "Comment on selection" });
    selection.collapse(text, 0);
    fireEvent(prompt, new Event(event, { bubbles: true }));
    expect(prompt.isConnected).toBe(true);
    fireEvent.click(prompt);
    const input = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(input, { target: { value: "The selected letters" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body).target).toMatchObject({
      kind: "writeup-span",
      blockId: block.id,
      quote: "ee",
    });
    selection.removeAllRanges();
  },
);
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
function mount(ui: ReactNode) {
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const key of [["inbox"], ["review", id]]) client.setQueryData(key, {});
  for (const seq of [1, 2, 3])
    client.setQueryData<RevisionView>(["revision", id, seq], {
      seq,
      base: null,
      head: null,
      main: null,
      writeupEmpty: true,
      writeup: { sections: [] },
      docs: [],
      files: [],
      topics: [],
      changedBlocks: [],
      threads: [],
    });
  fetchMock = vi.fn(async () => Response.json({ threadId: id, commentId: id, sendId: id }, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("draft survives remount, creates the thread on the displayed revision, clears and invalidates all three queries", async () => {
  const first = mount(<Composer reviewId={id} revision={2} target={target} />);
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep this draft" } });
  expect(localStorage.getItem(draftKey(id, target))).toBe("Keep this draft");
  expect(draftKey(id, target)).toBe(
    draftKey(id, { suffix: "", prefix: "", quote: "seed", blockId: block.id, kind: "writeup-span" }),
  );
  first.unmount();
  mount(<Composer reviewId={id} revision={2} target={target} />);
  expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(localStorage.getItem(draftKey(id, target))).toBeNull());
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/v1/reviews/${id}/threads`,
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ revision: 2, target, body: "Keep this draft" }),
    }),
  );
  for (const key of [["inbox"], ["review", id], ["revision", id, 1], ["revision", id, 2], ["revision", id, 3]])
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});
test("composer works when every localStorage operation throws", async () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  mount(<Composer reviewId={id} revision={2} target={target} />);
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Without storage" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe(""));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
test.each(["Second", ""])(
  "save preserves another tab's persisted text %j before its storage event arrives",
  async (persisted) => {
    let finish = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(Response.json({}));
        }),
    );
    const saved = vi.fn();
    mount(<Composer reviewId={id} revision={2} target={target} onSaved={saved} />);
    const key = draftKey(id, target);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    // Tab B writes, but tab A has not received the corresponding storage event.
    localStorage.setItem(key, persisted);
    expect(loadDraft(key)).toBe("First");
    await act(async () => finish());
    await waitFor(() => expect(isDraftSaving(key)).toBe(false));
    expect(localStorage.getItem(key)).toBe(persisted);
    expect(loadDraft(key)).toBe(persisted);
    expect(hasDraft(key)).toBe(true);
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe(persisted);
    expect(saved).not.toHaveBeenCalled();
    act(() =>
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: persisted, storageArea: localStorage })),
    );
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe(persisted);
  },
);
test.each([false, true])(
  "save preserves newer text after a quota failure and retries persistence once (recovers=%s)",
  async (recovers) => {
    let finish = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(Response.json({}));
        }),
    );
    const saved = vi.fn();
    mount(<Composer reviewId={id} revision={2} target={target} onSaved={saved} />);
    const key = draftKey(id, target);
    const input = screen.getByLabelText("Comment") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const storage = localStorage;
    const setItem = vi.fn(storage.setItem.bind(storage));
    vi.spyOn(window, "localStorage", "get").mockReturnValue(
      new Proxy(storage, {
        get: (value, property) => (property === "setItem" ? setItem : Reflect.get(value, property)),
      }),
    );
    const quotaExceeded = () => {
      throw new DOMException("Storage full", "QuotaExceededError");
    };
    if (recovers) setItem.mockImplementationOnce(quotaExceeded);
    else setItem.mockImplementation(quotaExceeded);
    fireEvent.change(input, { target: { value: "Second" } });
    expect(localStorage.getItem(key)).toBeNull();
    expect(loadDraft(key)).toBe("Second");
    setItem.mockClear();
    await act(async () => finish());
    await waitFor(() => expect(isDraftSaving(key)).toBe(false));
    expect(loadDraft(key)).toBe("Second");
    expect(input.value).toBe("Second");
    expect(saved).not.toHaveBeenCalled();
    expect(setItem).toHaveBeenCalledExactlyOnceWith(key, "Second");
    expect(localStorage.getItem(key)).toBe(recovers ? "Second" : null);
    expect((screen.getByRole("button", { name: "Save comment" }) as HTMLButtonElement).disabled).toBe(false);
  },
);
test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])("matching save clears matching or absent copies (memory=%s, storage=%s)", (memory, stored) => {
  const key = draftKey(id, target);
  if (memory) saveDraft(key, "First");
  if (stored) localStorage.setItem(key, "First");
  else localStorage.removeItem(key);
  expect(clearDraftIfUnchanged(key, "First")).toBe(true);
  expect(localStorage.getItem(key)).toBeNull();
  expect(hasDraft(key)).toBe(false);
  expect(loadDraft(key)).toBe("");
});
test("compare and clear uses memory when the storage read throws", () => {
  const key = draftKey(id, target);
  saveDraft(key, "First");
  const storage = localStorage;
  const getItem = vi.fn(() => {
    throw new Error("Storage unavailable");
  });
  vi.spyOn(window, "localStorage", "get").mockReturnValue(
    new Proxy(storage, { get: (value, property) => (property === "getItem" ? getItem : Reflect.get(value, property)) }),
  );
  expect(clearDraftIfUnchanged(key, "First")).toBe(true);
  expect(getItem).toHaveBeenCalledWith(key);
  expect(loadDraft(key)).toBe("");
});
test("failed save keeps the draft and comment text", async () => {
  fetchMock.mockResolvedValue(
    Response.json({ error: { code: "too_large", message: "Synthetic limit" } }, { status: 413 }),
  );
  mount(<Composer reviewId={id} revision={2} target={target} />);
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep me" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Synthetic limit");
  expect(localStorage.getItem(draftKey(id, target))).toBe("Keep me");
});
test.each([false, true])("pending save preserves newer text and remains usable (remount=%s)", async (remount) => {
  let finish = () => {};
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = () => resolve(Response.json({}));
      }),
  );
  const saved = vi.fn();
  let view = mount(<Composer reviewId={id} revision={2} target={target} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "First reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  if (remount) {
    view.unmount();
    // Rehydrate from persisted text, as a page reload does, rather than the tab's text cache.
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    view = mount(<Composer reviewId={id} revision={2} target={target} onSaved={saved} />);
  }
  const input = screen.getByLabelText("Comment") as HTMLTextAreaElement;
  expect(input.value).toBe("First reply");
  expect(localStorage.getItem(draftKey(id, target))).toBe("First reply");
  expect((screen.getByRole("button", { name: "Save comment" }) as HTMLButtonElement).disabled).toBe(true);
  expect(input.disabled).toBe(false);
  fireEvent.change(input, { target: { value: "Second unsent reply" } });
  await act(async () => finish());
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Save comment" }) as HTMLButtonElement).disabled).toBe(false),
  );
  expect(input.value).toBe("Second unsent reply");
  expect(localStorage.getItem(draftKey(id, target))).toBe("Second unsent reply");
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(localStorage.getItem(draftKey(id, target))).toBeNull());
  expect(fetchMock.mock.calls.at(-1)?.[1]?.body).toContain("Second unsent reply");
  view.unmount();
});
test("an unsent edit, including empty text, survives a remount", () => {
  let view = mount(<ThreadCard reviewId={id} revision={2} thread={thread} changedBlocks={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Edit comment"), { target: { value: "Unsaved replacement" } });
  view.unmount();
  view = mount(<ThreadCard reviewId={id} revision={2} thread={thread} changedBlocks={[]} />);
  expect((screen.getByLabelText("Edit comment") as HTMLTextAreaElement).value).toBe("Unsaved replacement");
  fireEvent.change(screen.getByLabelText("Edit comment"), { target: { value: "" } });
  view.unmount();
  mount(<ThreadCard reviewId={id} revision={2} thread={thread} changedBlocks={[]} />);
  expect((screen.getByLabelText("Edit comment") as HTMLTextAreaElement).value).toBe("");
});
test("thread edits and deletes only unsent comments, replies, resolves and reopens", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  const view = mount(<ThreadCard reviewId={id} revision={2} thread={thread} changedBlocks={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Edit comment"), { target: { value: "Edited comment" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/comments/${id}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ body: "Edited comment" }) }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/comments/${id}`, expect.objectContaining({ method: "DELETE" })),
  );
  expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  view.unmount();
  const sent = mount(
    <ThreadCard
      reviewId={id}
      revision={2}
      changedBlocks={[]}
      thread={{ ...thread, comments: thread.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 })) }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/threads/${id}/resolve`,
      expect.objectContaining({ method: "POST" }),
    ),
  );
  sent.unmount();
  const resolved = mount(
    <ThreadCard
      reviewId={id}
      revision={2}
      thread={{
        ...thread,
        state: "resolved",
        comments: [
          { ...required(thread.comments[0]), sent: true, sentOn: 1 },
          {
            id: "22222222-2222-4222-8222-222222222222",
            author: "agent",
            body: "Reply",
            outcome: "fixed",
            sent: false,
            sentOn: null,
          },
        ],
      }}
      changedBlocks={[]}
    />,
  );
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.getByText("Resolved")).toBeTruthy();
  expect(screen.getByText("Fixed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/threads/${id}/reopen`, expect.objectContaining({ method: "POST" })),
  );
  resolved.unmount();
  mount(
    <ThreadCard
      reviewId={id}
      revision={2}
      changedBlocks={[]}
      thread={{ ...thread, comments: thread.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 })) }}
    />,
  );
  fetchMock.mockResolvedValue(Response.json({ commentId: id }, { status: 201 }));
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "Follow-up" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/threads/${id}/comments`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ body: "Follow-up" }) }),
    ),
  );
});
test("reading shows server blocks and change badges, rejects cross-block selection and offers a whole-diagram comment", () => {
  const diagram = {
    ...block,
    id: "overview-87654321",
    kind: "diagram" as const,
    text: "graph TD; A-->B",
    source: "graph TD; A-->B",
    html: "",
  };
  const { container } = mount(
    <Writeup
      reviewId={id}
      revision={2}
      writeup={{ sections: [{ key: "overview", label: "Overview", topic: null, blocks: [block, diagram] }] }}
      changedBlocks={[{ blockId: block.id, revision: 2 }]}
      threads={[]}
    />,
  );
  expect(screen.getByText("Changed in rev 2")).toBeTruthy();
  expect(screen.queryByText("Select text to comment.")).toBeNull();
  const range = document.createRange();
  range.setStart(required(container.querySelector("[data-block-id] p")?.firstChild), 0);
  range.setEnd(required(container.querySelector("pre")?.firstChild), 3);
  const selection = required(window.getSelection());
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(required(container.querySelector("p")));
  expect(screen.getByText("Select text within one paragraph")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Comment on diagram" }));
  expect(screen.getByLabelText("Comment")).toBeTruthy();
});
test("an open Markdown doc renders its blocks under the doc bar", () => {
  const { container } = mount(
    <DocView
      reviewId={id}
      revision={2}
      docs={[{ path: "plan.md", kind: "markdown", blocks: [block] }]}
      openDoc={{ path: "plan.md", kind: "markdown", blocks: [block] }}
      search={{ tab: "docs", doc: "plan.md" }}
      targeted={false}
      onOpenDoc={() => {}}
      changedBlocks={[]}
      threads={[]}
    />,
  );
  expect(screen.getByText("seed")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "plan.md" })).toBeTruthy();
  expect(container.querySelector("iframe")).toBeNull();
});
test.each([
  ["writeup", "reply"],
  ["writeup", "edit"],
  ["markdown", "reply"],
  ["markdown", "edit"],
])("%s retains its draft-based %s restoration after dismissal and remount", async (surface, kind) => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const doc = { path: "plan.md", kind: "markdown" as const, blocks: [block] };
  const placed: ThreadView = {
    ...thread,
    target: surface === "markdown" ? { ...target, kind: "doc-span", path: doc.path } : target,
    placement: {
      status: "placed",
      location:
        surface === "markdown"
          ? { kind: "doc-span", path: doc.path, blockId: block.id, start: 0, end: 4 }
          : { kind: "writeup-span", blockId: block.id, start: 0, end: 4 },
    },
    comments: thread.comments.map((comment) => ({
      ...comment,
      sent: kind === "reply",
      sentOn: kind === "reply" ? 1 : null,
    })),
  };
  const props = { reviewId: id, revision: 2, changedBlocks: [], threads: [placed] };
  const reader =
    surface === "writeup" ? (
      <Writeup
        {...props}
        writeup={{ sections: [{ key: "overview", label: "Overview", topic: null, blocks: [block] }] }}
      />
    ) : (
      <DocView
        {...props}
        docs={[doc]}
        openDoc={doc}
        search={{ tab: "docs", doc: doc.path }}
        targeted={false}
        onOpenDoc={() => {}}
      />
    );
  const first = mount(reader);
  fireEvent.click(screen.getByRole("button", { name: kind === "reply" ? "Reply" : "Edit" }));
  const label = kind === "reply" ? "Reply" : "Edit comment";
  const editor = screen.getByRole("textbox", { name: label });
  fireEvent.change(editor, { target: { value: "Retained surface draft" } });
  if (kind === "reply") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  else fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: label })).toBeNull();
  await act(async () => first.unmount());
  mount(reader);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: label }).value).toBe("Retained surface draft");
});
test("thread groups are ordered, unplaced quotes link to their original revision, and answered changes link to the block", async () => {
  const answered = {
    ...thread,
    state: "answered" as const,
    comments: [
      { ...required(thread.comments[0]), sent: true, sentOn: 1 },
      {
        id: "22222222-2222-4222-8222-222222222222",
        author: "agent" as const,
        body: "Done",
        outcome: "fixed" as const,
        sent: false,
        sentOn: null,
      },
    ],
  };
  const ui = (
    <ThreadList
      onResume={() => {}}
      reviewId={id}
      revision={3}
      threads={[
        answered,
        {
          ...thread,
          id: "33333333-3333-4333-8333-333333333333",
          placement: { status: "unplaced", reason: "block-gone" },
        },
      ]}
      changedBlocks={[{ blockId: block.id, revision: 3 }]}
    />
  );
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  mount(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Unplaced 1" });

  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Answered1",
    "Unplaced1",
  ]);
  const changed = screen.getByRole("link", { name: "Changed in revision 3" });
  expect(changed.getAttribute("href")).toContain(`#block-${block.id}`);
  const unplaced = screen.getByRole("region", { name: "Unplaced" });
  expect(within(unplaced).getByText("seed")).toBeTruthy();
  expect(within(unplaced).getByRole("link", { name: "revision 1" }).getAttribute("href")).toContain("rev=1");
});
test("Send counts review-wide unsent comments, defaults mode, limits instruction input and posts the revision on screen", async () => {
  mount(<SendBar reviewId={id} revision={2} newestRevision={2} unsentCount={7} />);
  expect(screen.getByText("7 unsent comments")).toBeTruthy();
  expect((screen.getByLabelText("Mode") as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
    "Fix what's clear, ask about the rest",
  );
  expect(screen.getAllByRole("option")).toHaveLength(3);
  expect((screen.getByRole("button", { name: "Approve revision 2" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Send or delete before approving")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "x".repeat(4000) } });
  expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).maxLength).toBe(4000);
  expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toHaveLength(4000);
  fireEvent.click(screen.getByRole("button", { name: "Send 7" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/reviews/${id}/sends`,
      expect.objectContaining({
        body: JSON.stringify({ revision: 2, kind: "go", mode: "fix-clear", instruction: "x".repeat(4000) }),
      }),
    ),
  );
  await screen.findByText(/No agent has picked this up yet/);
});
test.each([
  ["stale_revision", 409, "This page is out of date. Reload to see the newest revision."],
  ["empty_send", 400, "Synthetic message"],
  ["unsent_comments", 409, "Synthetic message"],
  ["too_large", 413, "Synthetic message"],
])("Send surfaces %s", async (code, status, message) => {
  fetchMock.mockResolvedValue(
    Response.json({ error: { code, message: "Synthetic message" } }, { status: Number(status) }),
  );
  mount(<SendBar reviewId={id} revision={2} newestRevision={2} unsentCount={0} />);
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Synthetic instruction" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByRole("alert")).textContent).toBe(message);
});
test("Approve has no mode or instruction, invalidates the displayed revision, review and inbox", async () => {
  mount(<SendBar reviewId={id} revision={2} newestRevision={2} unsentCount={0} />);
  fireEvent.click(screen.getByRole("button", { name: "Approve revision 2" }));
  // Approving asks first.
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve" }));
  await screen.findByText("Approved revision 2");
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/v1/reviews/${id}/sends`,
    expect.objectContaining({ body: JSON.stringify({ revision: 2, kind: "approve" }) }),
  );
  for (const key of [["inbox"], ["review", id], ["revision", id, 1], ["revision", id, 2], ["revision", id, 3]])
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});
test("phone Send opens the existing Sheet with mode and instructions", async () => {
  mount(<SendBar reviewId={id} revision={2} newestRevision={2} unsentCount={0} phone />);
  expect(screen.queryByLabelText("Instructions")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("group", { name: "Mode" })).toBeTruthy();
  expect(within(dialog).getByLabelText("Instructions")).toBeTruthy();
});

test("empty diagrams have no comment control and long selections explain the limit", () => {
  const text = "x".repeat(2001);
  const { container } = mount(
    <Writeup
      reviewId={id}
      revision={2}
      threads={[]}
      changedBlocks={[]}
      writeup={{
        sections: [
          {
            key: "overview",
            label: "Overview",
            topic: null,
            blocks: [
              { ...block, text, html: `<p>${text}</p>` },
              { ...block, id: "overview-87654321", kind: "diagram", text: " \n \t", source: " \n \t", html: "" },
            ],
          },
        ],
      }}
    />,
  );
  expect(screen.queryByRole("button", { name: "Comment on diagram" })).toBeNull();
  const node = required(container.querySelector("[data-block-id] p")?.firstChild);
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 2001);
  const selection = required(window.getSelection());
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(required(node.parentElement));
  expect(screen.getByText("Select at most 2000 characters.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
  selection.removeAllRanges();
});

test("duplicate composer requests share one editor and saving empties its draft", async () => {
  mount(
    <>
      <Composer reviewId={id} revision={2} target={target} />
      <Composer reviewId={id} revision={2} target={target} />
    </>,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Comment" })[0] as HTMLElement);
  const fields = screen.getAllByLabelText("Comment") as HTMLTextAreaElement[];
  fireEvent.change(required(fields[0]), { target: { value: "Follow-up" } });
  expect(fields.map((field) => field.value)).toEqual(["Follow-up"]);
  fireEvent.change(required(fields[0]), { target: { value: "Shared edit" } });
  expect(fields.map((field) => field.value)).toEqual(["Shared edit"]);
  fireEvent.click(required(screen.getAllByRole("button", { name: "Save comment" })[0]));
  await waitFor(() => expect(fields.map((field) => field.value)).toEqual([""]));
  expect(localStorage.getItem(draftKey(id, target))).toBeNull();
  expect(
    screen.getAllByRole("button", { name: "Save comment" }).every((button) => (button as HTMLButtonElement).disabled),
  ).toBe(true);
});
test.each(["paragraph", "diagram"] as const)("opening a %s composer claims its resumed draft", (kind) => {
  const value: RenderedBlock = kind === "diagram" ? { ...block, kind, source: "seed", html: "" } : block;
  const view = mount(
    <>
      <section aria-label="Reading content">
        <Writeup
          reviewId={id}
          revision={2}
          threads={[]}
          changedBlocks={[]}
          writeup={{ sections: [{ key: "overview", label: "Overview", topic: null, blocks: [value] }] }}
        />
      </section>
      <Composer
        reviewId={id}
        revision={2}
        target={target}
        surface="resumed"
        placeholder={false}
        wrap={(editor) => <section aria-label="Resumed comment">{editor}</section>}
      />
    </>,
  );
  const resumed = screen.getByLabelText("Comment");
  fireEvent.focus(resumed);
  fireEvent.change(resumed, { target: { value: "Resumed text" } });
  const reader = screen.getByRole("region", { name: "Reading content" });
  if (kind === "paragraph") {
    const node = required(reader.querySelector("[data-block-id] p")?.firstChild);
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = required(window.getSelection());
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(required(node.parentElement));
    selection.removeAllRanges();
  }
  fireEvent.click(
    within(reader).getByRole("button", { name: kind === "diagram" ? "Comment on diagram" : "Comment on selection" }),
  );
  const editor = within(reader).getByLabelText("Comment");
  expect(document.activeElement).toBe(editor);
  expect((editor as HTMLTextAreaElement).value).toBe("Resumed text");
  expect(screen.queryByRole("region", { name: "Resumed comment" })).toBeNull();
  view.unmount();
  mount(<Composer reviewId={id} revision={2} target={target} surface="resumed" />);
  expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Resumed text");
});
test("Discard empties every open composer for its draft", () => {
  localStorage.setItem(draftKey(id, target), "Discard this text");
  mount(
    <>
      <DraftList reviewId={id} onResume={() => {}} />
      <Composer reviewId={id} revision={2} target={target} />
    </>,
  );
  expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Discard this text");
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("");
  expect(localStorage.getItem(draftKey(id, target))).toBeNull();
});
test("storage events update and clear open composers and the draft list", () => {
  mount(
    <>
      <DraftList reviewId={id} onResume={() => {}} />
      <Composer reviewId={id} revision={2} target={target} />
    </>,
  );
  const field = screen.getByLabelText("Comment") as HTMLTextAreaElement;
  const key = draftKey(id, target);
  localStorage.setItem(key, "From another tab");
  act(() =>
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "From another tab", storageArea: localStorage })),
  );
  expect(field.value).toBe("From another tab");
  expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  localStorage.removeItem(key);
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", { key, oldValue: "From another tab", newValue: null, storageArea: localStorage }),
    ),
  );
  expect(field.value).toBe("");
  expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  fireEvent.change(field, { target: { value: "Local draft" } });
  localStorage.clear();
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage })));
  expect(field.value).toBe("");
});
test("unavailable storage keeps shared draft text through rerender and remount", () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  const first = mount(<Composer reviewId={id} revision={2} target={target} />);
  fireEvent.focus(screen.getByLabelText("Comment"));
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "In memory" } });
  first.rerender(
    <QueryClientProvider client={client}>
      <Composer reviewId={id} revision={3} target={target} />
      <Composer reviewId={id} revision={3} target={target} />
      <DraftList reviewId={id} onResume={() => {}} />
    </QueryClientProvider>,
  );
  expect(screen.getAllByLabelText("Comment").map((field) => (field as HTMLTextAreaElement).value)).toEqual([
    "In memory",
  ]);
  expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  first.unmount();
  mount(<Composer reviewId={id} revision={3} target={target} />);
  expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("In memory");
});

test("one composer owns each draft key and a remaining copy takes over on unmount", async () => {
  const first = mount(<Composer reviewId={id} revision={2} target={target} />);
  fireEvent.focus(screen.getByLabelText("Comment"));
  const second = mount(<Composer reviewId={id} revision={2} target={target} />);
  expect(screen.getAllByLabelText("Comment")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Shared draft" } });
  first.unmount();
  await waitFor(() => expect(screen.getAllByLabelText("Comment")).toHaveLength(1));
  expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Shared draft");
  second.unmount();
});
test("refocusing an existing owner cancels another key's kept handoff", () => {
  const other: Target = { ...target, blockId: "overview-87654321" };
  const first = mount(<Composer reviewId={id} revision={2} target={target} />);
  const second = mount(<Composer reviewId={id} revision={2} target={other} />);
  const a = within(first.container).getByLabelText("Comment");
  const b = within(second.container).getByLabelText("Comment");
  act(() => b.focus());
  act(() => a.focus());
  first.unmount();
  act(() => b.focus());
  // Remount A synchronously, before its handoff timer has fired.
  mount(<Composer reviewId={id} revision={2} target={target} />);
  expect(document.activeElement).toBe(b);
});
test("a pending Resume or open intent cancels another key's kept handoff", () => {
  const other: Target = { ...target, blockId: "overview-87654321" };
  const first = mount(<Composer reviewId={id} revision={2} target={target} />);
  act(() => within(first.container).getByLabelText("Comment").focus());
  first.unmount();
  act(() => claimDraft(draftKey(id, other), "reading"));
  const replacement = mount(<Composer reviewId={id} revision={2} target={target} />);
  expect(document.activeElement).not.toBe(within(replacement.container).getByLabelText("Comment"));
  const second = mount(<Composer reviewId={id} revision={2} target={other} />);
  expect(document.activeElement).toBe(within(second.container).getByLabelText("Comment"));
});
