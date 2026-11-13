import {
  APPROVED_ACTIVE_HOURS,
  type InboxItem,
  type ReviewView,
  type RevisionView,
  reviewDownloadPath,
  type ThreadView,
} from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { App } from "./App.tsx";
import { type InboxData, revisionQuery } from "./api/queries.ts";
import { doneDimmed } from "./components/inbox/ReviewRow.tsx";
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
  project: null,
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
  activeUntil: null,
  releasedAt: null,
  pickedUpAt: null,
  kind: "review",
};
const revision: RevisionView = {
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
let binned: boolean;
let serverOffset: number;
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
  binned = false;
  serverOffset = 0;
  fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "DELETE") {
      gone = true;
      inbox = [];
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === `/api/v1/reviews/${id}/bin`) {
      binned = true;
      inbox = [];
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === `/api/v1/reviews/${id}/restore`) {
      binned = false;
      inbox = [item];
      return new Response(null, { status: 204 });
    }
    if (method === "POST") return new Response(null, { status: 204 });
    if (path === "/api/v1/reviews")
      return Response.json({
        items: inbox,
        approvedActiveHours: 12,
        serverTime: new Date(Date.now() + serverOffset).toISOString(),
      });
    if (path === `/api/v1/reviews/${id}` && binned)
      return Response.json({ error: { code: "review_in_bin", message: "The review is in the bin." } }, { status: 409 });
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
  client.clear();
  vi.useRealTimers();
});

function mount(path = "/") {
  const history = createMemoryHistory({ initialEntries: [path] });
  return { ...render(<App queryClient={client} history={history} />), history };
}
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function mountTimed(path = "/") {
  await act(async () => {
    mount(path);
  });
  await tick();
}
function fixedClock() {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
}
function recentApproval(): InboxItem {
  return {
    ...item,
    title: "Recently approved",
    state: "approved",
    list: "active",
    activeUntil: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  };
}
function expectDimmed(link: HTMLElement) {
  for (const name of doneDimmed.split(" ")) expect(link.classList.contains(name)).toBe(true);
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

test("the inbox shows Active, Snoozed and Done in order with counts, wake times and collapsed Snoozed and Done", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
  inbox = inboxItems();
  mount();
  await screen.findByRole("link", { name: /Active one/ });
  const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
  expect(headings).toEqual(["Active2", "Snoozed2", "Done2"]);
  const snoozed = screen.getByRole("button", { name: /Snoozed/ });
  expect(snoozed.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: /Snoozed/ })).toBeNull();
  fireEvent.click(snoozed);
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

test("Snoozed starts collapsed with its count and toggles independently of Done", async () => {
  inbox = inboxItems();
  mount();
  const snoozed = await screen.findByRole("button", { name: "Snoozed 2" });
  const done = screen.getByRole("button", { name: "Done 2" });
  expect(snoozed.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: /Snoozed/ })).toBeNull();
  expect(done.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(done);
  expect(done.getAttribute("aria-expanded")).toBe("true");
  expect(row("Done approved")).toBeTruthy();
  expect(row("Done retired")).toBeTruthy();
  fireEvent.click(snoozed);
  expect(snoozed.getAttribute("aria-expanded")).toBe("true");
  expect(row("Snoozed timed")).toBeTruthy();
  expect(row("Snoozed revision")).toBeTruthy();
  expect(done.getAttribute("aria-expanded")).toBe("true");
  expect(row("Done approved")).toBeTruthy();
  fireEvent.click(snoozed);
  expect(snoozed.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: /Snoozed/ })).toBeNull();
  expect(done.getAttribute("aria-expanded")).toBe("true");
  expect(row("Done approved")).toBeTruthy();
  fireEvent.click(snoozed);
  expect(snoozed.getAttribute("aria-expanded")).toBe("true");
  expect(row("Snoozed timed")).toBeTruthy();
  expect(row("Snoozed revision")).toBeTruthy();
  expect(done.getAttribute("aria-expanded")).toBe("true");
  expect(row("Done approved")).toBeTruthy();
  fireEvent.click(done);
  expect(done.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: /Done approved/ })).toBeNull();
  expect(snoozed.getAttribute("aria-expanded")).toBe("true");
  expect(row("Snoozed timed")).toBeTruthy();
  expect(row("Snoozed revision")).toBeTruthy();
});

