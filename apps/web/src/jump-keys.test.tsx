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
const jumpRow = () => within(screen.getByRole("group", { name: "Open Active row 1 to 9" }));
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
    const value = modifier === null ? null : `${modifier}+${index + 1}`;
    Object.assign(settings.keys.commands[command], { value, source: "override", override: value });
  }
}

test.each([1280, 900])(
  "inbox at %s numbers the first nine of twelve rows and Alt+3 opens row three",
  async (pixels) => {
    width = pixels;
    const history = mount();
    await ready();
    expect(numbers()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    for (let n = 1; n <= 12; n++) {
      const link = rowLink(n);
      expect(badge(link)).toBe(n <= 9 ? String(n) : undefined);
      expect(link.getAttribute("aria-keyshortcuts")).toBe(n <= 9 ? `Alt+${n}` : null);
    }
    expect(jump(3).defaultPrevented).toBe(true);
    await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(3)}`));
    expect(history.location.search).toBe("?rev=3");
  },
);

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
  expect(numbers(rail)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  expect(badge(rowLink(3, rail))).toBe("3");
  expect(rowLink(3, rail).getAttribute("aria-keyshortcuts")).toBe("Alt+3");
  expect(jump(3).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(3)}`));
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
  expect(numbers()).toHaveLength(9);
  expect(jump(3, sheet).defaultPrevented).toBe(false);
  expect(history.location.pathname).toBe(`/r/${id(1)}`);
});

test.each(["page", "rail"])(
  "%s skips moved, snoozed, grouped and Done rows with fewer than nine Active rows",
  async (surface) => {
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
    expect(numbers()).toEqual(["1", "2"]);
    expect(badge(rowLink(2))).toBe("1");
    expect(badge(rowLink(6))).toBe("2");
    for (const n of [3, 4, 5]) expect(badge(rowLink(n))).toBeUndefined();
    expect(jump(2).defaultPrevented).toBe(true);
    await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(6)}`));
  },
);

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
  expect(history.location.pathname).toBe(path);
});

test("remapped jumps handle Ctrl+1 and leave Alt+1 alone", async () => {
  setJumpKeys("mod");
  const history = mount();
  await ready();
  expect(badge(rowLink(1))).toBe("1");
  expect(rowLink(1).getAttribute("aria-keyshortcuts")).toBe("Control+1");
  expect(jump(1).defaultPrevented).toBe(false);
  expect(history.location.pathname).toBe("/");
  expect(press("1", { ctrlKey: true, code: "Digit1" }).defaultPrevented).toBe(true);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${id(1)}`));
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

test("Alt+1 stays in the inbox search field", async () => {
  const history = mount();
  await ready();
  const input = screen.getByRole("textbox", { name: "Filter reviews" });
  act(() => input.focus());
  expect(jump(1, input).defaultPrevented).toBe(false);
  expect(history.location.pathname).toBe("/");
});

test.each(["/", `/r/${id(1)}`])("phone shows no jump numbers or handlers on %s", async (path) => {
  width = 767;
  const history = mount(path);
  if (path === "/") await ready();
  else await screen.findByRole("button", { name: "Approve" });
  expect(numbers()).toEqual([]);
  expect(jump(1).defaultPrevented).toBe(false);
  expect(history.location.pathname).toBe(path);
});

test.each([false, true])("? lists jumps as one row and the palette excludes them (off=%s)", async (off) => {
  if (off) setJumpKeys(null);
  mount();
  await ready();
  press("?", { shiftKey: true });
  const dialog = await screen.findByRole("alertdialog", { name: "Keyboard shortcuts" });
  const label = within(dialog).getByText("Open Active row 1 to 9");
  expect(label.tagName).toBe("DT");
  expect(label.nextElementSibling?.textContent).toBe(off ? "Off" : "Alt+1–9");
  expect(label.nextElementSibling?.querySelector("kbd") !== null).toBe(!off);
  expect(within(dialog).queryByText("Open Active row 1", { exact: true })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  press("P", { ctrlKey: true, shiftKey: true });
  const palette = await screen.findByRole("dialog", { name: "Command palette" });
  expect(within(palette).queryByRole("option", { name: /Open Active row/ })).toBeNull();
});

test.each([
  ["1", { ctrlKey: true, code: "Digit1" }, "mod"],
  ["&", { metaKey: true, code: "Digit1" }, "mod"],
  ["¡", { altKey: true, code: "Digit1" }, "alt"],
  ["0", { ctrlKey: true, code: "Digit0" }, "mod"],
] as const)("Settings captures %s (%j) as one patch for all nine %s keys", async (key, options, modifier) => {
  await openSettings();
  expect(jumpRow().getByText("Alt+1–9")).toBeTruthy();
  expect(jumpRow().getByText("Default.")).toBeTruthy();
  expect(jumpRow().queryByRole("button", { name: "Reset" })).toBeNull();
  expect(press(key, options, change()).defaultPrevented).toBe(true);
  await jumpRow().findByText("Set here.");
  expect(patches()).toHaveLength(1);
  expect(patchBody(0)).toEqual({
    keys: Object.fromEntries(jumpCommands.map((command, index) => [command, { key: `${modifier}+${index + 1}` }])),
  });
  expect(jumpRow().getByText(modifier === "mod" ? "Ctrl+1–9" : "Alt+1–9")).toBeTruthy();
  for (const [index, command] of jumpCommands.entries())
    expect(client.getQueryData<SettingsView>(["settings"])?.keys.commands[command].value).toBe(
      `${modifier}+${index + 1}`,
    );
});

test("Turn off and Reset each patch all nine commands once", async () => {
  await openSettings();
  fireEvent.click(jumpRow().getByRole("button", { name: "Turn off" }));
  await jumpRow().findByText("Off");
  expect(jumpRow().queryByRole("button", { name: "Turn off" })).toBeNull();
  expect(patches()).toHaveLength(1);
  expect(patchBody(0)).toEqual({ keys: Object.fromEntries(jumpCommands.map((command) => [command, { key: null }])) });
  fireEvent.click(jumpRow().getByRole("button", { name: "Reset" }));
  await jumpRow().findByText("Default.");
  expect(patches()).toHaveLength(2);
  expect(patchBody(1)).toEqual({ keys: Object.fromEntries(jumpCommands.map((command) => [command, null])) });
  expect(jumpRow().getByText("Alt+1–9")).toBeTruthy();
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

test("jump capture checks the full range against non-jump commands", async () => {
  settings.keys.commands["tab.writeup"].value = "mod+9";
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
  expect(jumpRow().getByText("Ctrl+1, Off, Off, Alt+4, Alt+5, Alt+6, Alt+7, Alt+8, Alt+9")).toBeTruthy();
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
