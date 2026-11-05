import type { InboxItem } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { defaultLayout, layoutStore } from "./lib/layout-store.ts";
import { wakeTime } from "./lib/time.ts";
import { Events } from "./test/events.ts";

const id = "11111111-1111-4111-8111-111111111111";
const other = (n: number) => `22222222-2222-4222-8222-22222222222${n}`;
const item: InboxItem = {
  id,
  title: "Synthetic review",
  origin: { id, name: "Workshop" },
  repo: "c".repeat(64),
  branch: "main",
  state: "open",
  newestRevision: 1,
  unsentCount: 0,
  openThreads: 0,
  agentWaiting: false,
  pendingSend: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  movedTo: null,
  list: "active",
  snoozed: false,
  snoozedUntil: null,
  releasedAt: null,
  pickedUpAt: null,
  kind: "review",
};
const revision = {
  seq: 1,
  base: null,
  head: null,
  main: null,
  writeupEmpty: false,
  topics: [],
  files: [],
  writeup: { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [] }] },
  docs: [],
  threads: [],
  changedBlocks: [],
};
let width = 1280;
const queries = new Set<{ media: string; matches: boolean; events: EventTarget }>();
function matchesWidth(query: string) {
  return [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, bound, pixels]) =>
    bound === "min" ? width >= Number(pixels) : width <= Number(pixels),
  );
}
let inbox: InboxItem[];
let review: InboxItem;
let gone: boolean;
let fetchMock: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
let client: QueryClient;
beforeEach(() => {
  width = 1280;
  queries.clear();
  localStorage.clear();
  layoutStore.update(defaultLayout);
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const media = { matches: matchesWidth(query), media: query, events: new EventTarget() };
      queries.add(media);
      return Object.assign(media, {
        addEventListener: media.events.addEventListener.bind(media.events),
        removeEventListener: media.events.removeEventListener.bind(media.events),
      });
    }),
  );
  review = item;
  inbox = [item];
  gone = false;
  fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "DELETE") {
      gone = true;
      inbox = [];
      return new Response(null, { status: 204 });
    }
    if (method === "POST") return new Response(null, { status: 204 });
    if (path === "/api/v1/reviews") return Response.json({ items: inbox });
    if (path === `/api/v1/reviews/${id}`)
      return gone
        ? Response.json({ error: { code: "unknown_review", message: "Unknown review." } }, { status: 404 })
        : Response.json({ ...review, revisions: [{ seq: 1, createdAt: review.updatedAt }] });
    if (path.includes("/revisions/")) return Response.json(revision);
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount(path = "/") {
  const history = createMemoryHistory({ initialEntries: [path] });
  return { ...render(<App queryClient={client} history={history} />), history };
}
function row(title: string) {
  return screen.getByRole("link", { name: new RegExp(title) });
}
function inboxItems(): InboxItem[] {
  return [
    { ...item, id: other(1), title: "Active one" },
    { ...item, id: other(2), title: "Active two", updatedAt: "2025-12-01T00:00:00.000Z" },
    {
      ...item,
      id: other(3),
      title: "Snoozed timed",
      list: "snoozed",
      snoozed: true,
      snoozedUntil: "2026-11-05T09:00:00.000Z",
    },
    { ...item, id: other(4), title: "Snoozed revision", list: "snoozed", snoozed: true },
    { ...item, id: other(5), title: "Done approved", list: "done", state: "approved" },
    { ...item, id: other(6), title: "Done retired", list: "done", state: "settled" },
  ];
}

test("the inbox shows Active, Snoozed and Done in order with counts, wake times and a collapsed Done", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
  inbox = inboxItems();
  mount();
  await screen.findByRole("link", { name: /Active one/ });
  const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
  expect(headings).toEqual(["Active2", "Snoozed2", "Done2"]);
  const links = screen.getAllByRole("link").map((link) => link.textContent ?? "");
  const order = ["Active one", "Active two", "Snoozed timed", "Snoozed revision"].map((title) =>
    links.findIndex((text) => text.includes(title)),
  );
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(
    within(row("Snoozed timed")).getByText(`until ${wakeTime("2026-11-05T09:00:00.000Z", Date.now())}`),
  ).toBeTruthy();
  expect(within(row("Snoozed revision")).getByText("until it changes")).toBeTruthy();
  // Done starts collapsed.
  const done = screen.getByRole("button", { name: /Done/ });
  expect(done.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: /Done approved/ })).toBeNull();
  fireEvent.click(done);
  expect(done.getAttribute("aria-expanded")).toBe("true");
  expect(within(row("Done approved")).getByText("Approved")).toBeTruthy();
  expect(within(row("Done retired")).getByText("Retired")).toBeTruthy();
  fireEvent.click(done);
  expect(screen.queryByRole("link", { name: /Done approved/ })).toBeNull();
});