test("done rows are dimmed until hover or focus; active and snoozed rows keep full opacity", async () => {
  inbox = inboxItems();
  mount();
  await screen.findByRole("link", { name: /Active one/ });
  fireEvent.click(screen.getByRole("button", { name: /Snoozed/ }));
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

test.each([390, 1280])(
  "an approved review stays under Active with its badge and Done dimming at %s px",
  async (size) => {
    fixedClock();
    width = size;
    inbox = [recentApproval(), { ...item, id: other(1), title: "Retired review", state: "settled", list: "done" }];
    await mountTimed();
    const active = within(screen.getByRole("region", { name: "Active" }));
    const approved = active.getByRole("link", { name: /Recently approved/ });
    expect(within(approved).getByText("Approved")).toBeTruthy();
    expectDimmed(approved);
    fireEvent.click(screen.getByRole("button", { name: /Done/ }));
    expectDimmed(row("Retired review"));
  },
);

test("the collapsed inbox rail dims a recent approval like a Done row", async () => {
  fixedClock();
  inbox = [
    { ...recentApproval(), id: other(1) },
    { ...item, id: other(2), title: "Retired review", state: "settled", list: "done" },
    item,
  ];
  await mountTimed(`/r/${id}`);
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  const rail = within(screen.getByRole("complementary", { name: "Inbox" }));
  expectDimmed(rail.getByRole("link", { name: "Recently approved" }));
  expectDimmed(rail.getByRole("link", { name: "Retired review" }));
  expect(rail.getByRole("link", { name: item.title }).className).not.toContain("opacity-");
});

test("the inbox sidebar starts Snoozed collapsed and supports toggling and filtering", async () => {
  inbox = [item, ...inboxItems().filter((entry) => entry.list === "snoozed")];
  mount(`/r/${id}`);
  const pane = within(await screen.findByRole("complementary", { name: "Inbox" }));
  const snoozed = await pane.findByRole("button", { name: "Snoozed 2" });
  expect(snoozed.getAttribute("aria-expanded")).toBe("false");
  expect(pane.queryByRole("link", { name: /Snoozed/ })).toBeNull();
  fireEvent.click(snoozed);
  expect(snoozed.getAttribute("aria-expanded")).toBe("true");
  expect(pane.getByRole("link", { name: /Snoozed timed/ })).toBeTruthy();
  expect(pane.getByRole("link", { name: /Snoozed revision/ })).toBeTruthy();
  fireEvent.click(snoozed);
  expect(snoozed.getAttribute("aria-expanded")).toBe("false");
  expect(pane.queryByRole("link", { name: /Snoozed/ })).toBeNull();
  fireEvent.change(pane.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "Snoozed timed" } });
  expect(pane.getByRole("link", { name: /Snoozed timed/ })).toBeTruthy();
  expect(pane.queryByRole("button", { name: /Snoozed/ })).toBeNull();
});

