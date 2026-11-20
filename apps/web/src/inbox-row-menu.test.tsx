import type { InboxItem, RevisionView } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { type InboxData, inboxQuery } from "./api/queries.ts";
import { useRowMenuTrigger } from "./components/inbox/RowMenu.tsx";
import { beginReviewSend, finishReviewSend } from "./lib/drafts.ts";
import { defaultLayout, layoutStore } from "./lib/layout-store.ts";
import { SWIPE_REVEAL_PX, SWIPE_SLOP_PX, useRowSwipe } from "./lib/use-row-swipe.ts";

const id = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const group = { id: "33333333-3333-4333-8333-333333333333", name: "Alpha", members: 0 };
const item: InboxItem = {
  id,
  title: "Open review",
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
  groupId: null,
  pinnedAt: null,
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
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
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
  inbox = [item, { ...item, id: targetId, title: "Row review" }];
  fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const match = /^\/api\/v1\/reviews\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    const entry = inbox.find((entry) => entry.id === match?.[1]);
    if (method === "POST" || method === "PUT") {
      const action = match?.[2];
      if (entry) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const patch: Partial<InboxItem> =
          action === "snooze"
            ? { snoozed: true, list: "snoozed", snoozedUntil: body.until ?? null }
            : action === "unsnooze"
              ? { snoozed: false, list: "active", snoozedUntil: null }
              : action === "retire"
                ? { state: "settled", list: "done" }
                : action === "reopen"
                  ? { state: "open", list: "active" }
                  : action === "pin"
                    ? { pinnedAt: body.pinned ? new Date().toISOString() : null }
                    : action === "group"
                      ? { groupId: body.groupId, list: "active" }
                      : {};
        inbox =
          action === "bin"
            ? inbox.filter((row) => row.id !== entry.id)
            : inbox.map((row) => (row.id === entry.id ? { ...row, ...patch } : row));
      }
      return new Response(null, { status: 204 });
    }
    if (path === "/api/v1/reviews")
      return Response.json({
        items: inbox,
        groups: [group],
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date().toISOString(),
      });
    if (path.includes("/revisions/")) return Response.json(revision);
    if (entry) return Response.json({ ...entry, revisions: [{ seq: 1, createdAt: entry.updatedAt }] });
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  finishReviewSend(targetId);
});
function target(patch: Partial<InboxItem>) {
  inbox = inbox.map((row) => (row.id === targetId ? { ...row, ...patch } : row));
}
function mount(path = "/") {
  const history = createMemoryHistory({ initialEntries: [path] });
  return { ...render(<App queryClient={client} history={history} />), history };
}
async function rowLink(title = "Row review") {
  await screen.findByRole("region", { name: "Active" });
  for (const name of ["Snoozed", "Done"]) {
    const toggle = screen.queryByRole("button", { name: new RegExp(`^${name} `) });
    if (toggle?.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  }
  return screen.findByRole("link", { name: new RegExp(title) });
}
async function rowMenu(title = "Row review") {
  const row = await rowLink(title);
  expect(fireEvent.contextMenu(row, { clientX: 40, clientY: 80 })).toBe(false);
  return screen.findByRole("menu", { name: `Actions for “${title}”` });
}
function labels(menu: HTMLElement) {
  return within(menu)
    .getAllByRole("menuitem")
    .map((entry) => entry.textContent);
}
async function escapeMenu() {
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}
async function choose(name: string) {
  fireEvent.click(within(await rowMenu()).getByRole("menuitem", { name }));
}
function writes() {
  return fetchMock.mock.calls
    .filter(([path, init]) => ["POST", "PUT"].includes(init?.method ?? "") && !path.endsWith("/viewed"))
    .map(([path, init]) => [init?.method, path, init?.body]);
}
function expectOpen(history: ReturnType<typeof createMemoryHistory>) {
  expect(history.location.pathname).toBe(`/r/${id}`);
  expect(screen.getByRole("heading", { name: "Open review", level: 1 })).toBeTruthy();
}
const states: { name: string; patch: Partial<InboxItem>; items: string[] }[] = [
  { name: "open", patch: {}, items: ["Snooze", "Retire", "Pin"] },
  { name: "snoozed", patch: { snoozed: true, list: "snoozed" }, items: ["Snooze again", "Unsnooze", "Retire", "Pin"] },
  { name: "approved", patch: { state: "approved", list: "done" }, items: ["Pin"] },
  { name: "retired", patch: { state: "settled", list: "done" }, items: ["Reopen", "Pin"] },
  { name: "pinned", patch: { pinnedAt: "2026-01-01T00:00:00.000Z" }, items: ["Snooze", "Retire", "Unpin"] },
];
for (const pixels of [1280, 390]) {
  test.each(states)(`row and review menus agree for $name at ${pixels}px`, async ({ patch, items }) => {
    width = pixels;
    target(patch);
    mount();
    const menu = await rowMenu();
    const expected = [...(pixels === 390 ? [] : ["How to resume"]), ...items, "Move to group…", "Delete"];
    expect(labels(menu)).toEqual(expected);
    await escapeMenu();
    fireEvent.click(await rowLink());
    await screen.findByRole("heading", { name: "Row review", level: 1 });
    fireEvent.keyDown(screen.getByRole("button", { name: "More review actions" }), { key: "ArrowDown" });
    expect(labels(await screen.findByRole("menu"))).toEqual(expected);
  });
}

test("snoozing another row keeps the open review and uses its shared dialog", async () => {
  const { history } = mount(`/r/${id}`);
  await choose("Snooze");
  const dialog = await screen.findByRole("alertdialog", { name: "Snooze this review" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Until it changes" }));
  await waitFor(() =>
    expect(writes()).toEqual([["POST", `/api/v1/reviews/${targetId}/snooze`, '{"untilRevision":true}']]),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expectOpen(history);
  expect(document.body.style.pointerEvents).not.toBe("none");
});

test.each([false, true])("delete uses the review dialog and leaves the correct route (own row: %s)", async (own) => {
  const { history } = mount(`/r/${id}`);
  await screen.findByRole("heading", { name: "Open review", level: 1 });
  fireEvent.keyDown(screen.getByRole("button", { name: "More review actions" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const original = await screen.findByRole("alertdialog");
  const description = document.getElementById(original.getAttribute("aria-describedby") ?? "")?.textContent;
  fireEvent.click(within(original).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  const title = own ? "Open review" : "Row review";
  const rowId = own ? id : targetId;
  if (!own) client.setQueryData(["review", rowId], { ...item, id: rowId });
  client.setQueryData(["revision", rowId, 1], revision);
  fireEvent.click(within(await rowMenu(title)).getByRole("menuitem", { name: "Delete" }));
  const dialog = await screen.findByRole("alertdialog", { name: `Delete “${title}”?` });
  expect(document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent).toBe(description);
  fireEvent.click(within(dialog).getByRole("button", { name: "Move to bin" }));
  await waitFor(() => expect(writes()).toEqual([["POST", `/api/v1/reviews/${rowId}/bin`, undefined]]));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  if (own) {
    await waitFor(() => expect(history.location.pathname).toBe("/"));
    expect(screen.getByRole("heading", { name: "Inbox", level: 1 })).toBeTruthy();
  } else expectOpen(history);
  await waitFor(() => {
    expect(client.getQueryData(["review", rowId])).toBeUndefined();
    expect(client.getQueryData(["revision", rowId, 1])).toBeUndefined();
  });
});

test("retire confirms for the row without changing the open review", async () => {
  const { history } = mount(`/r/${id}`);
  await choose("Retire");
  const dialog = await screen.findByRole("alertdialog", { name: "Retire this review?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Retire" }));
  await waitFor(() => expect(writes()).toEqual([["POST", `/api/v1/reviews/${targetId}/retire`, "{}"]]));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expectOpen(history);
});

test.each([
  { label: "Reopen", action: "reopen", patch: { state: "settled", list: "done" } },
  { label: "Unsnooze", action: "unsnooze", patch: { snoozed: true, list: "snoozed" } },
] satisfies { label: string; action: string; patch: Partial<InboxItem> }[])(
  "$label acts on the row",
  async ({ label, action, patch }) => {
    target(patch);
    const { history } = mount(`/r/${id}`);
    await choose(label);
    await waitFor(() => expect(writes()).toEqual([["POST", `/api/v1/reviews/${targetId}/${action}`, undefined]]));
    expectOpen(history);
  },
);

test.each([false, true])("pin toggles the row (already pinned: %s)", async (pinned) => {
  target({ pinnedAt: pinned ? item.updatedAt : null });
  const { history } = mount(`/r/${id}`);
  await choose(pinned ? "Unpin" : "Pin");
  await waitFor(() =>
    expect(writes()).toEqual([["PUT", `/api/v1/reviews/${targetId}/pin`, JSON.stringify({ pinned: !pinned })]]),
  );
  expectOpen(history);
});

test("move to group lists groups and moves the row", async () => {
  const { history } = mount(`/r/${id}`);
  await choose("Move to group…");
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByRole("heading").textContent).toBe("Move “Row review” to a group");
  fireEvent.click(within(dialog).getByRole("button", { name: "Alpha" }));
  await waitFor(() =>
    expect(writes()).toEqual([["PUT", `/api/v1/reviews/${targetId}/group`, JSON.stringify({ groupId: group.id })]]),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expectOpen(history);
});

test.each([{ key: "F10", shiftKey: true }, { key: "ContextMenu" }])(
  "$key opens a focused row and Escape restores focus",
  async (key) => {
    mount();
    const row = await rowLink();
    act(() => row.focus());
    expect(fireEvent.keyDown(row, key)).toBe(false);
    const menu = await screen.findByRole("menu", { name: "Actions for “Row review”" });
    expect(fireEvent.contextMenu(menu)).toBe(false);
    await escapeMenu();
    await waitFor(() => expect(document.activeElement).toBe(row));
  },
);

test("right-click anchors at the pointer; a keyboard context event uses the row rectangle", async () => {
  mount();
  const row = await rowLink();
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 20, 200, 64));
  for (const point of [true, false]) {
    fireEvent.contextMenu(row, point ? { clientX: 50, clientY: 60 } : {});
    await screen.findByRole("menu");
    const anchor = document.querySelector<HTMLElement>('span[aria-label="Actions for “Row review”"]');
    expect(anchor?.style.left).toBe(point ? "50px" : "12px");
    expect(anchor?.style.top).toBe(point ? "60px" : "20px");
    expect(anchor?.style.width).toBe(point ? "0px" : "200px");
    expect(anchor?.tabIndex).toBe(-1);
    await escapeMenu();
  }
});

test("outside dismissal leaves focus on the outside control", async () => {
  mount();
  await rowMenu();
  const input = screen.getByRole("textbox", { name: "Filter reviews", hidden: true });
  fireEvent.pointerDown(input, { pointerType: "mouse" });
  act(() => input.focus());
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(input));
});

test.each(["Snooze", "Retire", "Move to group…", "Delete", "How to resume"])(
  "%s dialog returns focus to its row",
  async (action) => {
    mount();
    const row = await rowLink();
    await choose(action);
    const dialog = await screen.findByRole("alertdialog");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: action === "How to resume" ? "Close" : "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(document.body.style.pointerEvents).not.toBe("none");
  },
);

test("collapsed rail opens the same actions to the right of a row", async () => {
  const { history } = mount(`/r/${id}`);
  const expected = labels(await rowMenu());
  await escapeMenu();
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  const rail = within(screen.getByRole("complementary", { name: "Inbox" }));
  fireEvent.contextMenu(rail.getByRole("link", { name: "Row review" }), { clientX: 20, clientY: 50 });
  const menu = await screen.findByRole("menu");
  expect(labels(menu)).toEqual(expected);
  expect(menu.getAttribute("data-side")).toBe("right");
  await escapeMenu();
  expectOpen(history);
});

test("tablet inbox sheet keeps its row dialogs and the open review", async () => {
  width = 900;
  const { history } = mount(`/r/${id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Show inbox" }));
  const sheet = await screen.findByRole("dialog", { name: "Inbox" });
  const row = within(sheet).getByRole("link", { name: /Row review/ });
  fireEvent.contextMenu(row);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Snooze" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Snooze this review" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(row));
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expectOpen(history);
});

function drag(row: HTMLElement, dx: number, dy = 0, pointerType = "touch", cancel = false) {
  const start = { pointerType, pointerId: 1, clientX: 160, clientY: 80 };
  const end = { ...start, clientX: 160 + dx, clientY: 80 + dy };
  fireEvent.pointerDown(row, start);
  fireEvent.pointerMove(row, end);
  if (cancel) fireEvent.pointerCancel(row, end);
  else fireEvent.pointerUp(row, end);
}
function actionsButton() {
  return screen.queryByRole("button", { name: "Actions for “Row review”" });
}

test("phone swipe reveals actions, suppresses navigation and opens the shared Snooze dialog", async () => {
  width = 390;
  const { history } = mount();
  const expected = labels(await rowMenu());
  await escapeMenu();
  const row = await rowLink();
  expect(row.style.transform).toBe("");
  drag(row, -80);
  expect(fireEvent.click(row)).toBe(false);
  expect(history.location.pathname).toBe("/");
  expect(row.style.transform).toBe(`translateX(-${SWIPE_REVEAL_PX}px)`);
  const button = actionsButton();
  expect(button).toBeTruthy();
  if (!button) throw new Error("Missing swipe action");
  fireEvent.click(button);
  expect(labels(await screen.findByRole("menu"))).toEqual(expected);
  fireEvent.click(screen.getByRole("menuitem", { name: "Snooze" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Snooze this review" });
  expect(actionsButton()).toBeNull();
  expect(row.style.transform).toBe("");
  fireEvent.click(within(dialog).getByRole("button", { name: "Until it changes" }));
  await waitFor(() =>
    expect(writes()).toEqual([["POST", `/api/v1/reviews/${targetId}/snooze`, '{"untilRevision":true}']]),
  );
  expect(history.location.pathname).toBe("/");
});

test.each(["mouse", "pen", "vertical", "short", "cancel"])(
  "%s gesture leaves the swipe button hidden",
  async (gesture) => {
    width = 390;
    mount();
    const row = await rowLink();
    if (gesture === "vertical") {
      fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(row, { pointerType: "touch", pointerId: 1, clientX: 100, clientY: 120 });
      fireEvent.pointerMove(row, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 120 });
      fireEvent.pointerUp(row, { pointerType: "touch", pointerId: 1 });
    } else
      drag(
        row,
        gesture === "short" ? -SWIPE_SLOP_PX : -80,
        0,
        ["mouse", "pen"].includes(gesture) ? gesture : "touch",
        gesture === "cancel",
      );
    expect(actionsButton()).toBeNull();
    expect(row.style.transform).toBe("");
  },
);

test("a phone tap still opens the review", async () => {
  width = 390;
  const { history } = mount();
  const row = await rowLink();
  drag(row, 0);
  fireEvent.click(row);
  await screen.findByRole("heading", { name: "Row review", level: 1 });
  expect(history.location.pathname).toBe(`/r/${targetId}`);
});

test.each(["tap", "outside", "back", "cancel"])(
  "%s on a revealed row handles the reveal without navigation",
  async (gesture) => {
    width = 390;
    const { history } = mount();
    const row = await rowLink();
    drag(row, -80);
    fireEvent.click(row);
    expect(actionsButton()).toBeTruthy();
    if (gesture === "outside") fireEvent.pointerDown(screen.getByRole("textbox", { name: "Filter reviews" }));
    else {
      drag(row, gesture === "tap" ? 0 : 80, 0, "touch", gesture === "cancel");
      if (gesture !== "cancel") expect(fireEvent.click(row)).toBe(false);
    }
    expect(!!actionsButton()).toBe(gesture === "cancel");
    expect(history.location.pathname).toBe("/");
  },
);

test("moved rows keep the browser menu and never reveal swipe actions", async () => {
  width = 390;
  target({ movedTo: "https://example.com/r/synthetic" });
  mount();
  const title = await screen.findByText("Row review");
  const row = title.closest<HTMLElement>('[aria-disabled="true"]');
  if (!row) throw new Error("Missing moved row");
  expect(fireEvent.contextMenu(row)).toBe(true);
  drag(row, -80);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(actionsButton()).toBeNull();
});

test("a menu follows live inbox state and disappears when its row is removed elsewhere", async () => {
  mount();
  await rowMenu();
  act(() =>
    client.setQueryData<InboxData>(
      ["inbox"],
      (data) =>
        data && {
          ...data,
          items: data.items.map((row) => (row.id === targetId ? { ...row, pinnedAt: item.updatedAt } : row)),
        },
    ),
  );
  await screen.findByRole("menuitem", { name: "Unpin" });
  act(() =>
    client.setQueryData<InboxData>(
      ["inbox"],
      (data) =>
        data && {
          ...data,
          items: data.items.filter((row) => row.id !== targetId),
        },
    ),
  );
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test("resume availability follows the row's agent and current sends", async () => {
  mount();
  await choose("How to resume");
  const dialog = await screen.findByRole("alertdialog", { name: "How to resume" });
  expect(dialog.textContent).toContain(targetId);
  target({ agentWaiting: true });
  await act(async () => {
    await client.invalidateQueries(inboxQuery());
  });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await rowMenu();
  expect(screen.getByRole("menuitem", { name: "How to resume" }).getAttribute("aria-disabled")).toBe("true");
  await escapeMenu();
  target({ agentWaiting: false });
  await act(async () => {
    await client.invalidateQueries(inboxQuery());
  });
  act(() => {
    beginReviewSend(targetId);
  });
  await rowMenu();
  expect(screen.getByRole("menuitem", { name: "How to resume" }).getAttribute("aria-disabled")).toBe("true");
});

test("a pub row uses the same lifecycle actions", async () => {
  target({ kind: "publish", repo: null, branch: null });
  const { history } = mount(`/r/${id}`);
  await choose("Pin");
  await waitFor(() => expect(writes()).toEqual([["PUT", `/api/v1/reviews/${targetId}/pin`, '{"pinned":true}']]));
  expectOpen(history);
});

test("opening a row menu never takes over the open review's pin shortcut", async () => {
  mount(`/r/${id}`);
  await rowMenu();
  await escapeMenu();
  fireEvent.keyDown(document.body, { key: "P", shiftKey: true });
  await waitFor(() => expect(writes()).toEqual([["PUT", `/api/v1/reviews/${id}/pin`, '{"pinned":true}']]));
});

test("rows without a menu provider have no context-menu handlers", () => {
  const { result } = renderHook(() => useRowMenuTrigger(item));
  expect(result.current).toBeUndefined();
});

function SwipeProbe({ enabled = true }: { enabled?: boolean }) {
  const swipe = useRowSwipe(enabled);
  return (
    <ul>
      <li ref={swipe.row}>
        <button
          type="button"
          {...swipe.handlers}
          onClick={swipe.guardClick}
          style={{ transform: `translateX(${swipe.offset}px)` }}
          data-dragging={swipe.dragging}
        >
          Swipe
        </button>
      </li>
    </ul>
  );
}

test.each([
  [-SWIPE_SLOP_PX + 1, 0, false],
  [-SWIPE_REVEAL_PX / 2 + 1, 0, true],
  [-SWIPE_REVEAL_PX / 2, -SWIPE_REVEAL_PX, true],
  [-200, -SWIPE_REVEAL_PX, true],
  [200, 0, true],
])("swipe of %spx snaps to %spx and guards only a drag's click", (dx, offset, dragged) => {
  render(<SwipeProbe />);
  const button = screen.getByRole("button", { name: "Swipe" });
  const capture = vi.fn();
  Object.defineProperty(button, "setPointerCapture", { value: capture });
  drag(button, dx);
  expect(button.style.transform).toBe(`translateX(${offset}px)`);
  expect(button.getAttribute("data-dragging")).toBe("false");
  expect(capture.mock.calls).toHaveLength(dragged ? 1 : 0);
  expect(fireEvent.click(button)).toBe(!dragged);
  expect(fireEvent.click(button)).toBe(true);
});

test("a disabled swipe ignores touch", () => {
  render(<SwipeProbe enabled={false} />);
  const button = screen.getByRole("button", { name: "Swipe" });
  drag(button, -80);
  expect(button.style.transform).toBe("translateX(0px)");
  expect(fireEvent.click(button)).toBe(true);
});

test("swipe tolerates failed pointer capture and ignores another pointer's events", () => {
  render(<SwipeProbe />);
  const button = screen.getByRole("button", { name: "Swipe" });
  Object.defineProperty(button, "setPointerCapture", {
    value: () => {
      throw new Error("Pointer ended");
    },
  });
  fireEvent.pointerDown(button, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 0 });
  fireEvent.pointerMove(button, { pointerId: 1, pointerType: "touch", clientX: 80, clientY: 0 });
  expect(button.style.transform).toBe("translateX(-20px)");
  expect(button.getAttribute("data-dragging")).toBe("true");
  fireEvent.pointerMove(button, { pointerId: 2, pointerType: "touch", clientX: 20, clientY: 0 });
  fireEvent.pointerUp(button, { pointerId: 2, pointerType: "touch" });
  fireEvent.pointerCancel(button, { pointerId: 2, pointerType: "touch" });
  expect(button.style.transform).toBe("translateX(-20px)");
  expect(button.getAttribute("data-dragging")).toBe("true");
  fireEvent.pointerCancel(button, { pointerId: 1, pointerType: "touch" });
  expect(button.style.transform).toBe("translateX(0px)");
  expect(button.getAttribute("data-dragging")).toBe("false");
});
