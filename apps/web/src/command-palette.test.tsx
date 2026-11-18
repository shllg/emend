import { type InboxItem, KeysSetting, type RevisionView, type SettingsView, SHORTCUT_DEFAULTS } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { inboxQuery, reviewQuery } from "./api/queries.ts";
import { defaultLayout, layoutStore } from "./lib/layout-store.ts";
import { jumpCommands, keyLabel, shortcutGroups, shortcutLabels } from "./lib/shortcuts.ts";

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
  groupId: null,
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
const mediaQueries = new Set<{ media: string; matches: boolean; events: EventTarget }>();
function matchesWidth(query: string) {
  const constraints = [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
  if (!constraints.length) throw new Error(`Unsupported media query: ${query}`);
  return constraints.every(([, bound, pixels]) =>
    bound === "min" ? width >= Number(pixels) : width <= Number(pixels),
  );
}
function resize(widthPx: number) {
  width = widthPx;
  for (const media of mediaQueries) {
    const matches = matchesWidth(media.media);
    if (matches === media.matches) continue;
    media.matches = matches;
    media.events.dispatchEvent(Object.assign(new Event("change"), { matches, media: media.media }));
  }
}
let fetcher: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  width = 1280;
  mediaQueries.clear();
  localStorage.clear();
  layoutStore.update(defaultLayout);
  settings = defaultSettings();
  revision = structuredClone(initialRevision);
  inbox = structuredClone(items);
  vi.stubGlobal("matchMedia", (query: string) => {
    const media = { matches: matchesWidth(query), media: query, events: new EventTarget() };
    mediaQueries.add(media);
    return Object.assign(media, {
      addEventListener: media.events.addEventListener.bind(media.events),
      removeEventListener: media.events.removeEventListener.bind(media.events),
    });
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("em-diff-pane") ? new DOMRect(0, 0, 900, 600) : new DOMRect();
  });
  fetcher = vi.fn(async (path, init) => {
    if (path === "/api/v1/session") return new Response(null, { status: 204 });
    if (path === "/api/v1/settings") return Response.json(settings);
    if (path === "/api/v1/devices") return Response.json({ items: [] });
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
    if (path.includes("/revisions/")) return Response.json({ ...revision, seq: Number(path.split("/").at(-1)) });
    const item =
      inbox.find((item) => path === `/api/v1/reviews/${item.id}`) ??
      (path === `/api/v1/reviews/${ids[0]}` ? items[0] : undefined);
    if (item)
      return Response.json({
        ...item,
        revisions: Array.from({ length: item.newestRevision }, (_, index) => ({
          seq: index + 1,
          createdAt: item.updatedAt,
        })),
      });
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
function mount(path = `/r/${ids[0]}`) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(
    <StrictMode>
      <App queryClient={client} history={history} />
    </StrictMode>,
  );
  return history;
}
const keyDown = (key: string, options: KeyboardEventInit = {}, target: HTMLElement = document.body) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  fireEvent(target, event);
  return event;
};
const press = (key: string, options: KeyboardEventInit = {}, target: HTMLElement = document.body) => {
  const event = keyDown(key, options, target);
  fireEvent.keyUp(target, { key, ...options });
  return event;
};
const ready = () => screen.findByRole("button", { name: "Approve revision 1" });
const writes = (method?: string) =>
  fetcher.mock.calls.filter(([, init]) => (method ? init?.method === method : init?.method && init.method !== "GET"));
const openPalette = async () => {
  press(
    "P",
    { ctrlKey: true, shiftKey: true },
    document.activeElement instanceof HTMLElement ? document.activeElement : document.body,
  );
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  return within(dialog).getByRole<HTMLInputElement>("combobox", { name: "Search" });
};
const option = (label: string) => screen.getByRole("option", { name: new RegExp(`^${label}`) });
const selected = () => screen.queryByRole("option", { selected: true });
const search = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });
const caps = (button: HTMLElement) => [...button.querySelectorAll("kbd")].map((cap) => cap.textContent);

test.each(["/", `/r/${ids[0]}`, "/settings", "/devices"])(
  "the wide top bar opens the palette on %s and restores focus on Escape",
  async (path) => {
    width = 1280;
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    mount(path);
    if (path === "/") await screen.findByRole("link", { name: /Review 1/ });
    else if (path === "/settings") await screen.findByText("The bin is empty.");
    else if (path === "/devices") await screen.findByText("No paired devices.");
    else await ready();
    const buttons = screen.getAllByRole("button", { name: "Search reviews and commands" });
    expect(buttons).toHaveLength(1);
    const button = screen.getByRole("button", { name: "Search reviews and commands" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Search reviews and commands");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+P");
    expect(caps(button)).toEqual(["Ctrl", "Shift", "P"]);
    const description = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Opens the command palette. Shortcut: Ctrl+Shift+P.");
    expect(description?.hidden).toBe(true);
    expect(description?.parentElement).toBe(button.parentElement);
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(dialog).getByRole("combobox", { name: "Search" });
    expect(document.activeElement).toBe(input);
    press("Escape", {}, input);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  },
);

test("the top bar follows changed and disabled palette keys and still opens on click", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  mount();
  await ready();
  const button = screen.getByRole("button", { name: "Search reviews and commands" });
  expect(caps(button)).toEqual(["Ctrl", "Shift", "P"]);
  for (const value of ["mod+k", null] as const) {
    act(() =>
      client.setQueryData<SettingsView>(
        ["settings"],
        (old) =>
          old && {
            ...old,
            keys: {
              ...old.keys,
              commands: {
                ...old.keys.commands,
                "palette.open": { ...old.keys.commands["palette.open"], value },
              },
            },
          },
      ),
    );
    await waitFor(() => expect(caps(button)).toEqual(value === null ? [] : ["Ctrl", "K"]));
    expect(button.getAttribute("aria-keyshortcuts")).toBe(value === null ? null : "Control+K");
    expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      value === null ? "Opens the command palette." : "Opens the command palette. Shortcut: Ctrl+K.",
    );
  }
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  expect(document.activeElement).toBe(within(dialog).getByRole("combobox", { name: "Search" }));
});

