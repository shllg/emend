import {
  type InboxItem,
  type KeySetting,
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
import { adjacentInboxItem, inboxSections, inboxSequence } from "./lib/inbox-list.ts";
import { defaultLayout, layoutStore } from "./lib/layout-store.ts";
import { shortcutLabels } from "./lib/shortcuts.ts";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;
const items: InboxItem[] = ids.map((id, index) => ({
  id,
  title: `Review ${index + 1}`,
  origin: { id: ids[0], name: "Workshop" },
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
  kind: index === 2 ? "publish" : "review",
}));
const initialRevision: RevisionView = {
  seq: 1,
  base: null,
  head: null,
  main: null,
  writeupEmpty: false,
  topics: [],
  files: ["a.txt", "b.txt"].map((path, order) => ({
    id: order === 0 ? ids[0] : ids[1],
    path,
    order,
    oldPath: null,
    role: "diff",
    status: "modified",
    topic: null,
    mediaType: "text/plain",
    flag: "binary",
    hasOld: false,
    hasNew: false,
  })),
  writeup: { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [] }] },
  docs: [{ path: "plan.md", kind: "markdown", blocks: [] }],
  threads: [],
  changedBlocks: [],
};
const defaultSettings = (): SettingsView => ({
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
});
let client: QueryClient;
let settings: SettingsView;
let revision: RevisionView;
let inbox: InboxItem[];
let width: number;
let patchReply: Promise<Response> | undefined;
let settingsReply: Promise<Response> | undefined;
let fetcher: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  width = 1280;
  localStorage.clear();
  layoutStore.update(defaultLayout);
  settings = defaultSettings();
  revision = structuredClone(initialRevision);
  inbox = structuredClone(items);
  patchReply = undefined;
  settingsReply = undefined;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(query.match(/\d+/)?.[0]),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("em-diff-pane") ? new DOMRect(0, 0, 900, 600) : new DOMRect();
  });
  fetcher = vi.fn(async (path, init) => {
    if (path === "/api/v1/session") return new Response(null, { status: 204 });
    if (path === "/api/v1/settings") {
      if (init?.method === "PATCH") {
        if (patchReply) return patchReply;
        const body = JSON.parse(String(init.body));
        if (body.approvedActiveHours !== undefined) {
          const old = settings.approvedActiveHours;
          settings.approvedActiveHours = {
            ...old,
            override: body.approvedActiveHours,
            value: body.approvedActiveHours ?? old.file ?? old.default,
            source: body.approvedActiveHours !== null ? "override" : old.file !== null ? "file" : "default",
          };
        }
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
      } else if (settingsReply) return settingsReply;
      return Response.json(settings);
    }
    if (path === "/api/v1/bin") return Response.json({ items: [], more: false, total: 0, version: "a".repeat(64) });
    if (path === "/api/v1/reviews")
      return Response.json({
        items: inbox,
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date().toISOString(),
      });
    if (path.endsWith("/viewed")) {
      const body = JSON.parse(String(init?.body));
      revision = {
        ...revision,
        files: revision.files.map((file) =>
          body.paths.includes(file.path) ? { ...file, viewed: body.viewed ? "viewed" : undefined } : file,
        ),
      };
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/threads")) return new Response(null, { status: 201 });
    if (path.includes("/revisions/")) return Response.json(revision);
    const item =
      inbox.find((item) => path === `/api/v1/reviews/${item.id}`) ??
      (path === `/api/v1/reviews/${ids[0]}` ? items[0] : undefined);
    if (item) return Response.json({ ...item, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
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
  layoutStore.update({ fileOrder: "topics" });
});
function mount(path = `/r/${ids[0]}`) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(
    <StrictMode>
      <App queryClient={client} history={history} />
    </StrictMode>,
  );
  return history;
}
const press = (key: string, options: KeyboardEventInit = {}, target: HTMLElement = document.body) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  fireEvent(target, event);
  return event;
};
const ready = () => screen.findByRole("button", { name: "Approve revision 1" });
const writes = (method?: string) =>
  fetcher.mock.calls.filter(([, init]) => (method ? init?.method === method : init?.method && init.method !== "GET"));
const row = (command: ShortcutCommand) => within(screen.getByRole("group", { name: shortcutLabels[command] }));
const openSettings = async () => {
  mount("/settings");
  await screen.findByRole("heading", { name: "Keyboard shortcuts" });
};
const change = (command: ShortcutCommand) => {
  const button = row(command).getByRole("button", { name: "Change" });
  fireEvent.click(button);
  expect(document.activeElement).toBe(button);
  return button;
};

test("shared inbox sections preserve filters, expiry, Done sorting, expansion and link order", () => {
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  const base = items[0] as InboxItem;
  const list: InboxItem[] = [
    { ...base, id: "active", title: "Active", project: "One" },
    { ...base, id: "moved", movedTo: "https://example.com/review", project: "One" },
    { ...base, id: "snoozed", list: "snoozed", title: "Needle" },
    { ...base, id: "done-b", list: "done", title: "Needle", updatedAt: "2026-11-11T00:00:00.000Z" },
    { ...base, id: "done-a", list: "done", title: "Needle", updatedAt: "2026-11-11T00:00:00.000Z" },
    {
      ...base,
      id: "expired",
      title: "Needle",
      activeUntil: "2026-11-12T11:00:00.000Z",
      updatedAt: "2026-11-12T10:00:00.000Z",
    },
    { ...base, id: "pub", kind: "publish", title: "Published" },
    { ...base, id: "waiting-pub", kind: "publish", agentWaiting: true, title: "Waiting" },
  ];
  const original = structuredClone(list);
  const order = (options: Parameters<typeof inboxSections>[2]) =>
    inboxSequence(inboxSections(list, now, options)).map((item) => item.id);
  expect(order({})).toEqual(["active", "pub", "waiting-pub"]);
  expect(order({ kind: "review" })).toEqual(["active", "waiting-pub"]);
  expect(order({ kind: "publish" })).toEqual(["pub", "waiting-pub"]);
  expect(order({ project: "One" })).toEqual(["active"]);
  expect(order({ machine: "absent" })).toEqual([]);
  expect(order({ filter: "NEEDLE" })).toEqual(["snoozed", "expired", "done-a", "done-b"]);
  expect(order({ open: { snoozed: true, done: true } })).toEqual([
    "active",
    "pub",
    "waiting-pub",
    "snoozed",
    "expired",
    "done-a",
    "done-b",
  ]);
  expect(list).toEqual(original);
  expect(adjacentInboxItem(items, "missing", 1)?.id).toBe(ids[0]);
  expect(adjacentInboxItem(items, "missing", -1)?.id).toBe(ids[2]);
});

test.each([false, true])("j/k navigate the rendered inbox sequence (collapsed=%s)", async (collapsed) => {
  layoutStore.update({ inboxCollapsed: collapsed });
  const history = mount();
  await ready();
  await waitFor(() => expect(client.getQueryData(["inbox"])).toBeTruthy());
  expect(press("j").defaultPrevented).toBe(true);
  await screen.findByRole("heading", { name: "Review 2", level: 1 });
  expect(history.location.pathname).toBe(`/r/${ids[1]}`);
  expect(history.location.search).toBe("?rev=1");
  press("k");
  await screen.findByRole("heading", { name: "Review 1", level: 1 });
  expect(history.location.pathname).toBe(`/r/${ids[0]}`);
  expect(press("k").defaultPrevented).toBe(false);
});
test.each(["j", "k"])("%s starts at the edge when the current review is outside the stored Kind", async (key) => {
  localStorage.setItem("emend:inbox-kind", "publish");
  layoutStore.update({ inboxCollapsed: true });
  mount();
  await ready();
  press(key);
  await screen.findByRole("heading", { name: "Review 3", level: 1 });
});
test("inbox j/k focus row links, skip moved rows and scroll; f cycles and persists Kind", async () => {
  inbox[1] = { ...(inbox[1] as InboxItem), movedTo: "https://example.com/review" };
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  const history = mount("/");
  const first = await screen.findByRole("link", { name: /Review 1/ });
  const last = screen.getByRole("link", { name: /Review 3/ });
  press("j");
  expect(document.activeElement).toBe(first);
  press("j");
  expect(document.activeElement).toBe(last);
  press("k");
  expect(document.activeElement).toBe(first);
  act(() => first.blur());
  press("k");
  expect(document.activeElement).toBe(last);
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  expect(history.location.pathname).toBe("/");
  const kind = within(screen.getByRole("radiogroup", { name: "Kind" }));
  for (const [label, value] of [
    ["Reviews", "review"],
    ["Pubs", "publish"],
    ["All", null],
  ]) {
    press("f");
    expect(kind.getByRole("radio", { name: label ?? "" }).getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("emend:inbox-kind")).toBe(value);
  }
});
test("mounted inbox j follows its text filter into the Done section", async () => {
  inbox[2] = { ...(inbox[2] as InboxItem), list: "done" };
  mount();
  await ready();
  const input = screen.getByRole("textbox", { name: "Filter reviews" });
  fireEvent.change(input, { target: { value: "Review 3" } });
  press("j");
  await screen.findByRole("heading", { name: "Review 3", level: 1 });
});
test.each(["inbox", "open", "collapsed", "tablet"])("/ focuses the inbox field (%s)", async (mode) => {
  if (mode === "tablet") width = 900;
  layoutStore.update({ inboxCollapsed: mode === "collapsed" });
  mount(mode === "inbox" ? "/" : undefined);
  if (mode === "inbox") await screen.findByRole("link", { name: /Review 1/ });
  else await ready();
  press("/");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Filter reviews" })));
  if (mode === "tablet") expect(screen.getByRole("dialog", { name: "Inbox" })).toBeTruthy();
});
test("u returns to the inbox and declines on the inbox", async () => {
  const history = mount();
  await ready();
  press("u");
  await screen.findByRole("heading", { name: "Inbox", level: 1 });
  expect(history.location.pathname).toBe("/");
  expect(press("u").defaultPrevented).toBe(false);
});
test("tabs follow their visibility and 5 only works in Tabs mode", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  const history = mount();
  await ready();
  expect(press("5").defaultPrevented).toBe(false);
  for (const [key, tab] of [
    ["2", "files"],
    ["3", "docs"],
    ["4", "comments"],
    ["1", "writeup"],
  ] as const) {
    press(key);
    await waitFor(() => expect(history.location.search).toContain(`tab=${tab}`));
  }
  act(() => layoutStore.update({ pane: { ...defaultLayout.pane, desktop: "tabs" } }));
  press("5");
  await waitFor(() => expect(history.location.search).toContain("tab=diff"));
});
test("hidden reading tabs let their keys through", async () => {
  revision = { ...revision, writeupEmpty: true, docs: [], files: [] };
  mount();
  await ready();
  for (const key of ["1", "2", "3", "5", "n", "p", "v"]) expect(press(key).defaultPrevented).toBe(false);
});
test("v in a Files row toggles only that row, ahead of the diff handler", async () => {
  mount();
  await ready();
  press("2");
  const file = await screen.findByRole("button", { name: /^Open diff for b.txt/ });
  act(() => file.focus());
  expect(press("v", {}, file).defaultPrevented).toBe(true);
  await waitFor(() => expect(writes("PUT")).toHaveLength(1));
  expect(JSON.parse(String(writes("PUT")[0]?.[1]?.body))).toEqual({ revision: 1, paths: ["b.txt"], viewed: true });
  expect(writes("PUT")[0]?.[0]).toBe(`/api/v1/reviews/${ids[0]}/viewed`);
});
test("n/p use file order and the toolbar jump; v uses the current file; hidden diff declines", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  mount();
  await ready();
  const pane = screen.getByTestId("diff-pane");
  await within(pane).findByRole("button", { name: "Mark a.txt as viewed" });
  const first = document.getElementById(`diff-file-${ids[0]}`) as HTMLElement;
  const second = document.getElementById(`diff-file-${ids[1]}`) as HTMLElement;
  first.style.position = "sticky";
  second.style.position = "sticky";
  const firstBlock = first.closest("[data-diff-file]") as HTMLElement;
  const secondBlock = second.closest("[data-diff-file]") as HTMLElement;
  let position = 0;
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    if (this === pane) return new DOMRect(0, 0, 900, 400);
    if (this === firstBlock) return new DOMRect(0, position + 64, 800, 400);
    if (this === secondBlock) return new DOMRect(0, position + 464, 800, 400);
    if (this.hasAttribute("data-diff-toolbar")) return new DOMRect(0, 0, 800, 40);
    if (this.hasAttribute("data-topic-header")) return new DOMRect(0, 40, 800, 24);
    if (this.hasAttribute("data-file-header")) return new DOMRect(0, 64, 800, 32);
    return this.classList.contains("em-diff-pane") ? new DOMRect(0, 0, 900, 600) : new DOMRect();
  });
  Object.defineProperties(pane, {
    scrollHeight: { value: 1200, configurable: true },
    clientHeight: { value: 400, configurable: true },
  });
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation(() => {});
  // Content above the first file fills the viewport: only n has a destination.
  position = 450;
  expect(press("p").defaultPrevented).toBe(false);
  expect(press("v").defaultPrevented).toBe(false);
  expect(writes("PUT")).toHaveLength(0);
  expect(press("n").defaultPrevented).toBe(true);
  expect(scroll).toHaveBeenLastCalledWith({ top: 442, behavior: "instant" });
  position = 0;
  expect(press("p").defaultPrevented).toBe(false);
  scroll.mockClear();
  expect(press("n").defaultPrevented).toBe(true);
  expect(scroll).toHaveBeenCalledWith({ top: 392, behavior: "instant" });
  position = -400;
  expect(press("n").defaultPrevented).toBe(false);
  scroll.mockClear();
  expect(press("p").defaultPrevented).toBe(true);
  expect(scroll).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
  position = -100;
  scroll.mockClear();
  press("p");
  expect(scroll).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
  const mark = within(first).getByRole<HTMLButtonElement>("button", { name: "Mark a.txt as viewed" });
  mark.disabled = true;
  expect(press("v").defaultPrevented).toBe(false);
  mark.disabled = false;
  press("v");
  await waitFor(() => expect(writes("PUT")).toHaveLength(1));
  expect(JSON.parse(String(writes("PUT")[0]?.[1]?.body)).paths).toEqual(["a.txt"]);
  act(() => layoutStore.update({ pane: { ...defaultLayout.pane, desktop: "tabs" } }));
  expect(pane.hidden).toBe(true);
  for (const key of ["n", "p", "v"]) expect(press(key).defaultPrevented).toBe(false);
});
test("n/p walk A to Z after switching from a different topic order", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  revision.topics = [
    { slug: "first", title: "First", importance: 10, summary: "" },
    { slug: "second", title: "Second", importance: 20, summary: "" },
  ];
  revision.files = ["c.txt", "a.txt", "b.txt"].map((path, order) => ({
    ...(initialRevision.files[0] as RevisionView["files"][number]),
    id: ids[order] ?? ids[0],
    path,
    order,
    topic: order === 0 ? "first" : "second",
  }));
  mount();
  await ready();
  const pane = screen.getByTestId("diff-pane");
  await within(pane).findByRole("button", { name: "Mark c.txt as viewed" });
  const headers = () => [...pane.querySelectorAll<HTMLElement>("[data-file-header]")];
  expect(headers().map((header) => header.id)).toEqual(ids.map((id) => `diff-file-${id}`));
  fireEvent.keyDown(screen.getByRole("button", { name: "2 topics · 3 files" }), { key: "ArrowDown" });
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "A to Z" }));
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(layoutStore.getSnapshot().fileOrder).toBe("path");
  const ordered = headers();
  expect(ordered.map((header) => header.id)).toEqual([ids[1], ids[2], ids[0]].map((id) => `diff-file-${id}`));
  const blocks = ordered.map((header) => {
    header.style.position = "sticky";
    return header.closest("[data-diff-file]");
  });
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    if (this === pane || this.classList.contains("em-diff-pane")) return new DOMRect(0, 100, 900, 600);
    const index = blocks.indexOf(this);
    if (index !== -1) return new DOMRect(0, 148 + index * 180, 800, 180);
    if (this.hasAttribute("data-diff-toolbar")) return new DOMRect(0, 100, 800, 40);
    if (this.hasAttribute("data-file-header")) return new DOMRect(0, 140, 800, 32);
    return new DOMRect();
  });
  Object.defineProperties(pane, {
    scrollHeight: { value: 1200, configurable: true },
    clientHeight: { value: 600, configurable: true },
  });
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation(() => {});
  expect(press("p").defaultPrevented).toBe(false);
  for (const [key, top] of [
    ["n", 180],
    ["n", 360],
    ["p", 180],
    ["p", 0],
  ] as const) {
    scroll.mockClear();
    expect(press(key).defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenLastCalledWith({ top, behavior: "instant" });
  }
  expect(press("p").defaultPrevented).toBe(false);
});
test("short files that cannot scroll keep the last keyboard destination for n and v", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  mount();
  await ready();
  const pane = screen.getByTestId("diff-pane");
  await within(pane).findByRole("button", { name: "Mark a.txt as viewed" });
  const first = document.getElementById(`diff-file-${ids[0]}`) as HTMLElement;
  const second = document.getElementById(`diff-file-${ids[1]}`) as HTMLElement;
  const firstBlock = first.closest("[data-diff-file]");
  const secondBlock = second.closest("[data-diff-file]");
  // Neither header can reach the viewport top, and both complete sections fit without scrolling.
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    if (this === pane || this.classList.contains("em-diff-pane")) return new DOMRect(0, 100, 900, 600);
    if (this === first) return new DOMRect(0, 164, 800, 32);
    if (this === second) return new DOMRect(0, 364, 800, 32);
    if (this === firstBlock) return new DOMRect(0, 164, 800, 200);
    if (this === secondBlock) return new DOMRect(0, 364, 800, 200);
    if (this.hasAttribute("data-diff-toolbar")) return new DOMRect(0, 100, 800, 40);
    if (this.hasAttribute("data-topic-header")) return new DOMRect(0, 140, 800, 24);
    return new DOMRect();
  });
  Object.defineProperties(pane, {
    scrollHeight: { value: 600, configurable: true },
    clientHeight: { value: 600, configurable: true },
  });
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation(() => {});
  expect(press("p").defaultPrevented).toBe(false);
  expect(press("n").defaultPrevented).toBe(true);
  expect(scroll).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
  // A scroll event from the jump must not forget its destination.
  fireEvent.scroll(pane);
  scroll.mockClear();
  expect(press("n").defaultPrevented).toBe(false);
  expect(scroll).not.toHaveBeenCalled();
  expect(press("v").defaultPrevented).toBe(true);
  await waitFor(() => expect(writes("PUT")).toHaveLength(1));
  expect(JSON.parse(String(writes("PUT")[0]?.[1]?.body))).toEqual({ revision: 1, paths: ["b.txt"], viewed: true });
});
test("opening a short file from Files replaces the keyboard destination for v", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  const history = mount();
  await ready();
  const pane = screen.getByTestId("diff-pane");
  await within(pane).findByRole("button", { name: "Mark a.txt as viewed" });
  const first = document.getElementById(`diff-file-${ids[0]}`) as HTMLElement;
  const second = document.getElementById(`diff-file-${ids[1]}`) as HTMLElement;
  const firstBlock = first.closest("[data-diff-file]");
  const secondBlock = second.closest("[data-diff-file]");
  // Neither header can reach the viewport top, and both complete sections fit without scrolling.
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    if (this === pane || this.classList.contains("em-diff-pane")) return new DOMRect(0, 100, 900, 600);
    if (this === first) return new DOMRect(0, 164, 800, 32);
    if (this === second) return new DOMRect(0, 364, 800, 32);
    if (this === firstBlock) return new DOMRect(0, 164, 800, 200);
    if (this === secondBlock) return new DOMRect(0, 364, 800, 200);
    if (this.hasAttribute("data-diff-toolbar")) return new DOMRect(0, 100, 800, 40);
    if (this.hasAttribute("data-topic-header")) return new DOMRect(0, 140, 800, 24);
    return new DOMRect();
  });
  Object.defineProperties(pane, {
    scrollHeight: { value: 600, configurable: true },
    clientHeight: { value: 600, configurable: true },
  });
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation(() => {});
  expect(press("n").defaultPrevented).toBe(true);
  expect(scroll).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
  expect(press("n").defaultPrevented).toBe(false);
  press("2");
  const file = await screen.findByRole("button", { name: /^Open diff for a.txt/ });
  act(() => file.focus());
  scroll.mockClear();
  fireEvent.click(file);
  await waitFor(() => expect(history.location.hash).toBe(`#diff-file-${ids[0]}`));
  await waitFor(() => expect(scroll).toHaveBeenCalledWith({ top: 0, behavior: "instant" }));
  press("1");
  await waitFor(() => expect(history.location.search).toContain("tab=writeup"));
  expect(press("v").defaultPrevented).toBe(true);
  await waitFor(() => expect(writes("PUT")).toHaveLength(1));
  expect(JSON.parse(String(writes("PUT")[0]?.[1]?.body))).toEqual({ revision: 1, paths: ["a.txt"], viewed: true });
});
test.each(["wheel", "touchstart", "touchmove", "pointerdown", "PageUp"])(
  "%s forgets the keyboard destination when the reader returns to A with B still visible",
  async (input) => {
    layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
    mount();
    await ready();
    const pane = screen.getByTestId("diff-pane");
    await within(pane).findByRole("button", { name: "Mark a.txt as viewed" });
    const first = document.getElementById(`diff-file-${ids[0]}`) as HTMLElement;
    const second = document.getElementById(`diff-file-${ids[1]}`) as HTMLElement;
    first.style.position = "sticky";
    second.style.position = "sticky";
    const firstBlock = first.closest("[data-diff-file]");
    const secondBlock = second.closest("[data-diff-file]");
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      if (this === pane || this.classList.contains("em-diff-pane")) return new DOMRect(0, 100, 900, 400);
      if (this === firstBlock) return new DOMRect(0, 164 - pane.scrollTop, 800, 200);
      if (this === secondBlock) return new DOMRect(0, 364 - pane.scrollTop, 800, 400);
      if (this.hasAttribute("data-diff-toolbar")) return new DOMRect(0, 100, 800, 40);
      if (this.hasAttribute("data-topic-header")) return new DOMRect(0, 140, 800, 24);
      if (this.hasAttribute("data-file-header")) return new DOMRect(0, 164, 800, 32);
      return new DOMRect();
    });
    Object.defineProperties(pane, {
      scrollHeight: { value: 664, configurable: true },
      clientHeight: { value: 400, configurable: true },
    });
    const scroll = vi.spyOn(pane, "scrollTo").mockImplementation(() => {});
    expect(press("n").defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenLastCalledWith({ top: 192, behavior: "instant" });
    pane.scrollTop = 192;
    if (input === "PageUp") press(input, {}, pane);
    else fireEvent(pane, new Event(input, { bubbles: true }));
    pane.scrollTop = 0;
    fireEvent.scroll(pane);
    expect(press("v").defaultPrevented).toBe(true);
    scroll.mockClear();
    expect(press("n").defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenLastCalledWith({ top: 192, behavior: "instant" });
    await waitFor(() => expect(writes("PUT")).toHaveLength(1));
    expect(JSON.parse(String(writes("PUT")[0]?.[1]?.body))).toEqual({ revision: 1, paths: ["a.txt"], viewed: true });
  },
);
test("reader input past B selects C at the top and n goes to D, even with B still partly visible", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  revision.files = ["a.txt", "b.txt", "c.txt", "d.txt"].map((path, order) => ({
    ...(initialRevision.files[0] as RevisionView["files"][number]),
    id: ids[order] ?? "44444444-4444-4444-8444-444444444444",
    path,
    order,
  }));
  mount();
  await ready();
  const pane = screen.getByTestId("diff-pane");
  await within(pane).findByRole("button", { name: "Mark d.txt as viewed" });
  const blocks = revision.files.map((file) => {
    const header = document.getElementById(`diff-file-${file.id}`) as HTMLElement;
    header.style.position = "sticky";
    return header.closest("[data-diff-file]");
  });
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    if (this === pane || this.classList.contains("em-diff-pane")) return new DOMRect(0, 100, 900, 400);
    const index = blocks.indexOf(this);
    if (index !== -1) return new DOMRect(0, 164 + index * 200 - pane.scrollTop, 800, 200);
    if (this.hasAttribute("data-diff-toolbar")) return new DOMRect(0, 100, 800, 40);
    if (this.hasAttribute("data-topic-header")) return new DOMRect(0, 140, 800, 24);
    if (this.hasAttribute("data-file-header")) return new DOMRect(0, 164, 800, 32);
    return new DOMRect();
  });
  Object.defineProperties(pane, {
    scrollHeight: { value: 1200, configurable: true },
    clientHeight: { value: 400, configurable: true },
  });
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation(() => {});
  expect(press("n").defaultPrevented).toBe(true);
  expect(scroll).toHaveBeenLastCalledWith({ top: 192, behavior: "instant" });
  pane.scrollTop = 192;
  fireEvent.wheel(pane);
  pane.scrollTop = 400;
  fireEvent.scroll(pane);
  scroll.mockClear();
  expect(press("n").defaultPrevented).toBe(true);
  expect(scroll).toHaveBeenLastCalledWith({ top: 592, behavior: "instant" });
});
test("p returns to the current file's header from inside its body after manual scrolling", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  mount();
  await ready();
  const pane = screen.getByTestId("diff-pane");
  await within(pane).findByRole("button", { name: "Mark a.txt as viewed" });
  const first = document.getElementById(`diff-file-${ids[0]}`) as HTMLElement;
  const second = document.getElementById(`diff-file-${ids[1]}`) as HTMLElement;
  first.style.position = "sticky";
  second.style.position = "sticky";
  const firstBlock = first.closest("[data-diff-file]");
  const secondBlock = second.closest("[data-diff-file]");
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    if (this === pane || this.classList.contains("em-diff-pane")) return new DOMRect(0, 100, 900, 400);
    if (this === firstBlock) return new DOMRect(0, 164 - pane.scrollTop, 800, 800);
    if (this === secondBlock) return new DOMRect(0, 964 - pane.scrollTop, 800, 800);
    if (this.hasAttribute("data-diff-toolbar")) return new DOMRect(0, 100, 800, 40);
    if (this.hasAttribute("data-topic-header")) return new DOMRect(0, 140, 800, 24);
    if (this.hasAttribute("data-file-header")) return new DOMRect(0, 164, 800, 32);
    return new DOMRect();
  });
  Object.defineProperties(pane, {
    scrollHeight: { value: 1664, configurable: true },
    clientHeight: { value: 400, configurable: true },
  });
  pane.scrollTop = 1100;
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation(() => {});
  expect(press("p").defaultPrevented).toBe(true);
  expect(scroll).toHaveBeenLastCalledWith({ top: 792, behavior: "instant" });
  // The remembered second file stops taking priority when the reader scrolls it out of view.
  pane.scrollTop = 100;
  scroll.mockClear();
  expect(press("p").defaultPrevented).toBe(true);
  expect(scroll).toHaveBeenLastCalledWith({ top: 0, behavior: "instant" });
});
test("s focuses instructions; Shift+A asks before approval; z opens snooze choices", async () => {
  mount();
  await ready();
  press("s");
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Instructions" }));
  act(() => (document.activeElement as HTMLElement).blur());
  expect(press("A").defaultPrevented).toBe(false);
  press("A", { shiftKey: true });
  const approve = await screen.findByRole("alertdialog", { name: "Approve revision 1?" });
  expect(writes()).toHaveLength(0);
  expect(press("j").defaultPrevented).toBe(false);
  fireEvent.click(within(approve).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  press("z");
  const snooze = await screen.findByRole("alertdialog", { name: "Snooze this review" });
  expect(within(snooze).getByRole("button", { name: /Until it changes/ })).toBeTruthy();
  expect(writes()).toHaveLength(0);
});
test("disabled approval and unavailable snooze decline", async () => {
  inbox[0] = { ...(inbox[0] as InboxItem), state: "settled" };
  mount();
  await ready();
  expect(press("A", { shiftKey: true }).defaultPrevented).toBe(false);
  expect(press("z").defaultPrevented).toBe(false);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(writes()).toHaveLength(0);
});
test("? lists all commands, their effective keys, fixed keys and settings link", async () => {
  settings.keys.commands["inbox.next"].value = "x";
  settings.keys.commands["inbox.previous"].value = null;
  mount();
  await ready();
  press("?", { shiftKey: true });
  const dialog = await screen.findByRole("alertdialog", { name: "Keyboard shortcuts" });
  for (const label of Object.values(shortcutLabels)) expect(within(dialog).getByText(label)).toBeTruthy();
  expect(within(dialog).getByText("x")).toBeTruthy();
  expect(within(dialog).getByText("Off")).toBeTruthy();
  expect(within(dialog).getByText("⌘↵ / Ctrl ↵: save a comment, or send from the instructions field")).toBeTruthy();
  expect(within(dialog).getByText("Esc: close a composer, a dialog or a menu")).toBeTruthy();
  expect(within(dialog).getByRole("link").getAttribute("href")).toBe("/settings");
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
  expect(writes()).toHaveLength(0);
});
test.each(["Instructions", "Filter reviews", "Comment"])("letters and ? keep typing in %s", async (name) => {
  const history = mount();
  await ready();
  if (name === "Comment") fireEvent.click(screen.getByRole("button", { name: "Comment on review" }));
  const field = await screen.findByRole<HTMLInputElement | HTMLTextAreaElement>("textbox", { name });
  act(() => field.focus());
  for (const key of ["j", "v", "?"]) {
    expect(press(key, {}, field).defaultPrevented).toBe(false);
    fireEvent.change(field, { target: { value: field.value + key } });
  }
  expect(field.value).toBe("jv?");
  expect(history.location.pathname).toBe(`/r/${ids[0]}`);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(writes()).toHaveLength(0);
});
test.each(["ctrlKey", "metaKey"])("%s+Enter still saves a comment", async (modifier) => {
  mount();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Comment on review" }));
  const field = await screen.findByRole("textbox", { name: "Comment" });
  fireEvent.change(field, { target: { value: "A synthetic comment" } });
  press("Enter", { [modifier]: true }, field);
  await waitFor(() => expect(writes("POST")).toHaveLength(1));
  expect(writes("POST")[0]?.[0]).toBe(`/api/v1/reviews/${ids[0]}/threads`);
  expect(JSON.parse(String(writes("POST")[0]?.[1]?.body)).body).toBe("A synthetic comment");
});
test("changed and off keys are respected and cache updates apply without remounting", async () => {
  settings.keys.commands["inbox.next"].value = "x";
  settings.keys.commands["shortcuts.show"].value = null;
  mount();
  await ready();
  expect(press("j").defaultPrevented).toBe(false);
  expect(press("?").defaultPrevented).toBe(false);
  press("x");
  await screen.findByRole("heading", { name: "Review 2", level: 1 });
  act(() =>
    client.setQueryData(["settings"], {
      ...settings,
      keys: {
        ...settings.keys,
        commands: {
          ...settings.keys.commands,
          "inbox.previous": { ...settings.keys.commands["inbox.previous"], value: "w" },
        },
      },
    }),
  );
  expect(press("k").defaultPrevented).toBe(false);
  press("w");
  await screen.findByRole("heading", { name: "Review 1", level: 1 });
});
test.each(["pending", "failed"])("defaults work while settings are %s", async (state) => {
  settingsReply = state === "pending" ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 500 }));
  mount();
  await ready();
  press("j");
  await screen.findByRole("heading", { name: "Review 2", level: 1 });
});
test("a failed settings refetch keeps v off and the shortcut dialog shows Off", async () => {
  settings.keys.commands["file.toggleViewed"] = {
    ...settings.keys.commands["file.toggleViewed"],
    value: null,
    override: null,
    source: "override",
  };
  mount();
  await ready();
  await waitFor(() => expect(client.getQueryState(["settings"])?.status).toBe("success"));
  press("2");
  const file = await screen.findByRole("button", { name: /^Open diff for b.txt/ });
  act(() => file.focus());
  expect(press("v", {}, file).defaultPrevented).toBe(false);
  settingsReply = Promise.resolve(new Response(null, { status: 500 }));
  await act(async () => {
    await client.refetchQueries({ queryKey: ["settings"] });
  });
  expect(client.getQueryState(["settings"])?.status).toBe("error");
  expect(client.getQueryData<SettingsView>(["settings"])?.keys.commands["file.toggleViewed"].value).toBeNull();
  expect(press("v", {}, file).defaultPrevented).toBe(false);
  expect(writes()).toHaveLength(0);
  press("?", { shiftKey: true });
  const dialog = await screen.findByRole("alertdialog", { name: "Keyboard shortcuts" });
  const command = within(dialog).getByText(shortcutLabels["file.toggleViewed"]).parentElement as HTMLElement;
  expect(within(command).getByText("Off")).toBeTruthy();
});
test("phone layout never handles shortcuts", async () => {
  width = 400;
  const history = mount();
  await screen.findByRole("button", { name: "Approve" });
  for (const key of Object.values(SHORTCUT_DEFAULTS))
    expect(
      press(key === "mod+shift+p" ? "P" : key === "shift+a" ? "A" : key, {
        shiftKey: key === "shift+a" || key === "mod+shift+p",
        ctrlKey: key === "mod+shift+p",
      }).defaultPrevented,
    ).toBe(false);
  expect(history.location.pathname).toBe(`/r/${ids[0]}`);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(writes()).toHaveLength(0);
});

