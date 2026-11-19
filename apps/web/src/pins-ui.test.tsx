import { InboxItem, KeysSetting, type ReviewView, type SettingsView, SHORTCUT_DEFAULTS } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
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
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  localStorage.clear();
  layoutStore.update(defaultLayout);
  items = [item(1), item(2, { pinnedAt })];
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, bound, pixels]) =>
      bound === "min" ? 1280 >= Number(pixels) : 1280 <= Number(pixels),
    ),
    addEventListener() {},
    removeEventListener() {},
  }));
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    if (path === "/api/v1/session") return new Response(null, { status: 204 });
    if (path === "/api/v1/settings") return Response.json(defaultSettings());
    if (init?.method === "PUT" && path.endsWith("/pin")) {
      const { pinned } = JSON.parse(String(init.body));
      items = items.map((row) =>
        path === `/api/v1/reviews/${row.id}/pin` ? { ...row, pinnedAt: pinned ? pinnedAt : null } : row,
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

test("the collapsed rail lists each review once, pins first, and keeps its jump badges", async () => {
  localStorage.setItem("emend:inbox-kind", "review");
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
  expect(links.map((link) => link.querySelector("[data-jump-number]")?.textContent)).toEqual([
    "1",
    "2",
    "3",
    undefined,
  ]);
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
