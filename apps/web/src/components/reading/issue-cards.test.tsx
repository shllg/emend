import { type IssueRef, RenderedWriteup } from "@recense/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderWriteup } from "../../../../../packages/core/src/render/writeup.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import { IssueCards } from "./IssueCards.tsx";
import { Writeup } from "./Writeup.tsx";

const reviewId = "11111111-1111-4111-8111-111111111111";
const repoUrl = "https://github.com/example/app";
const refs: IssueRef[] = [
  { number: 412, title: "Store money as whole cents", state: "open" },
  { number: 9, title: "Retire the old importer", state: "merged" },
];
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  localStorage.clear();
  window.getSelection()?.removeAllRanges();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type MountOptions = {
  repoUrl?: string | null;
  issueRefs?: IssueRef[];
  phone?: boolean;
  glossary?: { term: string; definition: string }[];
};
async function mount(options: MountOptions = {}) {
  const { issueRefs = refs, phone = false } = options;
  const url = "repoUrl" in options ? options.repoUrl : repoUrl;
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        overview: "Fixes #412 and follows #9, not #7.",
        tldr: "Done.",
        decisions: "",
        topics: {},
        ...(options.glossary ? { glossary: options.glossary } : {}),
      },
      [],
      { repoUrl, issueRefs },
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
          phone={phone}
          repoUrl={url}
          issueRefs={issueRefs}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  const anchor = (n: number) => {
    const found = view.container.querySelector<HTMLElement>(`a[data-recense-issue="${n}"]`);
    if (!found) throw new Error(`Missing anchor #${n}`);
    return found;
  };
  return { ...view, anchor };
}
/** Clicks, reports whether the link would be followed, and never lets happy-dom navigate. */
function followed(element: Element) {
  let prevented = true;
  const stop = (event: Event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", stop);
  fireEvent.click(element);
  document.removeEventListener("click", stop);
  return !prevented;
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const over = (element: Element, pointerType = "mouse") =>
  fireEvent.pointerOver(element, { pointerType, relatedTarget: null });
const out = (element: Element) => fireEvent.pointerOut(element, { pointerType: "mouse", relatedTarget: null });

test("mouse hover opens the card after 500 ms and leaving closes it", async () => {
  const { anchor } = await mount();
  const issue = anchor(412);
  expect(issue.getAttribute("aria-haspopup")).toBe("dialog");
  expect(issue.hasAttribute("role")).toBe(false);
  expect(issue.hasAttribute("tabindex")).toBe(false);
  over(issue);
  advance(499);
  expect(screen.queryByRole("dialog")).toBeNull();
  advance(1);
  const card = screen.getByRole("dialog", { name: "#412 Store money as whole cents" });
  expect(card.className).toBe("em-term-card");
  expect(card.textContent).toBe("#412 OpenStore money as whole centsView on github.com");
  expect(issue.getAttribute("aria-expanded")).toBe("true");
  expect(issue.getAttribute("aria-controls")).toBe(card.id);
  out(issue);
  advance(299);
  expect(screen.getByRole("dialog")).toBe(card);
  advance(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(issue.getAttribute("aria-expanded")).toBe("false");
});

test("the card names the state as a word and links to the issue", async () => {
  const { anchor } = await mount();
  over(anchor(9));
  advance(500);
  const card = screen.getByRole("dialog");
  expect(card.textContent).toContain("#9 Merged");
  const link = within(card).getByRole("link", { name: "View on github.com" });
  expect(link.getAttribute("href")).toBe("https://github.com/example/app/issues/9");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
});

test("keyboard focus opens the card and Escape closes it without taking Enter", async () => {
  const { anchor } = await mount();
  const issue = anchor(412);
  act(() => issue.focus());
  advance(500);
  expect(screen.getByRole("dialog")).toBeTruthy();
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  issue.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(false);
  fireEvent.keyDown(issue, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a touch tap opens the card and keeps the page; a mouse click follows the link", async () => {
  const { anchor } = await mount({ phone: true });
  const issue = anchor(412);
  fireEvent.pointerDown(issue, { pointerType: "touch" });
  expect(followed(issue)).toBe(false);
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.pointerDown(document.body, { pointerType: "touch" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.pointerDown(issue, { pointerType: "mouse" });
  expect(followed(issue)).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a keyboard click after a touch tap is not treated as touch", async () => {
  const { anchor } = await mount({ phone: true });
  const issue = anchor(412);
  fireEvent.pointerDown(issue, { pointerType: "touch" });
  fireEvent.keyDown(issue, { key: "Enter" });
  expect(followed(issue)).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a number without a recorded title stays a plain link", async () => {
  const { anchor } = await mount();
  const plain = anchor(7);
  expect(plain.hasAttribute("aria-haspopup")).toBe(false);
  over(plain);
  advance(600);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.pointerDown(plain, { pointerType: "touch" });
  expect(followed(plain)).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test.each([null, undefined, "http://github.com/example/app", "https://github.com/example/app/extra"])(
  "no card and no attributes when repoUrl is %s",
  async (value) => {
    const { anchor } = await mount({ repoUrl: value });
    const issue = anchor(412);
    expect(issue.hasAttribute("aria-haspopup")).toBe(false);
    over(issue);
    advance(600);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.pointerDown(issue, { pointerType: "touch" });
    expect(followed(issue)).toBe(true);
  },
);

function Fixture({ title = "Plain title", href }: { title?: string; href?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const good = `${repoUrl}/issues/5`;
  return (
    <>
      <div ref={root}>
        <div data-block-id="overview-12345678">
          <a data-recense-issue="5" href={good}>
            #5
          </a>
          <a data-recense-issue="5" href={href ?? `${good}/other`}>
            #5 odd
          </a>
          <a data-recense-issue="05" href={good}>
            #05
          </a>
          <div data-thread-card>
            <a data-recense-issue="5" href={good}>
              #5 in thread
            </a>
          </div>
        </div>
        <a data-recense-issue="5" href={good}>
          #5 no block
        </a>
      </div>
      <a data-recense-issue="5" href={good}>
        #5 outside
      </a>
      <IssueCards root={root} repoUrl={repoUrl} refs={[{ number: 5, title, state: "closed" }]} />
    </>
  );
}

test("only an anchor in a block with the exact href gets a card", () => {
  vi.useFakeTimers();
  const { container } = render(<Fixture />);
  const anchors = [...container.querySelectorAll("a")];
  expect(anchors.map((a) => a.hasAttribute("aria-haspopup"))).toEqual([true, false, false, false, false, false]);
  for (const odd of anchors.slice(1)) {
    over(odd);
    advance(600);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.pointerDown(odd, { pointerType: "touch" });
    expect(followed(odd)).toBe(true);
  }
});

test("a title with markup and control characters shows as plain text", () => {
  vi.useFakeTimers();
  const title = "<img src=x onerror=alert(1)><b>Fix</b> \u0007 bell";
  const { container } = render(<Fixture title={title} />);
  const first = container.querySelector("a");
  if (!first) throw new Error("Missing anchor");
  over(first);
  advance(500);
  const card = screen.getByRole("dialog");
  expect(card.querySelector("img, b")).toBeNull();
  expect(card.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(card.textContent).toContain("Closed");
});

test("a writeup with glossary terms and issue refs shares one pair of document pointer listeners", async () => {
  const spy = vi.spyOn(document, "addEventListener");
  const removed = vi.spyOn(document, "removeEventListener");
  const count = (calls: typeof spy, name: string) =>
    calls.mock.calls.filter(([type, , capture]) => type === name && capture === true).length;
  // "Fixes" is a glossary term, so GlossaryTerms mounts its own hover card beside IssueCards.
  const view = await mount({ glossary: [{ term: "Fixes", definition: "Closes the named issue." }] });
  expect(view.container.querySelector("span.recense-term")).not.toBeNull();
  // Per-instance listeners would register two of each here.
  expect(count(spy, "pointerover")).toBe(1);
  expect(count(spy, "pointerout")).toBe(1);
  view.unmount();
  expect(count(removed, "pointerover")).toBe(1);
  expect(count(removed, "pointerout")).toBe(1);
});
