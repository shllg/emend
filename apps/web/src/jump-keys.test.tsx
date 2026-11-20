import {
  type InboxItem,
  type InboxListGroup,
  KeysSetting,
  type RevisionView,
  type SettingsView,
  SHORTCUT_DEFAULTS,
  type ShortcutCommand,
} from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { defaultLayout, layoutStore } from "./lib/layout-store.ts";
import { jumpCommands } from "./lib/shortcuts.ts";

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
function activeItems(count: number): InboxItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: id(index + 1),
    title: `Review ${index + 1}`,
    origin: { id: id(100), name: "Workshop" },
    repo: "c".repeat(64),
    project: null,
    branch: "main",
    state: "open",
    newestRevision: index + 1,
    unsentCount: 0,
    openThreads: 0,
    agentWaiting: false,
    pendingSend: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    movedTo: null,
    list: "active",
    groupId: null,
    pinnedAt: null,
    snoozed: false,
    snoozedUntil: null,
    activeUntil: null,
    releasedAt: null,
    pickedUpAt: null,
    kind: "review",
  }));
}
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
let client: QueryClient;
let settings: SettingsView;
let inbox: InboxItem[];
let groups: InboxListGroup[];
let width: number;
let patchReply: Promise<Response> | undefined;
let fetcher: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  width = 1280;
  localStorage.clear();
  layoutStore.update(defaultLayout);
  settings = defaultSettings();
  inbox = activeItems(12);
  groups = [];
  patchReply = undefined;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(query.match(/\d+/)?.[0]),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  fetcher = vi.fn(async (path, init) => {
    if (path === "/api/v1/session") return new Response(null, { status: 204 });
    if (path === "/api/v1/settings") {
      if (init?.method === "PATCH") {
        if (patchReply) return patchReply;
        const body = JSON.parse(String(init.body));
        for (const command of Object.keys(body.keys ?? {}) as ShortcutCommand[]) {
          const old = settings.keys.commands[command];
          const binding = body.keys[command];
          if (binding === null) {
            const { override: _, ...rest } = old;
            settings.keys.commands[command] = {
              ...rest,
              value: old.file !== undefined ? old.file : old.default,
              source: old.file !== undefined ? "file" : "default",
            };
          } else
            settings.keys.commands[command] = { ...old, value: binding.key, override: binding.key, source: "override" };
        }
      }
      return Response.json(settings);
    }
    if (path === "/api/v1/bin") return Response.json({ items: [], more: false, total: 0, version: "a".repeat(64) });
    if (path === "/api/v1/reviews")
      return Response.json({
        items: inbox,
        groups,
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date().toISOString(),
      });
    if (path.includes("/revisions/")) return Response.json({ ...revision, seq: Number(path.split("/").at(-1)) });
    const item = inbox.find((item) => path === `/api/v1/reviews/${item.id}`);
    if (item) return Response.json({ ...item, revisions: [{ seq: item.newestRevision, createdAt: item.updatedAt }] });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(path = "/") {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(
    <StrictMode>
      <App queryClient={client} history={history} />
    </StrictMode>,
  );
  return history;
}
function press(key: string, options: KeyboardEventInit = {}, target: HTMLElement = document.body) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  fireEvent(target, event);
  return event;
}
const jump = (n: number, target?: HTMLElement) => press(String(n), { altKey: true, code: `Digit${n}` }, target);
async function ready() {
  await waitFor(() => {
    expect(client.getQueryState(["inbox"])?.status).toBe("success");
    expect(client.getQueryState(["settings"])?.status).toBe("success");
  });
  await screen.findByRole("link", { name: /Review 1(?:\s|$)/ });
}
const rowLink = (n: number, scope: HTMLElement = document.body) =>
  within(scope).getByRole("link", { name: new RegExp(`Review ${n}(?:\\s|$)`) });
const badge = (link: HTMLElement) => link.querySelector("[data-jump-number]")?.textContent;
const numbers = (scope: ParentNode = document) =>
  [...scope.querySelectorAll("[data-jump-number]")].map((node) => node.textContent);
const patches = () =>
  fetcher.mock.calls.filter(([path, init]) => path === "/api/v1/settings" && init?.method === "PATCH");
const patchBody = (index: number) => JSON.parse(String(patches()[index]?.[1]?.body));
const jumpRow = () => within(screen.getByRole("group", { name: "Open inbox row 1 to 10" }));
async function openSettings() {
  mount("/settings");
  await screen.findByRole("heading", { name: "Keyboard shortcuts" });
}
function change() {
  const button = jumpRow().getByRole("button", { name: "Change" });
  fireEvent.click(button);
  expect(document.activeElement).toBe(button);
  expect(button.textContent).toBe("Press a modifier and a digit…");
  return button;
}
function setJumpKeys(modifier: "mod" | null) {
  for (const [index, command] of jumpCommands.entries()) {
    const value = modifier === null ? null : `${modifier}+${(index + 1) % 10}`;
    Object.assign(settings.keys.commands[command], { value, source: "override", override: value });
  }
}

test.each([1280, 900])("inbox at %s numbers the first ten of twelve rows and Alt+0 opens row ten", async (pixels) => {
  width = pixels;
  const history = mount();
  await ready();
  expect(numbers()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
  for (let n = 1; n <= 12; n++) {
    const link = rowLink(n);
    expect(badge(link)).toBe(n <= 10 ? String(n % 10) : undefined);
    expect(link.getAttribute("aria-keyshortcuts")).toBe(n <= 10 ? `Alt+${n % 10}` : null);
  }
  expect(jump(0).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(10)}`));
  expect(history.location.search).toBe("?rev=10");
});

test.each(["page", "pane"])("folding Active removes %s numbers and jumps until it opens again", async (surface) => {
  const path = surface === "page" ? "/" : `/r/${id(2)}`;
  const history = mount(path);
  await ready();
  const toggle = screen.getByRole("button", { name: "Active 12" });
  expect(numbers()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(numbers()).toEqual([]);
  expect(screen.queryByRole("link", { name: /Review 1(?:\s|$)/ })).toBeNull();
  const location = history.location;
  const length = history.length;
  await act(async () => {
    expect(jump(1).defaultPrevented).toBe(true);
  });
  expect(history.location).toEqual(location);
  expect(history.length).toBe(length);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(numbers()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
  expect(rowLink(1).getAttribute("aria-keyshortcuts")).toBe("Alt+1");
  expect(jump(1).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(1)}`));
  expect(history.location.search).toBe("?rev=1");
});

