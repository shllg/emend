import {
  InboxItem,
  KeysSetting,
  placePin,
  ReviewPinPlaceRequest,
  type ReviewView,
  type SettingsView,
  SHORTCUT_DEFAULTS,
} from "@recense/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { inboxSections } from "./lib/inbox-list.ts";
import { defaultLayout, layoutStore } from "./lib/layout-store.ts";
import { Events } from "./test/events.ts";

const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const pinnedAt = "2026-11-04T09:00:00.000Z";
const group = { id: id(100), name: "Alpha", members: 1 };
function item(n: number, patch: Partial<InboxItem> = {}): InboxItem {
  return InboxItem.parse({
    id: id(n),
    title: `Item ${n}`,
    origin: { id: id(200), name: "Workshop" },
    repo: null,
    branch: null,
    state: "open",
    newestRevision: 1,
    unsentCount: 0,
    openThreads: 0,
    agentWaiting: false,
    pendingSend: false,
    updatedAt: "2026-11-04T10:00:00.000Z",
    movedTo: null,
    list: "active",
    snoozed: false,
    snoozedUntil: null,
    activeUntil: null,
    releasedAt: null,
    pickedUpAt: null,
    kind: "review",
    ...patch,
  });
}
function defaultSettings(): SettingsView {
  return {
    approvedActiveHours: { value: 12, source: "default", default: 12, file: null, override: null, fileError: false },
    approvedActiveLimit: { value: 5, source: "default", default: 5, file: null, override: null, fileError: false },
    keys: KeysSetting.parse({
      commands: Object.fromEntries(
        Object.entries(SHORTCUT_DEFAULTS).map(([command, key]) => [
          command,
          { value: key, default: key, source: "default", fileError: false, clashWith: null },
        ]),
      ),
      fileError: false,
    }),
    serverTime: new Date().toISOString(),
  };
}
let items: InboxItem[];
let width: number;
let placeResponse: Promise<Response | undefined> | undefined;
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  width = 1280;
  placeResponse = undefined;
  localStorage.clear();
  layoutStore.update(defaultLayout);
  items = [item(1), item(2, { pinnedAt })];
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, bound, pixels]) =>
      bound === "min" ? width >= Number(pixels) : width <= Number(pixels),
    ),
    addEventListener() {},
    removeEventListener() {},
  }));
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    if (path === "/api/v1/session") return new Response(null, { status: 204 });
    if (path === "/api/v1/settings") return Response.json(defaultSettings());
    if (init?.method === "PUT" && path.endsWith("/pin/place")) {
      const response = await placeResponse;
      if (response) return response;
      const order = placePin(
        inboxSections(items, Date.now())[0]?.rows.map((row) => row.id) ?? [],
        path.split("/")[4] ?? "",
        ReviewPinPlaceRequest.parse(JSON.parse(String(init.body))),
      );
      if (!order) throw new Error("Invalid pin placement");
      items = items.map((row) => ({ ...row, pinOrder: row.pinnedAt === null ? null : order.indexOf(row.id) + 1 }));
      return new Response(null, { status: 204 });
    }
    if (init?.method === "PUT" && path.endsWith("/pin")) {
      const { pinned } = JSON.parse(String(init.body));
      items = items.map((row) =>
        path === `/api/v1/reviews/${row.id}/pin`
          ? {
              ...row,
              pinnedAt: pinned ? pinnedAt : null,
              pinOrder: pinned ? Math.max(0, ...items.map((item) => item.pinOrder ?? 0)) + 1 : null,
            }
          : row,
      );
      return new Response(null, { status: 204 });
    }
    if (path === "/api/v1/reviews")
      return Response.json({
        items,
        groups: items.some((row) => row.groupId === group.id) ? [group] : [],
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date().toISOString(),
      });
    if (path.includes("/revisions/"))
      return Response.json({
        seq: 1,
        base: null,
        head: null,
        main: null,
        writeupEmpty: false,
        topics: [],
        files: [],
        writeup: { sections: [] },
        docs: [],
        threads: [],
        changedBlocks: [],
      });
    const row = items.find((row) => path === `/api/v1/reviews/${row.id}`);
    if (row) return Response.json({ ...row, revisions: [{ seq: 1, createdAt: row.updatedAt }] });
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(path = "/") {
  const history = createMemoryHistory({ initialEntries: [path] });
  const view = render(<App queryClient={client} history={history} />);
  return { ...view, history };
}
async function ready() {
  await waitFor(() => {
    expect(client.getQueryState(["inbox"])?.status).toBe("success");
    expect(client.getQueryState(["settings"])?.status).toBe("success");
  });
}
function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  fireEvent(document.body, event);
  fireEvent.keyUp(document.body, { key, ...options });
  return event;
}
const pinWrites = () =>
  fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith("/pin") && init?.method === "PUT");
async function choose(action: "Pin" | "Unpin") {
  fireEvent.keyDown(await screen.findByRole("button", { name: "More review actions" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
}
async function expectPinned(reviewId: string, pinned: boolean) {
  await waitFor(() =>
    expect(client.getQueryData<ReviewView>(["review", reviewId])?.pinnedAt).toBe(pinned ? pinnedAt : null),
  );
}

test.each([
  ["review", "open"],
  ["review", "approved"],
  ["review", "settled"],
  ["publish", "open"],
  ["publish", "approved"],
  ["publish", "settled"],
] as const)("the %s menu pins and unpins an item in state %s", async (kind, state) => {
  items = [item(1, { kind, state })];
  mount(`/r/${id(1)}`);
  await choose("Pin");
  await expectPinned(id(1), true);
  expect(pinWrites()[0]).toEqual([
    `/api/v1/reviews/${id(1)}/pin`,
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ pinned: true }) }),
  ]);
  expect(await screen.findByRole("region", { name: "Pinned" })).toBeTruthy();
  await choose("Unpin");
  await expectPinned(id(1), false);
  expect(pinWrites()[1]).toEqual([
    `/api/v1/reviews/${id(1)}/pin`,
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ pinned: false }) }),
  ]);
  expect(pinWrites()).toHaveLength(2);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull());
});

