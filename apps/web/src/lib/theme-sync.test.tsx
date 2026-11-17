import type { ThemeList } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { customTheme } from "../test/themes.ts";
import { customThemeKey, setThemePick } from "./theme.ts";
import { ThemeSync } from "./theme-sync.tsx";

let client: QueryClient;
let response: ThemeList;
beforeEach(() => {
  vi.stubGlobal("localStorage", new Storage());
  setThemePick("system");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  response = { themes: [customTheme], folderError: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(response)),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  setThemePick("system");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const key = ["themes", "pick", "mine"];
const cache = () => JSON.parse(localStorage.getItem(customThemeKey) ?? "null");
const mount = () => {
  setThemePick("theme:mine");
  render(
    <QueryClientProvider client={client}>
      <ThemeSync />
    </QueryClientProvider>,
  );
};

test("a clock step back by an hour does not block a freshly fetched valid theme", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  mount();
  await waitFor(() => expect(cache()).toEqual(customTheme));
  clock.mockReturnValue(now - 3_600_000);
  const newer = { ...customTheme, scales: { "n-950": "#223344" }, themeColor: "#223344" };
  response = { themes: [newer], folderError: false };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["themes"] });
  });
  await waitFor(() => expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("#223344"));
  expect(cache()).toEqual(newer);
});

test("two identical fetches write the custom cache once", async () => {
  const writes = vi.spyOn(localStorage, "setItem");
  mount();
  await waitFor(() => expect(cache()).toEqual(customTheme));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["themes"] });
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(writes.mock.calls.filter(([key]) => key === customThemeKey)).toEqual([
    [customThemeKey, JSON.stringify(customTheme)],
  ]);
});

test("leaving a pick drops its query and picking it again fetches without reapplying its old data", async () => {
  mount();
  await waitFor(() => expect(client.getQueryData(key)).toEqual(response));
  act(() => setThemePick("system"));
  await waitFor(() => expect(client.getQueryState(key)).toBeUndefined());
  const newer = { ...customTheme, scales: { "n-950": "#223344" }, themeColor: "#223344" };
  localStorage.setItem(customThemeKey, JSON.stringify(newer));
  response = { themes: [], folderError: false };
  const applied = vi.spyOn(document.documentElement.style, "setProperty");
  act(() => setThemePick("theme:mine"));
  await waitFor(() => expect(client.getQueryData(key)).toEqual(response));
  expect(applied).not.toHaveBeenCalledWith("--n-950", "#112233");
  expect(cache()).toEqual(newer);
});