test("Done's first row follows three Active rows and Alt+4 opens it", async () => {
  inbox = activeItems(5).map((item, index) => (index >= 3 ? { ...item, list: "done" } : item));
  const history = mount();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Done 2" }));
  expect(numbers()).toEqual(["1", "2", "3", "4", "5"]);
  expect(badge(rowLink(4))).toBe("4");
  expect(jump(4).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(4)}`));
  expect(history.location.search).toBe("?rev=4");
});

test("Done starts folded and contributes no jump numbers", async () => {
  inbox = activeItems(5).map((item, index) => (index >= 3 ? { ...item, list: "done" } : item));
  const history = mount();
  await ready();
  const done = screen.getByRole("region", { name: "Done" });
  expect(within(done).getByRole("button", { name: "Done 2" }).getAttribute("aria-expanded")).toBe("false");
  expect(within(done).queryByRole("link")).toBeNull();
  expect(numbers(done)).toEqual([]);
  expect(numbers()).toEqual(["1", "2", "3"]);
  const location = history.location;
  await act(async () => {
    expect(jump(4).defaultPrevented).toBe(true);
  });
  expect(history.location).toEqual(location);
});

test("folded Active lets open Done start at 1 and Alt+1 opens it", async () => {
  inbox = activeItems(5).map((item, index) => (index >= 3 ? { ...item, list: "done" } : item));
  const history = mount();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Done 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Active 3" }));
  expect(numbers()).toEqual(["1", "2"]);
  expect(badge(rowLink(4))).toBe("1");
  expect(jump(1).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(4)}`));
});

