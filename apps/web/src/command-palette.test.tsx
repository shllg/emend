import { type InboxItem, KeysSetting, type RevisionView, type SettingsView, SHORTCUT_DEFAULTS } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { reviewQuery } from "./api/queries.ts";
import { defaultLayout, layoutStore } from "./lib/layout-store.ts";
import { keyLabel, shortcutGroups, shortcutLabels } from "./lib/shortcuts.ts";

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
let fetcher: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  width = 1280;
  localStorage.clear();
  layoutStore.update(defaultLayout);
  settings = defaultSettings();
  revision = structuredClone(initialRevision);
  inbox = structuredClone(items);
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
    if (path === "/api/v1/settings") return Response.json(settings);
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
  return within(dialog).getByRole<HTMLInputElement>("combobox", { name: "Command" });
};
const option = (label: string) => screen.getByRole("option", { name: new RegExp(`^${label}`) });
const selected = () => screen.queryByRole("option", { selected: true });
const search = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });

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
    expect(input.placeholder).toBe("Type a command…");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox", { name: "Commands" }).id);
    search(input, "files");
    press("Escape", {}, input);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    press("P", { metaKey: true, shiftKey: true }, opener);
    const reopened = await screen.findByRole<HTMLInputElement>("combobox", { name: "Command" });
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
  expect(screen.getAllByRole("option")).toHaveLength(Object.keys(SHORTCUT_DEFAULTS).length - 1);
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
  expect(screen.getByText("No command matches.")).toBe(status);
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
  expect(selected()).toBe(option("Next review or pub"));
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
