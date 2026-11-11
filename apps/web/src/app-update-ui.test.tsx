import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import {
  beginDraftSave,
  beginReviewSend,
  clearDraft,
  finishDraftSave,
  finishReviewSend,
  saveDraft,
} from "./lib/drafts.ts";
import type { FakeAppUpdate } from "./test/app-update.ts";

const fake = vi.hoisted(() => ({ current: undefined as unknown as FakeAppUpdate }));
vi.mock("./lib/app-update.ts", async (original) => {
  const actual = await original<typeof import("./lib/app-update.ts")>();
  const { createFakeAppUpdate } = await import("./test/app-update.ts");
  const { useSyncExternalStore } = await import("react");
  const store = createFakeAppUpdate();
  fake.current = store;
  return {
    ...actual,
    appUpdate: store,
    useAppUpdate: () => useSyncExternalStore(store.subscribe, store.getSnapshot),
  };
});

const checkedAt = Date.parse("2026-01-01T00:00:00.000Z");
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(checkedAt + 5 * 60_000);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ approvedActiveHours: 12, serverTime: new Date(Date.now()).toISOString(), items: [] }),
    ),
  );
  fake.current.set({ state: "idle", reason: null, checkedAt: null });
  for (const mock of [fake.current.checkForUpdate, fake.current.installUpdate, fake.current.reloadNow])
    mock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<App queryClient={client} history={createMemoryHistory({ initialEntries: ["/devices"] })} />);
}
async function openMenu() {
  fireEvent.keyDown(await screen.findByRole("button", { name: "More" }), { key: "ArrowDown" });
  return within(await screen.findByRole("menu", { name: "More" }));
}