test("a pinned Done item is numbered only in Pinned and the next Done row continues the count", async () => {
  inbox = activeItems(3).map((item, index) => ({
    ...item,
    list: index > 0 ? "done" : "active",
    pinnedAt: index === 1 ? "2026-01-01T00:00:00.000Z" : null,
  }));
  const history = mount();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Done 2" }));
  const pinned = screen.getByRole("region", { name: "Pinned" });
  const done = screen.getByRole("region", { name: "Done" });
  expect(badge(rowLink(2, pinned))).toBe("1");
  expect(badge(rowLink(2, done))).toBeUndefined();
  expect(rowLink(2, done).getAttribute("aria-keyshortcuts")).toBeNull();
  expect(badge(rowLink(3, done))).toBe("3");
  expect(numbers()).toEqual(["1", "2", "3"]);
  expect(jump(3).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(3)}`));
});

test("folded Pinned gives its Done copy a number in Done", async () => {
  inbox = activeItems(3).map((item, index) => ({
    ...item,
    list: index > 0 ? "done" : "active",
    pinnedAt: index === 1 ? "2026-01-01T00:00:00.000Z" : null,
  }));
  const history = mount();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Done 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Pinned 1" }));
  const done = screen.getByRole("region", { name: "Done" });
  expect(numbers(screen.getByRole("region", { name: "Pinned" }))).toEqual([]);
  expect(badge(rowLink(1))).toBe("1");
  expect(badge(rowLink(2, done))).toBe("2");
  expect(badge(rowLink(3, done))).toBe("3");
  expect(jump(2).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(2)}`));
});

test("a held jump key keeps its repeats from the browser and opens its row once", async () => {
  const history = mount();
  await ready();
  expect(jump(3).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(3)}`));
  await screen.findByRole("heading", { name: "Review 3", level: 1 });
  const length = history.length;
  const location = history.location;
  for (let n = 0; n < 3; n++) {
    await act(async () => {
      expect(press("3", { altKey: true, code: "Digit3", repeat: true }).defaultPrevented).toBe(true);
    });
    expect(history.length).toBe(length);
    expect(history.location).toEqual(location);
  }
});

test.each(["off", "search", "phone"])("repeats stay with the browser where the press would (%s)", async (context) => {
  if (context === "off") setJumpKeys(null);
  if (context === "phone") width = 767;
  const history = mount();
  await ready();
  const length = history.length;
  const location = history.location;
  const digit = context === "search" ? "2" : "1";
  const target = context === "search" ? screen.getByRole("textbox", { name: "Filter reviews" }) : document.body;
  if (context === "search") act(() => target.focus());
  if (context === "off") expect(jump(1).defaultPrevented).toBe(false);
  for (let n = 0; n < 3; n++) {
    await act(async () => {
      expect(press(digit, { altKey: true, code: `Digit${digit}`, repeat: true }, target).defaultPrevented).toBe(false);
    });
    expect(history.length).toBe(length);
    expect(history.location).toEqual(location);
  }
});

test("repeats of other shortcuts are unchanged", async () => {
  mount();
  await ready();
  expect(press("j").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(rowLink(1));
  expect(press("j", { repeat: true }).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(rowLink(1));
});

test.each(["3", "£"])("open review pane accepts Alt/Option key %s by physical digit", async (key) => {
  const history = mount(`/r/${id(1)}`);
  await ready();
  const pane = await screen.findByTestId("inbox-pane");
  expect(badge(rowLink(3, pane))).toBe("3");
  expect(press(key, { altKey: true, code: "Digit3" }).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(3)}`));
  expect(history.location.search).toBe("?rev=3");
});

