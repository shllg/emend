import type { ThemeList } from "@recense/contract";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { customTheme } from "../test/themes.ts";
import {
  createThemeStore,
  createThemeSync,
  customThemeKey,
  downloadTheme,
  setThemePick,
  themeKey,
  useDownloadTheme,
} from "./theme.ts";
import { ThemeSync } from "./theme-sync.tsx";

const newer = { ...customTheme, scales: { "n-950": "#223344" }, themeColor: "#223344" };
const list = (themes: ThemeList["themes"]): ThemeList => ({ themes, folderError: false });
const cache = () => JSON.parse(localStorage.getItem(customThemeKey) ?? "null");
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal("localStorage", new Storage());
  setThemePick("system");
});
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  setThemePick("system");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  const store = createThemeStore();
  store.set("theme:mine");
  const requests: {
    signal: AbortSignal;
    resolve: (value: ThemeList) => void;
    reject: (reason: Error) => void;
    promise: Promise<ThemeList>;
  }[] = [];
  const fetchList = vi.fn((signal: AbortSignal) => {
    const pending = Promise.withResolvers<ThemeList>();
    requests.push({ ...pending, signal });
    return pending.promise;
  });
  const sync = createThemeSync(store, fetchList);
  const start = () => {
    const stop = sync.start();
    stops.push(stop);
    return stop;
  };
  const resolve = async (index: number, themes: ThemeList["themes"]) => {
    const pending = requests[index];
    if (!pending) throw new Error("Missing theme request");
    pending.resolve(list(themes));
    await pending.promise;
  };
  return { store, sync, start, fetchList, requests, resolve };
}

test("another tab's older copy cannot replace the held version; an identical fetch repairs the cache", async () => {
  const { store, sync, start, resolve, fetchList } = setup();
  start();
  await resolve(0, [newer]);
  const snapshot = store.getState();
  const listener = vi.fn();
  stops.push(store.subscribe(listener));
  const applied = vi.spyOn(document.documentElement.style, "setProperty");
  localStorage.setItem(customThemeKey, JSON.stringify(customTheme));
  window.dispatchEvent(new StorageEvent("storage", { key: customThemeKey, storageArea: localStorage }));
  expect(store.getState()).toBe(snapshot);
  expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("#223344");
  const writes = vi.spyOn(localStorage, "setItem");
  sync.request();
  await resolve(1, [structuredClone(newer)]);
  expect(fetchList).toHaveBeenCalledTimes(2);
  expect(writes).toHaveBeenCalledExactlyOnceWith(customThemeKey, JSON.stringify(newer));
  expect(cache()).toEqual(newer);
  expect(store.getState()).toBe(snapshot);
  expect(listener).not.toHaveBeenCalled();
  expect(applied).not.toHaveBeenCalled();
  expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("#223344");
});

test.each([1, 5])("%s triggers during the first fetch queue exactly one more fetch", async (triggers) => {
  const { store, sync, start, resolve, fetchList } = setup();
  start();
  for (let i = 0; i < triggers; i++) sync.request();
  expect(fetchList).toHaveBeenCalledOnce();
  await resolve(0, [customTheme]);
  expect(fetchList).toHaveBeenCalledTimes(2);
  await resolve(1, [newer]);
  expect(fetchList).toHaveBeenCalledTimes(2);
  expect(store.getState().custom).toEqual(newer);
  expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("#223344");
});

test.each(["select", "storage"])(
  "a pick change through %s ignores the pending old result and fetches the new name",
  async (change) => {
    const { store, start, resolve, fetchList } = setup();
    start();
    const other = { ...newer, name: "another" };
    if (change === "select") store.selectCustomTheme(other);
    else {
      localStorage.setItem(themeKey, "theme:another");
      window.dispatchEvent(new StorageEvent("storage", { key: themeKey, storageArea: localStorage }));
    }
    await resolve(0, [customTheme, other]);
    expect(fetchList).toHaveBeenCalledTimes(2);
    expect(store.getState().checked).toBeUndefined();
    expect(store.getState().custom?.name).not.toBe("mine");
    await resolve(1, [other]);
    expect(store.getState().custom).toEqual(other);
    expect(downloadTheme(store.getState())).toBe("another");
  },
);

test("identical results do not notify listeners, write storage or reapply CSS", async () => {
  const { store, sync, start, resolve } = setup();
  start();
  await resolve(0, [customTheme]);
  const snapshot = store.getState();
  const listener = vi.fn();
  stops.push(store.subscribe(listener));
  const writes = vi.spyOn(localStorage, "setItem");
  const applied = vi.spyOn(document.documentElement.style, "setProperty");
  sync.request();
  await resolve(1, [structuredClone(customTheme)]);
  expect(store.getState()).toBe(snapshot);
  expect(listener).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
  expect(applied).not.toHaveBeenCalled();
});