test("done rows are dimmed until hover or focus; active and snoozed rows keep full opacity", async () => {
  inbox = inboxItems();
  mount();
  await screen.findByRole("link", { name: /Active one/ });
  fireEvent.click(screen.getByRole("button", { name: /Done/ }));
  for (const title of ["Done approved", "Done retired"]) {
    const classes = row(title).classList;
    expect(classes.contains("opacity-60")).toBe(true);
    expect(classes.contains("hover:opacity-100")).toBe(true);
    expect(classes.contains("focus-within:opacity-100")).toBe(true);
    // The open review (aria-current="page") is not dimmed.
    expect(classes.contains("aria-[current=page]:opacity-100")).toBe(true);
  }
  for (const title of ["Active one", "Snoozed timed", "Snoozed revision"])
    expect(row(title).className).not.toContain("opacity-");
});

test("a non-empty filter shows Done expanded under a plain heading; clearing it restores the reader's choice", async () => {
  inbox = inboxItems();
  mount();
  await screen.findByRole("link", { name: /Active one/ });
  const filter = screen.getByRole("textbox", { name: "Filter reviews" });
  fireEvent.change(filter, { target: { value: "Done" } });
  expect(await screen.findByRole("link", { name: /Done approved/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Done/ })).toBeNull();
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Done2"]);
  fireEvent.change(filter, { target: { value: "" } });
  const toggle = await screen.findByRole("button", { name: /Done/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: /Done approved/ })).toBeNull();
  fireEvent.click(toggle);
  fireEvent.change(filter, { target: { value: "Done" } });
  fireEvent.change(filter, { target: { value: "" } });
  expect((await screen.findByRole("button", { name: /Done/ })).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("link", { name: /Done approved/ })).toBeTruthy();
});

test("a wake time in the past shows waking up, never a date", async () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  inbox = [{ ...item, id: other(1), title: "Overdue", list: "snoozed", snoozed: true, snoozedUntil: past }];
  mount();
  expect(within(await screen.findByRole("link", { name: /Overdue/ })).getByText("waking up")).toBeTruthy();
  expect(screen.queryByText(/^until /)).toBeNull();
});

test("the review header says waking up for a snooze that has passed", async () => {
  review = { ...item, list: "snoozed", snoozed: true, snoozedUntil: new Date(Date.now() - 1000).toISOString() };
  mount(`/r/${id}`);
  await screen.findByRole("heading", { name: "Synthetic review", level: 1 });
  expect(screen.getByText("Waking up")).toBeTruthy();
  expect(screen.queryByText(/^Snoozed until/)).toBeNull();
});

test("a timed snooze that ends while the inbox is open refetches the inbox and the row moves to Active", async () => {
  const wake = new Date(Date.now() + 700).toISOString();
  inbox = [{ ...item, id: other(1), title: "About to wake", list: "snoozed", snoozed: true, snoozedUntil: wake }];
  mount();
  const row = await screen.findByRole("link", { name: /About to wake/ });
  expect(within(row).getByText(/^until /)).toBeTruthy();
  const inboxCalls = () => fetchMock.mock.calls.filter(([path]) => path === "/api/v1/reviews").length;
  const before = inboxCalls();
  // The server ends the snooze by the clock alone and sends no event.
  inbox = [{ ...item, id: other(1), title: "About to wake", list: "active" }];
  await waitFor(() => expect(inboxCalls()).toBeGreaterThan(before));
  await waitFor(() =>
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Active1"]),
  );
});

test("snoozed rows do not count as needing you", async () => {
  inbox = [
    { ...item, id: other(1), title: "Snoozed with comments", list: "snoozed", snoozed: true, unsentCount: 3 },
    { ...item, id: other(2), title: "Active" },
  ];
  mount();
  await screen.findByText(/^Nothing needs you/);
});

