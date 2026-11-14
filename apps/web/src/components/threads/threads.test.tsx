import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LIMITS,
  OTHER_TOPIC,
  type RevisionView,
  type Target,
  type ThreadView,
  type UnplacedReason,
} from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claimDraft } from "../../lib/composer-owner.ts";
import { plural } from "../../lib/count.ts";
import { draftKey, editDraftKey, hasDraft, loadDraft, saveDraft } from "../../lib/drafts.ts";
import { createLayoutStore, layoutKey } from "../../lib/layout-store.ts";
import { cancelThreadActionFocus, useThreadActionFocus } from "../../lib/thread-action-focus.ts";
import { OutcomeBadge } from "../status/OutcomeBadge.tsx";
import { shownThreadState, ThreadStateBadge } from "../status/ThreadStateBadge.tsx";
import { Composer } from "./Composer.tsx";
import { DraftList } from "./DraftList.tsx";
import { ThreadCard, threadPlaceLink } from "./ThreadCard.tsx";
import { ThreadList } from "./ThreadList.tsx";

const id = "11111111-1111-4111-8111-111111111111";
const target: Target = { kind: "writeup-span", blockId: "overview-12345678", quote: "Seed", prefix: "", suffix: "" };
const base: ThreadView = {
  id,
  target,
  state: "sent",
  createdOn: 1,
  placement: { status: "placed", location: { kind: "writeup-span", blockId: target.blockId, start: 0, end: 4 } },
  comments: [{ id, author: "user", body: "A synthetic comment", sent: true, sentOn: 1 }],
};
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
let width: number;
beforeEach(() => {
  width = 1280;
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  fetchMock = vi.fn(async () => Response.json({ threadId: id, commentId: id }, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(query.match(/\d+/)?.[0] ?? Infinity),
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cancelThreadActionFocus();
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function mount(children: ReactNode) {
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}
function card(thread = base) {
  return <ThreadCard reviewId={id} revision={2} thread={thread} changedBlocks={[]} />;
}

test.each(["unsent", "open", "sent", "answered", "resolved"] as const)(
  "%s cards share the head, body, footer and state pill",
  (state) => {
    const thread: ThreadView = {
      ...base,
      state: state === "unsent" ? "open" : state,
      comments:
        state === "unsent"
          ? base.comments.map((comment) => ({ ...comment, sent: false, sentOn: null }))
          : state === "answered"
            ? [...base.comments, { id: "agent", author: "agent", body: "A reply", sent: false, sentOn: null }]
            : base.comments,
    };
    mount(card(thread));
    const element = screen.getByRole("article");
    expect(element.classList.contains("em-card")).toBe(true);
    expect(element.dataset.state).toBe(state);
    for (const part of ["head", "body"]) expect(element.querySelector(`:scope > .em-card__${part}`)).toBeTruthy();
    expect(!!element.querySelector(":scope > .em-card__foot")).toBe(state !== "unsent");
    expect(element.querySelector(".em-card__head .em-card__pill")?.textContent).toBe(
      state[0]?.toUpperCase() + state.slice(1),
    );
    expect(element.querySelector(".em-card__body > .em-thread-quote")).toBeTruthy();
    expect(element.querySelector(".em-card__body > .em-thread__comments")).toBeTruthy();
  },
);

test.each([
  { pill: "New comment", prefix: "", props: {} },
  { pill: "Reply", prefix: "Reply · ", props: { threadId: id } },
  { pill: "Editing", prefix: "Edit · ", props: { commentId: id } },
])("standalone $pill composer shares the card anatomy", ({ pill, prefix, props }) => {
  mount(<Composer reviewId={id} revision={2} target={target} {...props} />);
  const form = screen.getByRole("textbox").closest("form");
  expect(form?.classList.contains("em-card")).toBe(true);
  expect(form?.dataset.state).toBe("draft");
  for (const part of ["head", "body", "foot"]) expect(form?.querySelector(`:scope > .em-card__${part}`)).toBeTruthy();
  expect(form?.querySelector(".em-card__pill")?.textContent).toBe(pill);
  expect(form?.querySelector(".em-composer__target")?.textContent).toBe(`${prefix}Writeup · Overview`);
});

test.each([
  { pill: "New comment", props: {} },
  { pill: "Reply", props: { threadId: id } },
  { pill: "Editing", props: { commentId: id } },
])("phone $pill composer keeps the anatomy inside its Sheet without a card border", ({ pill, props }) => {
  width = 390;
  mount(<Composer embedded reviewId={id} revision={2} target={target} {...props} />);
  const form = within(screen.getByRole("dialog")).getByRole("textbox").closest("form");
  expect(form?.classList.contains("em-composer--sheet")).toBe(true);
  expect(form?.classList.contains("em-card")).toBe(false);
  expect(form?.dataset.state).toBe("draft");
  for (const part of ["head", "body", "foot"]) expect(form?.querySelector(`:scope > .em-card__${part}`)).toBeTruthy();
  expect(form?.querySelector(".em-card__pill")?.textContent).toBe(pill);
});

test("a comment with server html renders it through CommentHtml; null or absent html stays plain text", () => {
  const html = '<p>Use <strong>bold</strong> and <a href="https://example.test/x" target="_blank">a link</a></p>';
  const thread: ThreadView = {
    ...base,
    comments: [
      { id, author: "user", body: "**raw** one", html, sent: true, sentOn: 1 },
      { id: "second", author: "agent", body: "**plain** two", html: null, sent: false, sentOn: null },
      { id: "third", author: "agent", body: "**plain** three", sent: false, sentOn: null },
    ],
  };
  mount(card(thread));
  const rendered = document.querySelector(".em-comment-html");
  expect(rendered?.classList.contains("em-prose")).toBe(true);
  expect(rendered?.querySelector("strong")?.textContent).toBe("bold");
  expect(rendered?.querySelector("a")?.getAttribute("target")).toBe("_blank");
  expect(screen.queryByText("**raw** one")).toBeNull();
  // The fallback shows the Markdown source as text, never as markup.
  expect(screen.getByText("**plain** two").tagName).toBe("P");
  expect(screen.getByText("**plain** three").classList.contains("em-comment__body")).toBe(true);
  expect(document.querySelectorAll(".em-comment-html")).toHaveLength(1);
});

test("an agent reply with html renders it, and the raw body still seeds an edit draft", () => {
  const thread: ThreadView = {
    ...base,
    comments: [
      {
        id,
        author: "user",
        body: "Please **fix** it",
        html: "<p>Please <strong>fix</strong> it</p>",
        sent: false,
        sentOn: null,
      },
    ],
  };
  mount(card(thread));
  expect(document.querySelector(".em-comment-html strong")?.textContent).toBe("fix");
  fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Please **fix** it");
});

test("card CSS distinguishes idle composer, hover, focus and jump, and respects reduced motion", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../../styles/threads.css"), "utf8");
  const rule = (selector: string) => css.slice(css.indexOf(`\n  ${selector}`)).split("}")[0];
  expect(rule(".em-composer {")).not.toContain("box-shadow");
  expect(rule(".em-card.em-composer {")).toContain("0 0 0 3px var(--accent-tint)");
  expect(rule(".em-card.em-composer {")).not.toContain("--accent-tint-2");
  expect(css).toMatch(
    /\.em-card:focus-within,\s*\.em-card\[data-focus-within\],\s*\.em-card\[data-jump\]\s*\{[^}]*--accent-tint-2/,
  );
  expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*?transition: none/);
  expect(rule(".em-card__foot {")).toContain("justify-content: flex-end");
  expect(rule(".em-card__foot {")).toContain("padding: 6px 8px 8px 12px");
  expect(rule(".em-card::before {")).toContain("width: 3px");
  expect(rule('.em-card[data-state="sent"] {')).toContain("--thread-sent");
  expect(rule('.em-card[data-state="answered"] {')).toContain("--thread-answered");
  expect(css).not.toContain('.em-card[data-state="resolved"]');
});

test.each(["composer", "thread"])(
  "%s card focus events work without highlights and preserve internal transfers",
  (kind) => {
    vi.stubGlobal("CSS", {});
    mount(
      <>
        <button type="button">Outside</button>
        {kind === "composer" ? <Composer reviewId={id} revision={2} target={target} /> : card()}
      </>,
    );
    const first = kind === "composer" ? screen.getByRole("textbox") : screen.getByRole("button", { name: "Reply" });
    if (kind === "composer") fireEvent.change(first, { target: { value: "A focused draft" } });
    const second = screen.getByRole("button", { name: kind === "composer" ? "Save comment" : "Resolve" });
    const element = first.closest(".em-card");
    if (!element) throw new Error("Missing card");
    expect(element.hasAttribute("data-focus-within")).toBe(false);
    act(() => first.focus());
    expect(element.hasAttribute("data-focus-within")).toBe(true);
    const changes = new MutationObserver(() => {});
    changes.observe(element, { attributes: true, attributeFilter: ["data-focus-within"] });
    try {
      fireEvent.focusOut(first, { relatedTarget: second });
      expect(element.hasAttribute("data-focus-within")).toBe(true);
      act(() => second.focus());
      expect(element.hasAttribute("data-focus-within")).toBe(true);
      expect(changes.takeRecords()).toEqual([]);
      const outside = screen.getByRole("button", { name: "Outside" });
      // During focusout activeElement can still be the departing control.
      fireEvent.focusOut(second, { relatedTarget: outside });
      expect(element.hasAttribute("data-focus-within")).toBe(false);
      act(() => outside.focus());
      expect(element.hasAttribute("data-focus-within")).toBe(false);
      act(() => first.focus());
      fireEvent.focusOut(first, { relatedTarget: null });
      expect(element.hasAttribute("data-focus-within")).toBe(false);
    } finally {
      changes.disconnect();
    }
  },
);

test("draft targets use the shared path styling", () => {
  saveDraft(draftKey(id, target), "A draft");
  mount(<DraftList reviewId={id} onResume={() => {}} />);
  const label = screen.getByText("Writeup · Overview").parentElement;
  expect(label?.classList.contains("em-card__target")).toBe(true);
  expect(label?.classList.contains("em-thread__target")).toBe(false);
  expect(label?.querySelector("svg")).toBeTruthy();
});

test("an unsent thread has no empty footer but retains a resumed reply editor", () => {
  mount(card({ ...base, comments: base.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) }));
  const element = screen.getByRole("article");
  expect(element.querySelector(":scope > footer")).toBeNull();
  act(() => claimDraft(draftKey(id, target, id), "reading"));
  const foot = element.querySelector(":scope > .em-card__foot");
  expect(foot?.contains(screen.getByRole("textbox", { name: "Reply" }))).toBe(true);
  expect(foot?.querySelector(":scope > .em-card__foot")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(element.querySelector(":scope > footer")).toBeNull();
});

test("collapsed resolved cards keep their flat shadow and surface head", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../../styles/threads.css"), "utf8");
  expect(css).toMatch(/\.em-thread\[data-collapsed\]\s*\{\s*box-shadow: none;/);
  expect(css).toMatch(/\.em-thread\[data-collapsed\] \.em-thread__head\s*\{[^}]*background: var\(--bg-surface\)/);
});

test("only hover-capable pointers get the card hover glow", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../../styles/threads.css"), "utf8");
  const hover = css.match(/@media \(hover: hover\)\s*\{\s*\.em-card:hover\s*\{[^}]*\}\s*\}/)?.[0];
  expect(hover).toContain("0 0 0 3px var(--accent-tint)");
  expect(css.replace(hover ?? "", "")).not.toContain(".em-card:hover");
});