test("Pubs numbers only the shown pubs and Alt+1 opens the first pub", async () => {
  inbox = inbox.map((item, i) => ({ ...item, kind: i % 2 ? "publish" : "review" }));
  const history = mount();
  await ready();
  fireEvent.click(screen.getByRole("radio", { name: "Pubs" }));
  expect(screen.queryByRole("link", { name: /Review 1(?:\s|$)/ })).toBeNull();
  expect(numbers()).toEqual(["1", "2", "3", "4", "5", "6"]);
  expect(badge(rowLink(2))).toBe("1");
  expect(jump(1).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(2)}`));
});

test("Pubs counts only the pubs shown across Pinned, Active, Snoozed, groups and Done", async () => {
  inbox = activeItems(10).map((item, index) => ({
    ...item,
    kind: index % 2 ? "publish" : "review",
    pinnedAt: index < 2 ? "2026-01-01T00:00:00.000Z" : null,
    list: index >= 8 ? "done" : index >= 4 && index < 6 ? "snoozed" : "active",
    snoozed: index >= 4 && index < 6,
    groupId: index >= 6 && index < 8 ? id(200) : null,
  }));
  groups = [{ id: id(200), name: "Later", members: 2 }];
  const history = mount();
  await ready();
  for (const name of ["Snoozed 2", "Later 2", "Done 2"]) fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.click(screen.getByRole("radio", { name: "Pubs" }));
  expect(numbers()).toEqual(["1", "2", "3", "4", "5"]);
  for (const n of [1, 3, 5, 7, 9])
    expect(screen.queryByRole("link", { name: new RegExp(`Review ${n}(?:\\s|$)`) })).toBeNull();
  for (const [index, n] of [2, 4, 6, 8, 10].entries()) expect(badge(rowLink(n))).toBe(String(index + 1));
  expect(jump(5).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(10)}`));
});

test.each(["search", "machine", "project"])("%s narrows both numbers and the jump destination", async (filter) => {
  inbox = inbox.map((item, i) => ({
    ...item,
    project: i % 2 ? "Two" : "One",
    origin: { id: id(i % 2 ? 101 : 100), name: i % 2 ? "Studio" : "Workshop" },
  }));
  const history = mount();
  await ready();
  if (filter === "search")
    fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "Review 2" } });
  else
    fireEvent.change(screen.getByRole("combobox", { name: filter === "machine" ? "Machine" : "Project" }), {
      target: { value: filter === "machine" ? id(101) : "Two" },
    });
  expect(badge(rowLink(2))).toBe("1");
  expect(numbers()).toHaveLength(filter === "search" ? 1 : 6);
  expect(jump(1).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(2)}`));
});

test.each([1280, 768, 1023])("rail at %s numbers its own rows and ignores Kind", async (pixels) => {
  width = pixels;
  layoutStore.update({ inboxCollapsed: true });
  localStorage.setItem("emend:inbox-kind", "publish");
  inbox = inbox.map((item, i) => ({ ...item, kind: i % 2 ? "publish" : "review" }));
  const history = mount(`/r/${id(1)}`);
  await ready();
  const rail = screen.getByRole("complementary", { name: "Inbox" });
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  expect(numbers(rail)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
  expect(badge(rowLink(3, rail))).toBe("3");
  expect(rowLink(3, rail).getAttribute("aria-keyshortcuts")).toBe("Alt+3");
  expect(jump(3).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(3)}`));
});