test("empty Snoozed and Done lists are hidden, and nothing active keeps a note", async () => {
  inbox = [{ ...item, id: other(1), title: "Only one" }];
  const first = mount();
  await screen.findByRole("link", { name: /Only one/ });
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Active1"]);
  first.unmount();
  client.clear();
  inbox = [{ ...item, id: other(1), title: "Snoozed only", list: "snoozed", snoozed: true }];
  mount();
  await screen.findByRole("link", { name: /Snoozed only/ });
  expect(screen.getByText("No active reviews.")).toBeTruthy();
});

test("an empty inbox keeps its empty state", async () => {
  inbox = [];
  mount();
  await screen.findByText("No reviews yet.");
  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
});

test("a retired review reads Retired, disables Send and Approve and offers Reopen", async () => {
  review = { ...item, state: "settled", list: "done", unsentCount: 1 };
  mount(`/r/${id}`);
  await screen.findByRole("heading", { name: "Synthetic review", level: 1 });
  expect(screen.getAllByText("Retired").length).toBeGreaterThan(0);
  const reason = "This review is retired. Reopen it to send or approve.";
  await waitFor(() => expect(screen.getAllByText(reason).length).toBeGreaterThan(0));
  expect((screen.getByRole("button", { name: /^Approve/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: /^Send/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole("button", { name: "More review actions" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Reopen" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([path, init]) => path === `/api/v1/reviews/${id}/reopen` && init?.method === "POST"),
    ).toBe(true),
  );
});

test.each([
  ["a timed snooze", "2026-11-05T09:00:00.000Z"],
  ["a snooze until the next revision", null],
])("the header names %s", async (_name, snoozedUntil) => {
  if (snoozedUntil) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
  }
  review = { ...item, list: "snoozed", snoozed: true, snoozedUntil };
  mount(`/r/${id}`);
  await screen.findByRole("heading", { name: "Synthetic review", level: 1 });
  expect(
    screen.getByText(snoozedUntil ? `Snoozed until ${wakeTime(snoozedUntil, Date.now())}` : "Snoozed until it changes"),
  ).toBeTruthy();
});

test("deleting from the review page asks, goes to the inbox and toasts the title", async () => {
  const { history } = mount(`/r/${id}`);
  await screen.findByRole("heading", { name: "Synthetic review", level: 1 });
  fireEvent.keyDown(screen.getByRole("button", { name: "More review actions" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Delete “Synthetic review”?" });
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete review" }));
  await screen.findByText("Deleted “Synthetic review”");
  await waitFor(() => expect(history.location.pathname).toBe("/"));
  await screen.findByText("No reviews yet.");
  expect(screen.queryByText("This review was deleted or never existed.")).toBeNull();
});

test("a delete event for the open review shows the deleted page with a link to the inbox", async () => {
  const { history } = mount(`/r/${id}`);
  await screen.findByRole("heading", { name: "Synthetic review", level: 1 });
  gone = true;
  act(() => {
    Events.opened[0]?.emit("delete", { reviewId: id, revision: 1 });
  });
  await screen.findByText("This review was deleted or never existed.");
  expect(screen.queryByText("Could not load this review.")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Back to the inbox" }));
  await waitFor(() => expect(history.location.pathname).toBe("/"));
});

test.each(["snooze", "unsnooze", "retire", "reopen"] as const)(
  "a %s event refreshes the inbox and the review",
  async (type) => {
    mount(`/r/${id}`);
    await screen.findByRole("heading", { name: "Synthetic review", level: 1 });
    const count = (path: string) => fetchMock.mock.calls.filter(([called]) => called === path).length;
    const before = [count("/api/v1/reviews"), count(`/api/v1/reviews/${id}`)];
    review = { ...item, state: type === "retire" ? "settled" : "open", list: type === "retire" ? "done" : "active" };
    act(() => {
      Events.opened[0]?.emit(type, { reviewId: id, revision: 1 });
    });
    await waitFor(() => {
      expect(count("/api/v1/reviews")).toBeGreaterThan(before[0] ?? 0);
      expect(count(`/api/v1/reviews/${id}`)).toBeGreaterThan(before[1] ?? 0);
    });
  },
);

test("on the phone the actions menu shares the bar with Approve and Send", async () => {
  width = 390;
  mount(`/r/${id}`);
  await screen.findByRole("heading", { name: "Synthetic review", level: 1 });
  const bar = within(screen.getByRole("region", { name: "Send and approve" }));
  expect(bar.getByRole("button", { name: "More review actions" })).toBeTruthy();
  expect(bar.getByRole("button", { name: "Approve" })).toBeTruthy();
  expect(bar.getByRole("button", { name: "Send" })).toBeTruthy();
});