test("the phone menu offers Update available only while an update waits", async () => {
  mount();
  let menu = await openMenu();
  expect(menu.queryByRole("menuitem", { name: "Update available" })).toBeNull();
  expect(menu.queryByRole("menuitem", { name: "Reload to finish the update" })).toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  act(() => fake.current.set({ state: "available" }));
  menu = await openMenu();
  expect(menu.queryByRole("menuitem", { name: "Reload to finish the update" })).toBeNull();
  fireEvent.click(menu.getByRole("menuitem", { name: "Update available" }));
  // The item opens the gate's dialog, so it runs once the menu has closed.
  await waitFor(() => expect(fake.current.installUpdate).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("the phone menu offers a reload after another window installed an update", async () => {
  mount();
  await screen.findByRole("heading", { name: "Devices" });
  act(() => fake.current.set({ state: "reload-needed" }));
  const menu = await openMenu();
  expect(menu.queryByRole("menuitem", { name: "Update available" })).toBeNull();
  fireEvent.click(menu.getByRole("menuitem", { name: "Reload to finish the update" }));
  await waitFor(() => expect(fake.current.reloadNow).toHaveBeenCalledTimes(1));
  expect(fake.current.installUpdate).not.toHaveBeenCalled();
});

test.each([
  ["a Send in progress", () => beginReviewSend("synthetic-review"), () => finishReviewSend("synthetic-review")],
  [
    "text that could not be stored on this device",
    () => {
      vi.stubGlobal("localStorage", {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
        removeItem: () => {},
      });
      saveDraft("emend.draft.synthetic-review.memory", "only in memory");
    },
    () => clearDraft("emend.draft.synthetic-review.memory"),
  ],
])("Update asks first when a reload could lose %s", async (text, begin, end) => {
  begin();
  try {
    mount();
    await screen.findByRole("heading", { name: "Devices" });
    act(() => fake.current.set({ state: "available" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Update now?" });
    expect(dialog.textContent).toContain(text);
    expect(fake.current.installUpdate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.current.installUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Update anyway" }));
    expect(fake.current.installUpdate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  } finally {
    end();
  }
});

test("the dialog names every kind of work that a reload could lose", async () => {
  const { lossText } = await import("./components/layout/UpdateGate.tsx");
  expect(lossText({ saving: true, sending: false, unstored: false })).toBe(
    "Reloading now could lose a comment that is still saving.",
  );
  expect(lossText({ saving: true, sending: true, unstored: true })).toBe(
    "Reloading now could lose a comment that is still saving, a Send in progress and text that could not be stored on this device.",
  );
});

const appRegion = () => within(screen.getByRole("region", { name: "App" }));

test("Reload from the Devices page asks first, with Reload wording, when work is in flight", async () => {
  beginReviewSend("synthetic-review");
  try {
    mount();
    await screen.findByRole("heading", { name: "Devices" });
    act(() => fake.current.set({ state: "reload-needed" }));
    fireEvent.click(await appRegion().findByRole("button", { name: "Reload" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Reload now?" });
    expect(within(dialog).queryByRole("button", { name: "Update anyway" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reload anyway" }));
    expect(fake.current.reloadNow).toHaveBeenCalledTimes(1);
  } finally {
    finishReviewSend("synthetic-review");
  }
});

test("the dialog checks again on confirm and stays open when the work at risk changed", async () => {
  beginReviewSend("synthetic-review");
  try {
    mount();
    await screen.findByRole("heading", { name: "Devices" });
    act(() => fake.current.set({ state: "available" }));
    fireEvent.click(await appRegion().findByRole("button", { name: "Update now" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Update now?" });
    expect(dialog.textContent).toContain("a Send in progress.");
    act(() => beginDraftSave("emend.draft.synthetic-review.saving"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Update anyway" }));
    expect(fake.current.installUpdate).not.toHaveBeenCalled();
    const again = await screen.findByRole("alertdialog", { name: "Update now?" });
    expect(again.textContent).toContain("a comment that is still saving and a Send in progress.");
    fireEvent.click(within(again).getByRole("button", { name: "Update anyway" }));
    expect(fake.current.installUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  } finally {
    finishDraftSave("emend.draft.synthetic-review.saving");
    finishReviewSend("synthetic-review");
  }
});

test("the reload bar shows on every layout, is a status region, and takes no focus", async () => {
  for (const matches of [false, true]) {
    vi.stubGlobal("matchMedia", () => ({ matches, addEventListener() {}, removeEventListener() {} }));
    const view = mount();
    await screen.findByRole("heading", { name: "Devices" });
    const text = "emend was updated in another window. Reload to keep working.";
    expect(screen.queryByText(text)).toBeNull();
    const before = document.activeElement;
    act(() => fake.current.set({ state: "reload-needed" }));
    const bar = (await screen.findByText(text)).closest("[role=status]") as HTMLElement;
    expect(bar.getAttribute("role")).toBe("status");
    expect(bar.closest("[role=dialog], [role=alertdialog]")).toBeNull();
    expect(document.activeElement).toBe(before);
    fireEvent.click(within(bar).getByRole("button", { name: "Reload" }));
    expect(fake.current.reloadNow).toHaveBeenCalledTimes(1);
    act(() => fake.current.set({ state: "current" }));
    expect(screen.queryByText(text)).toBeNull();
    fake.current.reloadNow.mockClear();
    view.unmount();
  }
});

test("the reload bar asks first when work is in flight", async () => {
  beginReviewSend("synthetic-review");
  try {
    mount();
    await screen.findByRole("heading", { name: "Devices" });
    act(() => fake.current.set({ state: "reload-needed" }));
    const bar = (await screen.findByText(/^emend was updated/)).closest("[role=status]") as HTMLElement;
    fireEvent.click(within(bar).getByRole("button", { name: "Reload" }));
    expect(await screen.findAllByRole("alertdialog")).toHaveLength(1);
    expect(fake.current.reloadNow).not.toHaveBeenCalled();
  } finally {
    finishReviewSend("synthetic-review");
  }
});

test.each([
  ["unsupported", {}, "Updates need the installed app over a secure connection."],
  ["checking", {}, "Checking for updates…"],
  ["current", { checkedAt }, "This is the newest version."],
  ["available", {}, "An update is ready."],
  ["updating", {}, "Updating…"],
  ["reload-needed", {}, "Another window installed an update. Reload to use it."],
  ["error", { reason: "Failed to fetch" }, "Could not check for updates: Failed to fetch."],
] as const)("the App section reports %s", async (state, extra, line) => {
  mount();
  await screen.findByRole("heading", { name: "App" });
  expect(screen.getByText("emend 0.0.0-test")).toBeTruthy();
  act(() => fake.current.set({ state, ...extra }));
  const status = await screen.findByText(line);
  expect(status.getAttribute("aria-live")).toBe("polite");
  // The check time sits outside the live region, so a quiet return check announces nothing.
  expect(status.textContent).not.toContain("Checked");
  expect(!!screen.queryByText("Checked 5m ago.")).toBe(state === "current");
  const check = appRegion().queryByRole("button", { name: "Check for update" });
  if (state === "unsupported") expect(check).toBeNull();
  else {
    // aria-disabled, never disabled: the button keeps keyboard focus while a check runs.
    expect(check?.hasAttribute("disabled")).toBe(false);
    expect(check?.getAttribute("aria-disabled") === "true").toBe(state === "checking" || state === "updating");
  }
  expect(!!appRegion().queryByRole("button", { name: "Update now" })).toBe(state === "available");
  expect(!!appRegion().queryByRole("button", { name: "Reload" })).toBe(state === "reload-needed");
});

test("a busy Check for update keeps focus and ignores clicks", async () => {
  mount();
  await screen.findByRole("heading", { name: "App" });
  const check = appRegion().getByRole("button", { name: "Check for update" });
  check.focus();
  act(() => fake.current.set({ state: "checking" }));
  expect(document.activeElement).toBe(check);
  fireEvent.click(check);
  expect(fake.current.checkForUpdate).not.toHaveBeenCalled();
});

test("Check for update starts a check, and Update now installs when nothing is at risk", async () => {
  mount();
  await screen.findByRole("heading", { name: "App" });
  fireEvent.click(screen.getByRole("button", { name: "Check for update" }));
  expect(fake.current.checkForUpdate).toHaveBeenCalledTimes(1);
  act(() => fake.current.set({ state: "available" }));
  fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
  expect(fake.current.installUpdate).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
