import type { FileView, ReviewView, RevisionView } from "@emend/contract";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { relativeTime, wakeTime } from "../../lib/time.ts";
import { ReviewHeader } from "./ReviewHeader.tsx";

const review: ReviewView = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Synthetic review",
  origin: { id: "22222222-2222-4222-8222-222222222222", name: "Workshop" },
  repo: "c".repeat(64),
  project: null,
  branch: "topic/synthetic",
  state: "open",
  newestRevision: 2,
  unsentCount: 0,
  openThreads: 0,
  agentWaiting: true,
  pendingSend: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  movedTo: null,
  list: "active",
  snoozed: false,
  snoozedUntil: null,
  activeUntil: null,
  releasedAt: null,
  pickedUpAt: null,
  kind: "review",
  importedAt: null,
  revisions: [
    { seq: 1, createdAt: new Date(Date.now() - 3600_000).toISOString() },
    { seq: 2, createdAt: new Date(Date.now() - 120_000).toISOString() },
  ],
};
const revision: RevisionView = {
  seq: 2,
  base: `abcdef1${"0".repeat(33)}`,
  head: `1234567${"0".repeat(33)}`,
  main: null,
  writeupEmpty: true,
  topics: [],
  files: [],
  writeup: { sections: [] },
  docs: [{ kind: "markdown", path: "plan.md", blocks: [] }],
  threads: [],
  changedBlocks: [],
};
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
const countedFile: FileView = {
  id: "33333333-3333-4333-8333-333333333333",
  path: "synthetic.ts",
  oldPath: null,
  role: "diff",
  status: "modified",
  topic: "first",
  order: 0,
  mediaType: "text/plain",
  flag: null,
  hasOld: true,
  hasNew: true,
  counts: { additions: 1200, deletions: 3 },
};

test.each([false, true])("review totals show immediately from all topic groups (phone: %s)", (phone) => {
  mount({
    phone,
    metadata: { ...review, branch: null },
    loaded: {
      ...revision,
      topics: [{ slug: "first", title: "First", importance: 10, summary: "" }],
      files: [
        countedFile,
        {
          ...countedFile,
          id: crypto.randomUUID(),
          path: "other.ts",
          topic: null,
          counts: { additions: 7, deletions: 1 },
        },
      ],
    },
  });
  expect(screen.getByText("+1,207")).toBeTruthy();
  expect(screen.getByText("−4")).toBeTruthy();
  expect(screen.getByText("1,207 lines added, 4 lines removed")).toBeTruthy();
});