test("the command palette pins and unpins the open review", async () => {
  mount(`/r/${id(1)}`);
  await screen.findByRole("button", { name: "More review actions" });
  await ready();
  for (const pinned of [true, false]) {
    fireEvent.click(screen.getByRole("button", { name: "Search reviews and commands" }));
    const palette = within(await screen.findByRole("dialog", { name: "Command palette" }));
    fireEvent.change(palette.getByRole("combobox", { name: "Search" }), { target: { value: "Pin or unpin" } });
    const command = palette.getByRole("option", { name: /^Pin or unpin the review/ });
    expect(command.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(command);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
    await expectPinned(id(1), pinned);
    expect(pinWrites().at(-1)?.[1]?.body).toBe(JSON.stringify({ pinned }));
  }
  expect(pinWrites()).toHaveLength(2);
});

test("Shift+P pins and unpins the open review", async () => {
  mount(`/r/${id(1)}`);
  await screen.findByRole("button", { name: "More review actions" });
  await ready();
  for (const pinned of [true, false]) {
    expect(press("P", { shiftKey: true }).defaultPrevented).toBe(true);
    await expectPinned(id(1), pinned);
    expect(pinWrites().at(-1)?.[1]?.body).toBe(JSON.stringify({ pinned }));
  }
});

test("a pending pin ignores another Shift+P and disables its palette command", async () => {
  const response = Promise.withResolvers<Response>();
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((input, init) => {
    if (String(input).endsWith("/pin")) return response.promise;
    if (!fallback) throw new Error("fetch mock has no default implementation");
    return fallback(input, init);
  });
  mount(`/r/${id(1)}`);
  const trigger = await screen.findByRole("button", { name: "More review actions" });
  await ready();
  press("P", { shiftKey: true });
  await waitFor(() => expect(trigger.getAttribute("aria-busy")).toBe("true"));
  expect(press("P", { shiftKey: true }).defaultPrevented).toBe(false);
  expect(pinWrites()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Search reviews and commands" }));
  const palette = within(await screen.findByRole("dialog", { name: "Command palette" }));
  expect(palette.getByRole("option", { name: /^Pin or unpin the review/ }).getAttribute("aria-disabled")).toBe("true");
  await act(async () => response.resolve(new Response(null, { status: 204 })));
  await waitFor(() =>
    expect(palette.getByRole("option", { name: /^Pin or unpin the review/ }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  expect(pinWrites()).toHaveLength(1);
});

test("a pin stays pending until the review refetch lands, then Shift+P sends the opposite value", async () => {
  mount(`/r/${id(1)}`);
  const trigger = await screen.findByRole("button", { name: "More review actions" });
  await ready();
  await expectPinned(id(1), false);
  const refetch = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === `/api/v1/reviews/${id(1)}`) {
      started.resolve();
      await refetch.promise;
    }
    if (!fallback) throw new Error("fetch mock has no default implementation");
    return fallback(input, init);
  });
  await act(async () => {
    expect(press("P", { shiftKey: true }).defaultPrevented).toBe(true);
    await started.promise;
  });
  await waitFor(() => {
    expect(client.getQueryState(["inbox"])?.fetchStatus).toBe("idle");
    expect(within(screen.getByRole("region", { name: "Pinned" })).getByText("Item 1")).toBeTruthy();
  });
  expect(client.getQueryState(["review", id(1)])?.fetchStatus).toBe("fetching");
  expect(client.getQueryData<ReviewView>(["review", id(1)])?.pinnedAt).toBeNull();
  expect(client.isMutating()).toBe(1);
  expect(trigger.getAttribute("aria-busy")).toBe("true");
  expect(press("P", { shiftKey: true }).defaultPrevented).toBe(false);
  expect(pinWrites()).toHaveLength(1);
  expect(pinWrites()[0]?.[1]?.body).toBe(JSON.stringify({ pinned: true }));

  await act(async () => refetch.resolve());
  await expectPinned(id(1), true);
  await waitFor(() => {
    expect(client.isMutating()).toBe(0);
    expect(trigger.getAttribute("aria-busy")).not.toBe("true");
  });
  expect(press("P", { shiftKey: true }).defaultPrevented).toBe(true);
  await expectPinned(id(1), false);
  expect(pinWrites()).toHaveLength(2);
  expect(pinWrites()[1]?.[1]?.body).toBe(JSON.stringify({ pinned: false }));
});

test("Pinned shows its count above Active, opens at start and folds", async () => {
  const { container } = mount();
  const section = within(await screen.findByRole("region", { name: "Pinned" }));
  expect(
    [...container.querySelectorAll("section[aria-label]")].map((section) => section.getAttribute("aria-label")),
  ).toEqual(["Pinned", "Active"]);
  const toggle = section.getByRole("button", { name: "Pinned 1" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(section.getByText("Item 2")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Active" })).queryByText("Item 2")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(section.queryByRole("link")).toBeNull();
  fireEvent.click(toggle);
  expect(section.getByText("Item 2")).toBeTruthy();
});

test("Pinned disappears when no pins or no matching pins remain", async () => {
  items = [item(1), item(2, { pinnedAt, kind: "publish", title: "Pinned doc" })];
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  fireEvent.click(screen.getByRole("radio", { name: "Reviews" }));
  expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Pubs" }));
  expect(within(screen.getByRole("region", { name: "Pinned" })).getByText("Pinned doc")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "Missing" } });
  expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "" } });
  items = items.map((row) => ({ ...row, pinnedAt: null }));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["inbox"] });
  });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull());
});