test("the wide top bar uses Mac key caps and the Meta ARIA shortcut", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  mount();
  await ready();
  const button = screen.getByRole("button", { name: "Search reviews and commands" });
  expect(caps(button)).toEqual(["⌘", "⇧", "P"]);
  expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+P");
});

test("the narrow top bar opens the palette from an icon before Refresh and restores focus", async () => {
  width = 900;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  mount();
  await ready();
  expect(screen.getAllByRole("button", { name: "Search reviews and commands" })).toHaveLength(1);
  const button = screen.getByRole("button", { name: "Search reviews and commands" });
  const refresh = screen.getByRole("button", { name: "Refresh" });
  expect(button.textContent).toBe("");
  expect(button.getAttribute("aria-label")).toBe("Search reviews and commands");
  expect(button.getAttribute("aria-haspopup")).toBe("dialog");
  expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+P");
  expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
    "Opens the command palette. Shortcut: Ctrl+Shift+P.",
  );
  expect(button.compareDocumentPosition(refresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  const input = within(dialog).getByRole("combobox", { name: "Search" });
  expect(document.activeElement).toBe(input);
  press("Escape", {}, input);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(button));
});

test.each([
  [1280, 900],
  [900, 1280],
])("the palette keeps its opener and restores focus after resizing from %s to %s", async (from, to) => {
  width = from;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  mount();
  await ready();
  const button = screen.getByRole("button", { name: "Search reviews and commands" });
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  const input = within(dialog).getByRole("combobox", { name: "Search" });
  act(() => resize(to));
  expect(screen.getByLabelText("Search reviews and commands", { selector: "button" })).toBe(button);
  expect(caps(button)).toEqual(to >= 1024 ? ["Ctrl", "Shift", "P"] : []);
  expect(document.activeElement).toBe(input);
  press("Escape", {}, input);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(button));
});

