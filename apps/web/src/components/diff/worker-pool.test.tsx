import type { ReviewView, RevisionView } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Window } from "happy-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../../App.tsx";
import { layoutStore } from "../../lib/layout-store.ts";
import { stubIntersectionObserver } from "../../test/intersection.ts";
import { parsePair } from "./parse.worker.ts";
import type { DiffParser } from "./parse-client.ts";

const workers = vi.hoisted(() => ({ constructed: vi.fn(), terminated: vi.fn() }));
const parser = vi.hoisted(() => vi.fn<DiffParser>());
vi.mock("./parse-client.ts", () => ({ parseOffThread: parser }));
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: class extends EventTarget {
    constructor() {
      super();
      workers.constructed();
    }
    postMessage({ type, id }: { type: string; id: string }) {
      if (type === "initialize")
        queueMicrotask(() =>
          this.dispatchEvent(new MessageEvent("message", { data: { type: "success", requestType: type, id } })),
        );
    }
    terminate() {
      workers.terminated();
    }
  },
}));

const id = "11111111-1111-4111-8111-111111111111";
const review: ReviewView = {
  id,
  title: "Synthetic garden",
  origin: { id, name: "Workshop" },
  repo: null,
  project: null,
  branch: null,
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
  pinOrder: null,
  snoozed: false,
  snoozedUntil: null,
  activeUntil: null,
  releasedAt: null,
  pickedUpAt: null,
  kind: "review",
  importedAt: null,
  revisions: [{ seq: 1, createdAt: "2026-01-01T00:00:00.000Z" }],
};
const revision: RevisionView = {
  seq: 1,
  base: null,
  head: null,
  main: "writeup",
  writeupEmpty: false,
  topics: [{ slug: "garden", title: "Plant a garden", summary: "A synthetic garden", importance: 1 }],
  files: ["seed.txt", "water.txt"].map((path, order) => ({
    id: order === 0 ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333",
    path,
    oldPath: null,
    role: "diff",
    topic: "garden",
    order,
    status: "modified",
    mediaType: "text/plain",
    flag: null,
    hasOld: true,
    hasNew: true,
  })),
  writeup: {
    sections: [
      {
        key: "t-garden-body",
        label: "Plant a garden — Details",
        topic: "garden",
        blocks: [
          {
            id: "t-garden-body-12345678",
            section: "t-garden-body",
            kind: "paragraph",
            text: "Keep growing",
            html: "<p>Keep growing</p>",
          },
        ],
      },
    ],
  },
  docs: [],
  threads: [],
  changedBlocks: [],
};
let client: QueryClient;
let intersections: ReturnType<typeof stubIntersectionObserver>;
let parseReady: ReturnType<typeof Promise.withResolvers<void>>;
beforeEach(() => {
  workers.constructed.mockClear();
  workers.terminated.mockClear();
  parseReady = Promise.withResolvers<void>();
  parser.mockReset().mockImplementation(async (pair) => {
    if (pair.newFile?.name === "water.txt") await parseReady.promise;
    return parsePair(pair);
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  intersections = stubIntersectionObserver();
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  // Happy DOM has no layout; file visibility is delivered through the observer below.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 900, 600));
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/api/v1/session") return new Response(null, { status: 204 });
      if (path === "/api/v1/devices") return Response.json({ items: [] });
      if (path === "/api/v1/reviews")
        return Response.json({
          approvedActiveHours: 12,
          approvedActiveLimit: 5,
          serverTime: new Date().toISOString(),
          items: [review],
        });
      if (path === `/api/v1/reviews/${id}`) return Response.json(review);
      if (path === `/api/v1/reviews/${id}/revisions/1`) return Response.json(revision);
      for (const file of revision.files) {
        if (path === `/api/v1/files/${file.id}/old`) return new Response(`Before ${file.path}\n`);
        if (path === `/api/v1/files/${file.id}/new`) return new Response(`After ${file.path}\n`);
      }
      throw new Error(`Unexpected synthetic request: ${path}`);
    }),
  );
});
afterEach(async () => {
  cleanup();
  parseReady.resolve();
  client.clear();
  await (window as unknown as Window).happyDOM.abort();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([
  { layout: "phone", width: 390, tabRole: "link" },
  { layout: "laptop", width: 1280, tabRole: "tab" },
])("$layout Tabs keeps the diff workers through Files and a pending file parse", async ({ width, tabRole }) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(query.match(/\d+/)?.[0] ?? Infinity),
    addEventListener() {},
    removeEventListener() {},
  }));
  expect(layoutStore.getSnapshot().pane.desktop).toBe("tabs");
  const history = createMemoryHistory({ initialEntries: [`/r/${id}?tab=writeup&rev=1`] });
  const page = render(<App queryClient={client} history={history} />);
  await screen.findByText("Keep growing");
  expect(workers.constructed).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole(tabRole, { name: "Diff" }));
  const first = await screen.findByRole("region", { name: "File seed.txt" });
  act(() => intersections.intersect(first));
  await waitFor(() =>
    expect(first.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line]")?.textContent).toContain(
      "seed.txt",
    ),
  );
  expect(workers.constructed).toHaveBeenCalledTimes(2);
  expect(workers.terminated).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole(tabRole, { name: /^Files/ }));
  const openSecond = await screen.findByRole("button", { name: /^Open diff for water.txt/ });
  if (width >= 768) {
    expect(screen.getByTestId("diff-pane").hidden).toBe(true);
    act(() => {
      for (const section of document.querySelectorAll("[data-diff-file]")) intersections.intersect(section, false);
    });
  } else expect(screen.queryByTestId("diff-pane")).toBeNull();
  expect(document.querySelector("diffs-container")).toBeNull();
  expect(workers.constructed).toHaveBeenCalledTimes(2);
  expect(workers.terminated).not.toHaveBeenCalled();

  fireEvent.click(openSecond);
  const second = await screen.findByRole("region", { name: "File water.txt" });
  act(() => intersections.intersect(second));
  await waitFor(() => expect(parser.mock.calls.some(([pair]) => pair.newFile?.name === "water.txt")).toBe(true));
  expect(within(second).getByText("Loading diff…")).toBeTruthy();
  expect(document.querySelector("diffs-container")).toBeNull();
  expect(workers.constructed).toHaveBeenCalledTimes(2);
  expect(workers.terminated).not.toHaveBeenCalled();

  await act(async () => parseReady.resolve());
  await waitFor(() => {
    const lines = second.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]") ?? [];
    expect([...lines].map((line) => line.textContent).join("\n")).toContain("After water.txt");
  });
  expect(workers.constructed).toHaveBeenCalledTimes(2);
  expect(workers.terminated).not.toHaveBeenCalled();
  page.unmount();
  expect(workers.terminated).toHaveBeenCalledTimes(2);
});