test.each([
  ["Done", { list: "done", state: "settled" }],
  ["Snoozed", { list: "snoozed", snoozed: true }],
  ["Alpha", { groupId: group.id }],
] as const)(
  "a pinned row in %s has a pin mark and no jump badge; its Pinned copy has only the jump badge",
  async (title, patch) => {
    items = [item(1), item(2, { pinnedAt, ...patch })];
    mount();
    const pinned = within(await screen.findByRole("region", { name: "Pinned" }));
    await ready();
    const own = within(screen.getByRole("region", { name: title }));
    fireEvent.click(own.getByRole("button", { name: `${title} 1` }));
    const copy = own.getByRole("link");
    expect(own.getByRole("img", { name: "Pinned" })).toBeTruthy();
    expect(pinned.queryByRole("img", { name: "Pinned" })).toBeNull();
    expect(copy.querySelector("[data-jump-number]")).toBeNull();
    expect(copy.getAttribute("aria-keyshortcuts")).toBeNull();
    const top = pinned.getByRole("link");
    expect(top.querySelector("[data-jump-number]")?.textContent).toBe("1");
    expect(top.getAttribute("aria-keyshortcuts")).toBe("Alt+1");
    expect(top.className).toBe(copy.className);
    if (title === "Snoozed") {
      expect(pinned.getByText("until it changes")).toBeTruthy();
      expect(own.getByText("until it changes")).toBeTruthy();
    }
  },
);

test.each(["page", "pane", "rail"])("Alt+1 opens Pinned and Alt+2 opens Active from the %s", async (surface) => {
  if (surface === "rail") layoutStore.update({ inboxCollapsed: true });
  const { history } = mount(surface === "page" ? "/" : `/r/${id(1)}`);
  await ready();
  expect(press("1", { altKey: true, code: "Digit1" }).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(2)}`));
  await screen.findByRole("heading", { name: "Item 2", level: 1 });
  expect(press("2", { altKey: true, code: "Digit2" }).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(1)}`));
});