test.each([1280, 900])(
  "rail at %s numbers ten rows across Pinned, Active and Done with matching jumps",
  async (pixels) => {
    width = pixels;
    layoutStore.update({ inboxCollapsed: true });
    inbox = inbox.map((item, index) => ({
      ...item,
      list: index >= 3 ? "done" : "active",
      pinnedAt: index === 10 ? "2026-01-01T00:00:00.000Z" : null,
    }));
    const history = mount(`/r/${id(2)}`);
    await ready();
    const rail = screen.getByRole("complementary", { name: "Inbox" });
    const order = [11, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12];
    expect(
      within(rail)
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(order.map((n) => `Review ${n}`));
    expect(numbers(rail)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
    for (const [index, n] of order.entries()) {
      expect(badge(rowLink(n, rail))).toBe(index < 10 ? String((index + 1) % 10) : undefined);
      expect(rowLink(n, rail).getAttribute("aria-keyshortcuts")).toBe(index < 10 ? `Alt+${(index + 1) % 10}` : null);
    }
    for (const [digit, n] of [
      [1, 11],
      [4, 3],
      [0, 9],
    ] as const) {
      expect(jump(digit).defaultPrevented).toBe(true);
      await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(n)}`));
      expect(history.location.search).toBe(`?rev=${n}`);
      await screen.findByRole("heading", { name: `Review ${n}`, level: 1 });
    }
  },
);

test("collapsing a pane with folded Active restores the rail's numbers and jumps", async () => {
  const history = mount(`/r/${id(2)}`);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Active 12" }));
  expect(numbers()).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  const rail = await screen.findByRole("complementary", { name: "Inbox" });
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  expect(numbers(rail)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
  expect(badge(rowLink(1, rail))).toBe("1");
  expect(rowLink(1, rail).getAttribute("aria-keyshortcuts")).toBe("Alt+1");
  expect(jump(1).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(1)}`));
  expect(history.location.search).toBe("?rev=1");
  fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
  const pane = await screen.findByTestId("inbox-pane");
  expect(within(pane).getByRole("button", { name: "Active 12" }).getAttribute("aria-expanded")).toBe("false");
  expect(numbers()).toEqual([]);
  const location = history.location;
  await act(async () => {
    expect(jump(3).defaultPrevented).toBe(true);
  });
  expect(history.location).toEqual(location);
});

test("collapsing a searched pane switches jumps to the rail's unfiltered rows", async () => {
  const history = mount(`/r/${id(1)}`);
  await ready();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "Review 3" } });
  expect(badge(rowLink(3))).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  expect(badge(await screen.findByRole("link", { name: /Review 2(?:\s|$)/ }))).toBe("2");
  expect(jump(2).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(2)}`));
  fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
  expect(badge(await screen.findByRole("link", { name: /Review 3(?:\s|$)/ }))).toBe("1");
  expect(jump(1).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(3)}`));
});

test("tablet sheet shows no numbers and blocks jumps while the rail keeps its own numbering", async () => {
  width = 900;
  const history = mount(`/r/${id(1)}`);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
  const sheet = await screen.findByRole("dialog", { name: "Inbox" });
  expect(numbers(sheet)).toEqual([]);
  expect(numbers()).toHaveLength(10);
  expect(jump(3, sheet).defaultPrevented).toBe(false);
  expect(history.location.pathname).toBe(`/r/${id(1)}`);
});

test.each(["page", "rail"])("%s numbers every open section and skips moved rows", async (surface) => {
  inbox = activeItems(6).map((item, i) => {
    if (i === 0) return { ...item, movedTo: "https://example.com/review" };
    if (i === 2) return { ...item, list: "snoozed", snoozed: true };
    if (i === 3) return { ...item, groupId: id(200) };
    if (i === 4) return { ...item, list: "done" };
    return item;
  });
  groups = [{ id: id(200), name: "Later", members: 1 }];
  layoutStore.update({ inboxCollapsed: true });
  const history = mount(surface === "page" ? "/" : `/r/${id(2)}`);
  await screen.findByRole("link", { name: /Review 2(?:\s|$)/ });
  if (surface === "page") {
    for (const name of [/^Snoozed/, /^Later/, /^Done/]) fireEvent.click(screen.getByRole("button", { name }));
    const moved = screen.getByText("Review 1").closest('[aria-disabled="true"]');
    expect(moved).not.toBeNull();
    expect(moved?.querySelector("[data-jump-number]")).toBeNull();
  }
  expect(numbers()).toEqual(["1", "2", "3", "4", "5"]);
  expect(badge(rowLink(2))).toBe("1");
  expect(badge(rowLink(6))).toBe("2");
  for (const n of [3, 4, 5]) expect(badge(rowLink(n))).toBe(String(n));
  expect(jump(2).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(6)}`));
});

test("numbers and jumps follow a refreshed server order", async () => {
  const history = mount();
  await ready();
  expect(badge(rowLink(5))).toBe("5");
  inbox = [{ ...(inbox[4] as InboxItem), agentWaiting: true }, ...inbox.filter((item) => item.id !== id(5))];
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["inbox"] });
  });
  await waitFor(() => expect(badge(rowLink(5))).toBe("1"));
  expect(badge(rowLink(1))).toBe("2");
  expect(jump(1).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(5)}`));
});

