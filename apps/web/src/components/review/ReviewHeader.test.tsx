import type { ReviewView, RevisionView } from "@emend/contract";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
afterEach(cleanup);
function mount({ metadata = review, loaded = revision, phone = false, seq = 2 } = {}) {
  const onRevisionChange = vi.fn();
  const titleRef = createRef<HTMLHeadingElement>();
  const result = render(
    <ReviewHeader
      review={metadata}
      revision={loaded}
      seq={seq}
      ready={metadata.newestRevision}
      phone={phone}
      titleRef={titleRef}
      onRevisionChange={onRevisionChange}
    />,
  );
  return { ...result, onRevisionChange, titleRef };
}

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