test("folded Pinned and Active sections contribute no jump badges", async () => {
  items.push(item(3, { list: "done" }));
  const { history } = mount();
  const pinned = within(await screen.findByRole("region", { name: "Pinned" }));
  await ready();
  const active = within(screen.getByRole("region", { name: "Active" }));
  fireEvent.click(pinned.getByRole("button", { name: "Pinned 1" }));
  expect(active.getByRole("link").querySelector("[data-jump-number]")?.textContent).toBe("1");
  fireEvent.click(active.getByRole("button", { name: "Active 1" }));
  expect(document.querySelectorAll("[data-jump-number]")).toHaveLength(0);
  press("1", { altKey: true, code: "Digit1" });
  expect(history.location.pathname).toBe("/");
  fireEvent.click(screen.getByRole("button", { name: "Done 1" }));
  const done = within(screen.getByRole("region", { name: "Done" })).getByRole("link");
  expect(done.querySelector("[data-jump-number]")?.textContent).toBe("1");
  expect(document.querySelectorAll("[data-jump-number]")).toHaveLength(1);
  press("1", { altKey: true, code: "Digit1" });
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(3)}`));
});

test("j and k visit a pinned Done item once, in Pinned", async () => {
  items = [item(1), item(2, { pinnedAt, list: "done", state: "settled" }), item(3, { list: "done", state: "settled" })];
  mount();
  const pinned = within(await screen.findByRole("region", { name: "Pinned" })).getByRole("link");
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Done 2" }));
  const active = within(screen.getByRole("region", { name: "Active" })).getByRole("link");
  const last = within(screen.getByRole("region", { name: "Done" })).getByRole("link", { name: /Item 3/ });
  for (const row of [pinned, active, last]) {
    press("j");
    expect(document.activeElement).toBe(row);
  }
  for (const row of [active, pinned]) {
    press("k");
    expect(document.activeElement).toBe(row);
  }
});

test("j and k start from the focused Done duplicate's position", async () => {
  items = [item(1), item(2, { pinnedAt, list: "done", state: "settled" }), item(3, { list: "done", state: "settled" })];
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Done 2" }));
  const done = within(screen.getByRole("region", { name: "Done" }));
  const duplicate = done.getByRole("link", { name: /Item 2/ });
  duplicate.focus();
  press("j");
  expect(document.activeElement).toBe(done.getByRole("link", { name: /Item 3/ }));
  duplicate.focus();
  press("k");
  expect(document.activeElement).toBe(
    within(screen.getByRole("region", { name: "Active" })).getByRole("link", { name: /Item 1/ }),
  );
});

test("the collapsed rail lists each review once, pins first, and keeps its jump badges", async () => {
  localStorage.setItem("recense:inbox-kind", "review");
  layoutStore.update({ inboxCollapsed: true });
  items = [
    item(1),
    item(2, { pinnedAt, list: "done", kind: "publish" }),
    item(3, { pinnedAt, groupId: group.id }),
    item(4, { list: "done" }),
    item(5, { pinnedAt, movedTo: "https://example.com/review" }),
  ];
  mount(`/r/${id(1)}`);
  const rail = within(await screen.findByRole("complementary", { name: "Inbox" }));
  await ready();
  const links = rail.getAllByRole("link");
  expect(links.map((link) => link.getAttribute("aria-label"))).toEqual(["Item 2", "Item 3", "Item 1", "Item 4"]);
  expect(links.map((link) => link.querySelector("[data-jump-number]")?.textContent)).toEqual(["1", "2", "3", "4"]);
});

test("a pins event refreshes the inbox and the open review", async () => {
  items = [item(1)];
  mount(`/r/${id(1)}`);
  await screen.findByRole("button", { name: "More review actions" });
  await ready();
  expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
  items = [item(1, { pinnedAt })];
  await waitFor(() => expect(Events.opened.length).toBeGreaterThan(0));
  const source = Events.opened.at(-1);
  if (!source) throw new Error("missing EventSource");
  act(() => source.emit("pins", { reviewId: id(1) }));
  expect(await screen.findByRole("region", { name: "Pinned" })).toBeTruthy();
  await expectPinned(id(1), true);
  fireEvent.keyDown(screen.getByRole("button", { name: "More review actions" }), { key: "ArrowDown" });
  expect(await screen.findByRole("menuitem", { name: "Unpin" })).toBeTruthy();
  expect(pinWrites()).toHaveLength(0);
});

function orderedPins(count = 3) {
  items = Array.from({ length: count }, (_, index) => item(index + 1, { pinnedAt, pinOrder: index + 1 }));
}
const placeWrites = () =>
  fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith("/pin/place") && init?.method === "PUT");
const pinnedRegion = () => screen.getByRole("region", { name: "Pinned" });
const pinLinks = () => within(pinnedRegion()).getAllByRole("link");
const shownPins = () => pinLinks().map((link) => link.getAttribute("data-inbox-row"));
const pinStatus = () => {
  const inbox = pinnedRegion().closest<HTMLElement>("[data-row-menu-surface]");
  if (!inbox) throw new Error("Missing inbox");
  return within(inbox).getByRole("status");
};
async function pinMenu(row: HTMLElement, key = "ContextMenu") {
  act(() => row.focus());
  fireEvent.keyDown(row, { key, shiftKey: key === "F10" });
  return screen.findByRole("menu");
}
async function movePin(row: HTMLElement, direction: "up" | "down") {
  const menu = await pinMenu(row);
  fireEvent.click(within(menu).getByRole("menuitem", { name: `Move ${direction}` }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}
async function expectMove(n: number, place: ReviewPinPlaceRequest, order: number[], announcement: string) {
  await waitFor(() => {
    expect(client.isMutating()).toBe(0);
    expect(shownPins()).toEqual(order.map(id));
    expect(pinStatus().textContent).toBe(announcement);
  });
  expect(placeWrites().at(-1)).toEqual([
    `/api/v1/reviews/${id(n)}/pin/place`,
    expect.objectContaining({ method: "PUT", body: JSON.stringify(place) }),
  ]);
}

test.each([
  [1, ["Move down"]],
  [2, ["Move up", "Move down"]],
  [3, ["Move up"]],
] as const)("pin %s has only its available moves, directly after Unpin", async (n, expected) => {
  orderedPins();
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  const menu = await pinMenu(within(pinnedRegion()).getByRole("link", { name: new RegExp(`Item ${n}`) }), "F10");
  const labels = within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent);
  expect(labels.filter((label) => label === "Move up" || label === "Move down")).toEqual(expected);
  const unpin = labels.indexOf("Unpin");
  expect(labels.slice(unpin + 1, unpin + 1 + expected.length)).toEqual(expected);
});

test("a single pin has neither move", async () => {
  orderedPins(1);
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  const menu = within(await pinMenu(pinLinks()[0] as HTMLElement));
  expect(menu.queryByRole("menuitem", { name: "Move up" })).toBeNull();
  expect(menu.queryByRole("menuitem", { name: "Move down" })).toBeNull();
});

test("an open pin menu keeps its moves until reopened after a fresh inbox response", async () => {
  orderedPins();
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 2/ });
  const menu = within(await pinMenu(row));
  expect(menu.getByRole("menuitem", { name: "Move up" })).toBeTruthy();
  expect(menu.getByRole("menuitem", { name: "Move down" })).toBeTruthy();
  items = items.map((row) => ({ ...row, pinOrder: [id(2), id(1), id(3)].indexOf(row.id) + 1 }));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["inbox"] });
  });
  await waitFor(() => expect(shownPins()).toEqual([2, 1, 3].map(id)));
  expect(menu.getByRole("menuitem", { name: "Move up" })).toBeTruthy();
  expect(menu.getByRole("menuitem", { name: "Move down" })).toBeTruthy();
  fireEvent.click(menu.getByRole("menuitem", { name: "Move up" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(placeWrites()).toHaveLength(0);
  expect(shownPins()).toEqual([2, 1, 3].map(id));
  const reopened = within(await pinMenu(row));
  expect(reopened.queryByRole("menuitem", { name: "Move up" })).toBeNull();
  expect(reopened.getByRole("menuitem", { name: "Move down" })).toBeTruthy();
});

test("a focused Move up keeps its identity when a fresh inbox response puts the pin first", async () => {
  orderedPins();
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 2/ });
  const menu = within(await pinMenu(row, "F10"));
  const moveUp = menu.getByRole("menuitem", { name: "Move up" });
  const menuItems = menu.getAllByRole("menuitem").filter((item) => !item.hasAttribute("data-disabled"));
  await waitFor(() => expect(document.activeElement).toBe(menuItems[0]));
  for (const item of menuItems.slice(1, menuItems.indexOf(moveUp) + 1)) {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(item));
  }
  expect(document.activeElement).toBe(moveUp);
  items = items.map((row) => ({ ...row, pinOrder: [id(2), id(1), id(3)].indexOf(row.id) + 1 }));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["inbox"] });
  });
  await waitFor(() => expect(shownPins()).toEqual([2, 1, 3].map(id)));
  expect(document.activeElement).toBe(moveUp);
  expect(document.activeElement?.textContent).toBe("Move up");
  fireEvent.keyDown(moveUp, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(placeWrites()).toHaveLength(0);
  expect(shownPins()).toEqual([2, 1, 3].map(id));
});

test("choosing a move in an open menu uses the fresh neighbour and announces the current place", async () => {
  orderedPins();
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 2/ });
  const menu = within(await pinMenu(row));
  items = items.map((row) => ({ ...row, pinOrder: [id(3), id(2), id(1)].indexOf(row.id) + 1 }));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["inbox"] });
  });
  await waitFor(() => expect(shownPins()).toEqual([3, 2, 1].map(id)));
  fireEvent.click(menu.getByRole("menuitem", { name: "Move up" }));
  await expectMove(2, { before: id(3) }, [2, 3, 1], "Moved to place 1 of 3");
  await waitFor(() => expect(document.activeElement).toBe(row));
});

test.each(["up", "down"])(
  "an open pin menu keeps its moves but Move %s does nothing when the filter hides the pin",
  async (direction) => {
    orderedPins();
    mount();
    await screen.findByRole("region", { name: "Pinned" });
    const menu = within(await pinMenu(within(pinnedRegion()).getByRole("link", { name: /Item 2/ })));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "Item 1" } });
    expect(shownPins()).toEqual([id(1)]);
    expect(menu.getByRole("menuitem", { name: "Unpin" })).toBeTruthy();
    expect(menu.getByRole("menuitem", { name: "Move up" })).toBeTruthy();
    expect(menu.getByRole("menuitem", { name: "Move down" })).toBeTruthy();
    fireEvent.click(menu.getByRole("menuitem", { name: `Move ${direction}` }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(placeWrites()).toHaveLength(0);
    expect(shownPins()).toEqual([id(1)]);
    expect(pinStatus().textContent).toBe("");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "" } });
    expect(shownPins()).toEqual([1, 2, 3].map(id));
  },
);

test("an open pin menu keeps its moves but sends no placement after the row is unpinned elsewhere", async () => {
  orderedPins();
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  const menu = within(await pinMenu(within(pinnedRegion()).getByRole("link", { name: /Item 2/ })));
  items = items.map((row) => (row.id === id(2) ? { ...row, pinnedAt: null, pinOrder: null } : row));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["inbox"] });
  });
  await waitFor(() => expect(shownPins()).toEqual([1, 3].map(id)));
  expect(menu.getByRole("menuitem", { name: "Move up" })).toBeTruthy();
  expect(menu.getByRole("menuitem", { name: "Move down" })).toBeTruthy();
  fireEvent.click(menu.getByRole("menuitem", { name: "Move down" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(placeWrites()).toHaveLength(0);
  expect(shownPins()).toEqual([1, 3].map(id));
});

test.each([
  ["Snoozed", { list: "snoozed", snoozed: true }],
  ["Done", { list: "done", state: "settled" }],
  ["Alpha", { groupId: group.id }],
] as const)("a pin's copy in %s has no ordering actions", async (title, patch) => {
  orderedPins();
  items = items.map((row) => (row.id === id(2) ? { ...row, ...patch } : row));
  mount();
  const own = within(await screen.findByRole("region", { name: title }));
  fireEvent.click(own.getByRole("button", { name: `${title} 1` }));
  const menu = within(await pinMenu(own.getByRole("link")));
  expect(menu.getByRole("menuitem", { name: "Unpin" })).toBeTruthy();
  expect(menu.queryByRole("menuitem", { name: "Move up" })).toBeNull();
  expect(menu.queryByRole("menuitem", { name: "Move down" })).toBeNull();
});

test.each(["rail", "review"])("the %s menu has no ordering actions", async (surface) => {
  orderedPins();
  if (surface === "rail") layoutStore.update({ inboxCollapsed: true });
  mount(`/r/${id(2)}`);
  if (surface === "rail") {
    const rail = within(await screen.findByRole("complementary", { name: "Inbox" }));
    await pinMenu(await rail.findByRole("link", { name: "Item 2" }));
  } else fireEvent.keyDown(await screen.findByRole("button", { name: "More review actions" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu"));
  expect(menu.getByRole("menuitem", { name: "Unpin" })).toBeTruthy();
  expect(menu.queryByRole("menuitem", { name: "Move up" })).toBeNull();
  expect(menu.queryByRole("menuitem", { name: "Move down" })).toBeNull();
});

test("Move up reorders immediately, keeps the row mounted and focused, and announces only after acceptance", async () => {
  orderedPins();
  const response = Promise.withResolvers<Response | undefined>();
  placeResponse = response.promise;
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 3/ });
  await movePin(row, "up");
  await waitFor(() => expect(shownPins()).toEqual([1, 3, 2].map(id)));
  expect(items.map((row) => row.pinOrder)).toEqual([1, 2, 3]);
  expect(pinLinks()[1]).toBe(row);
  expect(row.isConnected).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(pinStatus().textContent).toBe("");
  await act(async () => response.resolve(undefined));
  await expectMove(3, { before: id(2) }, [1, 3, 2], "Moved to place 2 of 3");
});

test("a move announces the server's current place only after the inbox refetch", async () => {
  orderedPins();
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  await ready();
  const refetch = Promise.withResolvers<void>();
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === "/api/v1/reviews") await refetch.promise;
    if (!fallback) throw new Error("fetch mock has no default implementation");
    return fallback(input, init);
  });
  items = items.map((row) => ({ ...row, pinOrder: [id(2), id(1), id(3)].indexOf(row.id) + 1 }));
  expect(shownPins()).toEqual([1, 2, 3].map(id));
  await movePin(within(pinnedRegion()).getByRole("link", { name: /Item 3/ }), "up");
  await waitFor(() => {
    expect(client.isMutating({ mutationKey: ["pin-place"] })).toBe(0);
    expect(client.isFetching({ queryKey: ["inbox"] })).toBe(1);
  });
  expect(placeWrites()[0]?.[1]?.body).toBe(JSON.stringify({ before: id(2) }));
  expect(shownPins()).toEqual([1, 3, 2].map(id));
  expect(pinStatus().textContent).toBe("");
  await act(async () => refetch.resolve());
  await expectMove(3, { before: id(2) }, [3, 2, 1], "Moved to place 1 of 3");
});

test("an accepted move makes no announcement if its pin is hidden when the refetch finishes", async () => {
  orderedPins();
  const response = Promise.withResolvers<Response | undefined>();
  placeResponse = response.promise;
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  await movePin(within(pinnedRegion()).getByRole("link", { name: /Item 3/ }), "up");
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "Item 1" } });
  await act(async () => response.resolve(undefined));
  await waitFor(() => {
    expect(client.isMutating({ mutationKey: ["pin-place"] })).toBe(0);
    expect(client.isFetching({ queryKey: ["inbox"] })).toBe(0);
  });
  expect(shownPins()).toEqual([id(1)]);
  expect(pinStatus().textContent).toBe("");
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "" } });
  expect(shownPins()).toEqual([1, 3, 2].map(id));
  expect(pinStatus().textContent).toBe("");
});

test("Move down places after the next pin and repeated announcements replace the live text node", async () => {
  orderedPins();
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 1/ });
  await movePin(row, "down");
  await expectMove(1, { after: id(2) }, [2, 1, 3], "Moved to place 2 of 3");
  const firstAnnouncement = pinStatus().firstChild;
  await movePin(within(pinnedRegion()).getByRole("link", { name: /Item 3/ }), "up");
  await expectMove(3, { before: id(1) }, [2, 3, 1], "Moved to place 2 of 3");
  expect(pinStatus().firstChild).not.toBe(firstAnnouncement);
});

test("quick moves are optimistic together and reach the server one at a time, including pins events", async () => {
  orderedPins();
  const first = Promise.withResolvers<Response | undefined>();
  const second = Promise.withResolvers<Response | undefined>();
  placeResponse = first.promise;
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 3/ });
  await movePin(row, "up");
  await waitFor(() => expect(shownPins()).toEqual([1, 3, 2].map(id)));
  await movePin(row, "up");
  await waitFor(() => expect(shownPins()).toEqual([3, 1, 2].map(id)));
  expect(placeWrites()).toHaveLength(1);
  placeResponse = second.promise;
  await act(async () => first.resolve(undefined));
  await waitFor(() => expect(placeWrites()).toHaveLength(2));
  expect(pinStatus().textContent).toBe("");
  expect(placeWrites().map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { before: id(2) },
    { before: id(1) },
  ]);
  await waitFor(() => expect(Events.opened.length).toBeGreaterThan(0));
  const source = Events.opened.at(-1);
  if (!source) throw new Error("Missing EventSource");
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const inboxReads = fetchMock.mock.calls.filter(([path]) => path === "/api/v1/reviews").length;
  act(() => source.emit("pins", { reviewId: id(3) }));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inbox"], refetchType: "none" });
  expect(shownPins()).toEqual([3, 1, 2].map(id));
  expect(fetchMock.mock.calls.filter(([path]) => path === "/api/v1/reviews")).toHaveLength(inboxReads);
  await act(async () => second.resolve(undefined));
  await expectMove(3, { before: id(1) }, [3, 1, 2], "Moved to place 1 of 3");
});

test("queued moves of different pins announce only the latest accepted move", async () => {
  orderedPins();
  const first = Promise.withResolvers<Response | undefined>();
  const second = Promise.withResolvers<Response | undefined>();
  placeResponse = first.promise;
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  await movePin(within(pinnedRegion()).getByRole("link", { name: /Item 3/ }), "up");
  await waitFor(() => expect(shownPins()).toEqual([1, 3, 2].map(id)));
  await movePin(within(pinnedRegion()).getByRole("link", { name: /Item 1/ }), "down");
  await waitFor(() => expect(shownPins()).toEqual([3, 1, 2].map(id)));
  expect(placeWrites()).toHaveLength(1);
  placeResponse = second.promise;
  await act(async () => first.resolve(undefined));
  await waitFor(() => expect(placeWrites()).toHaveLength(2));
  expect(pinStatus().textContent).toBe("");
  await act(async () => second.resolve(undefined));
  await expectMove(1, { after: id(3) }, [3, 1, 2], "Moved to place 2 of 3");
});

test("a new pin joins below the reordered pins", async () => {
  orderedPins();
  items.push(item(4));
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  await movePin(within(pinnedRegion()).getByRole("link", { name: /Item 3/ }), "up");
  await expectMove(3, { before: id(2) }, [1, 3, 2], "Moved to place 2 of 3");
  const active = within(screen.getByRole("region", { name: "Active" })).getByRole("link");
  fireEvent.contextMenu(active, { clientX: 100, clientY: 350 });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
  await waitFor(() => expect(shownPins()).toEqual([1, 3, 2, 4].map(id)));
});

test("a phone swipe menu moves a pin and restores focus to that row", async () => {
  width = 390;
  orderedPins();
  const { history } = mount();
  await screen.findByRole("region", { name: "Pinned" });
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 3/ });
  pointer(row, "pointerdown", { pointerType: "touch", clientX: 200, clientY: 250 });
  pointer(row, "pointermove", { pointerType: "touch", clientX: 120, clientY: 250 });
  pointer(row, "pointerup", { pointerType: "touch", clientX: 120, clientY: 250 });
  expect(fireEvent.click(row, { detail: 1 })).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Actions for “Item 3”" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move up" }));
  await expectMove(3, { before: id(2) }, [1, 3, 2], "Moved to place 2 of 3");
  expect(pinLinks()[1]).toBe(row);
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(history.location.pathname).toBe("/");
  expect(pinnedRegion().querySelector(".em-pin-grip")).toBeNull();
});

test("a filtered move goes past the shown neighbour and counts only shown pins", async () => {
  orderedPins();
  items = items.map((row) => ({ ...row, title: row.id === id(2) ? "Hidden" : row.title }));
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "Item" } });
  await movePin(within(pinnedRegion()).getByRole("link", { name: /Item 1/ }), "down");
  await expectMove(1, { after: id(3) }, [3, 1], "Moved to place 2 of 2");
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "" } });
  expect(shownPins()).toEqual([2, 3, 1].map(id));
});

test("a stale pin placement shows the server message and refetches the true order", async () => {
  orderedPins();
  const response = Promise.withResolvers<Response | undefined>();
  placeResponse = response.promise;
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  await ready();
  const reads = fetchMock.mock.calls.filter(([path]) => path === "/api/v1/reviews").length;
  await movePin(within(pinnedRegion()).getByRole("link", { name: /Item 3/ }), "up");
  await waitFor(() => expect(shownPins()).toEqual([1, 3, 2].map(id)));
  await act(async () =>
    response.resolve(
      Response.json(
        { error: { code: "invalid_state", message: "The pins changed. Check them and try again." } },
        { status: 409 },
      ),
    ),
  );
  expect(await screen.findByText("The pins changed. Check them and try again.")).toBeTruthy();
  await waitFor(() => expect(shownPins()).toEqual([1, 2, 3].map(id)));
  expect(fetchMock.mock.calls.filter(([path]) => path === "/api/v1/reviews").length).toBeGreaterThan(reads);
  expect(pinStatus().textContent).toBe("");
});

test("a fresh inbox load keeps the saved pin order and renumbers jumps", async () => {
  orderedPins();
  const first = mount();
  await screen.findByRole("region", { name: "Pinned" });
  await movePin(within(pinnedRegion()).getByRole("link", { name: /Item 3/ }), "up");
  await expectMove(3, { before: id(2) }, [1, 3, 2], "Moved to place 2 of 3");
  first.unmount();
  client.clear();
  // The response retains its original array order; only the server's pinOrder values changed.
  expect(items.map((row) => row.id)).toEqual([1, 2, 3].map(id));
  const { history } = mount();
  await screen.findByRole("region", { name: "Pinned" });
  await ready();
  expect(shownPins()).toEqual([1, 3, 2].map(id));
  expect(pinLinks().map((row) => row.querySelector("[data-jump-number]")?.textContent)).toEqual(["1", "2", "3"]);
  expect(pinLinks().map((row) => row.getAttribute("aria-keyshortcuts"))).toEqual(["Alt+1", "Alt+2", "Alt+3"]);
  press("2", { altKey: true, code: "Digit2" });
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(3)}`));
});