test.each([
  { status: "missing", entries: [] },
  {
    status: "refused",
    entries: [{ valid: false as const, name: "mine", base: "light" as const, problems: ["Unreadable."] }],
  },
])("$status entries keep the held version and download its base", async ({ entries }) => {
  const { store, sync, start, resolve } = setup();
  start();
  expect(downloadTheme(store.getState())).toBeUndefined();
  await resolve(0, entries);
  expect(downloadTheme(store.getState())).toBeUndefined();
  sync.request();
  await resolve(1, [customTheme]);
  expect(downloadTheme(store.getState())).toBe("mine");
  sync.request();
  await resolve(2, entries);
  expect(store.getState().custom).toEqual(customTheme);
  expect(cache()).toEqual(customTheme);
  expect(downloadTheme(store.getState())).toBe("dark");
  expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("#112233");
});

test("stop aborts the pending fetch, ignores its result, and allows a new start", async () => {
  const { store, sync, start, resolve, requests, fetchList } = setup();
  sync.request();
  expect(fetchList).not.toHaveBeenCalled();
  const stop = start();
  sync.request();
  stop();
  expect(requests[0]?.signal.aborted).toBe(true);
  sync.request();
  expect(fetchList).toHaveBeenCalledOnce();
  start();
  await resolve(1, [newer]);
  await resolve(0, [customTheme]);
  expect(fetchList).toHaveBeenCalledTimes(2);
  expect(store.getState().custom).toEqual(newer);
  expect(cache()).toEqual(newer);
});

test("a result arriving while stopped changes nothing and consumes no queued trigger", async () => {
  const { store, sync, start, resolve, fetchList } = setup();
  const stop = start();
  sync.request();
  const snapshot = store.getState();
  stop();
  await resolve(0, [customTheme]);
  sync.request();
  expect(store.getState()).toBe(snapshot);
  expect(cache()).toBeNull();
  expect(fetchList).toHaveBeenCalledOnce();
});

test.each(["system", "dark", "light"] as const)("starting with %s makes no theme request", (pick) => {
  const { store, sync, start, fetchList } = setup();
  store.set(pick);
  start();
  sync.request();
  expect(fetchList).not.toHaveBeenCalled();
});

test("errors preserve state and wait for another trigger", async () => {
  const { store, sync, start, resolve, requests, fetchList } = setup();
  start();
  await resolve(0, [customTheme]);
  const snapshot = store.getState();
  sync.request();
  requests[1]?.reject(new Error("offline"));
  await requests[1]?.promise.catch(() => {});
  expect(store.getState()).toBe(snapshot);
  expect(fetchList).toHaveBeenCalledTimes(2);
  sync.request();
  await resolve(2, [newer]);
  expect(store.getState().custom).toEqual(newer);
});

test("a pending fetch followed by System ignores its result and queues no fetch", async () => {
  const { store, sync, start, resolve, fetchList } = setup();
  start();
  sync.request();
  store.set("system");
  await resolve(0, [customTheme]);
  for (const pick of ["system", "dark", "light"] as const) {
    store.set(pick);
    sync.request();
  }
  expect(fetchList).toHaveBeenCalledOnce();
  expect(store.getState().custom).toBeUndefined();
});

function Download() {
  return <output>{useDownloadTheme() ?? "system"}</output>;
}

test("ThemeSync respects enabled and restarts under StrictMode without a query client", async () => {
  const requests: { signal?: AbortSignal | null; resolve: (response: Response) => void }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_path: string, init?: RequestInit) => {
      const pending = Promise.withResolvers<Response>();
      requests.push({ ...pending, signal: init?.signal });
      return pending.promise;
    }),
  );
  const entry = { ...customTheme, name: "component" };
  setThemePick("theme:component");
  const view = render(
    <StrictMode>
      <ThemeSync />
      <Download />
    </StrictMode>,
  );
  expect(requests).toHaveLength(2);
  expect(requests[0]?.signal?.aborted).toBe(true);
  await act(async () => requests[1]?.resolve(Response.json(list([entry]))));
  expect(screen.getByRole("status").textContent).toBe("component");
  view.rerender(
    <StrictMode>
      <ThemeSync enabled={false} />
      <Download />
    </StrictMode>,
  );
  view.rerender(
    <StrictMode>
      <ThemeSync />
      <Download />
    </StrictMode>,
  );
  expect(requests).toHaveLength(3);
  view.unmount();
  expect(requests[2]?.signal?.aborted).toBe(true);
  await act(async () => {
    requests[0]?.resolve(Response.json(list([entry])));
    requests[2]?.resolve(Response.json(list([newer])));
  });
  expect(cache()).toEqual(entry);
});
