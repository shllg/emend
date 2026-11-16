import { type InboxGroup, InboxItem } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { defaultLayout, layoutStore } from "./lib/layout-store.ts";

const alpha = { id: "11111111-1111-4111-8111-111111111111", name: "Alpha" };
const beta = { id: "22222222-2222-4222-8222-222222222222", name: "Beta" };
function item(n: number, patch: Partial<InboxItem> = {}): InboxItem {
  return InboxItem.parse({
    id: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
    title: `Item ${n}`,
    origin: { id: alpha.id, name: "Workshop" },
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
let groups: InboxGroup[];
let items: InboxItem[];
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  localStorage.clear();
  layoutStore.update(defaultLayout);
  groups = [beta, alpha];
  items = [
    item(1),
    item(2, { list: "snoozed", snoozed: true }),
    item(3, { groupId: beta.id }),
    item(4, { groupId: alpha.id, agentWaiting: true }),
    item(5, { list: "done", state: "settled" }),
  ];
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ media: query, matches: true, addEventListener() {}, removeEventListener() {} })),
  );
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      groups = groups.map((group) => (path.endsWith(group.id) ? { ...group, name: body.name } : group));
      return Response.json(groups.find((group) => path.endsWith(group.id)));
    }
    if (init?.method === "DELETE") {
      groups = groups.filter((group) => !path.endsWith(group.id));
      items = items.map((row) => (row.groupId && path.endsWith(row.groupId) ? { ...row, groupId: null } : row));
      return new Response(null, { status: 204 });
    }
    if (path === "/api/v1/reviews")
      return Response.json({
        items,
        groups: groups.map((group) => ({ ...group, members: items.filter((row) => row.groupId === group.id).length })),
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
  vi.unstubAllGlobals();
});
function mount(path = "/") {
  return render(<App queryClient={client} history={createMemoryHistory({ initialEntries: [path] })} />);
}
async function menu(name = alpha.name, action = "Rename group…") {
  fireEvent.keyDown(await screen.findByRole("button", { name: `Actions for group “${name}”` }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
}

test("groups render between Snoozed and Done, collapsed with counts; toggle shows the row and needs-you dot", async () => {
  const { container } = mount();
  await screen.findByRole("region", { name: "Alpha" });
  const sections = [...container.querySelectorAll("section[aria-label]")].map((section) =>
    section.getAttribute("aria-label"),
  );
  expect(sections).toEqual(["Active", "Snoozed", "Alpha", "Beta", "Done"]);
  const section = within(screen.getByRole("region", { name: "Alpha" }));
  const toggle = section.getByRole("button", { name: "Alpha 1" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(section.getByText("Alpha").getAttribute("dir")).toBe("auto");
  expect(section.queryByText("Item 4")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(section.getByText("Item 4")).toBeTruthy();
  expect(section.getByText("Needs you.")).toBeTruthy();
  expect(section.getByRole("link").querySelector(".bg-accent")).toBeTruthy();
  fireEvent.click(toggle);
  expect(section.queryByText("Item 4")).toBeNull();
});

test("empty groups remain visible even without any reviews and show the empty message on expansion", async () => {
  items = [];
  mount();
  const section = within(await screen.findByRole("region", { name: "Alpha" }));
  fireEvent.click(section.getByRole("button", { name: "Alpha 0" }));
  expect(section.getByText("No items in this group yet.")).toBeTruthy();
  expect(section.getByRole("button", { name: "Actions for group “Alpha”" })).toBeTruthy();
});

test("groups with members outside the loaded block remain visible with actions and explain the cap on expansion", async () => {
  const fallback = fetchMock.getMockImplementation();
  let served = false;
  fetchMock.mockImplementation(async (input, init) => {
    if (!served && String(input) === "/api/v1/reviews") {
      served = true;
      return Response.json({
        items: [],
        groups: [
          { ...alpha, members: 1 },
          { ...beta, members: 0 },
        ],
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date().toISOString(),
      });
    }
    if (!fallback) throw new Error("fetch mock has no default implementation");
    return fallback(input, init);
  });
  mount();
  const unloaded = within(await screen.findByRole("region", { name: "Alpha" }));
  const message = "Its items are past the 200 grouped items the inbox shows.";
  expect(unloaded.queryByText(message)).toBeNull();
  expect(within(unloaded.getByRole("heading")).getByText("1")).toBeTruthy();
  fireEvent.click(unloaded.getByRole("button", { name: "Alpha 1" }));
  expect(unloaded.getByText(message)).toBeTruthy();
  expect(unloaded.queryByText("No items in this group yet.")).toBeNull();
  const empty = within(await screen.findByRole("region", { name: "Beta" }));
  fireEvent.click(empty.getByRole("button", { name: "Beta 0" }));
  expect(screen.getAllByText("No items in this group yet.")).toHaveLength(1);
  fireEvent.keyDown(unloaded.getByRole("button", { name: "Actions for group “Alpha”" }), { key: "ArrowDown" });
  expect(await screen.findByRole("menuitem", { name: "Rename group…" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Delete group…" })).toBeTruthy();
});

test.each(["compact", "phone"])(
  "long group names truncate in the %s inbox and wrap in group dialog titles",
  async (layout) => {
    const name = "x".repeat(80);
    groups = [{ ...alpha, name }];
    if (layout === "phone")
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {} })),
      );
    mount(layout === "compact" ? `/r/${items[0]?.id}` : "/");
    const section = within(await screen.findByRole("region", { name }));
    const label = section.getByText(name);
    expect(label.classList.contains("truncate")).toBe(true);
    expect(label.classList.contains("min-w-0")).toBe(true);
    expect(label.getAttribute("title")).toBe(name);
    expect(section.getByRole("button", { name: `${name} 1` }).classList.contains("min-w-0")).toBe(true);
    expect(section.getByText("1").classList.contains("shrink-0")).toBe(true);
    const trigger = section.getByRole("button", { name: `Actions for group “${name}”` });
    expect(trigger.classList.contains("shrink-0")).toBe(true);
    const divider = trigger.previousElementSibling;
    expect(divider?.classList.contains("min-w-4")).toBe(true);
    expect(divider?.classList.contains("shrink-0")).toBe(true);
    await menu(name);
    expect(
      (await screen.findByRole("heading", { name: "Rename group" })).classList.contains("[overflow-wrap:anywhere]"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await menu(name, "Delete group…");
    expect(
      (await screen.findByRole("heading", { name: `Delete group “${name}”?` })).classList.contains(
        "[overflow-wrap:anywhere]",
      ),
    ).toBe(true);
  },
);

test("deleting a group from the keyboard returns focus to inbox search after the section disappears", async () => {
  mount();
  const trigger = await screen.findByRole("button", { name: "Actions for group “Alpha”" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const remove = await screen.findByRole("menuitem", { name: "Delete group…" });
  remove.focus();
  fireEvent.keyDown(remove, { key: "Enter" });
  const dialog = await screen.findByRole("alertdialog", { name: "Delete group “Alpha”?" });
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  const confirm = within(dialog).getByRole("button", { name: "Delete group" });
  confirm.focus();
  fireEvent.keyDown(confirm, { key: "Enter" });
  // happy-dom does not synthesize the native button activation for Enter.
  fireEvent.click(confirm, { detail: 0 });
  fireEvent.keyUp(confirm, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Alpha" })).toBeNull());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Filter reviews" })));
});

test("search, Kind, machine and project filters apply inside group sections", async () => {
  items = [
    item(1, { title: "Needle review", project: "One", groupId: alpha.id }),
    item(2, {
      title: "Needle pub",
      project: "Two",
      groupId: alpha.id,
      kind: "publish",
      origin: { id: beta.id, name: "Other machine" },
    }),
  ];
  mount();
  await screen.findByRole("region", { name: "Alpha" });
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "Needle" } });
  const section = within(screen.getByRole("region", { name: "Alpha" }));
  expect(section.getAllByRole("link")).toHaveLength(2);
  fireEvent.click(screen.getByRole("radio", { name: "Pubs" }));
  expect(section.queryByText("Needle review")).toBeNull();
  expect(section.getByText("Needle pub")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: beta.id } });
  expect(section.queryByText("Needle review")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "One" } });
  expect(section.getByText("Needle review")).toBeTruthy();
  expect(section.queryByText("Needle pub")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "Absent" } });
  expect(screen.queryByRole("region", { name: "Alpha" })).toBeNull();
  expect(screen.getByRole("region", { name: "Beta" })).toBeTruthy();
});