test("settings source, config errors and clashes use the shared labels", async () => {
  const set = (command: ShortcutCommand, changes: Partial<KeySetting>) =>
    Object.assign(settings.keys.commands[command], changes);
  set("inbox.previous", { source: "file", value: "b", file: "b" });
  set("inbox.next", { source: "override", value: "x", override: "x", file: "w", fileError: true });
  set("inbox.filter", { source: "override", value: "t", override: "t", file: null });
  set("inbox.search", { value: null, clashWith: "inbox.next" });
  settings.keys.fileError = true;
  await openSettings();
  expect(row("shortcuts.show").getByText("Default.")).toBeTruthy();
  expect(row("inbox.previous").getByText("From the config file.")).toBeTruthy();
  expect(row("inbox.next").getByText("Set here.")).toBeTruthy();
  expect(
    row("inbox.next").getByText(
      (_, element) => element?.tagName === "P" && element.textContent === "The config file says w.",
    ),
  ).toBeTruthy();
  expect(row("inbox.filter").getByText("The config file turns it off.")).toBeTruthy();
  expect(row("inbox.next").getByText("The config file's key can't be used, so it is ignored.")).toBeTruthy();
  expect(row("inbox.search").getByText("Its key is used by Next review or pub.")).toBeTruthy();
  expect(screen.getByText("Some keys in the config file can't be used, so they are ignored.")).toBeTruthy();
});
test("Change captures, saves, updates cache, and the changed key works without reloading", async () => {
  await openSettings();
  const button = change("shortcuts.show");
  expect(button.textContent).toBe("Press a key…");
  expect(press("X", { shiftKey: true }, button).defaultPrevented).toBe(true);
  await row("shortcuts.show").findByText("Set here.");
  expect(JSON.parse(String(writes("PATCH")[0]?.[1]?.body))).toEqual({ keys: { "shortcuts.show": { key: "shift+x" } } });
  expect(client.getQueryData<SettingsView>(["settings"])?.keys.commands["shortcuts.show"].value).toBe("shift+x");
  expect(press("?").defaultPrevented).toBe(false);
  press("X", { shiftKey: true });
  await screen.findByRole("alertdialog", { name: "Keyboard shortcuts" });
});
test("capture refuses modifiers, named keys and clashes, staying ready for another key", async () => {
  await openSettings();
  const button = change("inbox.next");
  for (const [key, options, message] of [
    ["k", { altKey: true }, "Alt combinations stay with the browser."],
    ["1", { ctrlKey: true }, "Use Ctrl or ⌘ with one letter."],
    ["Enter", {}, "Use a letter, a digit or a punctuation key."],
    ["k", {}, "Already used by Previous review or pub."],
  ] as const) {
    expect(press(key, options, button).defaultPrevented).toBe(true);
    expect(row("inbox.next").getByRole("alert").textContent).toBe(message);
    expect(button.textContent).toBe("Press a key…");
    expect(writes()).toHaveLength(0);
  }
  press("Escape", {}, button);
  expect(button.textContent).toBe("Change");
  expect(writes()).toHaveLength(0);
});
test("Tab and blur cancel capture, and Tab keeps its normal behavior", async () => {
  await openSettings();
  let button = change("inbox.next");
  expect(press("Tab", {}, button).defaultPrevented).toBe(false);
  expect(button.textContent).toBe("Change");
  button = change("inbox.next");
  fireEvent.blur(button);
  expect(button.textContent).toBe("Change");
  expect(writes()).toHaveLength(0);
});
test("Turn off and Reset send distinct patches, including a stored off key", async () => {
  await openSettings();
  expect(row("inbox.next").queryByRole("button", { name: "Reset" })).toBeNull();
  fireEvent.click(row("inbox.next").getByRole("button", { name: "Turn off" }));
  await row("inbox.next").findByText("Off");
  expect(row("inbox.next").queryByRole("button", { name: "Turn off" })).toBeNull();
  expect(JSON.parse(String(writes("PATCH")[0]?.[1]?.body))).toEqual({ keys: { "inbox.next": { key: null } } });
  fireEvent.click(row("inbox.next").getByRole("button", { name: "Reset" }));
  await row("inbox.next").findByText("Default.");
  expect(JSON.parse(String(writes("PATCH")[1]?.[1]?.body))).toEqual({ keys: { "inbox.next": null } });
  expect(row("inbox.next").getByText("j")).toBeTruthy();
});
test("saving disables row controls and failure shows an alert", async () => {
  const pending = Promise.withResolvers<Response>();
  patchReply = pending.promise;
  await openSettings();
  const button = change("inbox.next");
  press("x", {}, button);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  for (const control of row("inbox.next").getAllByRole<HTMLButtonElement>("button"))
    expect(control.disabled).toBe(true);
  await act(async () => pending.resolve(new Response(null, { status: 500 })));
  expect((await row("inbox.next").findByRole("alert")).textContent).toBe("Could not save settings. Try again.");
  expect((button as HTMLButtonElement).disabled).toBe(false);
});
test("shortcut saves wait for each other and both disabled keys stay off", async () => {
  const history = mount("/settings");
  await screen.findByRole("heading", { name: "Keyboard shortcuts" });
  const pending = Promise.withResolvers<void>();
  const original = fetcher.getMockImplementation();
  if (!original) throw new Error("Missing fetch mock");
  fetcher.mockImplementation(async (path, init) => {
    const response = await original(path, init);
    if (init?.method === "PATCH" && JSON.parse(String(init.body)).keys?.["shortcuts.show"]) await pending.promise;
    return response;
  });
  fireEvent.click(row("shortcuts.show").getByRole("button", { name: "Turn off" }));
  await waitFor(() => expect(writes("PATCH")).toHaveLength(1));
  expect(row("inbox.back").getByRole<HTMLButtonElement>("button", { name: "Turn off" }).disabled).toBe(false);
  fireEvent.click(row("inbox.back").getByRole("button", { name: "Turn off" }));
  await waitFor(() => {
    for (const command of ["shortcuts.show", "inbox.back"] as const)
      expect(row(command).getByRole<HTMLButtonElement>("button", { name: "Change" }).disabled).toBe(true);
  });
  expect(writes("PATCH")).toHaveLength(1);
  await act(async () => pending.resolve());
  await row("shortcuts.show").findByText("Off");
  await row("inbox.back").findByText("Off");
  expect(writes("PATCH")).toHaveLength(2);
  for (const command of ["shortcuts.show", "inbox.back"] as const)
    expect(client.getQueryData<SettingsView>(["settings"])?.keys.commands[command].value).toBeNull();
  expect(press("?").defaultPrevented).toBe(false);
  expect(press("u").defaultPrevented).toBe(false);
  expect(history.location.pathname).toBe("/settings");
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
test("inbox settings wait for a shortcut save before writing the shared settings cache", async () => {
  const pending = Promise.withResolvers<Response>();
  patchReply = pending.promise;
  await openSettings();
  fireEvent.click(row("shortcuts.show").getByRole("button", { name: "Turn off" }));
  await waitFor(() => expect(writes("PATCH")).toHaveLength(1));
  const input = screen.getByRole<HTMLInputElement>("spinbutton", { name: "Keep approved reviews in Active for" });
  fireEvent.change(input, { target: { value: "24" } });
  fireEvent.click(within(input.closest("form") as HTMLFormElement).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(input.disabled).toBe(true));
  expect(writes("PATCH")).toHaveLength(1);
  settings.keys.commands["shortcuts.show"] = {
    ...settings.keys.commands["shortcuts.show"],
    value: null,
    override: null,
    source: "override",
  };
  patchReply = undefined;
  await act(async () => pending.resolve(Response.json(settings)));
  await row("shortcuts.show").findByText("Off");
  await waitFor(() => expect(input.disabled).toBe(false));
  expect(writes("PATCH")).toHaveLength(2);
  expect(JSON.parse(String(writes("PATCH")[1]?.[1]?.body))).toEqual({ approvedActiveHours: 24 });
  expect(client.getQueryData<SettingsView>(["settings"])?.approvedActiveHours.value).toBe(24);
  expect(press("?").defaultPrevented).toBe(false);
});

test("capture waits silently for Shift and saves Ctrl+Shift+K as a mod key", async () => {
  await openSettings();
  const button = change("palette.open");
  press("Shift", { shiftKey: true }, button);
  expect(row("palette.open").queryByRole("alert")).toBeNull();
  expect(button.textContent).toBe("Press a key…");
  expect(writes()).toHaveLength(0);
  press("K", { ctrlKey: true, shiftKey: true }, button);
  await row("palette.open").findByText("Set here.");
  expect(JSON.parse(String(writes("PATCH")[0]?.[1]?.body))).toEqual({
    keys: { "palette.open": { key: "mod+shift+k" } },
  });
  expect(client.getQueryData<SettingsView>(["settings"])?.keys.commands["palette.open"].value).toBe("mod+shift+k");
});

test("period and comma step through visible reader comments and leave reply typing alone", async () => {
  const block = {
    id: "overview-12345678",
    section: "overview",
    kind: "paragraph" as const,
    text: "Plant a seed.",
    html: "<p>Plant a seed.</p>",
  };
  revision.writeup.sections[0]?.blocks.push(block);
  revision.threads = ids.slice(0, 2).map((id, index) => ({
    id,
    createdOn: 1,
    state: "open",
    target: { kind: "writeup-span", blockId: block.id, quote: "seed", prefix: "", suffix: "" },
    placement: {
      status: "placed",
      location: { kind: "writeup-span", blockId: block.id, start: index * 8, end: index * 8 + 4 },
    },
    comments: [{ id, author: "user", body: "Synthetic comment", sent: true, sentOn: 1 }],
  }));
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 100, 600, 20),
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mount();
  await ready();
  press(",");
  const last = await screen.findByRole("dialog", { name: "Comment thread" });
  expect(within(last).getByText("2 of 2")).toBeTruthy();
  fireEvent.click(within(last).getByRole("button", { name: "Close" }));
  press(".");
  const dialog = await screen.findByRole("dialog", { name: "Comment thread" });
  expect(within(dialog).getByText("1 of 2")).toBeTruthy();
  press(".", {}, dialog);
  expect(within(dialog).getByText("2 of 2")).toBeTruthy();
  press(",", {}, dialog);
  expect(within(dialog).getByText("1 of 2")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Reply" }));
  const input = within(dialog).getByRole("textbox", { name: "Reply" });
  expect(press(".", {}, input).defaultPrevented).toBe(false);
  expect(press(",", {}, input).defaultPrevented).toBe(false);
  expect(within(dialog).getByText("1 of 2")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Comment on block" }));
  expect(screen.getByRole("textbox", { name: "Comment" })).toBeTruthy();
  press(".");
  const whileComposing = screen.getByRole("dialog", { name: "Comment thread" });
  expect(within(whileComposing).getByText("1 of 2")).toBeTruthy();
  press(".", {}, whileComposing);
  expect(within(whileComposing).getByText("2 of 2")).toBeTruthy();
  press(",", {}, whileComposing);
  expect(within(whileComposing).getByText("1 of 2")).toBeTruthy();
  fireEvent.click(within(whileComposing).getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
  await waitFor(() => expect(screen.getByTestId("reading-pane").hidden).toBe(true));
  expect(press(".").defaultPrevented).toBe(false);
  expect(screen.queryByRole("dialog", { name: "Comment thread" })).toBeNull();
});

test.each([false, true])(
  "with no thread open, stepping starts beside the visible area including folded=%s",
  async (folded) => {
    const blocks = ids.map((id, index) => ({
      id: `overview-${id.slice(0, 8)}`,
      section: "overview",
      kind: "paragraph" as const,
      text: `Synthetic passage ${index}`,
      html: `<p>Synthetic passage ${index}</p>`,
    }));
    revision.writeup.sections[0]?.blocks.push(...blocks);
    revision.threads = blocks
      .map((block, index) => ({
        id: ids[index] ?? ids[0],
        createdOn: 1,
        state: "open",
        target: { kind: "writeup-span", blockId: block.id, quote: block.text, prefix: "", suffix: "" },
        placement: {
          status: "placed",
          location: { kind: "writeup-span", blockId: block.id, start: 0, end: block.text.length },
        },
        comments: [],
      }))
      .reverse() as RevisionView["threads"];
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("em-review-tabs") || this.closest("[hidden]")) return new DOMRect();
      if (this.dataset.readingSection?.startsWith("t-garden")) return new DOMRect(0, 120, 600, 20);
      const index = blocks.findIndex((block) => this.dataset.blockId === block.id);
      return index >= 0
        ? new DOMRect(0, 20 + index * 100, 600, 20)
        : this.hasAttribute("data-reading-scroll")
          ? new DOMRect(0, 100, 600, 500)
          : new DOMRect(0, 0, 600, 600);
    });
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
      return [this.getBoundingClientRect()] as unknown as DOMRectList;
    });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    if (folded) {
      revision.topics = [
        { slug: "garden", title: "Garden", summary: "Synthetic plants", importance: 1, attention: "skim" },
      ];
      revision.writeup.sections = blocks.map((block, index) => ({
        key: index === 1 ? "t-garden-body" : index === 0 ? "overview" : "decisions",
        label: `Section ${index}`,
        topic: index === 1 ? "garden" : null,
        blocks: [block],
      }));
    }
    mount();
    await ready();
    press(".");
    let dialog = await screen.findByRole("dialog", { name: "Comment thread" });
    expect(within(dialog).getByText("2 of 3")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    press(",");
    dialog = await screen.findByRole("dialog", { name: "Comment thread" });
    expect(within(dialog).getByText("1 of 3")).toBeTruthy();
  },
);