test.each(["page", "pane", "rail"])(
  "%s keeps a jump with no row from the browser without navigating",
  async (surface) => {
    inbox = activeItems(1);
    layoutStore.update({ inboxCollapsed: surface === "rail" });
    const path = surface === "page" ? "/" : `/r/${id(1)}`;
    const history = mount(path);
    await ready();
    expect(jump(9).defaultPrevented).toBe(true);
    expect(history.location.pathname).toBe(path);
    expect(history.location.search).toBe("");
  },
);

test.each(["page", "rail"])("off jump keys remove %s badges and give Alt+1 back to the browser", async (surface) => {
  setJumpKeys(null);
  layoutStore.update({ inboxCollapsed: true });
  const path = surface === "page" ? "/" : `/r/${id(1)}`;
  const history = mount(path);
  await ready();
  expect(numbers()).toEqual([]);
  expect(rowLink(1).hasAttribute("aria-keyshortcuts")).toBe(false);
  expect(jump(1).defaultPrevented).toBe(false);
  expect(jump(0).defaultPrevented).toBe(false);
  expect(history.location.pathname).toBe(path);
});

test.each([
  [1, 1],
  [0, 10],
])("remapped jumps handle Ctrl+%s for row %s and leave Alt alone", async (digit, row) => {
  setJumpKeys("mod");
  const history = mount();
  await ready();
  expect(badge(rowLink(row))).toBe(String(digit));
  expect(rowLink(row).getAttribute("aria-keyshortcuts")).toBe(`Control+${digit}`);
  expect(jump(digit).defaultPrevented).toBe(false);
  expect(history.location.pathname).toBe("/");
  expect(press(String(digit), { ctrlKey: true, code: `Digit${digit}` }).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(row)}`));
});

test("a custom single jump key appears on its row and works", async () => {
  settings.keys.commands["inbox.jump1"].value = "mod+k";
  const history = mount();
  await ready();
  expect(badge(rowLink(1))).toBe("Ctrl+K");
  expect(rowLink(1).getAttribute("aria-keyshortcuts")).toBe("Control+K");
  expect(jump(1).defaultPrevented).toBe(false);
  expect(press("k", { ctrlKey: true }).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(1)}`));
});

test("Alt+0 stays in the inbox search field", async () => {
  const history = mount();
  await ready();
  const input = screen.getByRole("textbox", { name: "Filter reviews" });
  act(() => input.focus());
  const length = history.length;
  await act(async () => {
    expect(jump(0, input).defaultPrevented).toBe(false);
  });
  expect(history.location.pathname).toBe("/");
  expect(history.length).toBe(length);
  expect(document.activeElement).toBe(input);
});

test("Alt+digit stays in the real comment composer on a review", async () => {
  const history = mount(`/r/${id(1)}`);
  await ready();
  fireEvent.click(await screen.findByRole("button", { name: "Comment on review" }));
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Comment" });
  expect(input.tagName).toBe("TEXTAREA");
  act(() => input.focus());
  const location = history.location;
  const length = history.length;
  for (const digit of [2, 0]) {
    await act(async () => {
      expect(jump(digit, input).defaultPrevented).toBe(false);
    });
    expect(document.activeElement).toBe(input);
    expect(history.location).toEqual(location);
    expect(history.length).toBe(length);
  }
});