test.each(["new", "reply", "edit", "phone"])("textarea focus ring is suppressed only inside a card (%s)", (mode) => {
  const css = readFileSync(resolve(import.meta.dirname, "../../styles/threads.css"), "utf8");
  const baseCss = readFileSync(resolve(import.meta.dirname, "../../styles/base.css"), "utf8");
  const selector = ".em-card .em-composer__input";
  expect(css).toMatch(/\.em-card \.em-composer__input:focus-visible\s*\{\s*box-shadow: none;\s*\}/);
  expect(baseCss).toMatch(/:focus-visible\s*\{[^}]*box-shadow: var\(--focus-ring\)/);
  if (mode === "reply") {
    mount(card());
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  } else if (mode === "edit") {
    mount(card({ ...base, comments: base.comments.map((comment) => ({ ...comment, sent: false })) }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  } else {
    if (mode === "phone") width = 390;
    mount(<Composer reviewId={id} revision={2} target={target} />);
  }
  expect(screen.getByRole("textbox").matches(selector)).toBe(mode !== "phone");
  expect(
    screen.getByRole("button", { name: mode === "edit" ? "Save changes" : "Save comment" }).matches(selector),
  ).toBe(false);
  if (mode === "phone") expect(within(screen.getByRole("dialog")).getByRole("textbox")).toBeTruthy();
});

test("router hash replacement transfers the persistent jump marker between card surfaces", async () => {
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        {card()}
        <ThreadCard reviewId={id} revision={2} thread={base} changedBlocks={[]} surface="diff" />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [`/#thread-${id}`] }),
  });
  const view = render(<RouterProvider router={router} />);
  await waitFor(() => expect(view.container.querySelector("[data-jump]")?.id).toBe(`thread-${id}`));
  const reading = document.getElementById(`thread-${id}`);
  fireEvent.pointerLeave(reading as HTMLElement);
  expect(reading?.hasAttribute("data-jump")).toBe(true);
  await act(() => router.navigate({ hash: `diff-thread-${id}`, replace: true }));
  expect(reading?.hasAttribute("data-jump")).toBe(false);
  expect(view.container.querySelector("[data-jump]")?.id).toBe(`diff-thread-${id}`);
  await act(() => router.navigate({ hash: "", replace: true }));
  expect(view.container.querySelector("[data-jump]")).toBeNull();
});