function pointer(target: HTMLElement, type: string, patch: PointerEventInit = {}) {
  return fireEvent(
    target,
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 100,
      clientY: 250,
      ...patch,
    }),
  );
}
function pinRects() {
  const list = within(pinnedRegion()).getByRole("list");
  // happy-dom has no layout; give the containing surfaces a viewport-sized box.
  for (let ancestor = list.parentElement; ancestor; ancestor = ancestor.parentElement)
    vi.spyOn(ancestor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1280, 800));
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 100, 300, 180));
  for (const [index, row] of within(list).getAllByRole("listitem").entries()) {
    const rect = new DOMRect(20, 100 + index * 60, 300, 60);
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect);
    vi.spyOn(within(row).getByRole("link"), "getBoundingClientRect").mockReturnValue(rect);
  }
}

test("a scrolled Pinned list rejects drops above its scroller and still accepts visible drops", async () => {
  orderedPins();
  mount(`/r/${id(1)}`);
  await screen.findByRole("region", { name: "Pinned" });
  pinRects();
  const scroller = pinnedRegion().parentElement;
  if (!scroller) throw new Error("Missing inbox scroller");
  scroller.style.overflowY = "auto";
  scroller.scrollTop = 80;
  vi.mocked(scroller.getBoundingClientRect).mockReturnValue(new DOMRect(20, 180, 300, 400));
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 3/ });
  pointer(row, "pointerdown");
  pointer(row, "pointermove", { clientY: 185 });
  const line = pinnedRegion().querySelector<HTMLElement>("[data-pin-drop-slot]");
  expect(line?.dataset.pinDropSlot).toBe("1");
  expect(line?.style.top).toBe("80px");
  pointer(row, "pointermove", { clientY: 110 });
  expect(pinnedRegion().querySelector("[data-pin-drop-slot]")).toBeNull();
  pointer(row, "pointerup", { clientY: 110 });
  expect(shownPins()).toEqual([1, 2, 3].map(id));
  expect(placeWrites()).toHaveLength(0);
  pointer(row, "pointerdown");
  pointer(row, "pointermove", { clientY: 185 });
  expect(pinnedRegion().querySelector("[data-pin-drop-slot]")?.getAttribute("data-pin-drop-slot")).toBe("1");
  pointer(row, "pointerup", { clientY: 185 });
  await expectMove(3, { before: id(2) }, [1, 3, 2], "Moved to place 2 of 3");
});

