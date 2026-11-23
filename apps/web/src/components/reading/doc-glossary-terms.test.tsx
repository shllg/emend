import type { RevisionView } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type RenderEffects, renderDoc } from "../../../../../packages/core/src/render/markdown.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import { DocView } from "./DocView.tsx";

const reviewId = "11111111-1111-4111-8111-111111111111";
type Doc = Extract<RevisionView["docs"][number], { kind: "markdown" }>;
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  window.getSelection()?.removeAllRanges();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});

async function mount(markdown: string) {
  const effects: RenderEffects = {};
  const blocks = await renderDoc(markdown, "guide.md", undefined, undefined, effects);
  const doc: Doc = { path: "guide.md", kind: "markdown", blocks, ...(effects.terms ? { terms: effects.terms } : {}) };
  vi.useFakeTimers();
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DocView
          reviewId={reviewId}
          revision={2}
          docs={[doc]}
          openDoc={doc}
          search={{ rev: 2, tab: "docs", doc: doc.path }}
          targeted={false}
          onOpenDoc={() => {}}
          threads={[]}
          changedBlocks={[]}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, doc, marks: [...view.container.querySelectorAll<HTMLElement>("span.emend-term")] };
}
const glossaryDoc = "# Guide\n\nThe budget is spent.\n\n## Glossary\n\n- **Budget:** Attempts a worker may spend.\n";

test("a marked term in a Markdown doc opens the card on hover and links to its entry", async () => {
  const { marks, doc } = await mount(glossaryDoc);
  expect(marks.map((mark) => mark.textContent)).toEqual(["budget"]);
  expect(marks[0]?.getAttribute("role")).toBe("button");
  fireEvent.pointerOver(marks[0] as HTMLElement, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(500));
  const card = screen.getByRole("dialog", { name: "Budget" });
  expect(card.textContent).toBe("BudgetAttempts a worker may spend.Glossary");
  expect(within(card).getByRole("link", { name: "Glossary" }).getAttribute("href")).toBe(
    `/r/${reviewId}?rev=2&tab=docs&doc=guide.md#block-${doc.terms?.[0]?.blockId}`,
  );
});

test("a tap on a marked term opens the card at once", async () => {
  const { marks } = await mount(glossaryDoc);
  fireEvent.click(marks[0] as HTMLElement);
  expect(screen.getByRole("dialog", { name: "Budget" })).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the entry's own block is not marked", async () => {
  const { container } = await mount(glossaryDoc);
  expect(container.querySelectorAll("li span.emend-term")).toHaveLength(0);
});

test("a doc without a glossary shows no marks or card", async () => {
  const { marks } = await mount("# Guide\n\nThe budget is spent.\n");
  expect(marks).toHaveLength(0);
  expect(screen.queryByRole("dialog")).toBeNull();
});
