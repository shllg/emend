import { type SampleView, THEME_TOKENS, type ThemeList } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { buildSampleView } from "../../../../packages/core/src/sample/build.ts";
import { App } from "../App.tsx";
import { AgentNoteCard } from "../components/diff/AgentNoteCard.tsx";
import { DiffPane } from "../components/diff/DiffPane.tsx";
import { FileTextsContext } from "../components/diff/file-texts.ts";
import { parsePair } from "../components/diff/parse.worker.ts";
import { Panes } from "../components/layout/Panes.tsx";
import { requestThemeSync, setThemePick, themeKey } from "../lib/theme.ts";
import {
  collectSampleTokens,
  findTokenReferencesInSource,
  findWebTokenReferences,
  TOKENS_NO_ELEMENT_USES,
} from "../test/sample-tokens.ts";
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
let initialSample: SampleView;
let themes: ThemeList;
const clients: QueryClient[] = [];
beforeAll(async () => {
  initialSample = await buildSampleView();
});
beforeEach(() => {
  sample = structuredClone(initialSample);
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

const reviewTexts = { old: "const reviewBefore = 1;\n", new: "const reviewAfter = 2;\nconst extra = 3;\n" };

async function setup(
  path = "/settings/sample",
  width = 1440,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
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
    const side = ["old", "new"].find((side) => path === `/api/v1/files/${sample.revision.files[0]?.id}/${side}`);
    if (side) return new Response(reviewTexts[side as keyof typeof reviewTexts]);
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
  clients.push(client);
  const history = createMemoryHistory({ initialEntries: [path] });
  const view = render(<App queryClient={client} history={history} />);
  await screen.findByRole("heading", { name: path === "/settings" ? "Settings" : "Theme sample", level: 1 });
  if (path !== "/settings")
    await waitFor(() =>
      expect(document.querySelectorAll(".em-diff-host")).toHaveLength(
        sample.revision.files.filter((file) => file.role === "diff" && file.viewed !== "viewed").length,
      ),
    );
  return { ...view, fetcher, client, history };
}

async function mountReviewDiff(client: QueryClient, collapsed: boolean) {
  const file = sample.revision.files[0];
  if (!file) throw new Error("Missing sample file");
  const revision = {
    ...sample.revision,
    threads: [],
    files: [{ ...file, counts: undefined, notes: [], viewed: collapsed ? ("viewed" as const) : undefined }],
  };
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Panes
          header={null}
          reading={null}
          phoneTabs={null}
          tab="diff"
          hasDiff
          diff={<DiffPane reviewId="11111111-1111-4111-8111-111111111111" revision={revision} parser={parsePair} />}
        />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const view = render(<RouterProvider router={router} />);
  await screen.findByRole("region", { name: `File ${file.path}` });
  return view;
}

test.each([false, true].flatMap((collapsed) => ["sample", "review"].map((first) => ({ first, collapsed }))))(
  "sample and review file caches stay separate ($first first, collapsed: $collapsed)",
  async ({ first, collapsed }) => {
    const file = sample.revision.files[0];
    if (!file) throw new Error("Missing sample file");
    if (collapsed) {
      file.counts = undefined;
      file.viewed = "viewed";
    }
    const { client, unmount } = await setup("/settings");
    unmount();
    const fileRequests = new Set<string>();
    for (const source of [first, first === "sample" ? "review" : "sample", first]) {
      const view =
        source === "sample" ? await setup("/settings/sample", 1440, client) : await mountReviewDiff(client, collapsed);
      const region = await screen.findByRole("region", { name: `File ${file.path}` });
      const expected = source === "sample" ? { additions: 1, deletions: 1 } : { additions: 2, deletions: 1 };
      await waitFor(() => expect(within(region).getByText(`+${expected.additions}`)).toBeTruthy());
      await waitFor(() =>
        expect(
          client
            .getQueryData<Map<string, unknown>>(["diff-counts", source === "sample" ? "sample" : "reviews"])
            ?.get(file.id),
        ).toEqual(expected),
      );
      const expand = within(region).queryByRole("button", { name: "Expand file" });
      if (expand) fireEvent.click(expand);
      await waitFor(() => {
        const lines = [...(region.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]") ?? [])]
          .map((line) => line.textContent)
          .join("\n");
        expect(lines).toContain(
          source === "sample" ? 'return size > 2 ? "large" : "small";' : "const reviewAfter = 2;",
        );
        expect(lines).not.toContain(source === "sample" ? "const reviewAfter" : "return size");
      });
      for (const [path] of vi.mocked(fetch).mock.calls) fileRequests.add(String(path));
      if (source === "review")
        for (const side of ["old", "new"]) expect(fileRequests.has(`/api/v1/files/${file.id}/${side}`)).toBe(true);
      view.unmount();
    }
    const sampleDiff = client.getQueryData<{ cacheKey?: string }>(["file-diff", "sample", file.id]);
    const reviewDiff = client.getQueryData<{ cacheKey?: string }>(["file-diff", "reviews", file.id]);
    expect(sampleDiff?.cacheKey).toBeTruthy();
    expect(reviewDiff?.cacheKey).toBeTruthy();
    expect(sampleDiff?.cacheKey).not.toBe(reviewDiff?.cacheKey);
  },
);

test("agent notes quote the context's file source without using another source's cached text", async () => {
  const file = sample.revision.files[0];
  const note = file?.notes?.[0];
  if (!file || !note) throw new Error("Missing sample note");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  client.setQueryData(["file", "reviews", file.id, "new"], "Review line\n");
  const read = vi.fn(async () => "Context line\n");
  const comment = vi.fn();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(
    <QueryClientProvider client={client}>
      <FileTextsContext value={{ scope: "sample", read }}>
        <AgentNoteCard file={file} note={{ ...note, start: 1, end: 1 }} onComment={comment} />
      </FileTextsContext>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Comment on these lines" }));
  await waitFor(() => expect(comment).toHaveBeenCalledWith(expect.objectContaining({ lines: ["Context line"] })));
  expect(read).toHaveBeenCalledWith(file.id, "new", expect.any(AbortSignal));
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([390, 1440])("sample Contents scrolls only the picked doc's declared heading at %ipx", async (width) => {
  const doc = sample.revision.docs.find((doc) => doc.kind === "markdown");
  if (doc?.kind !== "markdown") throw new Error("Missing sample Markdown doc");
  // Three headings expose Contents; the fixed sample currently has only two h2/h3 headings.
  doc.blocks.push({
    id: "doc-12345678-abcdef12",
    section: "doc-12345678",
    kind: "heading",
    html: '<h2 id="user-content-delivery">Delivery</h2>',
    text: "Delivery",
  });
  doc.headings?.push({ id: "user-content-delivery", level: 2, text: "Delivery" });
  const { history } = await setup("/settings/sample", width);
  const before = history.location.href;
  const heading = within(screen.getByRole("region", { name: "Sample documents" })).getByRole("heading", {
    name: "Packing",
  });
  const scroll = vi.spyOn(heading, "scrollIntoView").mockImplementation(() => {});
  const outside = document.createElement("h3");
  outside.id = heading.id;
  document.body.prepend(outside);
  const outsideScroll = vi.spyOn(outside, "scrollIntoView").mockImplementation(() => {});
  try {
    if (width === 390) fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    const contents = await screen.findByRole("navigation", { name: "Document contents" });
    fireEvent.click(within(contents).getByRole("button", { name: "Packing" }));
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: "start" }));
    expect(outsideScroll).not.toHaveBeenCalled();
    expect(history.location.href).toBe(before);
  } finally {
    outside.remove();
  }
});

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
  const noElement = new Set<string>(TOKENS_NO_ELEMENT_USES);
  expect(
    THEME_TOKENS.filter((token) => !noElement.has(token) && !used.has(token)),
    "Theme tokens without a sample element",
  ).toEqual([]);
});

test.each(TOKENS_NO_ELEMENT_USES)("%s is a theme token no emend element uses", (token) => {
  expect(THEME_TOKENS).toContain(token);
  expect(
    findWebTokenReferences(token),
    `${token} is now used by an element; remove it from TOKENS_NO_ELEMENT_USES so the sample page must show that element`,
  ).toEqual([]);
});

const referenceTheme = `@theme inline {
  --color-agent-working: var(--agent-working);
  --color-agent-approved: var(--agent-approved);
  --color-progress: var(--agent-working);
}`;

test.each([
  ["agent-working", '<span className="hover:bg-agent-working/50" />'],
  ["agent-approved", '<span className="dark:group-hover:text-agent-approved/75" />'],
  ["agent-working", '<span className="[&:nth-child(2)]:border-progress/50" />'],
  ["agent-working", '<span className="bg-(--agent-working)" />'],
  ["agent-approved", '<span className="text-(--agent-approved)" />'],
  ["agent-working", '<span className="hover:bg-(--agent-working)/50" />'],
  ["agent-approved", '<span className="dark:group-hover:text-(--agent-approved)/75" />'],
  ["agent-working", '<span className="[&:nth-child(2)]:shadow-(--agent-working)/50" />'],
  ["agent-approved", '<span className="sm:leading-(--agent-approved)" />'],
  ["agent-approved", "color: var(--agent-approved)"],
  ["agent-working", "color: var(\n  --agent-working, red)"],
  ["agent-working", 'const token = "agent-working";'],
  ["agent-approved", "const token = 'agent-approved';"],
  ["agent-approved", "const token = `agent-approved`;"],
  ["agent-working", 'getPropertyValue("--agent-working")'],
])("the guard detects a reference to %s in %s", (token, source) => {
  expect(findTokenReferencesInSource(token, source, referenceTheme)).toHaveLength(1);
});

test("the guard reports every reference with its source line", () => {
  expect(
    findTokenReferencesInSource(
      "agent-working",
      '<span className="bg-agent-working text-progress" />\ncolor: var(--agent-working);',
      referenceTheme,
      "src/example.tsx",
    ),
  ).toEqual([
    { path: "src/example.tsx", line: 1, reference: "bg-agent-working" },
    { path: "src/example.tsx", line: 1, reference: "text-progress" },
    { path: "src/example.tsx", line: 2, reference: "var(--agent-working" },
  ]);
});

test.each([
  ["src/styles/colors.css", ":root { --agent-working: var(--agent-working, red); }"],
  ["src/styles/theme.css", "@theme inline { --color-agent-working: var(--agent-working); }"],
])("the guard ignores only the token's own definition in %s", (path, definition) => {
  expect(findTokenReferencesInSource("agent-working", definition, referenceTheme, path)).toEqual([]);
  expect(
    findTokenReferencesInSource(
      "agent-working",
      `${definition}\n.element { color: var(--agent-working); }`,
      referenceTheme,
      path,
    ),
  ).toEqual([{ path, line: 2, reference: "var(--agent-working" }]);
});

test("the guard requires an exact token or a mapped Tailwind utility", () => {
  const source = `
    <span className="bg-agent-working-extra not-bg-agent-working bg-unmapped bg-(--agent-working-extra)" />
    color: var(--agent-working-extra);
    const token = "agent-working-extra";
    --agent-working: red;
  `;
  expect(findTokenReferencesInSource("agent-working", source, referenceTheme)).toEqual([]);
  expect(findTokenReferencesInSource("agent-working", '"bg-agent-working"', "")).toEqual([]);
});

test("the collector detects missing diff coverage when the diff is removed", async () => {
  await setup();
  screen.getByRole("region", { name: "Sample diff" }).remove();
  const used = collectSampleTokens(document, sample);
  expect(used.has("diff-add-word")).toBe(false);
  expect(used.has("diff-del-word")).toBe(false);
});