test.each(["unsent", "open", "sent", "answered", "resolved"] as const)("thread badge labels %s", (state) => {
  const { container } = render(<ThreadStateBadge state={state} />);
  expect(screen.getByText(state[0]?.toUpperCase() + state.slice(1))).toBeTruthy();
  expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
});
test.each(["fixed", "explained", "held", "declined"] as const)("outcome badge labels %s", (outcome) => {
  render(<OutcomeBadge outcome={outcome} />);
  expect(screen.getByText(outcome[0]?.toUpperCase() + outcome.slice(1))).toBeTruthy();
});
test.each(["open", "sent", "answered", "resolved"] as const)(
  "shown state derives unsent over %s only for user comments",
  (state) => {
    const thread: ThreadView = {
      ...base,
      state,
      comments: [
        ...base.comments,
        { id: "agent", author: "agent", body: "Explained", sent: false, sentOn: null, outcome: "explained" },
      ],
    };
    expect(shownThreadState(thread)).toBe(state);
    thread.comments.push({ id: "unsent", author: "user", body: "Follow-up", sent: false, sentOn: null });
    expect(shownThreadState(thread)).toBe("unsent");
  },
);
test("never-sent comments have Edit and Delete, with no reply or resolution actions", () => {
  mount(
    card({
      ...base,
      state: "open",
      comments: base.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })),
    }),
  );
  expect(screen.getByText("Unsent")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
});
test("Reply focuses one editor; Cancel keeps its draft under Unsaved comments; a fresh claim reopens it", async () => {
  mount(
    <>
      {card()}
      <DraftList reviewId={id} onResume={(draft) => claimDraft(draft.key, "reading")} />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const input = screen.getByRole("textbox", { name: "Reply" });
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  expect(input.closest("form")?.querySelector(".em-card__head")).toBeNull();
  expect(input.closest("form")?.classList.contains("em-card")).toBe(false);
  expect(input.closest(".em-card")).toBe(screen.getByRole("article"));
  expect(screen.getByRole("article").querySelector(".em-card")).toBeNull();
  expect(screen.getByRole("article").querySelector(":scope > .em-card__foot")?.contains(input)).toBe(true);
  fireEvent.change(input, { target: { value: "Follow-up draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(within(screen.getByRole("region", { name: "Unsaved comments" })).getByText("Follow-up draft")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Reply" })));
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(hasDraft(draftKey(id, target, id))).toBe(false);
});
test("a reply draft opens on mount and a claim can arrive before the card mounts", async () => {
  const key = draftKey(id, target, id);
  saveDraft(key, "Saved locally");
  const view = mount(card());
  expect((screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement).value).toBe("Saved locally");
  view.unmount();
  act(() => claimDraft(key, "reading"));
  mount(card());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Reply" })));
});
test("resolved cards expose only Reopen and the Comments copy starts collapsed", () => {
  mount(
    <ThreadCard
      reviewId={id}
      revision={2}
      thread={{ ...base, state: "resolved" }}
      changedBlocks={[]}
      surface="comments"
    />,
  );
  expect(screen.queryByText("A synthetic comment")).toBeNull();
  expect(screen.getByText("Seed").closest(".em-thread-quote")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
  expect(screen.getByRole("button", { name: "Expand thread" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Expand thread" }));
  expect(screen.getByText("A synthetic comment")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Collapse thread" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
});
const reasons: [UnplacedReason, string][] = [
  ["block-gone", "The block this comment was on is gone."],
  ["ambiguous", "The quoted text now appears more than once."],
  ["topic-gone", "The topic this comment was on is gone."],
  ["file-gone", "The file this comment was on is no longer in the diff."],
  ["lines-gone", "The lines this comment was on are gone."],
  ["not-placed", "This comment has no place in this revision."],
];
test.each(reasons)("unplaced %s explains its reason and links only across revisions", (reason, sentence) => {
  const thread: ThreadView = { ...base, placement: { status: "unplaced", reason } };
  const view = mount(card(thread));
  expect(
    screen.getByText(
      (_, element) => element?.tagName === "SPAN" && element.textContent === `${sentence} Made on revision 1.`,
    ),
  ).toBeTruthy();
  const href = screen.getByRole("link", { name: "revision 1" }).getAttribute("href");
  expect(href).toBe(`/r/${id}?rev=1&tab=comments&thread=${id}#thread-${id}`);
  view.unmount();
  mount(<ThreadCard reviewId={id} revision={1} thread={thread} changedBlocks={[]} />);
  expect(screen.getByText(sentence)).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});
test("Comments groups follow place order, retain state badges, hide empties and keep drafts first", () => {
  const threads: ThreadView[] = (["resolved", "open", "answered", "sent"] as const).map((state, index) => ({
    ...base,
    id: `thread-${index}`,
    state,
  }));
  threads.push({ ...base, id: "unsent", comments: base.comments.map((comment) => ({ ...comment, sent: false })) });
  threads.push({ ...base, id: "unplaced", state: "resolved", placement: { status: "unplaced", reason: "block-gone" } });
  threads.push({ ...base, id: "review", placement: { status: "placed", location: { kind: "review" } } });
  threads.push({
    ...base,
    id: "topic",
    placement: { status: "placed", location: { kind: "topic", slug: "garden", part: "title", start: 0, end: 4 } },
  });
  threads.push({
    ...base,
    id: "doc",
    placement: {
      status: "placed",
      location: { kind: "doc-span", path: "garden.md", blockId: "doc-11111111-11111111", start: 0, end: 4 },
    },
  });
  threads.push({ ...base, id: "file", placement: { status: "placed", location: { kind: "file", path: "garden.ts" } } });
  const writeup: RevisionView["writeup"] = {
    sections: [
      { key: "overview", topic: null, label: "Overview", blocks: [] },
      { key: "t-garden-body", topic: "garden", label: "Garden", blocks: [] },
    ],
  };
  saveDraft(draftKey(id, { kind: "review" }), "Review draft");
  const view = mount(
    <ThreadList
      reviewId={id}
      revision={2}
      threads={threads}
      changedBlocks={[]}
      writeup={writeup}
      topics={[{ slug: "garden", title: "Garden", importance: 1, summary: "" }]}
      search={{ rev: 2, tab: "comments" }}
      onResume={() => {}}
    />,
  );
  expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual([
    "Unsaved comments1",
    "Whole review1",
    "Writeup · Overview5",
    "Topic 01 · Garden1",
    "garden.md1",
    "garden.ts1",
    "Unplaced1",
  ]);
  const overview = within(screen.getByRole("region", { name: "Writeup · Overview" }));
  for (const state of ["Resolved", "Open", "Answered", "Sent", "Unsent"])
    expect(overview.getByText(state)).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Topic 01 · Garden" }))
      .getByRole("link", { name: "Show in place" })
      .getAttribute("href"),
  ).toBe(`/r/${id}?rev=2&tab=writeup#thread-topic`);
  view.unmount();
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  mount(<ThreadList reviewId={id} revision={2} threads={[]} changedBlocks={[]} onResume={() => {}} />);
  expect(screen.queryByRole("heading")).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Hide resolved" })).toBeNull();
  expect(screen.getByText("No comments yet.")).toBeTruthy();
  expect(screen.queryByText("Select text to comment.")).toBeNull();
  expect(screen.getByText("Select text in the writeup or a doc, or click a line in the diff.")).toBeTruthy();
});
test("Hide resolved persists and keeps unsent and directly linked resolved threads visible", () => {
  const threads: ThreadView[] = [
    { ...base, id: "hidden", state: "resolved" },
    { ...base, id: "hidden-unplaced", state: "resolved", placement: { status: "unplaced", reason: "block-gone" } },
    { ...base, id: "linked", state: "resolved" },
    {
      ...base,
      id: "unsent",
      state: "resolved",
      comments: base.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })),
    },
    { ...base, id: "open" },
  ];
  const list = (
    <ThreadList
      reviewId={id}
      revision={2}
      threads={threads}
      changedBlocks={[]}
      search={{ thread: "linked" }}
      onResume={() => {}}
    />
  );
  const view = mount(list);
  expect(screen.getAllByRole("article")).toHaveLength(5);
  expect(screen.queryByText(/hidden$/)).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Hide resolved" }));
  expect(screen.getAllByRole("article").map((card) => card.id)).toEqual([
    "thread-linked",
    "thread-unsent",
    "thread-open",
  ]);
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Writeup · Overview3");
  expect(screen.queryByRole("region", { name: "Unplaced" })).toBeNull();
  expect(screen.getByText("2 hidden")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(layoutKey) ?? "{}").hideResolved).toBe(true);
  expect(createLayoutStore().getSnapshot().hideResolved).toBe(true);
  view.unmount();
  mount(list);
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Hide resolved" }).checked).toBe(true);
  expect(screen.getAllByRole("article")).toHaveLength(3);
  fireEvent.click(screen.getByRole("checkbox", { name: "Hide resolved" }));
  expect(screen.getAllByRole("article")).toHaveLength(5);
  expect(screen.queryByText("2 hidden")).toBeNull();
});
test("hiding every thread keeps the toolbar and distinguishes resolved threads from an empty review", () => {
  mount(
    <ThreadList
      reviewId={id}
      revision={2}
      threads={[{ ...base, state: "resolved" }]}
      changedBlocks={[]}
      onResume={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Hide resolved" }));
  expect(screen.getByText("Every thread is resolved.")).toBeTruthy();
  expect(screen.getByText("1 hidden")).toBeTruthy();
  expect(screen.queryByText("No comments yet.")).toBeNull();
  expect(screen.queryByRole("heading")).toBeNull();
  expect(screen.queryByRole("article")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Hide resolved" }));
  expect(screen.queryByText("Every thread is resolved.")).toBeNull();
  expect(screen.getByRole("article")).toBeTruthy();
});

test.each(["lines", "source-lines"] as const)(
  "%s code quotes show three lines only on the Comments surface, including collapsed cards",
  (kind) => {
    const target: Target = {
      kind,
      side: "new",
      path: "garden.ts",
      start: 1,
      end: 5,
      lines: ["one", "  two", "three", "four", "five"],
      before: [],
      after: [],
    };
    const thread = { ...base, target };
    const { container } = mount(
      <>
        <ThreadCard reviewId={id} revision={2} thread={thread} changedBlocks={[]} surface="comments" />
        <ThreadCard reviewId={id} revision={2} thread={thread} changedBlocks={[]} surface="reading" />
        <ThreadCard reviewId={id} revision={2} thread={thread} changedBlocks={[]} surface="diff" />
        <ThreadCard
          reviewId={id}
          revision={2}
          thread={{ ...thread, id: "resolved-code", state: "resolved" }}
          changedBlocks={[]}
          surface="comments"
        />
      </>,
    );
    const quotes = container.querySelectorAll("pre.em-thread-quote--code");
    expect(quotes).toHaveLength(2);
    for (const quote of quotes) expect(quote.textContent).toBe("one\n  two\nthree\n… 2 more lines");
    const collapsed = container.querySelector("[data-collapsed]");
    expect(collapsed?.querySelector(".em-thread-quote")).toBeTruthy();
    expect(collapsed?.querySelector(".em-thread__comments, .em-card__foot")).toBeNull();
    expect(container.querySelectorAll("[data-thread-card]:not([data-collapsed]) .em-thread-quote")).toHaveLength(1);
  },
);
test.each(
  [
    ["<script>evil()</script>", '<img src=x onerror="evil()">', '<a href="javascript:evil()">link</a>'],
    ["<b>raw HTML</b>", '<svg onload="evil()"></svg>', 'graph TD; A-->B; click A "javascript:evil()"'],
  ].flatMap((lines) => (["lines", "source-lines"] as const).map((kind) => ({ kind, lines }))),
)("hostile $kind quotes render only React text: $lines", ({ kind, lines }) => {
  const target: Target = { kind, side: "new", path: "garden.ts", start: 1, end: 3, lines, before: [], after: [] };
  const { container } = mount(
    <ThreadCard reviewId={id} revision={2} thread={{ ...base, target }} changedBlocks={[]} surface="comments" />,
  );
  expect(container.querySelector("pre")?.textContent).toBe(lines.join("\n"));
  const quote = container.querySelector("pre");
  expect(quote?.querySelector("*")).toBeNull();
  expect(container.querySelector('script, img, [onerror], [onload], [href^="javascript:"]')).toBeNull();
});

test.each([false, true])(
  "topic jumps use written cards and preserve the existing links for unwritten topics (phone=%s)",
  (phone) => {
    const written = new Set(["garden"]);
    const search = { rev: 2, tab: "comments" as const };
    for (const part of ["title", "summary", undefined] as const) {
      for (const slug of ["garden", "soil", OTHER_TOPIC.slug, "missing"]) {
        const thread: ThreadView = {
          ...base,
          placement: {
            status: "placed",
            location: { kind: "topic", slug, ...(part ? { part, start: 0, end: 4 } : {}) },
          },
        };
        const href = threadPlaceLink(id, thread, search, phone, written);
        if (slug === "garden") expect(href).toBe(`/r/${id}?rev=2&tab=writeup#thread-${id}`);
        else expect(href).toBe(`/r/${id}?rev=2&tab=${phone ? "diff" : "comments"}#diff-thread-${id}`);
        expect(threadPlaceLink(id, thread, search, phone)).toBe(
          `/r/${id}?rev=2&tab=${phone ? "diff" : "comments"}#diff-thread-${id}`,
        );
      }
    }
  },
);
test.each([false, true].flatMap((phone) => (["title", undefined] as const).map((part) => ({ phone, part }))))(
  "only ranked written topics link to writeup cards (phone=$phone, part=$part)",
  ({ phone, part }) => {
    const slugs = [OTHER_TOPIC.slug, "missing", "garden"];
    const threads: ThreadView[] = slugs.map((slug) => ({
      ...base,
      id: slug,
      target: { kind: "topic", slug, ...(part ? { part, quote: "Seed", prefix: "", suffix: "" } : {}) },
      placement: { status: "placed", location: { kind: "topic", slug, ...(part ? { part, start: 0, end: 4 } : {}) } },
    }));
    const { container } = mount(
      <ThreadList
        reviewId={id}
        revision={2}
        threads={threads}
        changedBlocks={[]}
        topics={[
          { ...OTHER_TOPIC, importance: 3, summary: "" },
          { slug: "garden", title: "Garden", importance: 1, summary: "" },
        ]}
        writeup={{ sections: slugs.map((slug) => ({ key: `t-${slug}-body`, label: slug, topic: slug, blocks: [] })) }}
        search={{ rev: 2, tab: "comments" }}
        phone={phone}
        onResume={() => {}}
      />,
    );
    for (const slug of slugs) {
      const card = container.querySelector(`[id="thread-${slug}"]`);
      expect(card).toBeTruthy();
      const href = within(card as HTMLElement)
        .getByRole("link", { name: "Show in place" })
        .getAttribute("href");
      expect(href).toBe(
        slug === "garden"
          ? `/r/${id}?rev=2&tab=writeup#thread-${slug}`
          : `/r/${id}?rev=2&tab=${phone ? "diff" : "comments"}#diff-thread-${slug}`,
      );
    }
  },
);

test("Comments group headings and collapsed span quotes render hostile input verbatim as text", () => {
  const docPath = "<img src=x onerror=alert(1)>.md";
  const filePath = "<script>alert(1)</script>.ts";
  const title = 'javascript:alert(1) <a href="javascript:alert(1)">link</a>';
  const quote = "<script>alert(1)</script><img src=x onerror=alert(1)><iframe onload=alert(1)></iframe>";
  const threads: ThreadView[] = [
    {
      ...base,
      id: "doc",
      target: {
        kind: "doc-span",
        path: docPath,
        blockId: "doc-11111111-11111111",
        quote: "Seed",
        prefix: "",
        suffix: "",
      },
      placement: {
        status: "placed",
        location: { kind: "doc-span", path: docPath, blockId: "doc-11111111-11111111", start: 0, end: 4 },
      },
    },
    {
      ...base,
      id: "file",
      target: { kind: "file", path: filePath },
      placement: { status: "placed", location: { kind: "file", path: filePath } },
    },
    {
      ...base,
      id: "topic",
      target: { kind: "topic", slug: "garden" },
      placement: { status: "placed", location: { kind: "topic", slug: "garden" } },
    },
    { ...base, id: "collapsed", state: "resolved", target: { ...target, quote } },
  ];
  const { container } = mount(
    <ThreadList
      reviewId={id}
      revision={2}
      threads={threads}
      changedBlocks={[]}
      topics={[{ slug: "garden", title, importance: 1, summary: "" }]}
      onResume={() => {}}
    />,
  );
  for (const label of [docPath, filePath, `Topic 01 · ${title}`]) {
    const group = within(screen.getByRole("region", { name: label }));
    expect(group.getByRole("heading", { level: 2 }).textContent).toBe(`${label}1`);
  }
  const collapsed = container.querySelector("#thread-collapsed[data-collapsed]");
  expect(collapsed?.querySelector(".em-thread-quote")?.textContent).toBe(quote);
  expect(collapsed?.querySelector(".em-thread__comments, .em-card__foot")).toBeNull();
  expect(container.querySelector('script, img, iframe, [onerror], [onload], a[href^="javascript:"]')).toBeNull();
});

test.each([{ metaKey: true }, { ctrlKey: true }])(
  "composer saves with %j Enter, ignoring IME and ordinary Enter",
  async (modifier) => {
    const cancel = vi.fn();
    mount(<Composer reviewId={id} revision={2} target={target} onCancel={cancel} />);
    const input = screen.getByRole("textbox", { name: "Comment" });
    expect((screen.getByRole("button", { name: "Save comment" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Please explain" } });
    fireEvent.keyDown(input, { key: "Enter", ...modifier, isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", ...modifier, keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", ...modifier });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(loadDraft(draftKey(id, target))).toBe(""));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(cancel).toHaveBeenCalledOnce();
  },
);
test("editing uses a bare editor and save label, and Cancel discards the edit", () => {
  mount(card({ ...base, comments: base.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const input = screen.getByRole("textbox", { name: "Edit comment" });
  expect(input.getAttribute("placeholder")).toBeNull();
  expect(input.closest("form")?.querySelector(".em-card__head")).toBeNull();
  expect(input.closest("form")?.classList.contains("em-card")).toBe(false);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  fireEvent.change(input, { target: { value: "An edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(hasDraft(editDraftKey(id, id))).toBe(false);
  expect(screen.queryByRole("textbox")).toBeNull();
});
test.each([
  { phone: false, action: "Escape" },
  { phone: true, action: "Escape" },
  { phone: true, action: "Close" },
  { phone: true, action: "outside" },
])("dismissing an edit with $action preserves its draft (phone $phone)", async ({ phone, action }) => {
  width = phone ? 390 : 1280;
  mount(card({ ...base, comments: base.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const input = screen.getByRole("textbox", { name: "Edit comment" });
  fireEvent.change(input, { target: { value: "Keep this edited text" } });
  if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
  else if (action === "Close") fireEvent.click(screen.getByRole("button", { name: "Close" }));
  else {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const overlay = document.querySelector(".bg-overlay");
    if (!overlay) throw new Error("Missing sheet overlay");
    fireEvent.pointerDown(overlay, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(overlay, { button: 0, pointerType: "mouse" });
    fireEvent.click(overlay);
  }
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(loadDraft(editDraftKey(id, id))).toBe("Keep this edited text");
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" }).value).toBe(
    "Keep this edited text",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(hasDraft(editDraftKey(id, id))).toBe(false);
});
test.each([
  { phone: false, action: "Escape" },
  { phone: true, action: "Escape" },
  { phone: true, action: "Close" },
  { phone: true, action: "outside" },
])("fix1 dismissing an unchanged edit with $action leaves no draft (phone $phone)", async ({ phone, action }) => {
  width = phone ? 390 : 1280;
  mount(card({ ...base, comments: base.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const input = screen.getByRole("textbox", { name: "Edit comment" });
  expect(hasDraft(editDraftKey(id, id))).toBe(true);
  if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
  else if (action === "Close") fireEvent.click(screen.getByRole("button", { name: "Close" }));
  else {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const overlay = document.querySelector(".bg-overlay");
    if (!overlay) throw new Error("Missing sheet overlay");
    fireEvent.pointerDown(overlay, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(overlay, { button: 0, pointerType: "mouse" });
    fireEvent.click(overlay);
  }
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(hasDraft(editDraftKey(id, id))).toBe(false);
  expect(localStorage.getItem(editDraftKey(id, id))).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
test("fix1 dismissal compares an edit with the comment's current body", () => {
  const unsent = { ...base, comments: base.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) };
  const view = mount(card(unsent));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const input = screen.getByRole("textbox", { name: "Edit comment" });
  fireEvent.change(input, { target: { value: "Updated body" } });
  view.rerender(
    <QueryClientProvider client={client}>
      {card({ ...unsent, comments: unsent.comments.map((comment) => ({ ...comment, body: "Updated body" })) })}
    </QueryClientProvider>,
  );
  fireEvent.keyDown(input, { key: "Escape" });
  expect(hasDraft(editDraftKey(id, id))).toBe(false);
});
test("Delete requires the dialog's danger action; Cancel and Escape do not delete", async () => {
  mount(card({ ...base, comments: base.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) }));
  for (const dismiss of ["Cancel", "Escape"]) {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete this comment?" });
    expect(within(dialog).getByText("It has not been sent yet. This cannot be undone.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    if (dismiss === "Cancel") fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    else fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  }
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const confirm = within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" });
  expect(confirm.className).toContain("text-danger-fg");
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/comments/${id}`,
      expect.objectContaining({ method: "DELETE" }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});
test("dismissing an edit closes both copies and an explicit claim resumes its text", async () => {
  const unsent = { ...base, comments: base.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) };
  mount(
    <>
      <section aria-label="Reading copy">{card(unsent)}</section>
      <section aria-label="Comments copy">
        <ThreadCard reviewId={id} revision={2} thread={unsent} changedBlocks={[]} surface="comments" />
      </section>
    </>,
  );
  const reading = within(screen.getByRole("region", { name: "Reading copy" }));
  fireEvent.click(reading.getByRole("button", { name: "Edit" }));
  const input = screen.getByRole("textbox", { name: "Edit comment" });
  fireEvent.change(input, { target: { value: "Shared unsaved edit" } });
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(loadDraft(editDraftKey(id, id))).toBe("Shared unsaved edit");
  act(() => claimDraft(editDraftKey(id, id), "comments"));
  const resumed = within(screen.getByRole("region", { name: "Comments copy" })).getByRole<HTMLTextAreaElement>(
    "textbox",
    { name: "Edit comment" },
  );
  expect(resumed.value).toBe("Shared unsaved edit");
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
});
function PhoneComposer() {
  const [open, setOpen] = useState(true);
  return open && <Composer reviewId={id} revision={2} target={target} onCancel={() => setOpen(false)} />;
}
test.each(["Close", "Cancel", "Escape", "overlay"])(
  "phone opens a focused New comment sheet; %s keeps the draft",
  async (action) => {
    width = 390;
    const { container } = mount(<PhoneComposer />);
    const dialog = await screen.findByRole("dialog", { name: "New comment" });
    const input = within(dialog).getByRole("textbox", { name: "Comment" });
    expect(container.contains(dialog)).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(dialog.querySelector("kbd")).toBeNull();
    fireEvent.change(input, { target: { value: "Keep this phone draft" } });
    if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
    else if (action === "overlay") {
      // Radix installs its outside pointer listener after the opening event.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      const overlay = document.querySelector(".bg-overlay");
      if (!overlay) throw new Error("Missing sheet overlay");
      fireEvent.pointerDown(overlay, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(overlay, { button: 0, pointerType: "mouse" });
      fireEvent.click(overlay);
    } else fireEvent.click(within(dialog).getByRole("button", { name: action }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loadDraft(draftKey(id, target))).toBe("Keep this phone draft");
  },
);
test.each(["MacIntel", "Linux x86_64"])("desktop keyboard hint follows %s", (platform) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  mount(<Composer reviewId={id} revision={2} target={target} />);
  expect(screen.getByText(platform === "MacIntel" ? "⌘↵" : "Ctrl ↵")).toBeTruthy();
});
test("comment limits clip without splitting a surrogate pair and mutation errors preserve text", async () => {
  fetchMock.mockResolvedValue(Response.json({ error: { code: "stale_revision", message: "stale" } }, { status: 409 }));
  mount(<Composer reviewId={id} revision={2} target={target} />);
  const input = screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: `${"a".repeat(LIMITS.commentBodyChars - 1)}🌱` } });
  expect(input.value.isWellFormed()).toBe(true);
  expect(input.value.length).toBeLessThanOrEqual(LIMITS.commentBodyChars);
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "This page is out of date. Reload to see the newest revision.",
  );
  expect(loadDraft(draftKey(id, target))).toBe(input.value);
});
test.each([
  "<script>evil()</script>",
  '<img src=x onerror="evil()">',
  "[link](javascript:evil())",
  "<b>raw HTML</b>",
  '<svg onload="evil()"></svg>',
  'graph TD; A-->B; click A "javascript:evil()"',
])("hostile comment, quote and path remain text: %s", (hostile) => {
  const target: Target = {
    kind: "doc-span",
    blockId: "doc-12345678-12345678",
    quote: hostile,
    prefix: "",
    suffix: "",
    path: hostile,
  };
  const thread: ThreadView = {
    ...base,
    target,
    comments: [{ id, author: "user", sent: false, sentOn: null, body: hostile }],
  };
  const { container } = mount(
    <>
      {card(thread)}
      <Composer reviewId={id} revision={2} target={target} />
    </>,
  );
  expect(screen.getAllByText(hostile).length).toBeGreaterThanOrEqual(4);
  expect(container.querySelector('script, img, [onerror], [onload], a[href^="javascript:"], iframe')).toBeNull();
});
test("Show in place uses placement, preserves revision and encodes doc paths", () => {
  const path = "docs/a b#c.md";
  for (const kind of ["doc-span", "html-span"] as const) {
    const thread: ThreadView = {
      ...base,
      placement: { status: "placed", location: { kind, path, blockId: "doc-12345678-12345678", start: 0, end: 4 } },
    };
    const url = new URL(threadPlaceLink(id, thread, { rev: 2, tab: "comments" }, false) ?? "", "http://localhost");
    expect(url.searchParams.get("doc")).toBe(path);
    expect(url.searchParams.get("tab")).toBe("docs");
    expect(url.searchParams.get("rev")).toBe("2");
    expect(url.searchParams.get("thread")).toBe(kind === "html-span" ? id : null);
    expect(url.hash).toBe(`#thread-${id}`);
  }
  expect(
    threadPlaceLink(id, { ...base, placement: { status: "placed", location: { kind: "review" } } }, {}, false),
  ).toBeUndefined();
});
test("singular counts include nouns and irregular verb agreement", () => {
  for (const noun of ["comment", "line", "doc", "file", "machine", "open thread"]) {
    expect(`${1} ${plural(1, noun)}`).toBe(`1 ${noun}`);
    expect(`${0} ${plural(0, noun)}`).toBe(`0 ${noun}s`);
    expect(`${2} ${plural(2, noun)}`).toBe(`2 ${noun}s`);
  }
  expect(plural(1, "needs", "need")).toBe("needs");
  expect(plural(2, "needs", "need")).toBe("need");
});

test.each(["Cancel", "Escape"].flatMap((action) => ["", " \n "].map((body) => ({ action, body }))))(
  "fix1 blank reply $action with $body removes its key and stays closed on remount",
  ({ action, body }) => {
    const view = mount(card());
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const input = screen.getByRole("textbox", { name: "Reply" });
    if (body) fireEvent.change(input, { target: { value: body } });
    if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
    else fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hasDraft(draftKey(id, target, id))).toBe(false);
    view.unmount();
    mount(card());
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
  },
);
test("fix1 a persisted blank reply does not open on mount", () => {
  saveDraft(draftKey(id, target, id), " \n ");
  mount(card());
  expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
});
test("fix2 an open blank reply is released after a commit with no card", async () => {
  const view = mount(card());
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Reply" }));
  view.unmount();
  await act(async () => {});
  mount(card());
  expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
});
test.each(["Cancel", "Escape"])("fix1 a blank new composer clears its draft on %s", (action) => {
  mount(<Composer reviewId={id} revision={2} target={target} onCancel={() => {}} />);
  const input = screen.getByRole("textbox", { name: "Comment" });
  fireEvent.change(input, { target: { value: " \n " } });
  if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
  else fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(hasDraft(draftKey(id, target))).toBe(false);
});
test("fix1 phone Escape calls Cancel exactly once", () => {
  width = 390;
  const cancel = vi.fn();
  mount(<Composer reviewId={id} revision={2} target={target} onCancel={cancel} />);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment" }), { key: "Escape" });
  expect(cancel).toHaveBeenCalledTimes(1);
});
test("fix1 Escape without Cancel passes through untouched", () => {
  const keydown = vi.fn();
  const { container } = mount(<Composer reviewId={id} revision={2} target={target} />);
  container.addEventListener("keydown", keydown);
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  fireEvent(screen.getByRole("textbox", { name: "Comment" }), event);
  expect(event.defaultPrevented).toBe(false);
  expect(keydown).toHaveBeenCalledOnce();
});
test.each(["Cancel", "Save comment"])("fix1 %s closes a resumed reply in every mounted copy", async (action) => {
  const view = mount(<ThreadCard reviewId={id} revision={2} thread={base} changedBlocks={[]} surface="diff" />);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), { target: { value: "Shared reply" } });
  mount(
    <>
      <ThreadCard reviewId={id} revision={2} thread={base} changedBlocks={[]} surface="comments" />
      <DraftList reviewId={id} onResume={(draft) => claimDraft(draft.key, "comments")} />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(view.container.querySelector("textarea")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: action }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull());
  expect(document.querySelectorAll("[data-composer-placeholder]")).toHaveLength(0);
  expect(screen.getAllByRole("button", { name: "Reply" })).toHaveLength(2);
  expect(loadDraft(draftKey(id, target, id))).toBe(action === "Cancel" ? "Shared reply" : "");
});
test.each([false, true])("fix1 resolved card expands for its edit draft or pending claim (claim=%s)", async (claim) => {
  const thread: ThreadView = {
    ...base,
    state: "resolved",
    comments: base.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })),
  };
  const key = editDraftKey(id, id);
  if (!claim) saveDraft(key, "Unsent edit draft");
  mount(<ThreadCard reviewId={id} revision={2} thread={thread} changedBlocks={[]} surface="comments" />);
  if (claim) {
    expect(screen.getByRole("button", { name: "Expand thread" })).toBeTruthy();
    act(() => {
      saveDraft(key, "Unsent edit draft");
      claimDraft(key, "comments");
    });
  }
  const editor = await screen.findByRole("textbox", { name: "Edit comment" });
  expect((editor as HTMLTextAreaElement).value).toBe("Unsent edit draft");
  if (claim) expect(document.activeElement).toBe(editor);
});
test.each(["reply", "edit"])("fix1 closing a phone %s sheet focuses its new action button", async (kind) => {
  width = 390;
  mount(
    card(
      kind === "reply"
        ? base
        : { ...base, comments: base.comments.map((comment) => ({ ...comment, sent: false, sentOn: null })) },
    ),
  );
  const name = kind === "reply" ? "Reply" : "Edit";
  const opener = screen.getByRole("button", { name });
  act(() => opener.focus());
  fireEvent.click(opener);
  const sheet = await screen.findByRole("dialog", { name: kind === "reply" ? "Reply" : "Edit comment" });
  fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name })));
});

function FocusReturnProbe({ generation = 0, copy = false }: { generation?: number; copy?: boolean }) {
  const action = useThreadActionFocus(id, id, "comments", "reply", false);
  return (
    <>
      <button type="button" key={generation} ref={action.ref}>
        Reply
      </button>
      {copy && (
        <button type="button" ref={action.ref}>
          Reply copy
        </button>
      )}
      <button type="button" onClick={() => action.returnFocus(true)}>
        Return after Save
      </button>
      <button type="button" onClick={() => action.returnFocus(false)}>
        Return after Cancel
      </button>
      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        Other action
      </button>
    </>
  );
}
test("fix3 a saved focus handoff ends at its first replacement and clears its timer", async () => {
  vi.useFakeTimers();
  const view = render(<FocusReturnProbe />);
  fireEvent.click(screen.getByRole("button", { name: "Return after Save" }));
  const first = screen.getByRole("button", { name: "Reply" });
  expect(document.activeElement).toBe(first);
  fireEvent.focusIn(first);
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => view.rerender(<FocusReturnProbe generation={1} />));
  expect(first.isConnected).toBe(false);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reply" }));
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => view.rerender(<FocusReturnProbe generation={2} />));
  expect(document.activeElement).toBe(document.body);
});
test("fix3 BODY is insufficient to restore when the last focused button is still connected", async () => {
  vi.useFakeTimers();
  const view = render(<FocusReturnProbe />);
  fireEvent.click(screen.getByRole("button", { name: "Return after Save" }));
  const first = screen.getByRole("button", { name: "Reply" });
  act(() => first.blur());
  await act(async () => view.rerender(<FocusReturnProbe copy />));
  expect(first.isConnected).toBe(true);
  expect(document.activeElement).toBe(document.body);
});
test.each([999, 1000])("fix3 a Save handoff is bounded at 1000 ms (replacement at %s ms)", async (elapsed) => {
  vi.useFakeTimers();
  const view = render(<FocusReturnProbe />);
  fireEvent.click(screen.getByRole("button", { name: "Return after Save" }));
  await act(async () => vi.advanceTimersByTimeAsync(elapsed));
  expect(vi.getTimerCount()).toBe(elapsed < 1000 ? 1 : 0);
  await act(async () => view.rerender(<FocusReturnProbe generation={1} />));
  expect(document.activeElement).toBe(elapsed < 1000 ? screen.getByRole("button", { name: "Reply" }) : document.body);
  expect(vi.getTimerCount()).toBe(0);
});
test.each(["pointer", "keyboard", "focus", "body focus", "navigation"])(
  "fix3 %s retires a Save handoff and clears its timer",
  async (event) => {
    vi.useFakeTimers();
    const view = render(<FocusReturnProbe />);
    fireEvent.click(screen.getByRole("button", { name: "Return after Save" }));
    const other = screen.getByRole("button", { name: "Other action" });
    if (event === "pointer") fireEvent.pointerDown(other);
    else if (event === "keyboard") fireEvent.keyDown(other, { key: "Escape" });
    else if (event === "focus") act(() => other.focus());
    else if (event === "body focus") fireEvent.focusIn(document.body);
    else cancelThreadActionFocus();
    expect(vi.getTimerCount()).toBe(0);
    act(() => (document.activeElement as HTMLElement).blur());
    await act(async () => view.rerender(<FocusReturnProbe generation={1} />));
    expect(document.activeElement).toBe(document.body);
  },
);
test("fix3 Cancel returns focus without scheduling a handoff", async () => {
  vi.useFakeTimers();
  const view = render(<FocusReturnProbe />);
  fireEvent.click(screen.getByRole("button", { name: "Return after Cancel" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reply" }));
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => view.rerender(<FocusReturnProbe generation={1} />));
  expect(document.activeElement).toBe(document.body);
});

function InlineEditor({ returnFocus }: { returnFocus: (saved: boolean) => HTMLElement | null }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button">Edit opener</button>
      {open && (
        <Composer
          inline
          reviewId={id}
          revision={2}
          target={target}
          commentId={id}
          returnFocus={returnFocus}
          onCancel={() => setOpen(false)}
          onDismiss={() => setOpen(false)}
          onSaved={() => setOpen(false)}
        />
      )}
    </>
  );
}

test.each(["Cancel", "Escape", "Save changes"])(
  "an inline phone composer returns focus with the saved flag after %s",
  async (action) => {
    width = 390;
    const returnFocus = vi.fn(() => screen.getByRole<HTMLButtonElement>("button", { name: "Edit opener" }));
    mount(<InlineEditor returnFocus={returnFocus} />);
    const input = screen.getByRole("textbox", { name: "Edit comment" });
    expect(returnFocus).not.toHaveBeenCalled();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "Synthetic edited draft" } });
    if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
    else fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    await waitFor(() => expect(returnFocus).toHaveBeenCalledWith(action === "Save changes"));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit opener" }));
  },
);

test.each(["field", "button"])(
  "an inline phone edit unmount after Save preserves focus moved to another %s",
  async (kind) => {
    width = 390;
    let finish = () => {};
    const response = new Promise<Response>((resolve) => {
      finish = () => resolve(new Response(null, { status: 200 }));
    });
    fetchMock.mockImplementation(() => response);
    const returnFocus = vi.fn(() => screen.getByRole<HTMLButtonElement>("button", { name: "Edit opener" }));
    mount(
      <>
        <input aria-label="Another field" />
        <button type="button">Another action</button>
        <InlineEditor returnFocus={returnFocus} />
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Edit comment" });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "Synthetic edited draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const other =
      kind === "field"
        ? screen.getByRole("textbox", { name: "Another field" })
        : screen.getByRole("button", { name: "Another action" });
    act(() => other.focus());
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull());
    expect(document.activeElement).toBe(other);
    expect(returnFocus).not.toHaveBeenCalled();
  },
);
