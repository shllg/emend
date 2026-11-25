// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { ok } from "node:assert/strict";
import type { RenderedBlock } from "@recense/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BlockReader, type ReaderGroup } from "./components/reading/BlockReader.tsx";
import { ToastProvider } from "./components/ui/Toast.tsx";
import { draftKey } from "./lib/drafts.ts";

const id = "11111111-1111-4111-8111-111111111111";
const block: RenderedBlock = {
  id: "overview-12345678",
  section: "overview",
  kind: "paragraph",
  text: "seed",
  html: "<p>seed</p>",
};
const second: RenderedBlock = { ...block, id: "overview-87654321", text: "plant", html: "<p>plant</p>" };
function required<T>(value: T | undefined | null): T {
  ok(value != null);
  return value;
}
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
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const key of [["inbox"], ["review", id], ["revision", id, 1]]) client.setQueryData(key, {});
  fetchMock = vi.fn(async () => Response.json({ threadId: id, commentId: id, sendId: id }, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  window.getSelection()?.removeAllRanges();
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const promptName = { name: "Comment on selection" };
function touchReader(groups: ReaderGroup[] = [{ key: "overview", blocks: [block, second] }]) {
  const view = mount(
    <div>
      <p data-testid="outside">outside text</p>
      <BlockReader reviewId={id} revision={1} changedBlocks={[]} threads={[]} groups={groups} />
    </div>,
  );
  const paragraphs = [...view.container.querySelectorAll<HTMLElement>("[data-block-id] p")];
  const text = required(required(paragraphs[0]).firstChild);
  const select = (node: Node, from: number, to: number, endNode: Node = node) => {
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(endNode, to);
    const selection = required(window.getSelection());
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  };
  const settle = (ms = 250) => act(() => void vi.advanceTimersByTime(ms));
  const changed = () => document.dispatchEvent(new Event("selectionchange"));
  const mouseCollapse = (element: HTMLElement) => {
    fireEvent.pointerDown(element, { pointerType: "mouse" });
    fireEvent.mouseDown(element);
    required(window.getSelection()).collapse(element, 0);
    changed();
    settle(120);
    fireEvent.pointerUp(element, { pointerType: "mouse" });
    fireEvent.mouseUp(element);
  };
  // A touch selection: no mouse events, only selectionchange, then the debounce.
  const reveal = () => {
    const selection = select(text, 1, 3);
    changed();
    settle();
    return { selection, prompt: screen.getByRole("button", promptName) };
  };
  return { ...view, paragraphs, text, select, settle, changed, reveal, mouseCollapse };
}
test("a touch selection shows the comment prompt from selectionchange alone", () => {
  const { select, text, changed, settle } = touchReader();
  select(text, 1, 3);
  changed();
  expect(screen.queryByRole("button", promptName)).toBeNull();
  settle();
  expect(screen.getByRole("button", promptName)).toBeTruthy();
});
test("a selection outside the reader retires a visible prompt", () => {
  const { getByTestId, reveal, select, changed, settle } = touchReader();
  reveal();
  select(required(getByTestId("outside").firstChild), 0, 4);
  changed();
  settle();
  expect(screen.queryByRole("button", promptName)).toBeNull();
});
test("a collapsed selection retires a visible prompt once no press guards it", () => {
  const { reveal, text, changed, settle } = touchReader();
  const { selection } = reveal();
  selection.collapse(text, 0);
  changed();
  settle();
  expect(screen.queryByRole("button", promptName)).toBeNull();
});
test.each([
  { name: "writeup", path: undefined },
  { name: "Markdown doc", path: "docs/seed.md" },
])("a held mouse click outside a $name retires its selection prompt on release", ({ path }) => {
  const { reveal, getByTestId, mouseCollapse } = touchReader([{ key: "overview", blocks: [block], path }]);
  reveal();
  mouseCollapse(getByTestId("outside"));
  expect(screen.queryByRole("button", promptName)).toBeNull();
});

test.each(["topic", "details"])("a form inside a closed %s fold keeps its draft and allows a new selection", (fold) => {
  const group: ReaderGroup =
    fold === "topic"
      ? {
          key: "seeds",
          heading: "Seeds",
          topic: { slug: "seeds", title: "Seeds", importance: 1, summary: "" },
          blocks: [block],
        }
      : { key: "seeds", blocks: [], subsections: [{ key: "body", kind: "body", heading: "Details", blocks: [block] }] };
  const { reveal, paragraphs, select, changed, settle, mouseCollapse } = touchReader([
    group,
    { key: "other", blocks: [second] },
  ]);
  const toggle = fold === "topic" ? screen.getByRole("button", { name: "Seeds" }) : screen.getByText("Details");
  const toggleFold = () => {
    mouseCollapse(toggle);
    fireEvent.click(toggle);
  };
  if (fold === "details") toggleFold();
  const { prompt } = reveal();
  fireEvent.click(prompt);
  const editor = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" });
  fireEvent.change(editor(), { target: { value: "Keep these letters" } });
  const selectOther = (end = 4) => {
    select(required(required(paragraphs[1]).firstChild), 0, end);
    changed();
    settle();
  };
  selectOther();
  expect(screen.queryByRole("button", promptName)).toBeNull();
  toggleFold();
  selectOther();
  expect(screen.getByRole("button", promptName)).toBeTruthy();
  toggleFold();
  expect(screen.queryByRole("button", promptName)).toBeNull();
  expect(editor().value).toBe("Keep these letters");
  expect(editor().form?.querySelector("mark")?.textContent).toBe("ee");
  toggleFold();
  selectOther();
  fireEvent.click(screen.getByRole("button", promptName));
  expect(editor().form?.querySelector("mark")?.textContent).toBe("plan");
  expect(editor().value).toBe("");
  const firstDraft = draftKey(id, { kind: "writeup-span", blockId: block.id, quote: "ee", prefix: "s", suffix: "d" });
  expect(localStorage.getItem(firstDraft)).toBe("Keep these letters");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("button", promptName)).toBeNull();
  selectOther(5);
  expect(screen.getByRole("button", promptName)).toBeTruthy();
});
test("a touch tap opens the composer once with the latched text, though the selection clears in between", async () => {
  const { reveal, text, changed, settle } = touchReader();
  const { selection, prompt } = reveal();
  expect(fireEvent.pointerDown(prompt, { pointerType: "touch" })).toBe(false);
  selection.collapse(text, 0);
  changed();
  settle();
  expect(prompt.isConnected).toBe(true);
  fireEvent.pointerUp(prompt, { pointerType: "touch" });
  fireEvent.click(prompt);
  expect(screen.getAllByRole("textbox", { name: "Comment" })).toHaveLength(1);
  vi.useRealTimers();
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "The selected letters" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body).target).toMatchObject({ quote: "ee" });
});
test("a collapse while the pointer is still down keeps the prompt", () => {
  const { reveal, text, changed, settle } = touchReader();
  const { selection, prompt } = reveal();
  fireEvent.pointerDown(prompt, { pointerType: "touch" });
  selection.collapse(text, 0);
  changed();
  settle(1000);
  expect(screen.getByRole("button", promptName)).toBe(prompt);
});
test("a mouse click on the prompt opens the composer", () => {
  const { reveal } = touchReader();
  const { prompt } = reveal();
  fireEvent.click(prompt);
  expect(screen.getByRole("textbox", { name: "Comment" })).toBeTruthy();
});
test("keyboard activation after an earlier touch tap opens the composer", () => {
  const { reveal, settle } = touchReader();
  const { prompt } = reveal();
  fireEvent.pointerDown(prompt, { pointerType: "touch" });
  fireEvent.pointerUp(prompt, { pointerType: "touch" });
  settle(700);
  fireEvent.click(prompt);
  expect(screen.getByRole("textbox", { name: "Comment" })).toBeTruthy();
});
test("a mouse drag across paragraphs flashes no error until the button is released", () => {
  const { paragraphs, text, select, changed, settle } = touchReader();
  const end = required(required(paragraphs[1]).firstChild);
  fireEvent.pointerDown(required(paragraphs[0]), { pointerType: "mouse" });
  select(text, 1, 3, end);
  changed();
  settle();
  expect(screen.queryByText("Select text within one paragraph")).toBeNull();
  fireEvent.pointerUp(required(paragraphs[1]), { pointerType: "mouse" });
  fireEvent.mouseUp(required(paragraphs[1]));
  expect(screen.getByText("Select text within one paragraph")).toBeTruthy();
});