test.each(["/", `/r/${id(1)}`])("phone shows no jump numbers or handlers on %s", async (path) => {
  width = 767;
  const history = mount(path);
  if (path === "/") await ready();
  else await screen.findByRole("button", { name: "Approve" });
  expect(numbers()).toEqual([]);
  expect(jump(1).defaultPrevented).toBe(false);
  expect(jump(0).defaultPrevented).toBe(false);
  expect(history.location.pathname).toBe(path);
});

test.each([false, true])("? lists jumps as one row and the palette excludes them (off=%s)", async (off) => {
  if (off) setJumpKeys(null);
  mount();
  await ready();
  press("?", { shiftKey: true });
  const dialog = await screen.findByRole("alertdialog", { name: "Keyboard shortcuts" });
  const label = within(dialog).getByText("Open inbox row 1 to 10");
  expect(label.tagName).toBe("DT");
  expect(label.nextElementSibling?.textContent).toBe(off ? "Off" : "Alt+1–9, Alt+0");
  expect(label.nextElementSibling?.querySelector("kbd") !== null).toBe(!off);
  expect(within(dialog).queryByText("Open inbox row 1", { exact: true })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  press("P", { ctrlKey: true, shiftKey: true });
  const palette = await screen.findByRole("dialog", { name: "Command palette" });
  expect(within(palette).queryByRole("option", { name: /Open inbox row / })).toBeNull();
});

test.each([
  ["1", { ctrlKey: true, code: "Digit1" }, "mod"],
  ["&", { metaKey: true, code: "Digit1" }, "mod"],
  ["¡", { altKey: true, code: "Digit1" }, "alt"],
  ["0", { ctrlKey: true, code: "Digit0" }, "mod"],
] as const)("Settings captures %s (%j) as one patch for all ten %s keys", async (key, options, modifier) => {
  await openSettings();
  expect(jumpRow().getByText("Alt+1–9, Alt+0")).toBeTruthy();
  expect(jumpRow().getByText("Default.")).toBeTruthy();
  expect(jumpRow().queryByRole("button", { name: "Reset" })).toBeNull();
  expect(press(key, options, change()).defaultPrevented).toBe(true);
  await jumpRow().findByText("Set here.");
  expect(patches()).toHaveLength(1);
  expect(Object.keys(patchBody(0).keys)).toHaveLength(10);
  expect(patchBody(0)).toEqual({
    keys: Object.fromEntries(
      jumpCommands.map((command, index) => [command, { key: `${modifier}+${(index + 1) % 10}` }]),
    ),
  });
  expect(jumpRow().getByText(modifier === "mod" ? "Ctrl+1–9, Ctrl+0" : "Alt+1–9, Alt+0")).toBeTruthy();
  for (const [index, command] of jumpCommands.entries())
    expect(client.getQueryData<SettingsView>(["settings"])?.keys.commands[command].value).toBe(
      `${modifier}+${(index + 1) % 10}`,
    );
});

test("Turn off and Reset each patch all ten commands once", async () => {
  await openSettings();
  fireEvent.click(jumpRow().getByRole("button", { name: "Turn off" }));
  await jumpRow().findByText("Off");
  expect(jumpRow().queryByRole("button", { name: "Turn off" })).toBeNull();
  expect(patches()).toHaveLength(1);
  expect(patchBody(0)).toEqual({ keys: Object.fromEntries(jumpCommands.map((command) => [command, { key: null }])) });
  expect(Object.keys(patchBody(0).keys)).toHaveLength(10);
  expect(patchBody(0).keys["inbox.jump10"]).toEqual({ key: null });
  fireEvent.click(jumpRow().getByRole("button", { name: "Reset" }));
  await jumpRow().findByText("Default.");
  expect(patches()).toHaveLength(2);
  expect(patchBody(1)).toEqual({ keys: Object.fromEntries(jumpCommands.map((command) => [command, null])) });
  expect(Object.keys(patchBody(1).keys)).toHaveLength(10);
  expect(patchBody(1).keys["inbox.jump10"]).toBeNull();
  expect(jumpRow().getByText("Alt+1–9, Alt+0")).toBeTruthy();
});

test.each(["Linux x86_64", "MacIntel"])("jump capture reports invalid combinations on %s", async (platform) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  await openSettings();
  const button = change();
  for (const [key, options] of [
    ["k", { altKey: true }],
    ["1", {}],
    ["1", { altKey: true, shiftKey: true, code: "Digit1" }],
    ["k", { ctrlKey: true }],
    ["1", { altKey: true, code: "Numpad1" }],
  ] as const) {
    expect(press(key, options, button).defaultPrevented).toBe(true);
    expect(jumpRow().getByRole("alert").textContent).toBe(
      platform === "MacIntel" ? "Hold ⌥ or ⌘ and press a digit." : "Hold Alt or Ctrl and press a digit.",
    );
    expect(patches()).toHaveLength(0);
  }
});

