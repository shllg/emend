import { type SampleView, THEME_TOKENS, type ThemeList } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { buildSampleView } from "../../../../packages/core/src/sample/build.ts";
import { App } from "../App.tsx";
import { requestThemeSync, setThemePick, themeKey } from "../lib/theme.ts";
import { collectSampleTokens } from "../test/sample-tokens.ts";
import { customTheme } from "../test/themes.ts";

vi.mock("../components/diff/parse-client.ts", async () => {
  const { parsePair } = await import("../components/diff/parse.worker.ts");
  return { parseOffThread: parsePair };
});
vi.mock("@pierre/diffs/react", async (original) => {
  const actual = await original<typeof import("@pierre/diffs/react")>();
  return { ...actual, WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({ default: class {} }));

let sample: SampleView;
let themes: ThemeList;
const clients: QueryClient[] = [];
beforeAll(async () => {
  sample = await buildSampleView();
});
beforeEach(() => {
  vi.stubGlobal("localStorage", new Storage());
  setThemePick("system");
  themes = {
    themes: [customTheme, { valid: false, name: "refused", base: "dark", problems: ["Unreadable"] }],
    folderError: false,
  };
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        this.callback(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("em-diff-pane") ? new DOMRect(0, 0, 900, 600) : original.call(this);
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setThemePick("system");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(path = "/settings/sample", width = 1440) {
  const matchMedia = window.matchMedia.bind(window);
  vi.stubGlobal("matchMedia", (query: string) => {
    const media = matchMedia(query);
    const minimum = /min-width:\s*(\d+)px/.exec(query);
    if (minimum) Object.defineProperty(media, "matches", { value: width >= Number(minimum[1]) });
    return media;
  });
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") throw new Error(`Unexpected write: ${path}`);
    if (path === "/api/v1/sample") return Response.json(sample);
    if (path === "/api/v1/themes") return Response.json(themes);
    if (path === "/api/v1/settings")
      return Response.json({
        approvedActiveHours: {
          value: 12,
          default: 12,
          file: null,
          override: null,
          source: "default",
          fileError: false,
        },
        approvedActiveLimit: { value: 5, default: 5, file: null, override: null, source: "default", fileError: false },
        serverTime: "2026-01-01T00:00:00.000Z",
      });
    if (path.startsWith("/api/v1/bin"))
      return Response.json({ items: [], total: 0, more: false, version: "a".repeat(64) });
    if (path === "/api/v1/reviews")
      return Response.json({
        items: [],
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: "2026-01-01T00:00:00.000Z",
      });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = render(<App queryClient={client} history={createMemoryHistory({ initialEntries: [path] })} />);
  await screen.findByRole("heading", { name: path === "/settings" ? "Settings" : "Theme sample", level: 1 });
  if (path !== "/settings") await waitFor(() => expect(document.querySelectorAll(".em-diff-host")).toHaveLength(4));
  return { ...view, fetcher, client };
}

test.each([390, 834, 1440])("Settings opens the sample and shares the theme pick at %ipx", async (width) => {
  await setup("/settings", width);
  fireEvent.click(screen.getByRole("link", { name: "Open the theme sample page" }));
  const select = await screen.findByRole("combobox", { name: "Theme on this device" });
  expect(within(select).queryByRole("option", { name: "refused" })).toBeNull();
  fireEvent.change(select, { target: { value: "light" } });
  expect(localStorage.getItem(themeKey)).toBe("light");
  fireEvent.click(screen.getAllByRole("link", { name: "Settings" }).at(-1) as HTMLElement);
  await screen.findByRole("heading", { name: "Settings", level: 1 });
  expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
});

test("the open sample and its diagram frames update after the custom theme changes", async () => {
  await setup();
  fireEvent.change(screen.getByRole("combobox", { name: "Theme on this device" }), { target: { value: "theme:mine" } });
  await waitFor(() => expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("#112233"));
  const heading = screen.getByRole("heading", { name: "Theme sample", level: 1 });
  const frame = document.querySelector('iframe[src="/mermaid-frame.html"]');
  const html = document.querySelector<HTMLIFrameElement>('iframe[src^="/content/sample/"]');
  if (!html) throw new Error("Missing HTML document frame");
  const post = vi.fn();
  Object.defineProperty(html, "contentWindow", { value: { postMessage: post } });
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { source: html.contentWindow, data: { type: "emend:ready" } }));
  });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "emend:theme",
        scales: { "n-950": "#112233" },
      }),
      "*",
    ),
  );
  post.mockClear();
  themes = { themes: [{ ...customTheme, scales: { "n-950": "#223344" }, themeColor: "#223344" }], folderError: false };
  act(() => requestThemeSync());
  await waitFor(() => expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("#223344"));
  expect(screen.getByRole("heading", { name: "Theme sample", level: 1 })).toBe(heading);
  expect(document.querySelector('iframe[src="/mermaid-frame.html"]')).not.toBe(frame);
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "emend:theme",
        scales: { "n-950": "#223344" },
      }),
      "*",
    ),
  );
});

test.each([390, 834, 1440])("renders real content and stays read-only at %ipx", async (width) => {
  const { fetcher } = await setup("/settings/sample", width);
  expect(document.querySelectorAll('iframe[src="/mermaid-frame.html"]')).toHaveLength(4);
  expect(document.querySelector('iframe[src^="/content/sample/"]')?.getAttribute("sandbox")).toBe("allow-scripts");
  for (const label of [
    "Sample writeup",
    "Sample documents",
    "Sample diff",
    "Sample comment threads",
    "Sample badges",
    "Sample controls",
  ])
    expect(screen.getByRole("region", { name: label })).toBeTruthy();
  const send = screen.getByRole("region", { name: "Send and approve" });
  for (const button of within(send).getAllByRole("button", { name: /Send|Approve/ })) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
  }
  const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/content/sample/"]');
  if (!frame) throw new Error("Missing HTML document frame");
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: vi.fn() } });
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "emend:ready" } }));
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "emend:anchor", quote: "parcel", prefix: "", suffix: "" },
      }),
    );
  });
  const paragraph = document.querySelector(".em-prose p");
  if (!paragraph) throw new Error("Missing prose");
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  window.getSelection()?.addRange(range);
  fireEvent.mouseUp(paragraph);
  for (const button of screen.getAllByRole("button", {
    name: /Expand topic|Collapse topic|Expand file|Collapse file|Details|Comments \(/,
  }))
    fireEvent.click(button);
  expect(
    screen.queryByRole("button", {
      name: /^(Comment on|Reply$|Edit$|Delete$|Resolve$|Reopen$|Save$|Resume selection)/,
    }),
  ).toBeNull();
  for (const link of document.querySelectorAll("a[href]"))
    expect(link.getAttribute("href")).not.toContain("/r/theme-sample");
  expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  expect(fetcher.mock.calls.some(([path]) => path.startsWith("/api/v1/files/"))).toBe(false);
  expect(Object.keys(localStorage).some((key) => key.includes("theme-sample"))).toBe(false);
});

test("every theme token is carried by a rendered emend element", async () => {
  await setup();
  const used = collectSampleTokens(document, sample);
  expect(
    THEME_TOKENS.filter((token) => !used.has(token)),
    "Theme tokens without a sample element",
  ).toEqual([]);
});

test("the collector detects missing diff coverage when the diff is removed", async () => {
  await setup();
  screen.getByRole("region", { name: "Sample diff" }).remove();
  const used = collectSampleTokens(document, sample);
  expect(used.has("diff-add-word")).toBe(false);
  expect(used.has("diff-del-word")).toBe(false);
});