test.each(["/", `/r/${ids[0]}`])("the phone More menu opens the palette on %s and regains focus", async (path) => {
  width = 390;
  mount(path);
  if (path === "/") await screen.findByRole("link", { name: /Review 1/ });
  else await screen.findByRole("button", { name: "Approve" });
  expect(screen.queryByRole("button", { name: "Search reviews and commands" })).toBeNull();
  const more = screen.getByRole("button", { name: "More" });
  fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
  const menu = await screen.findByRole("menu", { name: "More" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Search reviews and commands" }));
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  const input = within(dialog).getByRole("combobox", { name: "Search" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(input);
  press("Escape", {}, input);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(more));
});

test("the phone palette Close button dismisses it and returns focus to More", async () => {
  width = 390;
  mount("/");
  await screen.findByRole("link", { name: /Review 1/ });
  const more = screen.getByRole("button", { name: "More" });
  fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
  const menu = await screen.findByRole("menu", { name: "More" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Search reviews and commands" }));
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  const close = within(dialog).getByRole("button", { name: "Close" });
  expect(close.classList.contains("hidden")).toBe(true);
  expect(close.classList.contains("[@media(pointer:coarse)]:inline-grid")).toBe(true);
  expect(close.classList.contains("inline-grid")).toBe(false);
  expect(within(dialog).getByText("Esc").classList.contains("[@media(pointer:coarse)]:hidden")).toBe(true);
  fireEvent.click(close);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(more));
});

test("the palette publishes the visual viewport height when opened and when the keyboard resizes", async () => {
  mount();
  await ready();
  class FakeViewport extends EventTarget {
    height = 500;
    offsetTop = 0;
    scale = 1;
  }
  const viewport = new FakeViewport();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  fireEvent.click(screen.getByRole("button", { name: "Search reviews and commands" }));
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  within(dialog).getByRole("combobox", { name: "Search" }).scrollIntoView = vi.fn();
  act(() => {
    for (const frame of frames.splice(0)) frame(0);
  });
  expect(dialog.style.getPropertyValue("--visual-height")).toBe("500px");
  act(() => {
    viewport.height = 360;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    for (const frame of frames.splice(0)) frame(0);
  });
  expect(dialog.style.getPropertyValue("--visual-height")).toBe("360px");
});

test.each([1280, 900])(
  "opens with Ctrl or Meta on width %s, focuses search and restores the opener on Escape",
  async (size) => {
    width = size;
    mount();
    const opener = await ready();
    act(() => opener.focus());
    const input = await openPalette();
    const focus = vi.spyOn(opener, "focus");
    expect(document.activeElement).toBe(input);
    expect(input.placeholder).toBe("Find a review, pub or command…");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox", { name: "Results" }).id);
    search(input, "files");
    press("Escape", {}, input);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    press("P", { metaKey: true, shiftKey: true }, opener);
    const reopened = await screen.findByRole<HTMLInputElement>("combobox", { name: "Search" });
    expect(reopened.value).toBe("");
    expect(document.activeElement).toBe(reopened);
  },
);

test("lists every other command in its group with live keys and no hint for an off key", async () => {
  settings.keys.commands["file.next"].value = "mod+k";
  settings.keys.commands["review.snooze"].value = null;
  mount();
  await ready();
  await openPalette();
  expect(screen.getAllByRole("option")).toHaveLength(Object.keys(SHORTCUT_DEFAULTS).length - jumpCommands.length - 1);
  expect(screen.queryByRole("option", { name: /Open the command palette/ })).toBeNull();
  for (const group of shortcutGroups) {
    const section = screen.getByRole("group", { name: group.label });
    expect(section.tagName).toBe("DIV");
    expect(within(section).getByRole("presentation").textContent).toBe(group.label);
    for (const command of group.commands.filter((command) => command !== "palette.open")) {
      const row = within(section).getByRole("option", { name: new RegExp(`^${shortcutLabels[command]}`) });
      const key = settings.keys.commands[command].value;
      expect(row.querySelector("kbd")?.textContent ?? null).toBe(key === null ? null : keyLabel(key));
    }
  }
  act(() =>
    client.setQueryData<SettingsView>(
      ["settings"],
      (old) =>
        old && {
          ...old,
          keys: {
            ...old.keys,
            commands: {
              ...old.keys.commands,
              "file.next": { ...old.keys.commands["file.next"], value: "mod+shift+k" },
            },
          },
        },
    ),
  );
  await waitFor(() => expect(option("Next file").querySelector("kbd")?.textContent).toBe(keyLabel("mod+shift+k")));
});

test("finds letters with gaps, resets selection on search and shows when no command matches", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  mount();
  await ready();
  await within(screen.getByTestId("diff-pane")).findByRole("button", { name: "Mark a.txt as viewed" });
  const input = await openPalette();
  const status = within(screen.getByRole("dialog", { name: "Command palette" })).getByRole("status");
  expect(status.textContent).toBe("");
  expect(status.closest('[role="listbox"]')).toBeNull();
  search(input, "tab");
  expect(selected()).toBe(option("Docs tab"));
  press("ArrowDown", {}, input);
  expect(selected()).toBe(option("Files tab"));
  search(input, "ta");
  expect(option("Files tab").getAttribute("aria-disabled")).toBe("false");
  const firstAvailable = screen.getAllByRole("option").find((row) => row.getAttribute("aria-disabled") === "false");
  expect(selected()).toBe(firstAvailable);
  expect(selected()).toBe(option("Docs tab"));
  search(input, "nxtfl");
  expect(screen.getAllByRole("option")).toEqual([option("Next file")]);
  expect(selected()).toBe(option("Next file"));
  expect(input.getAttribute("aria-activedescendant")).toBe(selected()?.id);
  search(input, "xyz");
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  expect(screen.getByText("Nothing matches.")).toBe(status);
  expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  expect(press("ArrowDown", {}, input).defaultPrevented).toBe(true);
  press("Enter", {}, input);
  expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  search(input, "file");
  expect(within(screen.getByRole("dialog", { name: "Command palette" })).getByRole("status")).toBe(status);
  expect(status.textContent).toBe("");
});

test("sorts matches within groups and groups by their best score, keeping ties stable", async () => {
  mount();
  await ready();
  const input = await openPalette();
  search(input, "nf");
  const rows = screen.getAllByRole("option");
  expect(rows[0]).toBe(option("Next file"));
  expect(rows.indexOf(option("Next file"))).toBeLessThan(rows.indexOf(option("Switch the inbox filter")));
  expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-labelledby"))).toHaveLength(2);
  search(input, "tab");
  expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual([
    "Docs tab3",
    "Diff tab5",
    "Files tab2",
    "Writeup tab1",
    "Comments tab4",
  ]);
});

test("arrows wrap through available rows, skip unavailable rows and leave text editing keys alone", async () => {
  mount("/");
  await screen.findByRole("link", { name: /Review 1/ });
  const input = await openPalette();
  const available = screen.getAllByRole("option").filter((row) => row.getAttribute("aria-disabled") !== "true");
  expect(selected()).toBe(available[0]);
  for (let index = 1; index <= available.length; index++) {
    expect(press("ArrowDown", {}, input).defaultPrevented).toBe(true);
    expect(selected()).toBe(available[index % available.length]);
    expect(input.getAttribute("aria-activedescendant")).toBe(selected()?.id);
  }
  press("ArrowUp", {}, input);
  expect(selected()).toBe(available.at(-1));
  expect(input.getAttribute("aria-activedescendant")).toBe(selected()?.id);
  for (const key of ["Home", "End", "ArrowLeft", "ArrowRight"])
    expect(press(key, {}, input).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(input);
  search(input, "");
  search(input, "review");
  expect(selected()).toBe(option("Review 1"));
});

test("lists review commands as unavailable on the inbox and never selects or runs them", async () => {
  const history = mount("/");
  await screen.findByRole("link", { name: /Review 1/ });
  const input = await openPalette();
  for (const row of within(screen.getByRole("group", { name: "Review page" })).getAllByRole("option")) {
    expect(row.getAttribute("aria-disabled")).toBe("true");
    fireEvent.pointerMove(row);
    expect(row.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(row);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  }
  search(input, "Files tab");
  expect(selected()).toBeNull();
  expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  press("ArrowDown", {}, input);
  press("ArrowUp", {}, input);
  press("Enter", {}, input);
  expect(history.location.pathname).toBe("/");
  expect(writes()).toHaveLength(0);
});

test.each([
  ["Enter", { isComposing: true }],
  ["ArrowDown", { isComposing: true }],
  ["Enter", { keyCode: 229 }],
] as const)("leaves IME %s with %j alone without running a command or moving selection", async (key, options) => {
  const history = mount();
  await ready();
  const input = await openPalette();
  search(input, "tab");
  const active = selected();
  expect(active).toBe(option("Docs tab"));
  const location = history.location.href;
  expect(press(key, options, input).defaultPrevented).toBe(false);
  expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  expect(selected()).toBe(active);
  expect(input.getAttribute("aria-activedescendant")).toBe(active?.id);
  expect(history.location.href).toBe(location);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(writes()).toHaveLength(0);
});

test.each(["Enter", "click"])("runs Files tab with %s after closing the palette", async (method) => {
  mount();
  await ready();
  const input = await openPalette();
  search(input, "Files tab");
  if (method === "Enter") press("Enter", {}, input);
  else fireEvent.click(option("Files tab"));
  await waitFor(() => expect(screen.getByRole("tab", { name: /Files/ }).getAttribute("aria-selected")).toBe("true"));
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
});

test("held Enter keeps the palette open and runs the command once on release", async () => {
  mount();
  const opener = await ready();
  act(() => opener.focus());
  const instructions = screen.getByRole("textbox", { name: "Instructions" });
  const focus = vi.spyOn(instructions, "focus");
  const input = await openPalette();
  search(input, "Write the Send instructions");
  expect(keyDown("Enter", {}, input).defaultPrevented).toBe(true);
  fireEvent.pointerMove(option("Write the Send instructions"));
  for (let repeat = 0; repeat < 3; repeat++)
    expect(keyDown("Enter", { repeat: true }, input).defaultPrevented).toBe(true);
  expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  expect(document.activeElement).toBe(input);
  expect(focus).not.toHaveBeenCalled();
  expect(writes()).toHaveLength(0);
  fireEvent.keyUp(input, { key: "Enter" });
  await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
  expect(document.activeElement).toBe(instructions);
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  expect(writes()).toHaveLength(0);
});

test.each(["ctrlKey", "metaKey", "altKey", "shiftKey"])(
  "Enter with %s disarms without running a command or preventing the key",
  async (modifier) => {
    mount();
    await ready();
    const input = await openPalette();
    search(input, "Approve");
    expect(selected()).toBe(option("Approve"));
    expect(press("Enter", { [modifier]: true }, input).defaultPrevented).toBe(false);
    keyDown("Enter", {}, input);
    expect(keyDown("Enter", { [modifier]: true }, input).defaultPrevented).toBe(false);
    fireEvent.keyUp(input, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    keyDown("Enter", {}, input);
    expect(fireEvent.keyUp(input, { key: "Enter", [modifier]: true })).toBe(true);
    fireEvent.keyUp(input, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes()).toHaveLength(0);
  },
);

test("repeat Enter without an initial keydown never arms a command", async () => {
  mount();
  await ready();
  const input = await openPalette();
  search(input, "Approve");
  expect(keyDown("Enter", { repeat: true }, input).defaultPrevented).toBe(true);
  fireEvent.keyUp(input, { key: "Enter" });
  expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(writes()).toHaveLength(0);
});

test.each(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "typing", "pointer move", "close"])(
  "%s disarms a held Enter",
  async (action) => {
    const history = mount();
    const opener = await ready();
    act(() => opener.focus());
    let input = await openPalette();
    search(input, "tab");
    const location = history.location.href;
    keyDown("Enter", {}, input);
    if (action === "typing") search(input, "ta");
    else if (action === "pointer move") {
      fireEvent.pointerMove(option("Files tab"));
      fireEvent.pointerMove(option("Docs tab"));
    } else if (action === "close") {
      press("Escape", {}, input);
      await waitFor(() => expect(document.activeElement).toBe(opener));
      input = await openPalette();
      search(input, "tab");
    } else {
      press(action, {}, input);
      if (action === "ArrowDown") press("ArrowUp", {}, input);
      if (action === "ArrowUp") press("ArrowDown", {}, input);
    }
    fireEvent.keyUp(input, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(history.location.href).toBe(location);
    expect(writes()).toHaveLength(0);
  },
);

test.each([{ isComposing: true }, { keyCode: 229 }])(
  "composing Escape (%j) keeps the palette open",
  async (options) => {
    mount();
    await ready();
    const input = await openPalette();
    search(input, "tab");
    const active = selected();
    expect(press("Escape", options, input).defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(selected()).toBe(active);
    expect(input.getAttribute("aria-activedescendant")).toBe(active?.id);
    expect(writes()).toHaveLength(0);
  },
);

test("runs Files tab with Enter even when its shortcut key is off", async () => {
  settings.keys.commands["tab.files"].value = null;
  mount();
  await ready();
  const input = await openPalette();
  search(input, "Files tab");
  expect(selected()).toBe(option("Files tab"));
  expect(option("Files tab").querySelector("kbd")).toBeNull();
  press("Enter", {}, input);
  await waitFor(() => expect(screen.getByRole("tab", { name: /Files/ }).getAttribute("aria-selected")).toBe("true"));
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  expect(writes()).toHaveLength(0);
});

test("restores focus before running the command that focuses the Instructions field", async () => {
  mount();
  const opener = await ready();
  act(() => opener.focus());
  const input = await openPalette();
  search(input, "Write the Send instructions");
  press("Enter", {}, input);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Instructions" })));
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
});

test.each([
  ["Show keyboard shortcuts", "Keyboard shortcuts"],
  ["Snooze", "Snooze this review"],
  ["Approve", "Approve revision 1?"],
] as const)("opens %s only after removing the palette's modal layer", async (label, title) => {
  mount();
  const opener = await ready();
  act(() => opener.focus());
  const input = await openPalette();
  const palette = screen.getByRole("dialog", { name: "Command palette" });
  search(input, label);
  press("Enter", {}, input);
  const dialog = await screen.findByRole("alertdialog", { name: title });
  expect(palette.isConnected).toBe(false);
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(writes()).toHaveLength(0);
  press("Escape", {}, document.activeElement as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
  expect(writes()).toHaveLength(0);
});

test.each(["Show keyboard shortcuts", "Snooze", "Approve"])(
  "does not run %s when another dialog opens while Enter is held",
  async (label) => {
    mount();
    const opener = await ready();
    act(() => opener.focus());
    const input = await openPalette();
    search(input, label);
    expect(selected()).toBe(option(label));
    keyDown("Enter", {}, input);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    try {
      fireEvent.keyUp(input, { key: "Enter" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(opener));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(dialog.isConnected).toBe(true);
      expect(writes()).toHaveLength(0);
    } finally {
      dialog.remove();
    }
  },
);

test("diff commands are unavailable on the Writeup tab and available on the Diff tab in Tabs layout", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  mount();
  const opener = await ready();
  await within(screen.getByTestId("diff-pane")).findByRole("button", { name: "Mark a.txt as viewed" });
  act(() => layoutStore.update({ pane: { ...defaultLayout.pane, desktop: "tabs" } }));
  act(() => opener.focus());
  expect(screen.getByRole("tab", { name: /Writeup/ }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByTestId("diff-pane").hidden).toBe(true);
  const input = await openPalette();
  const labels = ["Next file", "Previous file", "Mark the current file viewed"];
  for (const label of labels) expect(option(label).getAttribute("aria-disabled")).toBe("true");
  press("Escape", {}, input);
  await waitFor(() => expect(document.activeElement).toBe(opener));
  press("5");
  await waitFor(() => expect(screen.getByRole("tab", { name: /Diff/ }).getAttribute("aria-selected")).toBe("true"));
  await within(screen.getByTestId("diff-pane")).findByRole("button", { name: "Mark a.txt as viewed" });
  expect(screen.getByTestId("diff-pane").hidden).toBe(false);
  await openPalette();
  for (const label of labels) expect(option(label).getAttribute("aria-disabled")).toBe("false");
});

test.each([false, true])(
  "unsent comments disable the selected Approve without selecting another row (armed: %s)",
  async (armed) => {
    mount();
    await ready();
    const input = await openPalette();
    fireEvent.pointerMove(option("Approve"));
    expect(selected()).toBe(option("Approve"));
    if (armed) keyDown("Enter", {}, input);
    act(() => client.setQueryData(reviewQuery(ids[0]).queryKey, (old) => old && { ...old, unsentCount: 1 }));
    await waitFor(() => expect(option("Approve").getAttribute("aria-disabled")).toBe("true"));
    expect(option("Show keyboard shortcuts").getAttribute("aria-disabled")).toBe("false");
    expect(selected()).toBeNull();
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    if (armed) fireEvent.keyUp(input, { key: "Enter" });
    else press("Enter", {}, input);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes()).toHaveLength(0);
    act(() => client.setQueryData(reviewQuery(ids[0]).queryKey, (old) => old && { ...old, unsentCount: 0 }));
    await waitFor(() => expect(option("Approve").getAttribute("aria-disabled")).toBe("false"));
    expect(selected()).toBe(option("Approve"));
  },
);

test.each([
  ["ArrowUp", -1],
  ["ArrowDown", 0],
] as const)(
  "%s selects the available boundary row after the selected command becomes unavailable",
  async (key, index) => {
    mount();
    await ready();
    const input = await openPalette();
    fireEvent.pointerMove(option("Approve"));
    expect(selected()).toBe(option("Approve"));
    act(() => client.setQueryData(reviewQuery(ids[0]).queryKey, (old) => old && { ...old, unsentCount: 1 }));
    await waitFor(() => expect(option("Approve").getAttribute("aria-disabled")).toBe("true"));
    expect(selected()).toBeNull();
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    const available = screen.getAllByRole("option").filter((row) => row.getAttribute("aria-disabled") !== "true");
    expect(available.length).toBeGreaterThan(1);
    expect(press(key, {}, input).defaultPrevented).toBe(true);
    expect(selected()).toBe(available.at(index));
    expect(input.getAttribute("aria-activedescendant")).toBe(selected()?.id);
    expect(document.activeElement).toBe(input);
    expect(writes()).toHaveLength(0);
  },
);

test("lists Approve and Snooze as unavailable on a retired review and keeps the palette open on Enter", async () => {
  inbox[0] = { ...(inbox[0] as InboxItem), state: "settled" };
  mount();
  await ready();
  const input = await openPalette();
  expect(option("Approve").getAttribute("aria-disabled")).toBe("true");
  expect(option("Snooze").getAttribute("aria-disabled")).toBe("true");
  search(input, "Snooze");
  expect(selected()).toBeNull();
  expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  press("Enter", {}, input);
  expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(writes()).toHaveLength(0);
});

test("lists Approve as unavailable when the review has unsent comments", async () => {
  inbox[0] = { ...(inbox[0] as InboxItem), unsentCount: 1 };
  mount();
  await ready();
  const input = await openPalette();
  expect(option("Approve").getAttribute("aria-disabled")).toBe("true");
  search(input, "Approve");
  expect(selected()).toBeNull();
  expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  press("Enter", {}, input);
  expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(writes()).toHaveLength(0);
});

test("returns focus to a Files row before marking that file viewed", async () => {
  mount();
  await ready();
  press("2");
  const file = await screen.findByRole("button", { name: /^Open diff for b.txt/ });
  act(() => file.focus());
  const input = await openPalette();
  const focus = vi.spyOn(file, "focus");
  search(input, "Mark the current file viewed");
  press("Enter", {}, input);
  await waitFor(() => expect(writes("PUT")).toHaveLength(1));
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(JSON.parse(String(writes("PUT")[0]?.[1]?.body)).paths).toEqual(["b.txt"]);
});

test("pointer movement selects an available row without taking focus from search", async () => {
  mount();
  await ready();
  const input = await openPalette();
  const files = option("Files tab");
  fireEvent.pointerMove(files);
  expect(selected()).toBe(files);
  expect(input.getAttribute("aria-activedescendant")).toBe(files.id);
  expect(document.activeElement).toBe(input);
});

test.each(["text field", "dialog", "menu", "phone"])("stays closed in a %s", async (context) => {
  if (context === "phone") width = 400;
  mount();
  await screen.findByRole("button", { name: context === "phone" ? "Approve" : "Approve revision 1" });
  let target = document.body;
  if (context === "text field") target = screen.getByRole("textbox", { name: "Instructions" });
  if (context === "dialog") {
    press("?");
    await screen.findByRole("alertdialog", { name: "Keyboard shortcuts" });
  }
  if (context === "menu") {
    fireEvent.pointerDown(screen.getByRole("button", { name: "More review actions" }), { button: 0, ctrlKey: false });
    await screen.findByRole("menu");
  }
  act(() => target.focus());
  expect(press("P", { ctrlKey: true, shiftKey: true }, target).defaultPrevented).toBe(false);
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
});

test("uses a changed palette key and stops handling its default key", async () => {
  settings.keys.commands["palette.open"].value = "mod+k";
  mount();
  await ready();
  expect(press("P", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  expect(press("k", { ctrlKey: true }).defaultPrevented).toBe(true);
  await screen.findByRole("dialog", { name: "Command palette" });
});

test("comment stepping commands appear in the Review page group", async () => {
  mount();
  await ready();
  await openPalette();
  const group = within(screen.getByRole("group", { name: "Review page" }));
  expect(group.getByRole("option", { name: /^Next comment/ }).querySelector("kbd")?.textContent).toBe(".");
  expect(group.getByRole("option", { name: /^Previous comment/ }).querySelector("kbd")?.textContent).toBe(",");
});

test.each([
  ["/", "Enter", "review"],
  [`/r/${ids[0]}`, "Enter", "publish"],
  ["/", "click", "publish"],
  [`/r/${ids[0]}`, "click", "review"],
] as const)("opens a matching item from %s with %s (%s)", async (path, method, kind) => {
  inbox[1] = {
    ...(inbox[1] as InboxItem),
    title: "Performance harness results",
    project: "Toolkit",
    branch: "emend-175-a-perf-harness",
    newestRevision: 3,
    kind,
  };
  const history = mount(path);
  if (path === "/") await screen.findByRole("link", { name: /Review 1/ });
  else await ready();
  const opener = screen.getByRole("button", { name: "Search reviews and commands" });
  act(() => opener.focus());
  const focus = vi.spyOn(opener, "focus");
  const input = await openPalette();
  search(input, "perf");
  const group = await screen.findByRole("group", { name: "Reviews and pubs" });
  const row = within(group).getByRole("option", { name: /^Performance harness results/ });
  expect(row.textContent).toBe(
    `Performance harness results${kind === "review" ? "Review" : "Pub"} · Workshop · Toolkit · emend-175-a-perf-harness`,
  );
  expect(within(row).getByText("Performance harness results").getAttribute("dir")).toBe("auto");
  expect(selected()).toBe(row);
  expect(input.getAttribute("aria-activedescendant")).toBe(row.id);
  if (method === "Enter") {
    keyDown("Enter", {}, input);
    for (let repeat = 0; repeat < 3; repeat++) keyDown("Enter", { repeat: true }, input);
    expect(history.location.pathname).toBe(path);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    fireEvent.keyUp(input, { key: "Enter" });
  } else fireEvent.click(row);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${ids[1]}`));
  expect(new URLSearchParams(history.location.search).get("rev")).toBe("3");
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(writes()).toHaveLength(0);
});

test.each(["Enter", "click"])("opens the chosen item after it leaves the inbox while closing (%s)", async (method) => {
  inbox[1] = { ...(inbox[1] as InboxItem), newestRevision: 3 };
  const history = mount();
  await ready();
  const input = await openPalette();
  search(input, "Review 2");
  const row = option("Review 2");
  expect(selected()).toBe(row);
  if (method === "Enter") keyDown("Enter", {}, input);
  act(() => {
    if (method === "Enter") fireEvent.keyUp(input, { key: "Enter" });
    else fireEvent.click(row);
    expect(history.location.pathname).toBe(`/r/${ids[0]}`);
    client.setQueryData(
      inboxQuery().queryKey,
      (old) => old && { ...old, items: old.items.filter((item) => item.id !== ids[1]) },
    );
  });
  expect(client.getQueryData(inboxQuery().queryKey)?.items.some((item) => item.id === ids[1])).toBe(false);
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${ids[1]}`));
  expect(new URLSearchParams(history.location.search).get("rev")).toBe("3");
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  expect(writes()).toHaveLength(0);
});

test("command groups win score ties and arrows and pointer move between commands and items", async () => {
  inbox[1] = { ...(inbox[1] as InboxItem), title: "Show keyboard shortcuts" };
  mount();
  await ready();
  const input = await openPalette();
  search(input, "keyboard");
  const results = screen.getByRole("listbox", { name: "Results" });
  expect(within(results).getAllByRole("group")).toHaveLength(2);
  const [command, item] = within(results).getAllByRole("option");
  expect(command?.closest('[role="group"]')?.getAttribute("aria-labelledby")).toContain("Everywhere");
  expect(item?.closest('[role="group"]')?.getAttribute("aria-labelledby")).toContain("Reviews-and-pubs");
  expect(selected()).toBe(command);
  press("ArrowDown", {}, input);
  expect(selected()).toBe(item);
  expect(input.getAttribute("aria-activedescendant")).toBe(item?.id);
  press("ArrowUp", {}, input);
  expect(selected()).toBe(command);
  fireEvent.pointerMove(item as HTMLElement);
  expect(selected()).toBe(item);
  expect(document.activeElement).toBe(input);
  search(input, "keyboar");
  expect(selected()).toBe(command);
  expect(within(screen.getByRole("group", { name: "Reviews and pubs" })).getByRole("option").id).toBe(item?.id);
});

test("an issue number selects the branch carrying it before decoys", async () => {
  inbox[0] = { ...(inbox[0] as InboxItem), branch: "emend-157-foo" };
  inbox[1] = { ...(inbox[1] as InboxItem), branch: "emend-175-a-perf-harness" };
  inbox[2] = { ...(inbox[2] as InboxItem), title: "1 thing, 7 tasks, 5 results" };
  mount();
  await ready();
  const input = await openPalette();
  search(input, "175");
  expect(selected()).toBe(option("Review 2"));
  expect(screen.getAllByRole("option")).toEqual([option("Review 2"), option("1 thing")]);
});

test("Done follows active matches and its higher score determines the item group's position", async () => {
  inbox[1] = { ...(inbox[1] as InboxItem), title: "Notes on keyboard", list: "active" };
  inbox[2] = { ...(inbox[2] as InboxItem), title: "Keyboard", list: "done" };
  mount();
  await ready();
  const input = await openPalette();
  search(input, "keyboard");
  const groups = within(screen.getByRole("listbox", { name: "Results" })).getAllByRole("group");
  expect(groups[0]).toBe(screen.getByRole("group", { name: "Reviews and pubs" }));
  const rows = within(groups[0] as HTMLElement).getAllByRole("option");
  expect(rows.map((row) => row.textContent)).toEqual([
    "Notes on keyboardReview · Workshop · main",
    "KeyboardPub · Workshop · main · Done",
  ]);
  expect(selected()).toBe(rows[0]);
});

test("Done stays outside the truncating metadata when the branch is long", async () => {
  const branch = `emend-175-${"long-branch-name-".repeat(100)}`;
  inbox[1] = { ...(inbox[1] as InboxItem), branch, list: "done" };
  mount();
  await ready();
  const input = await openPalette();
  search(input, "Review 2");
  const row = option("Review 2");
  const metadata = within(row).getByText(branch).closest(".truncate");
  const done = within(row).getByText("· Done");
  expect(metadata?.classList.contains("min-w-0")).toBe(true);
  expect(metadata?.contains(done)).toBe(false);
  expect(done.closest(".truncate")).toBeNull();
  expect(done.classList.contains("shrink-0")).toBe(true);
  expect(done.classList.contains("whitespace-pre")).toBe(true);
  expect(done.textContent).toBe(" · Done");
  expect(done.previousElementSibling).toBe(metadata);
  expect(done.parentElement?.classList.contains("flex")).toBe(true);
});

test.each(["review", "publish"] as const)("isolates remote metadata from %s and Done labels", async (kind) => {
  const popIsolate = String.fromCharCode(0x2069);
  const override = String.fromCharCode(0x202e);
  const machine = `${popIsolate}${override}Workshop`;
  const project = `${popIsolate}${override}Toolkit`;
  const branch = `${popIsolate}${override}emend-175-harness`;
  inbox[1] = {
    ...(inbox[1] as InboxItem),
    kind,
    list: "done",
    origin: { id: ids[0], name: machine },
    project,
    branch,
  };
  mount();
  await ready();
  const input = await openPalette();
  search(input, "Review 2");
  const row = option("Review 2");
  expect(row.textContent).not.toContain(popIsolate);
  expect(row.textContent).not.toContain(override);
  for (const value of ["Workshop", "Toolkit", "emend-175-harness"]) {
    const isolated = within(row).getByText(value).closest("bdi");
    expect(isolated?.textContent).toBe(value);
  }
  expect(within(row).getByText("emend-175-harness").classList.contains("font-mono")).toBe(true);
  const label = kind === "review" ? "Review" : "Pub";
  expect(
    within(row)
      .getByText(new RegExp(`^${label} ·`))
      .closest('bdi, [dir="auto"]'),
  ).toBeNull();
  expect(within(row).getByText("· Done").closest('bdi, [dir="auto"]')).toBeNull();
});

test("uses the server clock and group membership when labelling Done", async () => {
  inbox[1] = { ...(inbox[1] as InboxItem), title: "Harness grouped", groupId: ids[0], list: "done" };
  inbox[2] = {
    ...(inbox[2] as InboxItem),
    title: "Harness expired",
    activeUntil: "2030-01-01T00:00:00.000Z",
  };
  mount();
  await ready();
  const input = await openPalette();
  await waitFor(() => expect(client.getQueryData(inboxQuery().queryKey)).toBeDefined());
  act(() =>
    client.setQueryData(inboxQuery().queryKey, (old) =>
      old
        ? {
            ...old,
            groups: [{ id: ids[0], name: "Saved", members: 1 }],
            serverTime: "2030-01-02T00:00:00.000Z",
            receivedAt: Date.now(),
            receivedMono: performance.now(),
          }
        : old,
    ),
  );
  search(input, "harness");
  await waitFor(() => expect(option("Harness expired").textContent).toContain(" · Done"));
  expect(option("Harness grouped").textContent).not.toContain("Done");
  expect(selected()).toBe(option("Harness grouped"));
});

test("moved items are listed as unavailable, skipped by selection and never opened", async () => {
  inbox[1] = { ...(inbox[1] as InboxItem), title: "Harness moved", movedTo: "https://example.com/review" };
  inbox[2] = { ...(inbox[2] as InboxItem), title: "Harness available" };
  const history = mount();
  await ready();
  const input = await openPalette();
  search(input, "harness");
  const moved = option("Harness moved");
  const available = option("Harness available");
  expect(screen.getAllByRole("option")).toEqual([moved, available]);
  expect(moved.getAttribute("aria-disabled")).toBe("true");
  expect(moved.textContent).toContain("Moved to example.com");
  expect(within(moved).getByText("example.com").closest('bdi, [dir="auto"]')?.textContent).toBe("example.com");
  expect(selected()).toBe(available);
  for (const key of ["ArrowDown", "ArrowUp"]) {
    press(key, {}, input);
    expect(selected()).toBe(available);
  }
  fireEvent.pointerMove(moved);
  expect(selected()).toBe(available);
  fireEvent.click(moved);
  search(input, "moved");
  expect(selected()).toBeNull();
  expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  press("Enter", {}, input);
  expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  expect(history.location.pathname).toBe(`/r/${ids[0]}`);
});

test("blank queries show commands only, including after searching", async () => {
  mount();
  await ready();
  const input = await openPalette();
  for (const value of ["", "   "]) {
    search(input, value);
    expect(screen.queryByRole("group", { name: "Reviews and pubs" })).toBeNull();
    expect(screen.queryByRole("option", { name: /^Review 1/ })).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(Object.keys(SHORTCUT_DEFAULTS).length - jumpCommands.length - 1);
    search(input, "review");
    expect(screen.getByRole("group", { name: "Reviews and pubs" })).toBeTruthy();
  }
});

test("agent-written titles and metadata render only as text", async () => {
  const title = "<img src=x onerror=alert(1)>";
  inbox[1] = {
    ...(inbox[1] as InboxItem),
    title,
    project: "<script>alert(1)</script>",
    branch: "<svg onload=alert(1)>",
    origin: { id: ids[0], name: "<b>Workshop</b>" },
  };
  mount();
  await ready();
  const input = await openPalette();
  search(input, "img");
  const group = screen.getByRole("group", { name: "Reviews and pubs" });
  expect(within(group).getByText(title).textContent).toBe(title);
  expect(within(group).getByRole("option").textContent).toContain(
    "Review · <b>Workshop</b> · <script>alert(1)</script> · <svg onload=alert(1)>",
  );
  expect(group.querySelector("img, script, svg, b")).toBeNull();
});

test("settings fetches the inbox only when the palette opens and selects results arriving after typing", async () => {
  mount("/settings");
  await screen.findByText("The bin is empty.");
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/reviews")).toHaveLength(0);
  const respond = fetcher.getMockImplementation();
  let release = () => {};
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  fetcher.mockImplementation(async (path, init) => {
    if (path === "/api/v1/reviews") await response;
    if (!respond) throw new Error("Missing fixture response");
    return respond(path, init);
  });
  const input = await openPalette();
  search(input, "Review 2");
  expect(selected()).toBeNull();
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/reviews")).toHaveLength(1);
  release();
  await waitFor(() => expect(selected()).toBe(option("Review 2")));
});

test.each(["repeat", "typing", "pointer", "arrows"])(
  "%s does not release a stale Enter into an item",
  async (action) => {
    const history = mount();
    await ready();
    const input = await openPalette();
    search(input, "review");
    expect(selected()).toBe(option("Review 1"));
    keyDown("Enter", { repeat: action === "repeat" }, input);
    if (action === "typing") search(input, "revie");
    else if (action === "pointer") {
      fireEvent.pointerMove(option("Review 2"));
      fireEvent.pointerMove(option("Review 1"));
    } else if (action === "arrows") {
      press("ArrowDown", {}, input);
      press("ArrowUp", {}, input);
    }
    fireEvent.keyUp(input, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(history.location.pathname).toBe(`/r/${ids[0]}`);
  },
);