test.each(["mod+9", "mod+0"])("jump capture checks %s against non-jump commands", async (binding) => {
  settings.keys.commands["tab.writeup"].value = binding;
  await openSettings();
  press("1", { ctrlKey: true, code: "Digit1" }, change());
  expect(jumpRow().getByRole("alert").textContent).toBe("Already used by Writeup tab.");
  expect(patches()).toHaveLength(0);
});

test("capture ignores repeats and composition, waits for modifiers, and cancels on Tab, Escape or blur", async () => {
  await openSettings();
  const button = change();
  for (const options of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }])
    press("1", { ctrlKey: true, code: "Digit1", ...options }, button);
  press("Alt", { altKey: true }, button);
  expect(jumpRow().queryByRole("alert")).toBeNull();
  expect(patches()).toHaveLength(0);
  expect(press("Tab", {}, button).defaultPrevented).toBe(false);
  expect(button.textContent).toBe("Change");
  expect(press("Escape", {}, change()).defaultPrevented).toBe(true);
  expect(button.textContent).toBe("Change");
  fireEvent.blur(change());
  expect(button.textContent).toBe("Change");
  expect(patches()).toHaveLength(0);
});

test("combined source reports file entries, overrides, file errors and the first clash", async () => {
  Object.assign(settings.keys.commands["inbox.jump1"], { value: "mod+1", file: "mod+1", source: "file" });
  Object.assign(settings.keys.commands["inbox.jump2"], { fileError: true, clashWith: "tab.writeup", value: null });
  Object.assign(settings.keys.commands["inbox.jump3"], { clashWith: "tab.docs", value: null });
  await openSettings();
  expect(jumpRow().getByText("From the config file.")).toBeTruthy();
  expect(jumpRow().getByText("Some config file keys can't be used, so they are ignored.")).toBeTruthy();
  expect(jumpRow().getByText("Some of its keys are used by Writeup tab.")).toBeTruthy();
  expect(jumpRow().queryByText("Some of its keys are used by Docs tab.")).toBeNull();
  expect(jumpRow().getByText("Ctrl+1, Off, Off, Alt+4, Alt+5, Alt+6, Alt+7, Alt+8, Alt+9, Alt+0")).toBeTruthy();
  fireEvent.click(jumpRow().getByRole("button", { name: "Turn off" }));
  await jumpRow().findByText("Set here.");
  fireEvent.click(jumpRow().getByRole("button", { name: "Reset" }));
  await jumpRow().findByText("From the config file.");
});

test("pending jump saves disable their controls and show failures", async () => {
  const pending = Promise.withResolvers<Response>();
  patchReply = pending.promise;
  await openSettings();
  press("1", { ctrlKey: true, code: "Digit1" }, change());
  await waitFor(() => {
    for (const button of jumpRow().getAllByRole<HTMLButtonElement>("button")) expect(button.disabled).toBe(true);
  });
  expect(patches()).toHaveLength(1);
  await act(async () => pending.resolve(new Response(null, { status: 500 })));
  expect((await jumpRow().findByRole("alert")).textContent).toBe("Could not save settings. Try again.");
  expect(jumpRow().getByRole<HTMLButtonElement>("button", { name: "Change" }).disabled).toBe(false);
});