test.each(["ancestor", "viewport"])("the %s also clips the Pinned drop area", async (clip) => {
  orderedPins();
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  pinRects();
  if (clip === "ancestor") {
    const scroller = pinnedRegion().parentElement;
    const main = pinnedRegion().closest("main");
    if (!scroller || !main) throw new Error("Missing inbox containers");
    scroller.style.overflowY = "auto";
    main.style.overflowX = "hidden";
    vi.mocked(main.getBoundingClientRect).mockReturnValue(new DOMRect(60, 100, 260, 180));
  } else vi.stubGlobal("innerWidth", 90);
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 3/ });
  const point = { clientX: clip === "ancestor" ? 40 : 100, clientY: 110 };
  pointer(row, "pointerdown", { clientX: 80 });
  pointer(row, "pointermove", point);
  expect(pinnedRegion().querySelector("[data-pin-drop-slot]")).toBeNull();
  pointer(row, "pointerup", point);
  expect(placeWrites()).toHaveLength(0);
  expect(shownPins()).toEqual([1, 2, 3].map(id));
});

test.each(["page", "pane", "tablet sheet"])(
  "mouse drag puts the third pin first in the %s without navigating",
  async (surface) => {
    orderedPins();
    if (surface === "tablet sheet") width = 900;
    const { history } = mount(surface === "page" ? "/" : `/r/${id(1)}`);
    if (surface === "tablet sheet") fireEvent.click(await screen.findByRole("button", { name: "Show inbox" }));
    await screen.findByRole("region", { name: "Pinned" });
    pinRects();
    const row = within(pinnedRegion()).getByRole("link", { name: /Item 3/ });
    const capture = vi.fn();
    Object.defineProperty(row, "setPointerCapture", { configurable: true, value: capture });
    pointer(row, "pointerdown");
    expect(capture).not.toHaveBeenCalled();
    pointer(row, "pointermove", { clientY: 110 });
    expect(capture).toHaveBeenCalledWith(1);
    expect(row.closest("li")?.hasAttribute("data-pin-dragging")).toBe(true);
    expect(shownPins()).toEqual([1, 2, 3].map(id));
    expect(pinnedRegion().querySelector("[data-pin-drop-slot]")?.getAttribute("data-pin-drop-slot")).toBe("0");
    expect(row.getAttribute("draggable")).toBe("false");
    expect(fireEvent.dragStart(row)).toBe(false);
    pointer(row, "pointerup", { clientY: 110 });
    expect(fireEvent.click(row, { detail: 1 })).toBe(false);
    await expectMove(3, { before: id(1) }, [3, 1, 2], "Moved to place 1 of 3");
    if (surface === "tablet sheet") expect(screen.getByRole("dialog", { name: "Inbox" })).toBeTruthy();
    expect(pinLinks()[0]).toBe(row);
    expect(document.body.classList.contains("em-pin-dragging")).toBe(false);
    expect(history.location.pathname).toBe(surface === "page" ? "/" : `/r/${id(1)}`);
  },
);

