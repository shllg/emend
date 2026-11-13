import { RenderedWriteup, type WriteupInput } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderWriteup } from "../../../../../packages/core/src/render/writeup.ts";
import { isReadingFocusMove } from "../../lib/reading-focus.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import { GlossaryTerms } from "./GlossaryTerms.tsx";
import { Writeup } from "./Writeup.tsx";

const reviewId = "11111111-1111-4111-8111-111111111111";
const entries = [
  { term: "Budget", definition: "The attempts allowed.", aliases: ["Allowance"] },
  { term: "Retry", definition: "Try again." },
];
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  window.getSelection()?.removeAllRanges();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function mount(glossary: WriteupInput["glossary"] = entries) {
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        overview: "Budget budget and retry retry.",
        tldr: "Allowance budget.",
        decisions: "",
        topics: {},
        glossary,
      },
      [],
    ),
  );
  vi.useFakeTimers();
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Writeup
          writeup={writeup}
          reviewId={reviewId}
          revision={2}
          search={{ rev: 2, tab: "writeup" }}
          threads={[]}
          changedBlocks={[]}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  const marks = [...view.container.querySelectorAll<HTMLElement>("span.emend-term")];
  const first = marks[0];
  return { ...view, writeup, marks, first: first as HTMLElement };
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const over = (element: Element, relatedTarget: Element | null = null, pointerType = "mouse") =>
  fireEvent.pointerOver(element, { pointerType, relatedTarget });
const out = (element: Element, relatedTarget: Element | null = null) =>
  fireEvent.pointerOut(element, { pointerType: "mouse", relatedTarget });

function TermFixture({ terms, label = "Budget" }: { terms?: RenderedWriteup["terms"]; label?: string }) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={root}>
        <div data-block-id="overview-12345678">
          <span key={label} className="emend-term" data-emend-term="0">
            {label}
          </span>
          {["-1", "1.5", "1e0", " 0", "2", "NaN"].map((value) => (
            <span key={value} className="emend-term" data-emend-term={value}>
              {value}
            </span>
          ))}
          <span className="user-content-emend-term" data-emend-term="0">
            Namespaced
          </span>
        </div>
        <div data-block-id="glossary-12345678">
          <span className="emend-term" data-emend-term="0">
            Glossary term
          </span>
        </div>
        <span className="emend-term" data-emend-term="0">
          No block
        </span>
      </div>
      <span className="emend-term" data-emend-term="0">
        Outside
      </span>
      <GlossaryTerms root={root} terms={terms} href={(id) => `#block-${id}`} />
    </>
  );
}