test.each([
  { offsetHours: -2, remainingHours: 2 },
  { offsetHours: -2, remainingHours: 4 },
  { offsetHours: 2, remainingHours: 2 },
  { offsetHours: 0, remainingHours: 2 },
])(
  "approval expiry follows the server clock (offset $offsetHours h, $remainingHours h remaining)",
  async ({ offsetHours, remainingHours }) => {
    fixedClock();
    serverOffset = offsetHours * 3_600_000;
    const remaining = remainingHours * 3_600_000;
    const approved = {
      ...recentApproval(),
      activeUntil: new Date(Date.now() + serverOffset + remaining).toISOString(),
    };
    inbox = [approved];
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await mountTimed();
    expect(client.getQueryData<InboxData>(["inbox"])).toMatchObject({
      approvedActiveHours: 12,
      serverTime: new Date(Date.now() + serverOffset).toISOString(),
      receivedAt: Date.now(),
      receivedMono: performance.now(),
    });
    const inboxCalls = () => fetchMock.mock.calls.filter(([path]) => path === "/api/v1/reviews").length;
    const before = inboxCalls();
    await tick(remaining / 2);
    expect(
      within(screen.getByRole("region", { name: "Active" })).getByRole("link", { name: /Recently approved/ }),
    ).toBeTruthy();
    expect(inboxCalls()).toBe(before);
    inbox = [{ ...approved, list: "done", activeUntil: null }];
    await tick(remaining / 2 + 500);
    await tick();
    expect(inboxCalls()).toBe(before + 1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inbox"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["review", id] });
    expect(screen.getByText("No active reviews.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done 1" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: /Recently approved/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done 1" }));
    expect(
      within(screen.getByRole("region", { name: "Done" })).getByRole("link", { name: /Recently approved/ }),
    ).toBeTruthy();
  },
);

test("an accepted approval expires even when every following inbox refetch fails", async () => {
  fixedClock();
  serverOffset = 2 * 3_600_000;
  const windowMs = APPROVED_ACTIVE_HOURS * 3_600_000;
  const activeUntil = new Date(Date.now() + serverOffset + windowMs).toISOString();
  const receivedAt = Date.now();
  const receivedMono = performance.now();
  const fallback = fetchMock.getMockImplementation();
  let approved = false;
  fetchMock.mockImplementation(async (path, init) => {
    if (path === `/api/v1/reviews/${id}/sends` && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toMatchObject({ kind: "approve" });
      approved = true;
      review = { ...item, state: "approved", activeUntil };
      return new Response(null, { status: 201 });
    }
    if (approved && path === "/api/v1/reviews")
      return Response.json({ error: { code: "internal_error", message: "Synthetic failure" } }, { status: 500 });
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
  // Load the revision before clicking: Approve stays disabled while that query is pending.
  await client.fetchQuery(revisionQuery(id, 1));
  await mountTimed(`/r/${id}`);
  fireEvent.click(screen.getByRole("button", { name: /^Approve/ }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve" }));
  await tick();
  expect(approved).toBe(true);
  const cached = client.getQueryData<InboxData>(["inbox"]);
  expect(cached).toMatchObject({
    approvedActiveHours: 12,
    serverTime: new Date(receivedAt + serverOffset).toISOString(),
    receivedAt,
    receivedMono,
  });
  expect(cached?.items[0]).toMatchObject({ state: "approved", list: "active", activeUntil });
  expect(client.getQueryData<ReviewView>(["review", id])?.activeUntil).toBe(activeUntil);
  const active = within(screen.getByRole("region", { name: "Active" })).getByRole("link", { name: /Synthetic review/ });
  expectDimmed(active);
  expect(within(active).getByText("Approved")).toBeTruthy();
  expect(screen.getByText("Could not load reviews.")).toBeTruthy();
  await tick(windowMs - 1);
  expect(
    within(screen.getByRole("region", { name: "Active" })).getByRole("link", { name: /Synthetic review/ }),
  ).toBeTruthy();
  await tick(501);
  await tick();
  expect(screen.getByText("No active reviews.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Done 1" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Done 1" }));
  const done = within(screen.getByRole("region", { name: "Done" })).getByRole("link", { name: /Synthetic review/ });
  expectDimmed(done);
  expect(within(done).getByText("Approved")).toBeTruthy();
});

test("an approval that expires while refetches fail joins Done in updatedAt and id order", async () => {
  fixedClock();
  serverOffset = -2 * 3_600_000;
  const now = Date.now() + serverOffset;
  const approved = {
    ...recentApproval(),
    id: other(2),
    updatedAt: new Date(now).toISOString(),
    activeUntil: new Date(now + 2 * 3_600_000).toISOString(),
  };
  const retired = (n: number, title: string, updatedAt: number): InboxItem => ({
    ...item,
    id: other(n),
    title,
    state: "settled",
    list: "done",
    updatedAt: new Date(updatedAt).toISOString(),
  });
  inbox = [
    approved,
    retired(3, "Newer retired", now + 1000),
    retired(1, "Same-time retired", now),
    retired(4, "Older retired", now - 1000),
  ];
  await mountTimed();
  expect(
    within(screen.getByRole("region", { name: "Active" })).getByRole("link", { name: /Recently approved/ }),
  ).toBeTruthy();
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    if (path === "/api/v1/reviews")
      return Response.json({ error: { code: "internal_error", message: "Synthetic failure" } }, { status: 500 });
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
  await tick(2 * 3_600_000 + 500);
  await tick();
  expect(screen.getByText("Could not load reviews.")).toBeTruthy();
  expect(screen.getByText("No active reviews.")).toBeTruthy();
  const toggle = screen.getByRole("button", { name: "Done 4" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  const done = within(screen.getByRole("region", { name: "Done" }));
  expect(done.getAllByRole("link")).toEqual(
    ["Newer retired", "Same-time retired", "Recently approved", "Older retired"].map(row),
  );
  // The cache still has the old Active row: the displayed grouping and order handle expiry.
  expect(client.getQueryData<InboxData>(["inbox"])?.items[0]).toEqual(approved);
});

async function failInboxRefetches() {
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    if (path === "/api/v1/reviews")
      return Response.json({ error: { code: "internal_error", message: "Synthetic failure" } }, { status: 500 });
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["inbox"] });
  });
  await tick();
  expect(screen.getByText("Could not load reviews.")).toBeTruthy();
}

test("an approval expires on monotonic time after the wall clock moves back and refetches fail", async () => {
  fixedClock();
  const remaining = 90 * 60_000;
  inbox = [{ ...recentApproval(), activeUntil: new Date(Date.now() + remaining).toISOString() }];
  await mountTimed();
  const cached = client.getQueryData<InboxData>(["inbox"]);
  const monotonic = performance.now();
  vi.setSystemTime(Date.now() - 2 * 3_600_000);
  expect(performance.now()).toBe(monotonic);
  // A failed resync after the change must leave expiry running from the original response's clocks.
  await failInboxRefetches();
  await tick(remaining - 1);
  expect(
    within(screen.getByRole("region", { name: "Active" })).getByRole("link", { name: /Recently approved/ }),
  ).toBeTruthy();
  await tick(501);
  await tick();
  expect(performance.now() - monotonic).toBe(remaining + 500);
  expect(client.getQueryData<InboxData>(["inbox"])).toEqual(cached);
  expect(screen.getByText("No active reviews.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Done 1" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Done 1" }));
  expect(
    within(screen.getByRole("region", { name: "Done" })).getByRole("link", { name: /Recently approved/ }),
  ).toBeTruthy();
});

test("an approval expires at the next minute tick after sleep even when refetches fail", async () => {
  fixedClock();
  inbox = [{ ...recentApproval(), activeUntil: new Date(Date.now() + 90 * 60_000).toISOString() }];
  await mountTimed();
  const cached = client.getQueryData<InboxData>(["inbox"]);
  await failInboxRefetches();
  const monotonic = performance.now();
  vi.setSystemTime(Date.now() + 10 * 3_600_000);
  expect(performance.now()).toBe(monotonic);
  await tick(60_000);
  await tick();
  expect(performance.now() - monotonic).toBe(60_000);
  expect(client.getQueryData<InboxData>(["inbox"])).toEqual(cached);
  expect(screen.getByText("No active reviews.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Done 1" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Done 1" }));
  expect(
    within(screen.getByRole("region", { name: "Done" })).getByRole("link", { name: /Recently approved/ }),
  ).toBeTruthy();
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

test("a non-empty filter shows Snoozed expanded under a plain heading; clearing it restores the reader's choice", async () => {
  inbox = inboxItems();
  mount();
  await screen.findByRole("link", { name: /Active one/ });
  const filter = screen.getByRole("textbox", { name: "Filter reviews" });
  fireEvent.change(filter, { target: { value: "Snoozed timed" } });
  expect(await screen.findByRole("link", { name: /Snoozed timed/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Snoozed/ })).toBeNull();
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Snoozed1"]);
  fireEvent.change(filter, { target: { value: "" } });
  const toggle = await screen.findByRole("button", { name: /Snoozed/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: /Snoozed/ })).toBeNull();
  fireEvent.click(toggle);
  fireEvent.change(filter, { target: { value: "Snoozed timed" } });
  fireEvent.change(filter, { target: { value: "" } });
  expect((await screen.findByRole("button", { name: /Snoozed/ })).getAttribute("aria-expanded")).toBe("true");
  expect(row("Snoozed timed")).toBeTruthy();
  expect(row("Snoozed revision")).toBeTruthy();
});

test("a wake time in the past shows waking up, never a date", async () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  inbox = [{ ...item, id: other(1), title: "Overdue", list: "snoozed", snoozed: true, snoozedUntil: past }];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Snoozed/ }));
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
  fixedClock();
  const wake = new Date(Date.now() + 3_600_000).toISOString();
  inbox = [{ ...item, id: other(1), title: "About to wake", list: "snoozed", snoozed: true, snoozedUntil: wake }];
  await mountTimed();
  fireEvent.click(screen.getByRole("button", { name: /Snoozed/ }));
  expect(within(row("About to wake")).getByText(/^until /)).toBeTruthy();
  const inboxCalls = () => fetchMock.mock.calls.filter(([path]) => path === "/api/v1/reviews").length;
  const before = inboxCalls();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  // The server ends the snooze by the clock alone and sends no event.
  inbox = [{ ...item, id: other(1), title: "About to wake", list: "active" }];
  await tick(3_600_000 + 500);
  await tick();
  expect(inboxCalls()).toBe(before + 1);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["review", other(1)] });
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Active1"]);
});

test("a timed snooze that ends while Snoozed stays collapsed moves the row to Active", async () => {
  fixedClock();
  const wake = new Date(Date.now() + 3_600_000).toISOString();
  inbox = [{ ...item, id: other(1), title: "About to wake", list: "snoozed", snoozed: true, snoozedUntil: wake }];
  await mountTimed();
  expect(screen.getByRole("button", { name: "Snoozed 1" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: /About to wake/ })).toBeNull();
  inbox = [{ ...item, id: other(1), title: "About to wake", list: "active" }];
  await tick(3_600_000 + 500);
  await tick();
  expect(
    within(screen.getByRole("region", { name: "Active" })).getByRole("link", { name: /About to wake/ }),
  ).toBeTruthy();
  expect(screen.queryByRole("heading", { name: /Snoozed/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Snoozed/ })).toBeNull();
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
  await screen.findByRole("button", { name: /Snoozed/ });
  expect(screen.getByText("No active reviews.")).toBeTruthy();
});

test("an empty inbox keeps its empty state", async () => {
  inbox = [];
  mount();
  await screen.findByText("No reviews yet.");
  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
});

test("retiring with discard refetches the revision and updates the Comments tab counts", async () => {
  review = { ...item, unsentCount: 1, openThreads: 1 };
  inbox = [review];
  const threads: ThreadView[] = [false, true].map((sent, index) => ({
    id: other(index),
    createdOn: 1,
    state: sent ? "resolved" : "open",
    target: { kind: "review" },
    placement: { status: "placed", location: { kind: "review" } },
    comments: [{ id: other(index + 2), author: "user", body: "A comment", sent, sentOn: sent ? 1 : null }],
  }));
  let retired = false;
  let revisionGets = 0;
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    if (path === `/api/v1/reviews/${id}/retire` && init?.method === "POST") {
      retired = true;
      review = { ...review, state: "settled", list: "done", unsentCount: 0, openThreads: 0 };
      inbox = [review];
      return new Response(null, { status: 204 });
    }
    if (path === `/api/v1/reviews/${id}/revisions/1`) {
      revisionGets += 1;
      return Response.json({ ...revision, threads: retired ? threads.filter((t) => t.state === "resolved") : threads });
    }
    if (!original) throw new Error("Missing synthetic fetch");
    return original(path, init);
  });
  mount(`/r/${id}?tab=comments`);
  const before = await screen.findByRole("tab", { name: "Comments 1 unsent, 1 not resolved, 2 threads in all" });
  expect(within(before).getByText("1 / 1 / 2")).toBeTruthy();
  expect(revisionGets).toBe(1);
  fireEvent.keyDown(screen.getByRole("button", { name: "More review actions" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Retire" }));
  fireEvent.click(await screen.findByRole("button", { name: "Discard 1 unsent comment and retire" }));
  const after = await screen.findByRole("tab", { name: "Comments 0 unsent, 0 not resolved, 1 thread in all" });
  expect(within(after).getByText("0 / 0 / 1")).toBeTruthy();
  expect(revisionGets).toBe(2);
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/v1/reviews/${id}/retire`,
    expect.objectContaining({ method: "POST", body: JSON.stringify({ discardUnsent: true }) }),
  );
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
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
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
  expect(
    within(dialog).getByText(
      "It moves to the bin in Settings, where you can restore it or delete it for good. It leaves the inbox, and an agent waiting on it stops.",
    ),
  ).toBeTruthy();
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE" || init?.method === "POST")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Move to bin" }));
  await screen.findByText("Moved “Synthetic review” to the bin");
  await waitFor(() => expect(history.location.pathname).toBe("/"));
  await screen.findByText("No reviews yet.");
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  expect(
    fetchMock.mock.calls.filter(([path, init]) => path === `/api/v1/reviews/${id}/bin` && init?.method === "POST"),
  ).toHaveLength(1);
  expect(screen.queryByText("This review was deleted or never existed.")).toBeNull();
});

test("deleting from a review showing a doc reaches the inbox and Back keeps the real review address", async () => {
  const doc = {
    kind: "markdown",
    path: "note.md",
    blocks: [
      {
        id: "doc-12345678-12345678",
        section: "doc-12345678",
        kind: "paragraph",
        text: "A synthetic note",
        html: "<p>A synthetic note</p>",
      },
    ],
  };
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    if (path === `/api/v1/reviews/${id}/revisions/1`)
      return Response.json({ ...revision, main: doc.path, docs: [doc] });
    if (!original) throw new Error("Missing synthetic fetch");
    return original(path, init);
  });
  const { history } = mount(`/r/${id}`);
  const paths = [history.location.pathname];
  onTestFinished(history.subscribe(({ location }) => paths.push(location.pathname)));
  await screen.findByText("A synthetic note");
  await waitFor(() => expect(new URLSearchParams(history.location.search).get("doc")).toBe(doc.path));
  expect(history.location.pathname).toBe(`/r/${id}`);
  const search = history.location.search;

  fireEvent.keyDown(screen.getByRole("button", { name: "More review actions" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Delete “Synthetic review”?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Move to bin" }));
  await screen.findByText("Moved “Synthetic review” to the bin");
  expect(history.location.pathname).toBe("/");
  await screen.findByText("No reviews yet.");
  expect(history.location.pathname).toBe("/");
  expect(history.location.search).toBe("");
  expect(screen.queryByText("This review was deleted or never existed.")).toBeNull();
  expect(paths).not.toContain("/r/undefined");

  await act(async () => history.back());
  await screen.findByText("This review is in the bin.");
  expect(history.location.pathname).toBe(`/r/${id}`);
  expect(history.location.search).toBe(search);
  expect(new URLSearchParams(history.location.search).get("doc")).toBe(doc.path);
  expect(paths).not.toContain("/r/undefined");
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

test("a review in the bin shows a notice, and Restore loads the review again", async () => {
  binned = true;
  const { history } = mount(`/r/${id}`);
  await screen.findByText("This review is in the bin.");
  expect(screen.queryByText("This review was deleted or never existed.")).toBeNull();
  expect(screen.getByRole("link", { name: "Open the bin" }).getAttribute("href")).toBe("/settings");
  expect(screen.getByRole("link", { name: "Back to the inbox" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByRole("heading", { name: "Synthetic review", level: 1 });
  expect(
    fetchMock.mock.calls.filter(([path, init]) => path === `/api/v1/reviews/${id}/restore` && init?.method === "POST"),
  ).toHaveLength(1);
  expect(history.location.pathname).toBe(`/r/${id}`);
});

test("a bin event turns the open review into the bin notice, and a restore event brings it back", async () => {
  mount(`/r/${id}`);
  await screen.findByRole("heading", { name: "Synthetic review", level: 1 });
  binned = true;
  act(() => {
    Events.opened[0]?.emit("bin", { reviewId: id, revision: 1 });
  });
  await screen.findByText("This review is in the bin.");
  binned = false;
  act(() => {
    Events.opened[0]?.emit("restore", { reviewId: id, revision: 1 });
  });
  await screen.findByRole("heading", { name: "Synthetic review", level: 1 });
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

test("the desktop Download link follows the revision on screen", async () => {
  review = { ...item, newestRevision: 2 };
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    if (path === `/api/v1/reviews/${id}`)
      return Response.json({ ...review, revisions: [1, 2].map((seq) => ({ seq, createdAt: item.updatedAt })) });
    if (path.includes("/revisions/")) return Response.json({ ...revision, seq: Number(path.split("/").at(-1)) });
    if (!original) throw new Error("Missing fetch fixture");
    return original(path, init);
  });
  mount(`/r/${id}`);
  const link = await screen.findByRole("link", { name: "Download" });
  expect(link.getAttribute("href")).toBe(`/api/v1/reviews/${id}/revisions/2/download`);
  expect(link.hasAttribute("download")).toBe(true);
  expect(link.getAttribute("title")).toBe("Download this revision as one HTML file");
  expect(link.querySelector("svg")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("button", { name: "Revision 2 of 2" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /Revision 1/ }));
  await waitFor(() =>
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
      `/api/v1/reviews/${id}/revisions/1/download`,
    ),
  );
});

test("the phone review menu downloads the revision on screen", async () => {
  width = 390;
  mount(`/r/${id}`);
  await screen.findByRole("heading", { name: "Synthetic review", level: 1 });
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const link = await screen.findByRole("menuitem", { name: "Download" });
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe(`/api/v1/reviews/${id}/revisions/1/download`);
  expect(link.hasAttribute("download")).toBe(true);
});

function withDownloadDocs(count = 2, changes: Partial<RevisionView> = {}) {
  const docs = Array.from({ length: count }, (_, index) => ({
    path: `doc-${index}.md`,
    kind: "markdown" as const,
    blocks: [],
    ...(index === 0 ? { title: "Plan title" } : {}),
  }));
  const files: RevisionView["files"] = docs.map((doc, index) => ({
    id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    path: doc.path,
    oldPath: null,
    role: "doc",
    status: null,
    topic: null,
    order: index,
    mediaType: "text/markdown",
    flag: null,
    hasOld: false,
    hasNew: true,
  }));
  const value: RevisionView = { ...revision, docs, files, ...changes };
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    if (path.includes("/revisions/")) return Response.json(value);
    if (!original) throw new Error("Missing fetch fixture");
    return original(path, init);
  });
  return value;
}

test("desktop Download offers unticked docs, updates its link and resets each time it opens", async () => {
  const value = withDownloadDocs();
  mount(`/r/${id}`);
  const trigger = await screen.findByRole("button", { name: "Download" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = within(await screen.findByRole("alertdialog", { name: "Download" }));
  expect(
    dialog.getByText(
      "The writeup is always in. Tick docs to add them; with any doc ticked, the download is a ZIP file.",
    ),
  ).toBeTruthy();
  for (const checkbox of dialog.getAllByRole("checkbox")) expect((checkbox as HTMLInputElement).checked).toBe(false);
  expect(document.activeElement).toBe(dialog.getByRole("button", { name: "Cancel" }));
  expect(dialog.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(reviewDownloadPath(id, 1));
  fireEvent.click(dialog.getByRole("checkbox", { name: /Plan title/ }));
  const link = dialog.getByRole("link", { name: "Download" });
  expect(link.getAttribute("href")).toBe(reviewDownloadPath(id, 1, [value.files[0]?.id ?? ""]));
  expect(link.hasAttribute("download")).toBe(true);
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  fireEvent.click(trigger);
  const reopened = within(await screen.findByRole("alertdialog", { name: "Download" }));
  expect((reopened.getByRole("checkbox", { name: /Plan title/ }) as HTMLInputElement).checked).toBe(false);
  expect(reopened.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(reviewDownloadPath(id, 1));
});

const downloadThread = (sent: boolean): RevisionView["threads"][number] => ({
  id: "55555555-5555-4555-8555-555555555555",
  target: { kind: "review" },
  state: sent ? "sent" : "open",
  createdOn: 1,
  placement: { status: "placed", location: { kind: "review" } },
  comments: [
    {
      id: "66666666-6666-4666-8666-666666666666",
      author: "user",
      body: "Synthetic remark",
      sent,
      sentOn: sent ? 1 : null,
    },
  ],
});

test("Download hides the comments box without sent comments", async () => {
  withDownloadDocs(2, { threads: [downloadThread(false)] });
  mount(`/r/${id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Download" }));
  const dialog = within(await screen.findByRole("alertdialog", { name: "Download" }));
  expect(dialog.queryByRole("checkbox", { name: /Comments and replies/ })).toBeNull();
});

test("sent comments open the Download dialog without docs, unticked, and the box resets on reopen", async () => {
  withDownloadDocs(0, { threads: [downloadThread(true)] });
  mount(`/r/${id}`);
  const trigger = await screen.findByRole("button", { name: "Download" });
  fireEvent.click(trigger);
  const dialogNode = await screen.findByRole("alertdialog", { name: "Download" });
  const dialog = within(dialogNode);
  const description = document.getElementById(dialogNode.getAttribute("aria-describedby") ?? "");
  expect(description?.textContent).toBe("The writeup is always in.");
  const box = dialog.getByRole("checkbox", { name: /Comments and replies/ }) as HTMLInputElement;
  expect(box.checked).toBe(false);
  expect(
    dialog.getByText("Sent comments and the agent's replies, next to their text. Unsent comments stay out."),
  ).toBeTruthy();
  expect(dialog.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(reviewDownloadPath(id, 1));
  fireEvent.click(box);
  expect(dialog.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
    reviewDownloadPath(id, 1, [], { comments: true }),
  );
  expect(dialog.getByRole("link", { name: "Download" }).getAttribute("href")).toContain("?comments=1");
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fireEvent.click(trigger);
  const reopened = within(await screen.findByRole("alertdialog", { name: "Download" }));
  expect((reopened.getByRole("checkbox", { name: /Comments and replies/ }) as HTMLInputElement).checked).toBe(false);
  expect(reopened.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(reviewDownloadPath(id, 1));
});

test("Download combines ticked docs with comments in one link", async () => {
  const value = withDownloadDocs(2, { threads: [downloadThread(true)] });
  mount(`/r/${id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Download" }));
  const dialog = within(await screen.findByRole("alertdialog", { name: "Download" }));
  fireEvent.click(dialog.getByRole("checkbox", { name: /Plan title/ }));
  fireEvent.click(dialog.getByRole("checkbox", { name: /Comments and replies/ }));
  expect(dialog.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
    reviewDownloadPath(id, 1, [value.files[0]?.id ?? ""], { comments: true }),
  );
});

test.each([null, "doc-1.md"])("Download excludes a pub's base doc with main %s", async (main) => {
  withDownloadDocs(2, { writeupEmpty: true, main });
  mount(`/r/${id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Download" }));
  const dialogNode = await screen.findByRole("alertdialog", { name: "Download" });
  const dialog = within(dialogNode);
  expect(dialog.getAllByRole("checkbox")).toHaveLength(1);
  expect(dialog.getByRole("checkbox", { name: main ? /Plan title/ : "doc-1.md" })).toBeTruthy();
  const description = document.getElementById(dialogNode.getAttribute("aria-describedby") ?? "");
  expect(description?.textContent).toBe(
    `${main ?? "Plan title (doc-0.md)"} is always in. Tick docs to add them; with any doc ticked, the download is a ZIP file.`,
  );
  expect(Array.from(description?.querySelectorAll("bdi") ?? [], (node) => node.textContent)).toEqual(
    main ? ["doc-1.md"] : ["Plan title", "doc-0.md"],
  );
});

test("a pub with only its base doc keeps the direct Download link", async () => {
  withDownloadDocs(1, { writeupEmpty: true });
  mount(`/r/${id}`);
  const link = await screen.findByRole("link", { name: "Download" });
  expect(link.getAttribute("href")).toBe(reviewDownloadPath(id, 1));
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
});

test("Download disables unticked docs at 50 and enables them when a choice is cleared", async () => {
  withDownloadDocs(51);
  mount(`/r/${id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Download" }));
  const dialog = within(await screen.findByRole("alertdialog", { name: "Download" }));
  const checkboxes = dialog.getAllByRole("checkbox") as HTMLInputElement[];
  for (const checkbox of checkboxes.slice(0, 50)) fireEvent.click(checkbox);
  const first = checkboxes[0];
  const last = checkboxes[50];
  if (!first || !last) throw new Error("Missing choices");
  expect(last.disabled).toBe(true);
  expect(first.disabled).toBe(false);
  const href = dialog.getByRole("link", { name: "Download" }).getAttribute("href");
  expect(new URL(href ?? "", "http://localhost").searchParams.getAll("doc")).toHaveLength(50);
  fireEvent.click(first);
  expect(last.disabled).toBe(false);
  fireEvent.click(last);
  expect(first.disabled).toBe(true);
});

test("the phone menu opens the doc picker and downloads through its accessible link", async () => {
  width = 390;
  const value = withDownloadDocs();
  mount(`/r/${id}`);
  await screen.findByRole("heading", { name: "Synthetic review", level: 1 });
  // Wait for the revision, not just the review header.
  await screen.findByRole("link", { name: "Docs" });
  const trigger = screen.getByRole("button", { name: "More" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const item = await screen.findByRole("menuitem", { name: "Download" });
  expect(item.tagName).not.toBe("A");
  fireEvent.click(item);
  const dialog = within(await screen.findByRole("alertdialog", { name: "Download" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(dialog.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(reviewDownloadPath(id, 1));
  fireEvent.click(dialog.getByRole("checkbox", { name: "doc-1.md" }));
  const link = dialog.getByRole("link", { name: "Download" });
  expect(link.getAttribute("href")).toBe(reviewDownloadPath(id, 1, [value.files[1]?.id ?? ""]));
  expect(link.hasAttribute("download")).toBe(true);
  // Keep happy-dom from navigating; exercise the link's own close handler.
  link.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(link);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(document.body.style.pointerEvents).not.toBe("none");
});

test("Download can select rendered and source views of the same doc path independently", async () => {
  const value = withDownloadDocs();
  value.docs = [
    { kind: "markdown", path: "plan.md", title: "Plan", blocks: [] },
    { kind: "source", path: "plan.md", title: "Plan", language: "md", lines: [] },
  ];
  value.files = value.files.map((file, index) => ({
    ...file,
    path: "plan.md",
    mediaType: index === 0 ? "text/markdown" : "text/plain",
    ...(index === 1 ? { view: "source" as const } : {}),
  }));
  mount(`/r/${id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Download" }));
  const dialog = within(await screen.findByRole("alertdialog", { name: "Download" }));
  const rendered = dialog.getByRole("checkbox", { description: "plan.md" }) as HTMLInputElement;
  const source = dialog.getByRole("checkbox", { description: "plan.md · source" }) as HTMLInputElement;
  for (const checkbox of [rendered, source]) {
    const description = document.getElementById(checkbox.getAttribute("aria-describedby") ?? "");
    expect(description?.querySelectorAll("bdi")).toHaveLength(1);
    const path = description?.querySelector("bdi");
    expect(path?.textContent).toBe("plan.md");
    expect(path?.nextSibling?.textContent ?? "").toBe(checkbox === source ? " · source" : "");
  }
  expect(source.checked).toBe(false);
  fireEvent.click(rendered);
  expect(rendered.checked).toBe(true);
  expect(source.checked).toBe(false);
  fireEvent.click(source);
  expect(source.checked).toBe(true);
  expect(dialog.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
    reviewDownloadPath(
      id,
      1,
      value.files.map((file) => file.id),
    ),
  );
});