test("rename submits its prefilled field and delete returns members to their list", async () => {
  mount();
  await menu();
  const dialog = await screen.findByRole("alertdialog", { name: "Rename group" });
  const field = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Group name" });
  expect(field.value).toBe("Alpha");
  expect(field.maxLength).toBe(80);
  fireEvent.change(field, { target: { value: "Renamed" } });
  fireEvent.submit(field.closest("form") as HTMLFormElement);
  await screen.findByRole("region", { name: "Renamed" });
  expect(
    fetchMock.mock.calls.some(
      ([path, init]) =>
        path === `/api/v1/groups/${alpha.id}` &&
        init?.method === "PATCH" &&
        init.body === JSON.stringify({ name: "Renamed" }),
    ),
  ).toBe(true);
  await menu("Renamed", "Delete group…");
  const confirmation = await screen.findByRole("alertdialog", { name: "Delete group “Renamed”?" });
  expect(confirmation.textContent).toContain("Its items go back to Active, Snoozed or Done. Nothing else changes.");
  fireEvent.click(within(confirmation).getByRole("button", { name: "Delete group" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Renamed" })).toBeNull());
  await waitFor(() => expect(within(screen.getByRole("region", { name: "Active" })).getByText("Item 4")).toBeTruthy());
  expect(
    fetchMock.mock.calls.some(([path, init]) => path === `/api/v1/groups/${alpha.id}` && init?.method === "DELETE"),
  ).toBe(true);
});

test("rename errors show the server message and keep the dialog editable", async () => {
  mount();
  await menu();
  const field = await screen.findByRole("textbox", { name: "Group name" });
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: { code: "invalid_state", message: "A group with this name exists." } }, { status: 409 }),
  );
  fireEvent.change(field, { target: { value: "Beta" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("A group with this name exists.");
  expect(screen.getByRole("alertdialog", { name: "Rename group" })).toBeTruthy();
});

test.each(["<img src=x onerror=alert(1)>", "مشروع جديد"])("group names render as isolated text: %s", async (name) => {
  groups = [{ ...alpha, name }];
  items = [];
  const { container } = mount();
  const section = await screen.findByRole("region", { name });
  expect(within(section).getByText(name).getAttribute("dir")).toBe("auto");
  expect(container.querySelector("img")).toBeNull();
  await menu(name, "Delete group…");
  const dialog = await screen.findByRole("alertdialog", { name: `Delete group “${name}”?` });
  expect(dialog.querySelector("img")).toBeNull();
});

test("collapsed rail follows section order, regardless of group collapse or Kind filter", async () => {
  localStorage.setItem("emend:inbox-kind", "review");
  layoutStore.update({ inboxCollapsed: true });
  items[2] = item(3, { groupId: beta.id, kind: "publish" });
  mount(`/r/${items[0]?.id}`);
  const rail = within(await screen.findByRole("complementary", { name: "Inbox" }));
  await waitFor(() => expect(rail.getAllByRole("link")).toHaveLength(5));
  expect(rail.getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual([
    "Item 1",
    "Item 2",
    "Needs you: Item 4",
    "Item 3",
    "Item 5",
  ]);
});