test("marks only first uses, with accessible attributes and no title", async () => {
  const { marks } = await mount();
  expect(marks.map((mark) => mark.textContent)).toEqual(["Budget", "retry", "Allowance"]);
  for (const mark of marks) {
    expect(mark.tabIndex).toBe(0);
    expect(mark.getAttribute("role")).toBe("button");
    expect(mark.getAttribute("aria-haspopup")).toBe("dialog");
    expect(mark.getAttribute("aria-expanded")).toBe("false");
    expect(mark.hasAttribute("aria-controls")).toBe(false);
    expect(mark.hasAttribute("title")).toBe(false);
  }
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("hover opens after 500 ms and the card contains only text and the glossary link", async () => {
  const { first, writeup } = await mount();
  over(first);
  advance(400);
  expect(screen.queryByRole("dialog")).toBeNull();
  advance(100);
  const card = screen.getByRole("dialog", { name: "Budget" });
  expect(card.parentElement).toBe(document.body);
  expect(card.textContent).toBe("BudgetThe attempts allowed.Glossary");
  expect(card.hasAttribute("title")).toBe(false);
  expect(within(card).getByRole("link", { name: "Glossary" }).getAttribute("href")).toBe(
    `/r/${reviewId}?tab=writeup&rev=2#block-${writeup.terms?.[0]?.blockId}`,
  );
  expect(first.getAttribute("aria-expanded")).toBe("true");
  expect(first.getAttribute("aria-controls")).toBe(card.id);
  expect([...card.children].every((child) => child.getAttribute("dir") === "auto")).toBe(true);
});

test("leaving cancels pending hover and crossing the gap or entering the card cancels closing", async () => {
  const { first } = await mount();
  over(first);
  advance(400);
  out(first);
  advance(500);
  expect(screen.queryByRole("dialog")).toBeNull();
  over(first, null, "pen");
  advance(500);
  const card = screen.getByRole("dialog");
  out(first);
  advance(200);
  over(card);
  advance(500);
  expect(screen.getByRole("dialog")).toBe(card);
  out(card, first);
  over(first, card);
  advance(500);
  expect(screen.getByRole("dialog")).toBe(card);
  out(first, card);
  over(card, first);
  out(card);
  advance(299);
  expect(screen.getByRole("dialog")).toBe(card);
  advance(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("crossing another term for 100 ms keeps the open card's original 300 ms close deadline", async () => {
  const { first, marks } = await mount();
  render(<button type="button">Elsewhere</button>);
  act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
  const retry = marks[1];
  const paragraph = first.closest("p");
  if (!retry || !paragraph) throw new Error("Missing retry term or paragraph");
  over(first);
  advance(500);
  const card = screen.getByRole("dialog", { name: "Budget" });
  out(first, retry);
  over(retry, first);
  advance(100);
  out(retry, paragraph);
  over(paragraph, retry);
  advance(199);
  expect(screen.getByRole("dialog", { name: "Budget" })).toBe(card);
  advance(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  advance(500);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("crossing another term into the open card cancels that term's pending opening", async () => {
  const { first, marks, writeup } = await mount();
  const retry = marks[1];
  if (!retry) throw new Error("Missing retry term");
  over(first);
  advance(500);
  const card = screen.getByRole("dialog", { name: "Budget" });
  out(first, retry);
  over(retry, first);
  advance(100);
  out(retry, card);
  over(card, retry);
  for (const elapsed of [400, 500, 1000]) {
    advance(elapsed);
    expect(screen.getByRole("dialog", { name: "Budget" })).toBe(card);
    expect(screen.queryByRole("dialog", { name: "Retry" })).toBeNull();
    expect(within(card).getByRole("link", { name: "Glossary" }).getAttribute("href")).toBe(
      `/r/${reviewId}?tab=writeup&rev=2#block-${writeup.terms?.[0]?.blockId}`,
    );
  }
});

test("leaving the open card for another term closes at 300 ms and opens the next at 500 ms", async () => {
  const { first, marks } = await mount();
  render(<button type="button">Elsewhere</button>);
  act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
  const retry = marks[1];
  if (!retry) throw new Error("Missing retry term");
  over(first);
  advance(500);
  const card = screen.getByRole("dialog", { name: "Budget" });
  out(first, card);
  over(card, first);
  out(card, retry);
  over(retry, card);
  advance(299);
  expect(screen.getByRole("dialog", { name: "Budget" })).toBe(card);
  advance(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  advance(199);
  expect(screen.queryByRole("dialog")).toBeNull();
  advance(1);
  expect(screen.getByRole("dialog", { name: "Retry" })).toBeTruthy();
});

test("returning to the open term within 300 ms cancels its pending close", async () => {
  const { first } = await mount();
  render(<button type="button">Elsewhere</button>);
  act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
  const paragraph = first.closest("p");
  if (!paragraph) throw new Error("Missing paragraph");
  over(first);
  advance(500);
  const card = screen.getByRole("dialog", { name: "Budget" });
  out(first, paragraph);
  over(paragraph, first);
  advance(200);
  out(paragraph, first);
  over(first, paragraph);
  advance(100);
  expect(screen.getByRole("dialog", { name: "Budget" })).toBe(card);
  advance(500);
  expect(screen.getByRole("dialog", { name: "Budget" })).toBe(card);
});

test("focus on an unrelated writeup control does not cancel the pending hover close", async () => {
  const { first } = await mount();
  const section = first.closest("[data-reading-section]");
  if (!section) throw new Error("Missing writeup section");
  const elsewhere = document.createElement("button");
  elsewhere.type = "button";
  elsewhere.textContent = "Elsewhere";
  section.append(elsewhere);
  try {
    over(first);
    advance(500);
    const card = screen.getByRole("dialog");
    out(first);
    advance(100);
    act(() => elsewhere.focus());
    expect(document.activeElement).toBe(elsewhere);
    advance(199);
    expect(screen.getByRole("dialog")).toBe(card);
    advance(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    elsewhere.remove();
  }
});

test("focus opens after a delay, blur cancels pending focus and leaving the card closes it", async () => {
  const { first } = await mount();
  act(() => first.focus());
  advance(400);
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => first.blur());
  advance(500);
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => first.focus());
  advance(500);
  const link = within(screen.getByRole("dialog")).getByRole("link");
  act(() => link.focus());
  expect(screen.getByRole("dialog")).toBeTruthy();
  act(() => link.blur());
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("pointer departure keeps the card open while its link has keyboard focus", async () => {
  const { first } = await mount();
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "Enter" });
  const card = screen.getByRole("dialog");
  const link = within(card).getByRole("link");
  expect(document.activeElement).toBe(link);
  over(card);
  out(card);
  advance(400);
  expect(screen.getByRole("dialog")).toBe(card);
  expect(document.activeElement).toBe(link);
});

test("focus departure keeps the hovered card open until the pointer leaves for 300 ms", async () => {
  const { first } = await mount();
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "Enter" });
  const card = screen.getByRole("dialog");
  over(card);
  const outside = screen.getAllByRole("button", { name: "Comment on block" })[0];
  if (!outside) throw new Error("Missing outside focus target");
  act(() => outside.focus());
  advance(400);
  expect(screen.getByRole("dialog")).toBe(card);
  out(card);
  advance(299);
  expect(screen.getByRole("dialog")).toBe(card);
  advance(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test.each(["Enter", " "])(
  "%s opens immediately and focuses the link; Esc restores focus without reopening",
  async (key) => {
    const { first } = await mount();
    act(() => first.focus());
    expect(fireEvent.keyDown(first, { key })).toBe(false);
    const link = within(screen.getByRole("dialog")).getByRole("link");
    expect(document.activeElement).toBe(link);
    const otherEscape = vi.fn();
    document.addEventListener("keydown", otherEscape);
    fireEvent.keyDown(link, { key: "Escape" });
    expect(otherEscape).not.toHaveBeenCalled();
    document.removeEventListener("keydown", otherEscape);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(first);
    expect(first.hasAttribute("aria-controls")).toBe(false);
    advance(600);
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

test("keyboard glossary follow restores term focus without scrolling, reader input or reopening", async () => {
  const { first } = await mount();
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "Enter" });
  const link = within(screen.getByRole("dialog", { name: "Budget" })).getByRole("link", { name: "Glossary" });
  expect(document.activeElement).toBe(link);
  const scroll = vi.spyOn(first, "scrollIntoView").mockImplementation(() => {});
  const focus = vi.spyOn(first, "focus");
  const readingFocus = vi.fn(() => isReadingFocusMove(first));
  first.addEventListener("focusin", readingFocus);
  try {
    fireEvent.click(link);
    expect(document.activeElement).toBe(first);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(readingFocus).toHaveReturnedWith(true);
    expect(scroll).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    advance(500);
    expect(screen.queryByRole("dialog")).toBeNull();
    advance(500);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(first);
  } finally {
    first.removeEventListener("focusin", readingFocus);
  }
});

test("mouse glossary follow preserves focus outside the card", async () => {
  const { first } = await mount();
  render(<button type="button">Elsewhere</button>);
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  act(() => elsewhere.focus());
  over(first);
  advance(500);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Budget" })).getByRole("link", { name: "Glossary" }));
  expect(document.activeElement).toBe(elsewhere);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Esc closes the hovered card and reaches document when focus is elsewhere", async () => {
  const { first } = await mount();
  over(first);
  advance(500);
  const outside = document.createElement("button");
  outside.type = "button";
  outside.textContent = "Elsewhere";
  document.body.append(outside);
  const otherEscape = vi.fn();
  document.addEventListener("keydown", otherEscape);
  try {
    act(() => outside.focus());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(fireEvent.keyDown(outside, { key: "Escape" })).toBe(true);
    expect(otherEscape).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(outside);
  } finally {
    document.removeEventListener("keydown", otherEscape);
    outside.remove();
  }
});

test("touch opens immediately, switches terms without toggling, and outside pointerdown closes", async () => {
  const { first, marks } = await mount();
  over(first, null, "touch");
  advance(600);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent(first, new PointerEvent("click", { bubbles: true, pointerType: "touch" }));
  expect(screen.getByRole("dialog", { name: "Budget" })).toBeTruthy();
  fireEvent.click(first);
  expect(screen.getByRole("dialog", { name: "Budget" })).toBeTruthy();
  fireEvent.click(marks[1] as HTMLElement);
  expect(screen.getByRole("dialog", { name: "Retry" })).toBeTruthy();
  expect(first.getAttribute("aria-expanded")).toBe("false");
  fireEvent.pointerDown(document.body, { pointerType: "touch" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("selecting term text for a comment does not open the card", async () => {
  const { first } = await mount();
  const range = document.createRange();
  range.selectNodeContents(first);
  window.getSelection()?.addRange(range);
  fireEvent.click(first);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("hostile definitions stay React text and following the glossary link closes the card", async () => {
  const definition =
    "`<img src=x onerror=bad()>` `<script>bad()</script>` `<svg onload=bad()>` [Unsafe](javascript:bad())";
  const { first } = await mount([{ term: "Budget", definition }]);
  fireEvent.click(first);
  const card = screen.getByRole("dialog");
  expect(card.textContent).toContain("<img src=x onerror=bad()> <script>bad()</script> <svg onload=bad()> Unsafe");
  expect(card.querySelector("img, script, svg")).toBeNull();
  expect(card.querySelectorAll("a")).toHaveLength(1);
  fireEvent.click(within(card).getByRole("link"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("legacy Markdown glossaries have no marks or card", async () => {
  const { marks, container } = await mount("- **Budget:** The attempts allowed.");
  expect(marks).toEqual([]);
  fireEvent.click(container);
  advance(600);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("positions the card within the viewport and remeasures on captured scroll and resize", async () => {
  const { first } = await mount();
  let rect = { left: 30, top: 40, bottom: 60 };
  vi.spyOn(first, "getBoundingClientRect").mockImplementation(() => rect as DOMRect);
  fireEvent.click(first);
  const card = screen.getByRole("dialog");
  expect(card.style.left).toBe("30px");
  expect(card.style.top).toBe("66px");
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue({ width: 320, height: 120 } as DOMRect);
  rect = { left: window.innerWidth - 20, top: window.innerHeight - 50, bottom: window.innerHeight - 30 };
  fireEvent.scroll(first.parentElement as Element);
  expect(card.style.left).toBe(`${window.innerWidth - 328}px`);
  expect(card.style.top).toBe(`${rect.top - 126}px`);
  rect = { left: -20, top: -20, bottom: -10 };
  fireEvent.resize(window);
  expect(card.style.left).toBe("8px");
  expect(card.style.top).toBe("8px");
});

test("unmount cancels pending timers and removes the capture listener", async () => {
  const { first, unmount } = await mount();
  over(first);
  unmount();
  advance(600);
  expect(screen.queryByRole("dialog")).toBeNull();
  const mounted = await mount();
  fireEvent.click(mounted.first);
  mounted.unmount();
  const listener = vi.fn();
  window.addEventListener("keydown", listener);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(listener).toHaveBeenCalledOnce();
  window.removeEventListener("keydown", listener);
});

test("focus can move from an open term to another term and open it after the delay", async () => {
  const { first, marks } = await mount();
  act(() => first.focus());
  advance(500);
  act(() => marks[1]?.focus());
  expect(screen.queryByRole("dialog")).toBeNull();
  advance(499);
  expect(screen.queryByRole("dialog")).toBeNull();
  advance(1);
  expect(screen.getByRole("dialog", { name: "Retry" })).toBeTruthy();
});

test("ignores invalid marks and decorates replacement HTML, then cleans up when terms disappear", () => {
  vi.useFakeTimers();
  const terms = [{ term: "Budget", definition: "Attempts.", blockId: "glossary-12345678" }];
  const view = render(<TermFixture terms={terms} />);
  const valid = screen.getByText("Budget");
  expect(valid.tabIndex).toBe(0);
  for (const candidate of view.container.querySelectorAll("span")) {
    if (candidate === valid) continue;
    expect(candidate.hasAttribute("tabindex")).toBe(false);
    fireEvent.click(candidate);
    advance(600);
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  over(valid);
  advance(400);
  view.rerender(<TermFixture terms={terms} label="Allowance" />);
  advance(100);
  expect(screen.queryByRole("dialog")).toBeNull();
  const replacement = screen.getByText("Allowance");
  expect(replacement.tabIndex).toBe(0);
  fireEvent.click(replacement);
  expect(screen.getByRole("dialog")).toBeTruthy();
  view.rerender(<TermFixture label="Allowance" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(replacement.hasAttribute("tabindex")).toBe(false);
  expect(replacement.hasAttribute("aria-controls")).toBe(false);
  fireEvent.click(replacement);
  advance(600);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("clicking a new hovered term keeps its card open when focus moves away", async () => {
  const { first, marks } = await mount();
  render(<button type="button">Elsewhere</button>);
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  const retry = marks[1];
  if (!retry) throw new Error("Missing retry term");
  over(first);
  advance(500);
  out(first, retry);
  over(retry, first);
  fireEvent.pointerDown(retry, { pointerType: "mouse" });
  act(() => retry.focus());
  fireEvent.click(retry);
  expect(screen.getByRole("dialog", { name: "Retry" })).toBeTruthy();
  act(() => elsewhere.focus());
  advance(400);
  expect(screen.getByRole("dialog", { name: "Retry" })).toBeTruthy();
  out(retry);
  advance(300);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("hovering the old term does not keep a newly focused term's card open", async () => {
  const { first, marks } = await mount();
  render(<button type="button">Elsewhere</button>);
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  over(first);
  advance(500);
  act(() => marks[1]?.focus());
  advance(500);
  expect(screen.getByRole("dialog", { name: "Retry" })).toBeTruthy();
  act(() => elsewhere.focus());
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a removed node under the pointer no longer keeps the card open", async () => {
  const { first } = await mount();
  render(<button type="button">Elsewhere</button>);
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  over(first);
  advance(500);
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "Enter" });
  const link = within(screen.getByRole("dialog")).getByRole("link");
  expect(document.activeElement).toBe(link);
  first.remove();
  act(() => elsewhere.focus());
  expect(screen.queryByRole("dialog")).toBeNull();
});
