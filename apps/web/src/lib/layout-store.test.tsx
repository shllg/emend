import { act, cleanup, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLayoutStore, defaultLayout, layoutKey, tabsDefaultKey } from "./layout-store.ts";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("defaults include independent pane choices and D.4's 12px code size", () => {
  expect(createLayoutStore().getSnapshot()).toEqual({
    inboxWidth: 280,
    readingShare: 0.42,
    pane: { desktop: "tabs", tablet: "tabs" },
    readingWidth: "comfortable",
    compact: false,
    hideResolved: false,
    diffStyle: "split",
    fileOrder: "topics",
    wrap: false,
    notes: true,
    details: { phone: false, tablet: true, desktop: true },
    inboxCollapsed: false,
    proseSize: 16,
    codeSize: 12,
  });
});
test("details fall back per device class and keep valid choices", () => {
  localStorage.setItem(layoutKey, JSON.stringify({ details: { phone: true, tablet: "no", desktop: false } }));
  expect(createLayoutStore().getSnapshot().details).toEqual({ phone: true, tablet: true, desktop: false });
  localStorage.setItem(layoutKey, JSON.stringify({ details: "x" }));
  expect(createLayoutStore().getSnapshot().details).toEqual(defaultLayout.details);
});
test("invalid fields fall back independently, including each device choice", () => {
  localStorage.setItem(
    layoutKey,
    JSON.stringify({
      inboxWidth: 521,
      readingShare: 0.6,
      pane: { desktop: "invalid", tablet: "split" },
      readingWidth: "invalid",
      compact: true,
      hideResolved: "true",
      diffStyle: "unified",
      fileOrder: "invalid",
      wrap: "true",
      notes: "false",
      inboxCollapsed: true,
      proseSize: 999,
      codeSize: 14,
    }),
  );
  expect(createLayoutStore().getSnapshot()).toEqual({
    ...defaultLayout,
    readingShare: 0.6,
    pane: { desktop: "tabs", tablet: "split" },
    readingWidth: "comfortable",
    compact: true,
    diffStyle: "unified",
    inboxCollapsed: true,
    codeSize: 14,
  });
});
test("file order persists across stores and follows other tabs' updates", () => {
  const store = createLayoutStore();
  store.update({ fileOrder: "path" });
  expect(JSON.parse(localStorage.getItem(layoutKey) ?? "{}").fileOrder).toBe("path");
  expect(createLayoutStore().getSnapshot().fileOrder).toBe("path");
  const changed = vi.fn();
  const unsubscribe = store.subscribe(changed);
  try {
    const newValue = JSON.stringify({ ...store.getSnapshot(), fileOrder: "topics" });
    localStorage.setItem(layoutKey, newValue);
    window.dispatchEvent(new StorageEvent("storage", { key: layoutKey, newValue, storageArea: localStorage }));
    expect(changed).toHaveBeenCalledOnce();
    expect(store.getSnapshot().fileOrder).toBe("topics");
  } finally {
    unsubscribe();
  }
});
test.each([
  ['{"reading":"focus"}', true],
  ['{"reading":"focus","compact":false}', false],
  ['{"reading":"focus","compact":null}', false],
  ['{"reading":"standard"}', false],
  ['{"reading":"standard","compact":true}', true],
] as const)("legacy preference %s migrates without overriding explicit compact", (raw, compact) => {
  localStorage.setItem(layoutKey, raw);
  const store = createLayoutStore();
  expect(store.getSnapshot()).toEqual({ ...defaultLayout, compact });
  expect(store.getSnapshot()).not.toHaveProperty("reading");
  store.update({ wrap: true });
  const saved = JSON.parse(localStorage.getItem(layoutKey) ?? "{}");
  expect(saved).toMatchObject({ compact, wrap: true });
  expect(saved).not.toHaveProperty("reading");
  expect(createLayoutStore().getSnapshot()).toEqual(saved);
});

test.each([undefined, "wide"] as const)(
  "without a marker, desktop moves to Tabs once with readingWidth=%s and keeps other choices",
  (readingWidth) => {
    localStorage.setItem(
      layoutKey,
      JSON.stringify({ pane: { desktop: "split", tablet: "split" }, proseSize: 18, readingWidth }),
    );
    const write = vi.spyOn(localStorage, "setItem");
    const store = createLayoutStore();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(tabsDefaultKey, "1");
    expect(localStorage.getItem(tabsDefaultKey)).toBe("1");
    expect(store.getSnapshot()).toEqual({
      ...defaultLayout,
      pane: { desktop: "tabs", tablet: "split" },
      readingWidth: readingWidth ?? "comfortable",
      proseSize: 18,
    });
    expect(JSON.parse(localStorage.getItem(layoutKey) ?? "{}")).toEqual(store.getSnapshot());
    write.mockClear();
    store.getSnapshot();
    createLayoutStore();
    expect(write).not.toHaveBeenCalled();
    store.update({ pane: { desktop: "split", tablet: "split" } });
    expect(createLayoutStore().getSnapshot().pane.desktop).toBe("split");
  },
);