test("a mouse movement under four pixels stays a normal click", async () => {
  orderedPins();
  const { history } = mount();
  await screen.findByRole("region", { name: "Pinned" });
  pinRects();
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 3/ });
  pointer(row, "pointerdown");
  pointer(row, "pointermove", { clientX: 102, clientY: 252 });
  pointer(row, "pointerup", { clientX: 102, clientY: 252 });
  expect(pinnedRegion().querySelector("[data-pin-dragging]")).toBeNull();
  fireEvent.click(row, { detail: 1 });
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(3)}`));
  expect(placeWrites()).toHaveLength(0);
});

test.each([
  ["outside vertically", { clientY: 90 }, null],
  ["outside horizontally", { clientX: 400 }, null],
  ["just above itself", { clientY: 230 }, "2"],
  ["just below itself", { clientY: 270 }, "3"],
] as const)("dropping %s keeps the pin in place", async (_name, point, slot) => {
  orderedPins();
  const { history } = mount();
  await screen.findByRole("region", { name: "Pinned" });
  pinRects();
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 3/ });
  pointer(row, "pointerdown");
  pointer(row, "pointermove", point);
  expect(pinnedRegion().querySelector("[data-pin-drop-slot]")?.getAttribute("data-pin-drop-slot") ?? null).toBe(slot);
  pointer(row, "pointerup", point);
  expect(fireEvent.click(row, { detail: 1 })).toBe(false);
  expect(history.location.pathname).toBe("/");
  expect(shownPins()).toEqual([1, 2, 3].map(id));
  expect(placeWrites()).toHaveLength(0);
  expect(items.every((row) => row.pinnedAt === pinnedAt)).toBe(true);
});

test("dropping after the last pin uses that pin as the after anchor", async () => {
  orderedPins();
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  pinRects();
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 1/ });
  pointer(row, "pointerdown", { clientY: 130 });
  pointer(row, "pointermove", { clientY: 270 });
  pointer(row, "pointerup", { clientY: 270 });
  await expectMove(1, { after: id(3) }, [2, 3, 1], "Moved to place 3 of 3");
});

test.each(["Escape", "pointercancel"])("%s cancels a drag and suppresses its click", async (end) => {
  orderedPins();
  const { history } = mount();
  await screen.findByRole("region", { name: "Pinned" });
  pinRects();
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 3/ });
  pointer(row, "pointerdown");
  pointer(row, "pointermove", { clientY: 110 });
  if (end === "Escape") fireEvent.keyDown(document.body, { key: "Escape" });
  else pointer(row, "pointercancel");
  pointer(row, "pointerup", { clientY: 110 });
  expect(fireEvent.click(row, { detail: 1 })).toBe(false);
  expect(history.location.pathname).toBe("/");
  expect(shownPins()).toEqual([1, 2, 3].map(id));
  expect(placeWrites()).toHaveLength(0);
  expect(pinnedRegion().querySelector("[data-pin-drop-slot]")).toBeNull();
  expect(document.body.classList.contains("em-pin-dragging")).toBe(false);
});

test.each([
  ["touch", 1280, { pointerType: "touch" }],
  ["pen", 1280, { pointerType: "pen" }],
  ["phone mouse", 390, {}],
  ["right button", 1280, { button: 2 }],
  ["Shift", 1280, { shiftKey: true }],
  ["Control", 1280, { ctrlKey: true }],
  ["Alt", 1280, { altKey: true }],
  ["Meta", 1280, { metaKey: true }],
] as const)("%s never starts a pin drag", async (_name, pixels, patch) => {
  width = pixels;
  orderedPins();
  mount();
  await screen.findByRole("region", { name: "Pinned" });
  pinRects();
  const row = within(pinnedRegion()).getByRole("link", { name: /Item 3/ });
  pointer(row, "pointerdown", patch);
  pointer(row, "pointermove", { ...patch, clientY: 110 });
  pointer(row, "pointerup", { ...patch, clientY: 110 });
  expect(shownPins()).toEqual([1, 2, 3].map(id));
  expect(placeWrites()).toHaveLength(0);
  expect(pinnedRegion().querySelector("[data-pin-drop-slot]")).toBeNull();
});