test.each(["pub", "no files", "legacy"])("%s has no review total", (kind) => {
  const { counts: _counts, ...uncounted } = countedFile;
  const { container } = mount({
    metadata: { ...review, kind: kind === "pub" ? "publish" : "review" },
    loaded: {
      ...revision,
      files: kind === "pub" ? [{ ...uncounted, role: "doc" }] : kind === "no files" ? [] : [uncounted],
    },
  });
  expect(container.querySelector(".text-diff-add-fg, .text-diff-del-fg")).toBeNull();
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  if (execCommandDescriptor) Object.defineProperty(document, "execCommand", execCommandDescriptor);
  else Reflect.deleteProperty(document, "execCommand");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount({
  metadata = review,
  loaded = revision,
  phone = false,
  seq = 2,
  title = metadata.title,
}: {
  metadata?: ReviewView;
  loaded?: RevisionView;
  phone?: boolean;
  seq?: number;
  title?: string;
} = {}) {
  const onRevisionChange = vi.fn();
  const titleRef = createRef<HTMLHeadingElement>();
  const header = (title: string) => (
    <ReviewHeader
      review={{ ...metadata, title }}
      revision={loaded}
      seq={seq}
      ready={metadata.newestRevision}
      phone={phone}
      titleRef={titleRef}
      onRevisionChange={onRevisionChange}
    />
  );
  const result = render(header(title));
  return { ...result, onRevisionChange, titleRef, rerenderTitle: (title: string) => result.rerender(header(title)) };
}

const longTitle = 'Review the  "phone header" with a long title that keeps every word through the final trailing word';
const titleName = longTitle.replace(/\s+/g, " ");

test("phone keeps a focusable level-one heading with one full-title button and an ellipsis span", () => {
  const { titleRef, rerenderTitle } = mount({ phone: true, title: longTitle });
  const heading = screen.getByRole("heading", { level: 1, name: titleName });
  expect(heading.tagName).toBe("H1");
  expect(heading.getAttribute("tabindex")).toBe("-1");
  expect(titleRef.current).toBe(heading);
  expect(heading.classList.contains("wrap-anywhere")).toBe(false);
  expect(heading.classList.contains("text-pretty")).toBe(false);
  for (const name of [
    "m-0",
    "min-w-0",
    "flex-[1_1_240px]",
    "text-[17px]",
    "font-semibold",
    "leading-[1.3]",
    "tracking-[-0.01em]",
    "text-fg-1",
  ])
    expect(heading.classList.contains(name)).toBe(true);
  const button = within(heading).getByRole("button", { name: titleName });
  expect(within(heading).getAllByRole("button")).toHaveLength(1);
  expect(button.textContent).toBe(longTitle);
  for (const name of [
    "block",
    "w-full",
    "text-start",
    "p-0",
    "border-0",
    "bg-transparent",
    "[font:inherit]",
    "[color:inherit]",
    "focus-visible:outline-none",
    "focus-visible:shadow-(--focus-ring)",
  ])
    expect(button.classList.contains(name)).toBe(true);
  const span = button.querySelector("span");
  expect(span?.textContent).toBe(longTitle);
  expect(span?.classList.contains("block")).toBe(true);
  expect(span?.classList.contains("truncate")).toBe(true);
  act(() => titleRef.current?.focus());
  expect(document.activeElement).toBe(heading);
  rerenderTitle("Next review after navigation");
  const nextHeading = screen.getByRole("heading", { level: 1, name: "Next review after navigation" });
  expect(titleRef.current).toBe(nextHeading);
  act(() => titleRef.current?.focus());
  expect(document.activeElement).toBe(nextHeading);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("tablet and desktop keep the full wrapping heading without a title menu", () => {
  const { titleRef } = mount({ phone: false, title: longTitle });
  const heading = screen.getByRole("heading", { level: 1, name: titleName });
  expect(titleRef.current).toBe(heading);
  expect(heading.getAttribute("tabindex")).toBe("-1");
  expect(heading.textContent).toBe(longTitle);
  expect(heading.classList.contains("text-pretty")).toBe(true);
  expect(heading.classList.contains("wrap-anywhere")).toBe(true);
  expect(within(heading).queryByRole("button")).toBeNull();
  fireEvent.pointerDown(heading, { button: 0, pointerType: "mouse" });
  fireEvent.click(heading);
  fireEvent.keyDown(heading, { key: "Enter" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Copy title" })).toBeNull();
});

test.each(["touch", "pen", "mouse"])(
  "a phone %s opens the full title and its described Copy item",
  async (pointerType) => {
    mount({ phone: true, title: longTitle });
    const button = screen.getByRole("button", { name: titleName });
    const allowed = fireEvent.pointerDown(button, { button: 0, pointerType });
    if (pointerType !== "mouse") {
      expect(allowed).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      fireEvent.click(button, { detail: 1 });
    }
    const menu = await screen.findByRole("menu");
    const block = within(menu).getByText(titleName);
    expect(block.tagName).toBe("DIV");
    expect(block.textContent).toBe(longTitle);
    expect(block.getAttribute("aria-hidden")).toBe("true");
    for (const name of ["whitespace-pre-wrap", "[overflow-wrap:anywhere]", "font-sans", "select-text"])
      expect(block.classList.contains(name)).toBe(true);
    expect(block.classList.contains("font-stretch-mono")).toBe(false);
    const copy = within(menu).getByRole("menuitem", { name: "Copy title", description: titleName });
    expect(copy.getAttribute("aria-describedby")).toBe(block.id);
    expect(document.getElementById(block.id)).toBe(block);
  },
);

test("even a short phone title opens on an assistive-technology click", async () => {
  mount({ phone: true, title: "Short title" });
  fireEvent.click(screen.getByRole("button", { name: "Short title" }), { detail: 0 });
  expect(within(await screen.findByRole("menu")).getByText("Short title")).toBeTruthy();
});

test("Copy title writes the exact text, announces success and resets after two seconds", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  mount({ phone: true, title: longTitle });
  const heading = screen.getByRole("heading", { level: 1, name: titleName });
  const status = screen.getByRole("status");
  expect(heading.nextElementSibling).toBe(status);
  fireEvent.click(within(heading).getByRole("button"));
  const menu = await screen.findByRole("menu");
  vi.useFakeTimers();
  await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy title" })));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(longTitle);
  expect(within(menu).getByRole("menuitem", { name: "Copied" })).toBeTruthy();
  expect(status.textContent).toBe("Title copied");
  expect(status.classList.contains("sr-only")).toBe(true);
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(status.closest('[aria-hidden="true"]')).toBeNull();
  expect(menu.contains(status)).toBe(false);
  act(() => vi.advanceTimersByTime(1999));
  expect(within(menu).getByRole("menuitem", { name: "Copied" })).toBeTruthy();
  act(() => vi.advanceTimersByTime(1));
  expect(within(menu).getByRole("menuitem", { name: "Copy title" })).toBeTruthy();
  expect(status.textContent).toBe("");
});

test.each(["resolve", "reject"])("changing the phone title ignores a pending copy's late %s", async (settlement) => {
  const pending = Promise.withResolvers<void>();
  const writeText = vi.fn(() => pending.promise);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const execCommand = vi.fn(() => false);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  const { rerenderTitle } = mount({ phone: true, title: longTitle });
  fireEvent.click(screen.getByRole("button", { name: titleName }));
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy title" }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(longTitle);
  const nextTitle = "Updated review title";
  rerenderTitle(nextTitle);
  await act(async () => {
    if (settlement === "resolve") pending.resolve();
    else pending.reject(new Error("denied"));
  });
  expect(screen.getByRole("menu")).toBe(menu);
  expect(within(menu).getByRole("menuitem", { name: "Copy title" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("");
  expect(within(menu).getByText(nextTitle).textContent).toBe(nextTitle);
  expect(execCommand).not.toHaveBeenCalled();
  expect(window.getSelection()?.toString()).toBe("");
});

test("changing the phone title clears Copied and its live region while keeping the menu open", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const { rerenderTitle } = mount({ phone: true, title: longTitle });
  fireEvent.click(screen.getByRole("button", { name: titleName }));
  const menu = await screen.findByRole("menu");
  vi.useFakeTimers();
  await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy title" })));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(longTitle);
  expect(within(menu).getByRole("menuitem", { name: "Copied" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Title copied");
  const nextTitle = "Updated review title";
  rerenderTitle(nextTitle);
  expect(screen.getByRole("menu")).toBe(menu);
  expect(within(menu).getByRole("menuitem", { name: "Copy title" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("");
  expect(within(menu).getByText(nextTitle).textContent).toBe(nextTitle);
});

test.each(["missing", "rejected"])(
  "a %s clipboard selects only the title and announces the fallback",
  async (clipboard) => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: clipboard === "missing" ? undefined : { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    let selected: string | undefined;
    const execCommand = vi.fn(() => {
      selected = window.getSelection()?.toString();
      return false;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    mount({ phone: true, title: longTitle });
    const button = screen.getByRole("button", { name: titleName });
    const status = screen.getByRole("status");
    fireEvent.click(button);
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy title" }));
    await waitFor(() => expect(status.textContent).toBe("Select and copy the title"));
    expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(selected).toBe(longTitle);
    expect(window.getSelection()?.toString()).toBe(longTitle);
    const block = within(menu).getByText(titleName);
    expect(window.getSelection()?.getRangeAt(0).commonAncestorContainer).toBe(block);
    expect(within(menu).getByText("Select and copy the title").getAttribute("aria-hidden")).toBe("true");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(status.textContent).toBe("");
    fireEvent.click(button);
    expect(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Copy title" })).toBeTruthy();
    expect(status.textContent).toBe("");
  },
);

test.each(["Enter", " ", "ArrowDown"])(
  "%s opens the phone title menu; Escape returns focus to its trigger",
  async (key) => {
    mount({ phone: true, title: longTitle });
    const button = screen.getByRole("button", { name: titleName });
    act(() => button.focus());
    expect(fireEvent.keyDown(button, { key })).toBe(false);
    const menu = await screen.findByRole("menu");
    const copy = within(menu).getByRole("menuitem", { name: "Copy title" });
    await waitFor(() => expect(document.activeElement).toBe(copy));
    fireEvent.keyDown(copy, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  },
);

test("an outside tap closes the phone title menu and returns focus to its trigger", async () => {
  mount({ phone: true, title: longTitle });
  const button = screen.getByRole("button", { name: titleName });
  fireEvent.pointerDown(button, { button: 0, pointerType: "touch" });
  fireEvent.click(button, { detail: 1 });
  await screen.findByRole("menu");
  fireEvent.pointerDown(document.body, { button: 0, pointerType: "touch" });
  fireEvent.click(document.body);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(button));
});

test("a hostile title stays plain text in the phone heading and popover", async () => {
  const title = "<img src=x onerror=alert(1)><script>alert(1)</script>";
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  mount({ phone: true, title });
  const heading = screen.getByRole("heading", { level: 1, name: title });
  expect(heading.textContent).toBe(title);
  const button = within(heading).getByRole("button", { name: title });
  expect(button.textContent).toBe(title);
  expect(heading.querySelector("img,script,[onerror]")).toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.querySelector("img,[onerror]")).toBeNull();
  fireEvent.click(button);
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText(title).textContent).toBe(title);
  expect(heading.querySelector("img,script,[onerror]")).toBeNull();
  expect(menu.querySelector("img,script,[onerror]")).toBeNull();
  expect(document.querySelector("img,[onerror]")).toBeNull();
  await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy title" })));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(title);
});

test.each(["Orchard", "<img src=x onerror=alert(1)>"])(
  "header project %s is isolated text after the machine",
  (project) => {
    const { container } = mount({ metadata: { ...review, project } });
    const label = screen.getByText(project);
    expect(label.getAttribute("dir")).toBe("auto");
    expect(label.classList.contains("wrap-anywhere")).toBe(true);
    expect(label.previousElementSibling?.textContent).toBe("·");
    expect(label.previousElementSibling?.getAttribute("aria-hidden")).toBe("true");
    expect(label.previousElementSibling?.previousElementSibling).toBe(screen.getByText("Workshop"));
    expect(container.querySelector("img")).toBeNull();
  },
);

test("a null project adds no metadata or separator after the machine", () => {
  mount({ metadata: { ...review, project: null } });
  const meta = screen.getByText("Workshop").parentElement;
  expect(meta?.querySelector('[dir="auto"]')).toBeNull();
  const count = meta?.children.length;
  cleanup();
  mount({ metadata: { ...review, project: "Orchard" } });
  expect(screen.getByText("Workshop").parentElement?.children.length).toBe((count ?? 0) + 2);
});

test("links show as chips that open in a new tab, and nothing shows without links", () => {
  const { unmount } = mount();
  expect(screen.queryByRole("list", { name: "Links" })).toBeNull();
  unmount();
  mount({
    loaded: {
      ...revision,
      links: [
        { url: "https://github.com/o/r/pull/9", label: "PR 9", kind: "pr" },
        { url: "https://github.com/o/r/issues/3", label: "Issue 3", kind: "issue" },
        { url: "https://example.test/doc", label: "Design doc" },
      ],
    },
  });
  const list = screen.getByRole("list", { name: "Links" });
  const anchors = within(list).getAllByRole("link");
  expect(anchors.map((anchor) => anchor.querySelector("span")?.textContent)).toEqual(["PR 9", "Issue 3", "Design doc"]);
  for (const anchor of anchors) {
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  }
});

test("a chip shows the link's real host beside the agent's label, punycode for a lookalike", () => {
  mount({
    loaded: {
      ...revision,
      links: [
        { url: "https://github.com/o/r/pull/7", label: "PR #7", kind: "pr" },
        { url: "https://gіthub.com/o/r/pull/7", label: "PR #7", kind: "pr" },
      ],
    },
  });
  const [real, fake] = within(screen.getByRole("list", { name: "Links" })).getAllByRole("link");
  expect(real?.textContent).toContain("github.com");
  expect(real?.getAttribute("title")).toBe("https://github.com/o/r/pull/7");
  expect(fake?.textContent).toContain("xn--");
  expect(fake?.textContent).not.toContain("github.com");
  expect(fake?.getAttribute("title")).toContain("xn--");
});

test("two links that share a URL both show", () => {
  const url = "https://github.com/o/r/pull/9";
  mount({
    loaded: {
      ...revision,
      links: [
        { url, label: "PR 9", kind: "pr" },
        { url, label: "Same PR", kind: "other" },
      ],
    },
  });
  expect(
    within(screen.getByRole("list", { name: "Links" }))
      .getAllByRole("link")
      .map((anchor) => anchor.querySelector("span")?.textContent),
  ).toEqual(["PR 9", "Same PR"]);
});

test("the header drops any link that is not plain https", () => {
  mount({
    loaded: {
      ...revision,
      links: [
        { url: "javascript:alert(1)", label: "Script" },
        { url: "http://example.test/x", label: "Plain" },
        { url: "https://user:pw@example.test/x", label: "Credentials" },
        { url: "not a url", label: "Broken" },
        { url: "https://example.test/ok", label: "Fine" },
      ],
    },
  });
  expect(within(screen.getByRole("list", { name: "Links" })).getAllByRole("link")).toHaveLength(1);
  expect(screen.queryByText("Script")).toBeNull();
  expect(screen.getByText("Fine")).toBeTruthy();
});

test("header title, origin, branch, commits, doc count and focus ref use loaded metadata", () => {
  const { titleRef } = mount();
  const heading = screen.getByRole("heading", { level: 1, name: "Synthetic review" });
  expect(heading.tabIndex).toBe(-1);
  expect(titleRef.current).toBe(heading);
  expect(screen.getByText("Workshop")).toBeTruthy();
  expect(screen.getByText("topic/synthetic")).toBeTruthy();
  expect(screen.getByText("abcdef1 → 1234567")).toBeTruthy();
  expect(screen.getByText("1 doc · no code changes")).toBeTruthy();
  expect(screen.queryByText("Open")).toBeNull();
  expect(screen.getByText("Agent waiting")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Comment on review" })).toBeTruthy();
});

test.each([
  { state: "open" as const, agentWaiting: true, pendingSend: false, agent: "Agent waiting", badge: null },
  { state: "open" as const, agentWaiting: false, pendingSend: true, agent: "Not picked up yet", badge: null },
  { state: "open" as const, agentWaiting: false, pendingSend: false, agent: null, badge: null },
  { state: "approved" as const, agentWaiting: true, pendingSend: true, agent: null, badge: "Approved" },
  { state: "settled" as const, agentWaiting: false, pendingSend: false, agent: null, badge: "Retired" },
])("header state $state and agent status $agent do not duplicate approval", ({ agent, badge, ...metadata }) => {
  mount({ metadata: { ...review, ...metadata } });
  for (const label of ["Agent waiting", "Not picked up yet"])
    expect(screen.queryByText(label) !== null).toBe(label === agent);
  for (const label of ["Open", "Approved", "Retired"])
    expect(screen.queryAllByText(label)).toHaveLength(label === badge ? 1 : 0);
  expect(screen.queryByText(/Approved.*rev/i)).toBeNull();
});

test.each([false, true])("working tree commits are only shown off the phone (phone %s)", (phone) => {
  mount({ loaded: { ...revision, head: "worktree" }, phone });
  expect(screen.queryByText("abcdef1 → working tree") !== null).toBe(!phone);
});

test.each([false, true])("a timed snooze is a pill in the wrapping meta line (phone %s)", (phone) => {
  const until = new Date(Date.now() + 2 * 3600_000).toISOString();
  mount({ metadata: { ...review, snoozed: true, snoozedUntil: until }, phone });
  const label = `Snoozed until ${wakeTime(until, Date.now())}`;
  const pill = screen.getByText(label);
  expect(pill.textContent).toBe(label);
  for (const name of ["rounded-full", "bg-state-snoozed-bg", "text-state-snoozed-fg", "whitespace-nowrap", "shrink-0"])
    expect(pill.classList.contains(name)).toBe(true);
  expect(pill.querySelector("svg.lucide-bell-off")).not.toBeNull();
  expect(pill.previousElementSibling?.textContent).toBe("·");
  expect(pill.previousElementSibling?.getAttribute("aria-hidden")).toBe("true");
  expect(pill.nextElementSibling?.nextElementSibling?.textContent).toBe("Agent waiting");
  expect(pill.parentElement).toBe(screen.getByText("Workshop").parentElement);
  expect(pill.parentElement?.classList.contains("flex-wrap")).toBe(true);
});

test.each([
  { offset: null, label: "Snoozed until it changes" },
  { offset: -60_000, label: "Waking up" },
])("a snooze pill shows $label", ({ offset, label }) => {
  const snoozedUntil = offset === null ? null : new Date(Date.now() + offset).toISOString();
  mount({ metadata: { ...review, snoozed: true, snoozedUntil } });
  const pill = screen.getByText(label);
  expect(pill.textContent).toBe(label);
  for (const name of ["rounded-full", "bg-state-snoozed-bg", "text-state-snoozed-fg", "whitespace-nowrap", "shrink-0"])
    expect(pill.classList.contains(name)).toBe(true);
  expect(pill.querySelector("svg.lucide-bell-off")).not.toBeNull();
});

test("an unsnoozed review has no snooze icon or text", () => {
  const { container } = mount();
  expect(container.querySelector(".lucide-bell-off")).toBeNull();
  expect(screen.queryByText(/Snoozed|Waking up/)).toBeNull();
});

test("phone omits commit hashes", () => {
  mount({ phone: true });
  expect(screen.queryByText("abcdef1 → 1234567")).toBeNull();
  expect(screen.getByRole("button", { name: "Revision 2 of 2" })).toBeTruthy();
});

test("absent branch and null commits add no empty metadata items", () => {
  const { container } = mount({
    metadata: { ...review, branch: null },
    loaded: { ...revision, base: null, head: null },
  });
  expect(screen.queryByText(review.branch as string)).toBeNull();
  expect(container.querySelector(".lucide-git-branch")).toBeNull();
  expect(container.querySelector(".lucide-git-commit-horizontal")).toBeNull();
});

test.each([0, 1, 2])("docs-only metadata has the correct label for %s docs", (count) => {
  mount({
    loaded: {
      ...revision,
      docs: Array.from({ length: count }, (_, n) => ({ kind: "markdown" as const, path: `doc-${n}.md`, blocks: [] })),
    },
  });
  expect(screen.getByText(`${count} ${count === 1 ? "doc" : "docs"} · no code changes`)).toBeTruthy();
});

test("a revision with files does not claim no code changes", () => {
  mount({
    loaded: {
      ...revision,
      files: [
        {
          id: review.id,
          path: "file.txt",
          oldPath: null,
          role: "diff",
          status: "modified",
          topic: null,
          order: 0,
          mediaType: "text/plain",
          flag: "binary",
          hasOld: false,
          hasNew: false,
        },
      ],
    },
  });
  expect(screen.queryByText(/no code changes/)).toBeNull();
});

test("copied note preserves the original sentence", () => {
  const importedAt = "2026-03-01T12:00:00.000Z";
  mount({ metadata: { ...review, importedAt } });
  expect(
    screen.getByText(
      `Copied from Workshop on ${new Date(importedAt).toLocaleDateString()}. Comments, Sends and approvals before then were made there.`,
    ),
  ).toBeTruthy();
});

test("ready Banner reloads the newer revision without changing on its own", () => {
  const { onRevisionChange } = mount({ seq: 1, loaded: { ...revision, seq: 1 } });
  expect(screen.getByRole("status").textContent).toContain("Revision 2 is ready.");
  expect(onRevisionChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(onRevisionChange).toHaveBeenCalledExactlyOnceWith(2);
});

test.each([1, 2])(
  "revision %s picker has newest-first checked radio items, relative hints, and Latest tag",
  async (seq) => {
    const { onRevisionChange } = mount({ seq });
    const trigger = screen.getByRole("button", { name: seq === 1 ? "Revision 1, 2 is newer" : "Revision 2 of 2" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = within(await screen.findByRole("menu"));
    const items = menu.getAllByRole("menuitemradio");
    expect(items).toEqual([
      menu.getByRole("menuitemradio", { name: /^Revision 2\b/ }),
      menu.getByRole("menuitemradio", { name: /^Revision 1\b/ }),
    ]);
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(
      seq === 2 ? ["true", "false"] : ["false", "true"],
    );
    expect(within(items[0] as HTMLElement).getByText("Latest")).toBeTruthy();
    expect(within(items[1] as HTMLElement).queryByText("Latest")).toBeNull();
    for (const entry of review.revisions)
      expect(menu.getByText(relativeTime(entry.createdAt, Date.now()))).toBeTruthy();
    fireEvent.click(items[seq === 1 ? 0 : 1] as HTMLElement);
    expect(onRevisionChange).toHaveBeenCalledExactlyOnceWith(seq === 1 ? 2 : 1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  },
);

const withFiles: RevisionView = {
  ...revision,
  files: [
    {
      id: review.id,
      path: "file.txt",
      oldPath: null,
      role: "diff",
      status: "modified",
      topic: null,
      order: 0,
      mediaType: "text/plain",
      flag: "binary",
      hasOld: false,
      hasNew: false,
    },
  ],
};

test("phone newest revision: the picker shows only the numbers at the end of the title row", () => {
  mount({ phone: true });
  const picker = screen.getByRole("button", { name: "Revision 2 of 2" });
  expect(picker.textContent).toBe("2 of 2");
  expect(picker.textContent).not.toContain("Revision");
  const heading = screen.getByRole("heading", { level: 1 });
  const row = heading.parentElement as HTMLElement;
  expect(row.contains(picker)).toBe(true);
  expect(heading.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(row.classList.contains("flex-wrap")).toBe(false);
  expect(row.classList.contains("items-center")).toBe(true);
  expect(row.classList.contains("gap-3")).toBe(true);
  const metaRow = screen.getByText("topic/synthetic").parentElement as HTMLElement;
  expect(metaRow.contains(picker)).toBe(false);
});

test("phone older revision: the numbers carry the warning colour", () => {
  mount({ phone: true, seq: 1 });
  const picker = screen.getByRole("button", { name: "Revision 1, 2 is newer" });
  expect(picker.textContent).toBe("1 of 2");
  const text = screen.getByText("1 of 2");
  expect(text.classList.contains("text-warning-fg")).toBe(true);
  expect(text.classList.contains("font-semibold")).toBe(true);
});

test("phone with a long title: the heading truncates and the picker never shrinks or wraps", () => {
  mount({ phone: true, title: longTitle });
  const heading = screen.getByRole("heading", { level: 1, name: titleName });
  expect(heading.classList.contains("min-w-0")).toBe(true);
  expect(heading.querySelector("span")?.classList.contains("truncate")).toBe(true);
  const picker = screen.getByRole("button", { name: "Revision 2 of 2" });
  expect(picker.classList.contains("shrink-0")).toBe(true);
  expect(picker.classList.contains("whitespace-nowrap")).toBe(true);
});

test("phone without a branch and with files renders no meta row", () => {
  const { container } = mount({ phone: true, metadata: { ...review, branch: null }, loaded: withFiles });
  expect(container.querySelector(".font-mono.text-12")).toBeNull();
  expect(container.querySelector(".lucide-git-branch")).toBeNull();
  const header = container.firstElementChild as HTMLElement;
  expect(header.children).toHaveLength(2);
});

test("phone with a branch keeps the meta row without the picker", () => {
  mount({ phone: true, loaded: withFiles });
  const metaRow = screen.getByText("topic/synthetic").parentElement as HTMLElement;
  expect(metaRow.querySelector("button")).toBeNull();
  expect(within(metaRow).queryByText(/of 2/)).toBeNull();
});

test.each([2, 1])("off the phone the picker stays in the meta row with its full text (seq %s)", (seq) => {
  mount({ seq });
  const picker = screen.getByRole("button", { name: seq === 1 ? "Revision 1, 2 is newer" : "Revision 2 of 2" });
  expect(picker.textContent).toContain("Revision");
  expect(picker.textContent).toContain(seq === 1 ? "· 2 is newer" : "of 2");
  const metaRow = screen.getByText("topic/synthetic").parentElement as HTMLElement;
  expect(metaRow.contains(picker)).toBe(true);
  const titleRow = screen.getByRole("heading", { level: 1 }).parentElement as HTMLElement;
  expect(titleRow.contains(picker)).toBe(false);
  expect(titleRow.classList.contains("flex-wrap")).toBe(true);
  expect(titleRow.classList.contains("items-start")).toBe(true);
});

test("the phone picker opens the same newest-first menu", async () => {
  mount({ phone: true, seq: 1 });
  fireEvent.keyDown(screen.getByRole("button", { name: "Revision 1, 2 is newer" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu"));
  expect(menu.getAllByRole("menuitemradio")).toEqual([
    menu.getByRole("menuitemradio", { name: /^Revision 2\b/ }),
    menu.getByRole("menuitemradio", { name: /^Revision 1\b/ }),
  ]);
});