test("the marker preserves a chosen desktop Split even without a stored reading width", () => {
  localStorage.setItem(tabsDefaultKey, "1");
  localStorage.setItem(layoutKey, JSON.stringify({ pane: { desktop: "split", tablet: "tabs" } }));
  const write = vi.spyOn(localStorage, "setItem");
  expect(createLayoutStore().getSnapshot()).toMatchObject({ pane: { desktop: "split" }, readingWidth: "comfortable" });
  expect(write).not.toHaveBeenCalled();
});

test("a fresh browser records the Tabs default and a later Split choice survives store creation", () => {
  const store = createLayoutStore();
  expect(store.getSnapshot().pane).toEqual({ desktop: "tabs", tablet: "tabs" });
  expect(localStorage.getItem(tabsDefaultKey)).toBe("1");
  expect(JSON.parse(localStorage.getItem(layoutKey) ?? "{}")).toEqual(store.getSnapshot());
  store.update({ pane: { desktop: "split", tablet: "tabs" } });
  expect(createLayoutStore().getSnapshot().pane.desktop).toBe("split");
});

test.each(["snapshot", "storage event"])("an older client's write preserves Split through a %s", (refresh) => {
  localStorage.setItem(layoutKey, JSON.stringify({ pane: { desktop: "split", tablet: "split" } }));
  const store = createLayoutStore();
  expect(store.getSnapshot().pane.desktop).toBe("tabs");
  store.update({ pane: { desktop: "split", tablet: "split" } });
  const changed = vi.fn();
  const unsubscribe = store.subscribe(changed);
  const newValue = JSON.stringify({ pane: { desktop: "split", tablet: "split" }, proseSize: 18 });
  localStorage.setItem(layoutKey, newValue);
  const write = vi.spyOn(localStorage, "setItem");
  try {
    if (refresh === "storage event") {
      window.dispatchEvent(new StorageEvent("storage", { key: layoutKey, newValue, storageArea: localStorage }));
      expect(changed).toHaveBeenCalledOnce();
    }
    expect(store.getSnapshot()).toMatchObject({ pane: { desktop: "split", tablet: "split" }, proseSize: 18 });
    expect(createLayoutStore().getSnapshot().pane.desktop).toBe("split");
    expect(write).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});

test("denied storage reads neither throw nor record the pane move", () => {
  const write = vi.fn();
  vi.stubGlobal("localStorage", {
    getItem() {
      throw Error("Denied");
    },
    setItem: write,
  });
  expect(createLayoutStore().getSnapshot()).toEqual(defaultLayout);
  expect(write).not.toHaveBeenCalled();
});

test("an unreadable marker leaves a saved Split alone", () => {
  localStorage.setItem(layoutKey, JSON.stringify({ pane: { desktop: "split", tablet: "split" } }));
  const storage = localStorage;
  const write = vi.fn(storage.setItem.bind(storage));
  vi.stubGlobal("localStorage", {
    getItem(key: string) {
      if (key === tabsDefaultKey) throw Error("Denied");
      return storage.getItem(key);
    },
    setItem: write,
  });
  expect(createLayoutStore().getSnapshot().pane).toEqual({ desktop: "split", tablet: "split" });
  expect(write).not.toHaveBeenCalled();
});

test("obsolete Contents is stripped from preferences", () => {
  localStorage.setItem(layoutKey, '{"contents":true}');
  expect(createLayoutStore().getSnapshot()).not.toHaveProperty("contents");
  expect(JSON.parse(localStorage.getItem(layoutKey) ?? "{}")).not.toHaveProperty("contents");
});

test.each(["{", "null", "[]", '"text"'])("bad root %s uses defaults", (raw) => {
  localStorage.setItem(layoutKey, raw);
  expect(createLayoutStore().getSnapshot()).toEqual(defaultLayout);
});
test("migration reads all three old keys only when v1 is missing and leaves them intact", () => {
  localStorage.setItem("emend.diff.layout", "unified");
  localStorage.setItem("emend.diff.wrap", "true");
  localStorage.setItem("emend.inbox.collapsed", "true");
  const store = createLayoutStore();
  expect(store.getSnapshot()).toMatchObject({ diffStyle: "unified", wrap: true, inboxCollapsed: true });
  expect(JSON.parse(localStorage.getItem(layoutKey) ?? "{}")).toEqual(store.getSnapshot());
  store.update({ diffStyle: "split", wrap: false, inboxCollapsed: false });
  expect(createLayoutStore().getSnapshot()).toMatchObject({ diffStyle: "split", wrap: false, inboxCollapsed: false });
  expect(localStorage.getItem("emend.diff.layout")).toBe("unified");
  expect(localStorage.getItem("emend.diff.wrap")).toBe("true");
  expect(localStorage.getItem("emend.inbox.collapsed")).toBe("true");
});
test.each(["read", "write", "both"])("denied %s keeps preferences in memory", (denied) => {
  const storage = localStorage;
  vi.stubGlobal("localStorage", {
    getItem(key: string) {
      if (denied !== "write") throw Error("Denied");
      return storage.getItem(key);
    },
    setItem(key: string, value: string) {
      if (denied !== "read") throw Error("Full");
      storage.setItem(key, value);
    },
  });
  const store = createLayoutStore();
  expect(store.getSnapshot().codeSize).toBe(12);
  store.update({ proseSize: 18, inboxWidth: 400 });
  expect(store.getSnapshot()).toMatchObject({ proseSize: 18, inboxWidth: 400 });
  expect(store.getSnapshot()).toBe(store.getSnapshot());
});
function Read({ store }: { store: ReturnType<typeof createLayoutStore> }) {
  const value = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <output>{value.proseSize}</output>;
}
test("React subscribers receive other tabs' updates and storage clears", () => {
  const store = createLayoutStore();
  render(<Read store={store} />);
  expect(screen.getByRole("status").textContent).toBe("16");
  act(() => {
    const newValue = JSON.stringify({ ...defaultLayout, proseSize: 18 });
    localStorage.setItem(layoutKey, newValue);
    expect(store.getSnapshot().proseSize).toBe(18);
    window.dispatchEvent(new StorageEvent("storage", { key: layoutKey, newValue, storageArea: localStorage }));
  });
  expect(screen.getByRole("status").textContent).toBe("18");
  act(() => {
    sessionStorage.setItem(layoutKey, "{}");
    window.dispatchEvent(new StorageEvent("storage", { key: layoutKey, newValue: "{}", storageArea: sessionStorage }));
  });
  expect(screen.getByRole("status").textContent).toBe("18");
  act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  });
  expect(screen.getByRole("status").textContent).toBe("16");
});

test("migration writes during store creation, never during snapshot reads", () => {
  localStorage.setItem("emend.diff.wrap", "true");
  const write = vi.spyOn(localStorage, "setItem");
  const store = createLayoutStore();
  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenCalledWith(tabsDefaultKey, "1");
  write.mockClear();
  const initial = store.getSnapshot();
  expect(initial.wrap).toBe(true);
  expect(store.getSnapshot()).toBe(initial);
  localStorage.removeItem(layoutKey);
  const cleared = store.getSnapshot();
  expect(cleared.wrap).toBe(false);
  expect(store.getSnapshot()).toBe(cleared);
  expect(write).not.toHaveBeenCalled();
});

test("subscribe reconciles a write after the first snapshot and unrelated updates preserve it", () => {
  const store = createLayoutStore();
  const first = store.getSnapshot();
  localStorage.setItem(layoutKey, JSON.stringify({ ...first, proseSize: 18 }));
  const snapshots: (typeof first)[] = [];
  const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.proseSize).toBe(18);
  expect(store.getSnapshot()).toBe(snapshots[0]);
  store.update({ wrap: true });
  expect(store.getSnapshot()).toMatchObject({ proseSize: 18, wrap: true });
  expect(JSON.parse(localStorage.getItem(layoutKey) ?? "{}")).toMatchObject({ proseSize: 18, wrap: true });
  unsubscribe();
});

test("snapshot reads catch cross-tab writes before events without changing identity for unchanged storage", () => {
  const store = createLayoutStore();
  const unsubscribe = store.subscribe(() => {});
  const first = store.getSnapshot();
  expect(store.getSnapshot()).toBe(first);
  localStorage.setItem(layoutKey, JSON.stringify({ ...first, codeSize: 14 }));
  const next = store.getSnapshot();
  expect(next.codeSize).toBe(14);
  expect(next).not.toBe(first);
  expect(store.getSnapshot()).toBe(next);
  store.update({ inboxCollapsed: true });
  expect(store.getSnapshot()).toMatchObject({ codeSize: 14, inboxCollapsed: true });
  unsubscribe();
});

test("local numeric updates clamp to their ranges instead of restoring defaults", () => {
  const store = createLayoutStore();
  store.update({ inboxWidth: 999, readingShare: -1, proseSize: 25, codeSize: 1 });
  expect(store.getSnapshot()).toMatchObject({ inboxWidth: 520, readingShare: 0, proseSize: 18, codeSize: 11 });
  store.update({ inboxWidth: 1, readingShare: 2, proseSize: 3, codeSize: 99 });
  expect(store.getSnapshot()).toMatchObject({ inboxWidth: 220, readingShare: 1, proseSize: 15, codeSize: 14 });
});
