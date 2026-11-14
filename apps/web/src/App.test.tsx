// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import type { FileView, InboxItem, RenderedBlock, RevisionView, Target, ThreadView } from "@emend/contract";
import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Window } from "happy-dom";
import { afterEach, beforeEach, expect, expectTypeOf, onTestFinished, test, vi } from "vitest";
import { App } from "./App.tsx";
import { type InboxData, inboxQuery, reviewQuery } from "./api/queries.ts";
import type { PhoneTabs } from "./components/layout/PhoneTabs.tsx";
import type { ReviewTabs, ReviewTabsProps } from "./components/layout/ReviewTabs.tsx";
import { clearDraft, draftKey, editDraftKey, saveDraft } from "./lib/drafts.ts";
import { defaultLayout, layoutStore } from "./lib/layout-store.ts";
import { rememberPairingSecret, takePairingSecret } from "./lib/pairing-secret.ts";
import { validateReviewSearch } from "./router.tsx";
import { Events } from "./test/events.ts";

const id = "11111111-1111-4111-8111-111111111111";
const item: InboxItem = {
  id,
  title: "Synthetic review",
  origin: { id, name: "Workshop" },
  repo: "c".repeat(64),
  project: null,
  branch: "main",
  state: "open",
  newestRevision: 1,
  unsentCount: 2,
  openThreads: 1,
  agentWaiting: false,
  pendingSend: true,
  updatedAt: "2026-01-01T00:00:00.000Z",
  movedTo: null,
  list: "active",
  snoozed: false,
  snoozedUntil: null,
  activeUntil: null,
  releasedAt: null,
  pickedUpAt: null,
  kind: "review",
};
const diffFile: FileView = {
  id: "33333333-3333-4333-8333-333333333333",
  path: "new.txt",
  oldPath: null,
  role: "diff",
  status: "modified",
  topic: "topic",
  order: 0,
  mediaType: "text/plain",
  flag: "binary",
  hasOld: false,
  hasNew: false,
};
const revision = {
  seq: 1,
  base: null,
  head: null,
  main: null,
  writeupEmpty: false,
  topics: [],
  files: [{ ...diffFile, topic: null }],
  writeup: { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [] }] },
  docs: [{ path: "plan.md", kind: "markdown", blocks: [] }],
  threads: [],
  changedBlocks: [],
};
let width = 1280;
const mediaQueries = new Set<{ media: string; matches: boolean; events: EventTarget }>();
function matchesWidth(query: string) {
  const constraints = [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
  if (!constraints.length) throw new Error(`Unsupported media query: ${query}`);
  return constraints.every(([, bound, pixels]) =>
    bound === "min" ? width >= Number(pixels) : width <= Number(pixels),
  );
}
function resize(widthPx: number) {
  width = widthPx;
  for (const media of mediaQueries) {
    const matches = matchesWidth(media.media);
    if (matches === media.matches) continue;
    media.matches = matches;
    media.events.dispatchEvent(Object.assign(new Event("change"), { matches, media: media.media }));
  }
}
let newest = 1;
const initialUrl = window.location.href;
const signInInstructions =
  "Run emend in a terminal on the machine that runs emend. It opens this page signed in, or prints a one-time link you can open here.";
let fetchMock: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
let client: QueryClient;
function mount(path = "/") {
  const history = createMemoryHistory({ initialEntries: [path] });
  const result = render(<App queryClient={client} history={history} />);
  return { ...result, history };
}

test.each([
  { path: "/", size: 1280, count: 1 },
  { path: `/r/${id}`, size: 1280, count: 3 },
  { path: `/r/${id}`, size: 900, count: 3 },
])("scroll panes contain absolutely positioned labels at $path ($size px)", async ({ path, size, count }) => {
  width = size;
  const { container } = mount(path);
  await screen.findByRole("heading", { name: path === "/" ? "Inbox" : item.title, level: 1 });
  await waitFor(() =>
    expect(container.querySelectorAll(".overflow-y-auto:not(textarea), .overflow-auto")).toHaveLength(count),
  );
  const panes = container.querySelectorAll(".overflow-y-auto:not(textarea), .overflow-auto");
  expect(panes).toHaveLength(count);
  for (const pane of panes) expect(pane.classList.contains("relative")).toBe(true);
  if (size === 900) {
    fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
    const sheet = await screen.findByRole("dialog", { name: "Inbox" });
    const scrollers = sheet.querySelectorAll(".overflow-y-auto, .overflow-auto");
    expect(scrollers).toHaveLength(2);
    for (const pane of scrollers) expect(pane.classList.contains("relative")).toBe(true);
  }
});
beforeEach(() => {
  // Happy DOM has no layout; dedicated diff tests control positive and hidden measurements.
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("em-diff-pane") ? new DOMRect(0, 0, 900, 600) : bounds.call(this);
  });
  (window as unknown as Window).happyDOM.setURL(initialUrl);
  width = 1280;
  mediaQueries.clear();
  newest = 1;
  localStorage.clear();
  layoutStore.update(defaultLayout);
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const media = { matches: matchesWidth(query), media: query, events: new EventTarget() };
      mediaQueries.add(media);
      return Object.assign(media, {
        addEventListener: media.events.addEventListener.bind(media.events),
        removeEventListener: media.events.removeEventListener.bind(media.events),
      });
    }),
  );
  fetchMock = vi.fn(async (path: string) => {
    if (path === "/api/v1/session") return new Response(null, { status: 204 });
    if (path === "/api/v1/reviews")
      return Response.json({
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date(Date.now()).toISOString(),
        items: [item],
      });
    if (path === `/api/v1/reviews/${id}`)
      return Response.json({
        ...item,
        newestRevision: newest,
        revisions: Array.from({ length: newest }, (_, i) => ({ seq: i + 1, createdAt: item.updatedAt })),
      });
    if (path.includes("/revisions/")) return Response.json({ ...revision, seq: Number(path.split("/").at(-1)) });
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetchMock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

async function chooseRevision(seq: number) {
  fireEvent.keyDown(screen.getByRole("button", { name: /^Revision \d+(?: of|,)/ }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: new RegExp(`^Revision ${seq}\\b`) }));
}

function openingRevision(change: Partial<RevisionView>, previous?: Partial<RevisionView>) {
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path.includes("/revisions/")
      ? Response.json({
          ...revision,
          writeupEmpty: true,
          files: [],
          docs: [],
          seq: Number(path.split("/").at(-1)),
          ...(path.endsWith("/1") && previous ? previous : change),
        })
      : (fallback?.(path, init) as Promise<Response>),
  );
}

test("review search leaves an absent tab unset", () => {
  expect(validateReviewSearch({}).tab).toBeUndefined();
  expect(validateReviewSearch({ tab: "writeup" }).tab).toBe("writeup");
});

test.each([
  {
    name: "diff-only",
    change: {
      files: [
        { ...diffFile, role: "diff" as const, status: "modified" as const, flag: "binary" as const, topic: null },
      ],
    },
    tab: "Diff",
  },
  { name: "one doc", change: { docs: [{ path: "plan.md", kind: "markdown" as const, blocks: [] }] }, tab: "Docs" },
  {
    name: "several docs",
    change: {
      docs: [
        { path: "z.md", kind: "markdown" as const, blocks: [] },
        { path: "a.md", kind: "markdown" as const, blocks: [] },
      ],
    },
    tab: "Docs",
  },
  { name: "writeup text", change: { writeupEmpty: false }, tab: "Writeup" },
])("review without tab opens $name on $tab", async ({ change, tab }) => {
  width = 390;
  openingRevision(change);
  mount(`/r/${id}`);
  await waitFor(() => expect(screen.getByRole("link", { name: tab }).getAttribute("aria-current")).toBe("page"));
  expect(screen.getByRole("link", { name: /Comments/ })).toBeTruthy();
  expect(screen.queryByTestId("diff-pane") !== null).toBe(tab === "Diff");
});

test.each([390, 1280])("empty Writeup and absent Diff tabs are hidden at %s px", async (size) => {
  width = size;
  openingRevision({ docs: [{ path: "plan.md", kind: "markdown", blocks: [] }] });
  mount(`/r/${id}?tab=writeup`);
  await screen.findByRole("heading", { name: "plan.md" });
  expect(screen.queryByRole(width < 768 ? "link" : "tab", { name: "Writeup" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Diff" })).toBeNull();
  expect(
    screen
      .getByRole(width < 768 ? "link" : "tab", { name: /^Docs(?: \d+)?$/ })
      .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
  ).toBe(width < 768 ? "page" : "true");
  expect(screen.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ })).toBeTruthy();
  expect(screen.queryByTestId("diff-pane")).toBeNull();
  expect(screen.getByTestId("reading-pane").className).toContain("flex-1");
});

test("explicit Diff stays selected even with a main doc", async () => {
  width = 390;
  openingRevision({
    main: "plan.md",
    docs: [{ path: "plan.md", kind: "markdown", blocks: [] }],
    files: [{ ...diffFile, role: "diff", status: "modified", flag: "binary", topic: null }],
  });
  mount(`/r/${id}?tab=diff`);
  await screen.findByTestId("diff-pane");
  expect(screen.getByRole("link", { name: "Diff" }).getAttribute("aria-current")).toBe("page");
});

test("explicit empty main writeup remains visible", async () => {
  openingRevision({ main: "writeup" });
  mount(`/r/${id}`);
  await waitFor(() =>
    expect(
      screen
        .getByRole(width < 768 ? "link" : "tab", { name: "Writeup" })
        .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
    ).toBe(width < 768 ? "page" : "true"),
  );
});

test.each(["markdown", "html"] as const)(
  "opening main %s doc starts at the top without a synthetic scroll",
  async (kind) => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const path = kind === "html" ? "last.html" : "last.md";
    openingRevision({
      main: path,
      writeupEmpty: false,
      docs: [
        { path: "first.md", kind: "markdown", blocks: [] },
        ...(kind === "html" ? [{ path, kind, contentUrl: "/content/key/last.html" }] : [{ path, kind, blocks: [] }]),
      ],
    });
    mount(`/r/${id}`);
    await screen.findByRole("heading", { name: path });
    expect(screen.queryByRole("heading", { name: "first.md" })).toBeNull();
    expect(screen.getByTestId("reading-pane").scrollTop).toBe(0);
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["revision", id, 1] });
    });
    expect(scroll).not.toHaveBeenCalled();
  },
);

test.each(["writeup", "docs", "diff"] as const)("revision change falls back when %s becomes hidden", async (tab) => {
  width = 390;
  newest = 2;
  openingRevision(
    { docs: [{ path: "next.md", kind: "markdown", blocks: [] }] },
    {
      writeupEmpty: false,
      files: [{ ...diffFile, role: "diff", status: "modified", flag: "binary", topic: null }],
      docs: tab === "docs" ? [{ path: "old.md", kind: "markdown", blocks: [] }] : [],
    },
  );
  // The Docs case goes to a writeup-only revision instead.
  if (tab === "docs")
    openingRevision({ writeupEmpty: false }, { docs: [{ path: "old.md", kind: "markdown", blocks: [] }] });
  const { history } = mount(`/r/${id}?rev=1&tab=${tab}`);
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: tab.charAt(0).toUpperCase() + tab.slice(1) }).getAttribute("aria-current"),
    ).toBe("page"),
  );
  // The phone Diff tab hides the header, so navigate via a revision link.
  if (tab === "diff") act(() => history.push(`/r/${id}?rev=2&tab=diff`));
  else await chooseRevision(2);
  await waitFor(() =>
    expect(screen.getByRole("link", { name: tab === "docs" ? "Writeup" : "Docs" }).getAttribute("aria-current")).toBe(
      "page",
    ),
  );
});

test("revision picker keeps the visible opening tab even when no tab was in the URL", async () => {
  newest = 2;
  openingRevision(
    { writeupEmpty: false, docs: [{ path: "next.md", kind: "markdown", blocks: [] }] },
    { docs: [{ path: "old.md", kind: "markdown", blocks: [] }] },
  );
  mount(`/r/${id}?rev=1`);
  await screen.findByRole("heading", { name: "old.md" });
  await chooseRevision(2);
  await screen.findByText("Document not found. Showing all docs.");
  expect(screen.getByRole("link", { name: "next.md next.md" })).toBeTruthy();
  expect(
    screen
      .getByRole(width < 768 ? "link" : "tab", { name: /^Docs(?: \d+)?$/ })
      .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
  ).toBe(width < 768 ? "page" : "true");
});
afterEach(async () => {
  cleanup();
  try {
    localStorage.removeItem("emend:inbox-kind");
  } catch {
    // A test that stubs storage as unavailable has nothing to clear.
  }
  takePairingSecret();
  client.clear();
  // Stop browser tasks before restoring mocks or closing Vitest's logging channel.
  await (window as unknown as Window).happyDOM.abort();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(["127.0.0.1", "localhost", "[::1]", "::1"])(
  "loopback %s shows sign-in instructions without a code form",
  async (host) => {
    (window as unknown as Window).happyDOM.setURL(`http://${host === "::1" ? "[::1]" : host}:3636/pair`);
    if (host === "::1") vi.spyOn(window.location, "hostname", "get").mockReturnValue(host);
    mount("/pair");
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    const instructions = screen.getByText(
      (_, element) => element?.tagName === "P" && element.textContent === signInInstructions,
    );
    expect(instructions.querySelector("code")?.textContent).toBe("emend");
    expect(screen.getByText("emend", { selector: "p" })).toBeTruthy();
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pair" })).toBeNull();
    expect(screen.queryByText(/The app on your home screen/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test.each(["100.64.0.1", "127.0.0.2", "localhost.example"])(
  "remote host %s keeps the pairing code form",
  async (host) => {
    (window as unknown as Window).happyDOM.setURL(`http://${host}:3636/pair`);
    mount("/pair");
    await screen.findByRole("heading", { level: 1, name: "Pair this device" });
    expect(screen.getByLabelText("Pairing code")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pair" })).toBeTruthy();
    expect(
      screen.getByText("The app on your home screen pairs once more with a code, even after Safari has paired."),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
  },
);

test.each(["127.0.0.1", "localhost", "[::1]"])(
  "pair on %s consumes the startup secret once, clears it, and lands on the inbox",
  async (host) => {
    (window as unknown as Window).happyDOM.setURL(`http://${host}:3636/pair`);
    const secret = `emp_${"a".repeat(43)}`;
    rememberPairingSecret(secret);
    fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      expect(location.hash).toBe("");
      if (path === "/api/v1/session") {
        expect(JSON.parse(String(init?.body))).toEqual({ secret });
        return new Response(null, { status: 204 });
      }
      return Response.json({
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date(Date.now()).toISOString(),
        items: [],
      });
    });
    const { history } = mount("/pair");
    await screen.findByRole("heading", { name: "Inbox" });
    expect(takePairingSecret()).toBeUndefined();
    expect(history.location.pathname).toBe("/");
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/v1/session")).toHaveLength(1);
  },
);
test.each([
  [401, "That code did not work. Check it on the hub and try again."],
  [429, "Too many wrong codes. Wait 10 minutes, then try again."],
  [500, "Could not pair. Check your connection and try again."],
])(
  "loopback redemption failure %s keeps the error and sign-in instructions without a code form",
  async (status, message) => {
    (window as unknown as Window).happyDOM.setURL("http://127.0.0.1:3636/pair");
    rememberPairingSecret(`emp_${"f".repeat(43)}`);
    fetchMock.mockResolvedValue(Response.json({ error: { code: "failed", message: "Failed" } }, { status }));
    mount("/pair");
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(
      screen.getByText((_, element) => element?.tagName === "P" && element.textContent === signInInstructions),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pair" })).toBeNull();
    expect(screen.queryByText(/The app on your home screen/)).toBeNull();
  },
);
test.each([
  [401, "That code did not work. Check it on the hub and try again."],
  [429, "Too many wrong codes. Wait 10 minutes, then try again."],
])("pair shows the exact error for status %s", async (status, message) => {
  (window as unknown as Window).happyDOM.setURL("http://100.64.0.1:3636/pair");
  fetchMock.mockResolvedValue(
    Response.json({ error: { code: status === 401 ? "unauthorized" : "rate_limited", message: "Failed" } }, { status }),
  );
  mount("/pair");
  fireEvent.change(await screen.findByLabelText("Pairing code"), { target: { value: "ABCD-EFGH" } });
  fireEvent.click(screen.getByRole("button", { name: "Pair" }));
  expect((await screen.findByRole("alert")).textContent).toBe(message);
});
test("inbox shows the origin and pending Send without a waiting agent", async () => {
  mount();
  expect(await screen.findByText("Workshop")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Not picked up yet" })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Synthetic review/ }).getAttribute("href")).toContain(`/r/${id}`);
});
test("moved inbox rows show the destination host without a navigable link", async () => {
  fetchMock.mockResolvedValue(
    Response.json({
      approvedActiveHours: 12,
      approvedActiveLimit: 5,
      serverTime: new Date(Date.now()).toISOString(),
      items: [{ ...item, movedTo: "https://hub.example/r/new" }],
    }),
  );
  mount();
  expect(await screen.findByText("Moved to hub.example")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
});
test.each([767, 768, 1279, 1280, 390])(
  "review retains tablet panes and mounts only the active phone pane at %s px",
  async (size) => {
    width = size;
    layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
    mount(`/r/${id}`);
    await screen.findByText("Overview");
    expect(screen.getAllByTestId(/-pane$/)).toHaveLength(size >= 1280 ? 3 : size >= 768 ? 2 : 1);
    expect(screen.getAllByTestId(/-pane$/).filter((pane) => !pane.hidden)).toHaveLength(size >= 1280 ? 3 : 1);
    if (size < 768) {
      const tabs = within(screen.getByRole("navigation", { name: "Review tabs" }));
      expect(tabs.getAllByRole("link").map((link) => link.textContent)).toEqual([
        "Writeup",
        "Files 0/1",
        "Docs",
        "Comments",
        "Diff",
      ]);
      fireEvent.click(tabs.getByRole("link", { name: "Diff" }));
      await waitFor(() => expect(screen.getByTestId("diff-pane")).toBeTruthy());
      expect(screen.queryByTestId("reading-pane")).toBeNull();
    }
    if (size >= 768 && size < 1280) {
      fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
      expect(await screen.findByRole("dialog", { name: "Inbox" })).toBeTruthy();
    }
  },
);
test("resizing from desktop to phone replaces three panes with one and phone tabs", async () => {
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(screen.getAllByTestId(/-pane$/)).toHaveLength(3);
  expect(screen.queryByRole("navigation", { name: "Review tabs" })).toBeNull();
  act(() => resize(390));
  expect(screen.getAllByTestId(/-pane$/)).toHaveLength(1);
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  expect(screen.queryByTestId("diff-pane")).toBeNull();
  expect(screen.getByRole("navigation", { name: "Review tabs" })).toBeTruthy();
});
test("publish announces the next revision without switching or refetching the current revision", async () => {
  const { history, unmount } = mount(`/r/${id}`);
  await screen.findByText("Overview");
  newest = 2;
  const before = fetchMock.mock.calls.filter(([path]) => path.endsWith("/revisions/1")).length;
  act(() => {
    Events.opened[0]?.emit("publish", { reviewId: id, revision: 2 });
  });
  expect(await screen.findByText("Revision 2 is ready.")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Revision 1(?: of|,)/ })).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith("/revisions/1"))).toHaveLength(before);
  expect(Events.opened).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  await waitFor(() => expect(history.location.search).toContain("rev=2"));
  await screen.findByRole("button", { name: "Revision 2 of 2" });
  unmount();
  expect(Events.opened[0]?.close).toHaveBeenCalledOnce();
});
test("inbox collapse survives reload and unavailable localStorage", async () => {
  const first = mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  expect(JSON.parse(localStorage.getItem("emend.layout.v1") ?? "{}").inboxCollapsed).toBe(true);
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  first.unmount();
  const second = mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  second.unmount();
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  layoutStore.getSnapshot();
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Storage denied");
    },
    setItem: () => {
      throw new Error("Storage denied");
    },
  });
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
});

test("phone menu copies the complete link and links to devices; header selects revisions", async () => {
  width = 390;
  newest = 2;
  window.history.replaceState(null, "", `/r/${id}?rev=1&tab=comments`);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const { history } = mount(`/r/${id}?rev=1&tab=comments`);
  await screen.findByRole("button", { name: /^Revision 1(?: of|,)/ });
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu", { name: "More" }));
  expect(menu.getByRole("menuitem", { name: "Inbox" }).getAttribute("href")).toBe("/");
  expect(menu.getByRole("menuitem", { name: "Devices" }).getAttribute("href")).toBe("/devices");
  fireEvent.click(menu.getByRole("menuitem", { name: "Copy link" }));
  expect(writeText).toHaveBeenCalledWith(location.origin + location.pathname + location.search);
  expect(await screen.findByText("Link copied")).toBeTruthy();
  expect(screen.queryByRole("menu")).toBeNull();
  await chooseRevision(2);
  await waitFor(() => expect(history.location.search).toContain("rev=2"));
  expect(history.location.search).toContain("tab=comments");
});

test("the phone menu starts with Refresh, which refetches and reconnects without touching drafts", async () => {
  width = 390;
  const draft = draftKey(id, draftTarget);
  localStorage.setItem(draft, "Keep me");
  const { history } = mount(`/r/${id}`);
  await screen.findByRole("button", { name: /^Revision 1(?: of|,)/ });
  await waitFor(() => expect(Events.opened).toHaveLength(1));
  const streams = Events.opened.length;
  const reviewCalls = () => fetchMock.mock.calls.filter(([path]) => path === `/api/v1/reviews/${id}`).length;
  const before = reviewCalls();
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu", { name: "More" }));
  expect(menu.getAllByRole("menuitem")[0]?.textContent).toBe("Refresh");
  fireEvent.click(menu.getByRole("menuitem", { name: "Refresh" }));
  await waitFor(() => expect(Events.opened.length).toBe(streams + 1));
  act(() => Events.opened.at(-1)?.open());
  // The open refresh does the fetching; Refresh adds no second fetch of its own.
  await waitFor(() => expect(reviewCalls()).toBe(before + 1));
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(reviewCalls()).toBe(before + 1);
  expect(localStorage.getItem(draft)).toBe("Keep me");
  expect(history.location.pathname).toBe(`/r/${id}`);
});

// Refresh waits up to three seconds for the new stream to open, and the test stream never does: run
// that wait on a fake clock, then hand the rest back to real timers for Testing Library's polling.
async function clickRefreshWithoutStream() {
  const refresh = within(await screen.findByRole("menu", { name: "More" })).getByRole("menuitem", { name: "Refresh" });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  try {
    fireEvent.click(refresh);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
  } finally {
    vi.useRealTimers();
  }
}

test("Refresh retries a failed immutable file query and skips a loaded one", async () => {
  width = 390;
  mount(`/r/${id}`);
  await screen.findByRole("button", { name: /^Revision 1(?: of|,)/ });
  const failing = vi.fn(async () => {
    throw new Error("offline");
  });
  const failed = new QueryObserver(client, { queryKey: ["file-diff", "bad"], queryFn: failing, retry: false });
  const stopFailed = failed.subscribe(() => {});
  client.setQueryData(["file-diff", "good"], "loaded");
  const loadedFetch = vi.fn(async () => "again");
  const loaded = new QueryObserver(client, {
    queryKey: ["file-diff", "good"],
    queryFn: loadedFetch,
    staleTime: Infinity,
  });
  const stopLoaded = loaded.subscribe(() => {});
  await waitFor(() => expect(failing).toHaveBeenCalledOnce());
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  await clickRefreshWithoutStream();
  await waitFor(() => expect(failing).toHaveBeenCalledTimes(2));
  expect(loadedFetch).not.toHaveBeenCalled();
  stopFailed();
  stopLoaded();
});

test("Refresh refetches by itself when the new stream does not open", async () => {
  width = 390;
  mount(`/r/${id}`);
  await screen.findByRole("button", { name: /^Revision 1(?: of|,)/ });
  await waitFor(() => expect(Events.opened).toHaveLength(1));
  const reviewCalls = () => fetchMock.mock.calls.filter(([path]) => path === `/api/v1/reviews/${id}`).length;
  const before = reviewCalls();
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  await clickRefreshWithoutStream();
  await waitFor(() => expect(reviewCalls()).toBe(before + 1));
});

test("the desktop header has a Refresh button on every page that has the frame", async () => {
  for (const path of ["/", `/r/${id}`, "/devices"]) {
    const prior = Events.opened.length;
    const view = mount(path);
    await screen.findByRole("button", { name: "Refresh" });
    await waitFor(() => expect(Events.opened.length).toBe(prior + 1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(Events.opened.length).toBe(prior + 2));
    act(() => Events.opened.at(-1)?.open());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).not.toBe("true"),
    );
    view.unmount();
    cleanup();
  }
});

test("phone inbox menu offers Devices and Pair a device", async () => {
  width = 390;
  mount();
  await screen.findByRole("heading", { name: "Inbox" });
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu", { name: "More" }));
  expect(menu.getByRole("menuitem", { name: "Devices" }).getAttribute("href")).toBe("/devices");
  expect(menu.getByRole("menuitem", { name: "Pair a device" }).getAttribute("href")).toBe("/devices/pair");
});

test("hides Docs without docs, defaults bad search values, and keeps diff visible on desktop", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  fetchMock.mockImplementation(async (path: string) => {
    if (path.endsWith("/revisions/1")) return Response.json({ ...revision, docs: [] });
    if (path === "/api/v1/reviews")
      return Response.json({
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date(Date.now()).toISOString(),
        items: [item],
      });
    return Response.json({ ...item, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
  });
  const { history } = mount(`/r/${id}?rev=-1&tab=diff&thread=bad`);
  await screen.findByText("Overview");
  expect(screen.queryByRole(width < 768 ? "link" : "tab", { name: /^Docs(?: \d+)?$/ })).toBeNull();
  expect(screen.getByTestId("diff-pane")).toBeTruthy();
  const reading = within(screen.getByRole("tablist", { name: "Reading tabs" }));
  expect(
    reading
      .getByRole(width < 768 ? "link" : "tab", { name: "Writeup" })
      .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
  ).toBe(width < 768 ? "page" : "true");
  fireEvent.click(reading.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ }));
  await waitFor(() => expect(history.location.search).toContain("tab=comments"));
  expect(history.location.search).not.toContain("thread");
  expect(history.location.search).not.toContain("rev=-1");
});

test("one owner stream survives navigation from inbox through review and devices, closing on unmount", async () => {
  const { history, unmount } = mount();
  await screen.findByRole("heading", { name: "Inbox", level: 1 });
  expect(Events.opened).toHaveLength(1);
  expect(Events.opened[0]?.url).toBe("/api/v1/events");
  act(() => history.push(`/r/${id}`));
  await screen.findByText("Overview");
  act(() => history.push("/devices"));
  await screen.findByRole("heading", { name: "Devices" });
  expect(Events.opened).toHaveLength(1);
  expect(Events.opened[0]?.close).not.toHaveBeenCalled();
  unmount();
  expect(Events.opened[0]?.close).toHaveBeenCalledOnce();
});

test("pairing starts the owner stream only after sign-in succeeds", async () => {
  rememberPairingSecret("synthetic-pairing-secret");
  const paired = Promise.withResolvers<Response>();
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((path, init) =>
    path === "/api/v1/session" ? paired.promise : (fallback?.(path, init) as Promise<Response>),
  );
  mount("/pair");
  await screen.findByText("Pairing…");
  expect(Events.opened).toHaveLength(0);
  await act(async () => paired.resolve(new Response(null, { status: 204 })));
  await screen.findByRole("heading", { name: "Inbox", level: 1 });
  expect(Events.opened).toHaveLength(1);
  expect(Events.opened[0]?.url).toBe("/api/v1/events");
});

test("one page load fetches the review payload once when the stream opens during loading", async () => {
  const ready = Promise.withResolvers<void>();
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    await ready.promise;
    return fallback?.(path, init) as Promise<Response>;
  });
  mount(`/r/${id}`);
  await waitFor(() => expect(Events.opened).toHaveLength(1));
  const invalidate = vi.spyOn(client, "invalidateQueries");
  expect(invalidate).not.toHaveBeenCalled();
  act(() => Events.opened[0]?.open());
  ready.resolve();
  await screen.findByText("Overview");
  await waitFor(() => expect(invalidate).toHaveBeenCalledOnce());
  await act(async () => {
    await invalidate.mock.results[0]?.value;
  });
  for (const path of ["/api/v1/reviews", `/api/v1/reviews/${id}`, `/api/v1/reviews/${id}/revisions/1`])
    expect(fetchMock.mock.calls.filter(([url]) => url === path)).toHaveLength(1);
});

test("the first stream open recovers a publication after the initial inbox snapshot", async () => {
  vi.stubGlobal("navigator", {});
  const arrival = { ...item, id: "22222222-2222-4222-8222-222222222222", title: "Published before subscription" };
  let items = [item];
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((path, init) =>
    path === "/api/v1/reviews"
      ? Promise.resolve(
          Response.json({
            approvedActiveHours: 12,
            approvedActiveLimit: 5,
            serverTime: new Date(Date.now()).toISOString(),
            items,
          }),
        )
      : (fallback?.(path, init) as Promise<Response>),
  );
  mount();
  await screen.findByText(item.title);
  expect(screen.queryByText(arrival.title)).toBeNull();
  items = [item, arrival];
  // No event can arrive before subscription; the first open must fetch the missed publication.
  act(() => Events.opened[0]?.open());
  await screen.findByText(arrival.title);
});

test("the first inbox response establishes the baseline even when a stale cache was shown first", async () => {
  const arrival = { ...item, id: "22222222-2222-4222-8222-222222222222", title: "Already present at first response" };
  client.setQueryData<InboxData>(["inbox"], {
    approvedActiveHours: 12,
    approvedActiveLimit: 5,
    serverTime: new Date(Date.now()).toISOString(),
    receivedAt: Date.now(),
    receivedMono: performance.now(),
    items: [item],
  });
  const response = Promise.withResolvers<Response>();
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((path, init) =>
    path === "/api/v1/reviews" ? response.promise : (fallback?.(path, init) as Promise<Response>),
  );
  const { container } = mount();
  await screen.findByText(item.title);
  expect(container.querySelector(".em-inbox-new")).toBeNull();
  await act(async () =>
    response.resolve(
      Response.json({
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date(Date.now()).toISOString(),
        items: [item, arrival],
      }),
    ),
  );
  await screen.findByText(arrival.title);
  expect(container.querySelector(".em-inbox-new")).toBeNull();
});

test("a review published while away highlights once on return, including after a background inbox fetch", async () => {
  const arrival = { ...item, id: "22222222-2222-4222-8222-222222222222", title: "Published while on devices" };
  let items = [item];
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((path, init) =>
    path === "/api/v1/reviews"
      ? Promise.resolve(
          Response.json({
            approvedActiveHours: 12,
            approvedActiveLimit: 5,
            serverTime: new Date(Date.now()).toISOString(),
            items,
          }),
        )
      : (fallback?.(path, init) as Promise<Response>),
  );
  const { history, container } = mount();
  await screen.findByText(item.title);
  expect(container.querySelector(".em-inbox-new")).toBeNull();
  act(() => history.push("/devices"));
  await screen.findByRole("heading", { name: "Devices" });
  items = [item, arrival];
  act(() => Events.opened[0]?.emit("publish", { reviewId: arrival.id, revision: 1 }));
  await act(async () => {
    await client.fetchQuery(inboxQuery());
  });
  act(() => history.push("/"));
  await screen.findByText(arrival.title);
  await waitFor(() =>
    expect(screen.getByText(arrival.title).closest("a")?.classList.contains("em-inbox-new")).toBe(true),
  );
  act(() => history.push("/devices"));
  await screen.findByRole("heading", { name: "Devices" });
  act(() => history.push("/"));
  await screen.findByText(arrival.title);
  expect(container.querySelector(".em-inbox-new")).toBeNull();
});

test("an arrival hidden by a filter consumes its highlight before the filter is cleared", async () => {
  const arrival = { ...item, id: "22222222-2222-4222-8222-222222222222", title: "Hidden arrival" };
  const { container } = mount();
  await screen.findByText(item.title);
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: item.title } });
  vi.useFakeTimers();
  try {
    await act(async () => {
      client.setQueryData<InboxData>(["inbox"], {
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date(Date.now()).toISOString(),
        receivedAt: Date.now(),
        receivedMono: performance.now(),
        items: [item, arrival],
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText(arrival.title)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "" } });
    expect(screen.getByText(arrival.title)).toBeTruthy();
    expect(container.querySelector(".em-inbox-new")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test.each([false, true])(
  "inbox highlights only first-seen arrivals for one second (initially empty: %s)",
  async (empty) => {
    if (empty) {
      const fallback = fetchMock.getMockImplementation();
      fetchMock.mockImplementation((path, init) =>
        path === "/api/v1/reviews"
          ? Promise.resolve(
              Response.json({
                approvedActiveHours: 12,
                approvedActiveLimit: 5,
                serverTime: new Date(Date.now()).toISOString(),
                items: [],
              }),
            )
          : (fallback?.(path, init) as Promise<Response>),
      );
    }
    const { container } = mount();
    if (empty) await screen.findByText("No reviews yet.");
    else await screen.findByText(item.title);
    expect(container.querySelector(".em-inbox-new")).toBeNull();
    const arrival = { ...item, id: "22222222-2222-4222-8222-222222222222", title: "New synthetic review" };
    const initial = empty ? [] : [item];
    vi.useFakeTimers();
    try {
      async function items(values: InboxItem[]) {
        await act(async () => {
          client.setQueryData<InboxData>(["inbox"], {
            approvedActiveHours: 12,
            approvedActiveLimit: 5,
            serverTime: new Date(Date.now()).toISOString(),
            receivedAt: Date.now(),
            receivedMono: performance.now(),
            items: values,
          });
          await vi.advanceTimersByTimeAsync(0);
        });
      }
      await items([...initial, arrival]);
      expect(screen.getByText(arrival.title).closest("a")?.classList.contains("em-inbox-new")).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      await items([...initial, { ...arrival, unsentCount: 3 }]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(499);
      });
      expect(container.querySelectorAll(".em-inbox-new")).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(container.querySelector(".em-inbox-new")).toBeNull();
      await items(initial);
      await items([...initial, arrival]);
      expect(container.querySelector(".em-inbox-new")).toBeNull();
      fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "nothing" } });
      fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "" } });
      expect(container.querySelector(".em-inbox-new")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  },
);

test("review route saves a selected doc span, refreshes its thread, sends it, then enables approval", async () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 100, 200, 20),
  ] as unknown as DOMRectList);
  const block = {
    id: "doc-12345678-12345678",
    section: "doc-12345678",
    kind: "paragraph",
    html: "<p>Plant a seed.</p>",
    text: "Plant a seed.",
  };
  let saved: ThreadView | undefined;
  let sent = false;
  const posts: { path: string; body: unknown }[] = [];
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ path, body });
      if (path.endsWith("/threads"))
        saved = {
          id,
          target: body.target,
          createdOn: 1,
          state: "open",
          placement: {
            status: "placed",
            location: { kind: "doc-span", path: "plan.md", blockId: block.id, start: 8, end: 12 },
          },
          comments: [{ id, body: body.body, author: "user", sent: false, sentOn: null }],
        };
      if (path.endsWith("/sends") && saved) {
        sent = true;
        saved = {
          ...saved,
          state: "sent",
          comments: saved.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 })),
        };
      }
      return Response.json({ threadId: id, commentId: id, sendId: id }, { status: 201 });
    }
    const current = { ...item, unsentCount: saved && !sent ? 1 : 0 };
    if (path === "/api/v1/reviews")
      return Response.json({
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date(Date.now()).toISOString(),
        items: [current],
      });
    if (path.endsWith("/revisions/1"))
      return Response.json({
        ...revision,
        docs: [{ path: "plan.md", kind: "markdown", blocks: [block] }],
        threads: saved ? [saved] : [],
      });
    return Response.json({ ...current, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
  });
  const { container } = mount(`/r/${id}?tab=docs`);
  const paragraph = await screen.findByText("Plant a seed.");
  const node = paragraph.firstChild;
  const selection = window.getSelection();
  if (!node || !selection) throw new Error("Missing selection fixture");
  const range = document.createRange();
  range.setStart(node, 8);
  range.setEnd(node, 12);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(paragraph);
  fireEvent.click(screen.getByRole("button", { name: "Comment on selection" }));
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Explain the seed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull());
  fireEvent.click(await screen.findByRole("button", { name: "1 comment" }));
  expect(within(screen.getByRole("dialog", { name: "Comment thread" })).getByText("Explain the seed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(posts[0]).toEqual({
    path: `/api/v1/reviews/${id}/threads`,
    body: {
      revision: 1,
      target: { kind: "doc-span", path: "plan.md", blockId: block.id, quote: "seed", prefix: "Plant a ", suffix: "." },
      body: "Explain the seed",
    },
  });
  await screen.findByText("1 unsent comment");
  expect((screen.getByRole("button", { name: /^Approve/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText(/No agent has picked this up yet/);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByText(/No agent has picked this up yet/)).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "1 comment" }));
  expect(within(screen.getByRole("dialog", { name: "Comment thread" })).getByText("Sent")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect((screen.getByRole("button", { name: /^Approve/ }) as HTMLButtonElement).disabled).toBe(false);
  expect(
    container
      .querySelector('[aria-label="Send and approve"]')
      ?.previousElementSibling?.contains(screen.getByTestId("diff-pane")),
  ).toBe(true);
});

const draftBlock: RenderedBlock = {
  id: "overview-12345678",
  section: "overview",
  kind: "paragraph",
  text: "Plant a seed.",
  html: "<p>Plant a seed.</p>",
};
const draftTarget: Target = {
  kind: "writeup-span",
  blockId: draftBlock.id,
  quote: "seed",
  prefix: "Plant a ",
  suffix: ".",
};
function withDraftBlock() {
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.includes("/revisions/"))
      return Response.json({
        ...revision,
        writeup: { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [draftBlock] }] },
      });
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
}
function selectSeed() {
  const paragraph = screen.getByText("Plant a seed.");
  const node = paragraph.firstChild;
  const selection = window.getSelection();
  if (!node || !selection) throw new Error("Missing selection fixture");
  const range = document.createRange();
  range.setStart(node, 8);
  range.setEnd(node, 12);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(paragraph);
  selection.removeAllRanges();
  fireEvent.click(screen.getByRole("button", { name: "Comment on selection" }));
}
test("reload discovers drafts without a supplied target; Resume restores text and scrolls, Discard removes", async () => {
  withDraftBlock();
  const first = mount(`/r/${id}`);
  await screen.findByText("Plant a seed.");
  selectSeed();
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Recover after reload" } });
  first.unmount();
  client.clear();
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const second = mount(`/r/${id}?tab=comments`);
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  expect(drafts.getByText("Recover after reload")).toBeTruthy();
  fireEvent.click(drafts.getByRole("button", { name: "Resume" }));
  expect(((await screen.findByLabelText("Comment")) as HTMLTextAreaElement).value).toBe("Recover after reload");
  await waitFor(() =>
    expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === `block-${draftBlock.id}`)).toBe(true),
  );
  second.unmount();
  client.clear();
  mount(`/r/${id}?tab=comments`);
  const restored = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  fireEvent.click(restored.getByRole("button", { name: "Discard" }));
  expect(localStorage.getItem(draftKey(id, draftTarget))).toBeNull();
  expect(screen.queryByRole("region", { name: "Unsaved comments" })).toBeNull();
});
test("unreadable draft targets offer only Discard and other reviews' drafts stay hidden", async () => {
  const key = `emend.draft.${id}.not-json`;
  localStorage.setItem(key, "Unreadable draft");
  localStorage.setItem(draftKey("22222222-2222-4222-8222-222222222222", draftTarget), "Other review");
  mount(`/r/${id}?tab=comments`);
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  expect(drafts.queryByRole("button", { name: "Resume" })).toBeNull();
  expect(drafts.getAllByRole("button", { name: "Discard" })).toHaveLength(1);
  fireEvent.click(drafts.getByRole("button", { name: "Discard" }));
  expect(localStorage.getItem(key)).toBeNull();
});
test("saved reply clears before delayed metadata while revision refresh regroups its composer", async () => {
  let saved = false;
  const metadata = Promise.withResolvers<Response>();
  const thread: ThreadView = {
    id,
    target: draftTarget,
    createdOn: 1,
    state: "sent",
    placement: { status: "placed", location: { kind: "writeup-span", blockId: draftBlock.id, start: 8, end: 12 } },
    comments: [{ id, author: "user", body: "Earlier comment", sent: true, sentOn: 1 }],
  };
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      saved = true;
      return Response.json({ commentId: id }, { status: 201 });
    }
    if (path === "/api/v1/reviews")
      return Response.json({
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date(Date.now()).toISOString(),
        items: [item],
      });
    if (path.includes("/revisions/"))
      return Response.json({
        ...revision,
        threads: [
          {
            ...thread,
            state: saved ? "open" : "sent",
            comments: saved
              ? [
                  ...thread.comments,
                  {
                    id: "22222222-2222-4222-8222-222222222222",
                    author: "user",
                    body: "Saved reply",
                    sent: false,
                    sentOn: null,
                  },
                ]
              : thread.comments,
          },
        ],
      });
    if (saved) return metadata.promise;
    return Response.json({ ...item, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
  });
  mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  const original = await screen.findByLabelText("Reply");
  fireEvent.change(original, { target: { value: "Saved reply" } });
  const key = `${draftKey(id, draftTarget)}.reply.${id}`;
  expect(localStorage.getItem(key)).toBe("Saved reply");
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  try {
    await screen.findByText("Saved reply", { selector: "p" });
    await waitFor(() => expect(original.isConnected).toBe(false));
    expect(localStorage.getItem(key)).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
  } finally {
    metadata.resolve(Response.json({ ...item, revisions: [{ seq: 1, createdAt: item.updatedAt }] }));
  }
});
test.each(["Send", "Approve"])(
  "%s waits for the delayed revision on screen and instructions survive",
  async (action) => {
    newest = 2;
    const delayed = Promise.withResolvers<Response>();
    const fallback = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/revisions/2")) return delayed.promise;
      if (init?.method === "POST") return Response.json({ sendId: id }, { status: 201 });
      if (path === `/api/v1/reviews/${id}`)
        return Response.json({
          ...item,
          unsentCount: 0,
          newestRevision: 2,
          revisions: [1, 2].map((seq) => ({ seq, createdAt: item.updatedAt })),
        });
      if (!fallback) throw new Error("Missing fetch fixture");
      return fallback(path, init);
    });
    mount(`/r/${id}?rev=1`);
    await screen.findByText("Overview");
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Keep these instructions" } });
    await chooseRevision(2);
    try {
      await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.endsWith("/revisions/2"))).toBe(true));
      const sendBar = within(screen.getByRole("region", { name: "Send and approve" }));
      for (const name of [/^Send/, /^Approve/]) {
        const button = sendBar.getByRole("button", { name }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
      }
      expect(sendBar.getByText("Loading revision…")).toBeTruthy();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
      expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep these instructions");
    } finally {
      delayed.resolve(Response.json({ ...revision, seq: 2 }));
    }
    await waitFor(() => expect(screen.queryByText("Loading revision…")).toBeNull());
    expect(screen.getByText("Overview")).toBeTruthy();
    expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep these instructions");
    for (const name of [/^Send/, /^Approve/])
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${action}`) }));
    // Approving asks first.
    if (action === "Approve")
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/reviews/${id}/sends`,
        expect.objectContaining({
          body: JSON.stringify(
            action === "Approve"
              ? { revision: 2, kind: "approve" }
              : { revision: 2, kind: "go", mode: "fix-clear", instruction: "Keep these instructions" },
          ),
        }),
      ),
    );
  },
);
test("failed revision disables Send and Approve with a reason, preserving instructions through retry", async () => {
  newest = 2;
  let failed = true;
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/revisions/2") && failed)
      return Response.json({ error: { code: "internal", message: "Synthetic failure" } }, { status: 500 });
    if (path === `/api/v1/reviews/${id}`)
      return Response.json({
        ...item,
        unsentCount: 0,
        newestRevision: 2,
        revisions: [1, 2].map((seq) => ({ seq, createdAt: item.updatedAt })),
      });
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
  mount(`/r/${id}?rev=1`);
  await screen.findByText("Overview");
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Keep through failure" } });
  await chooseRevision(2);
  await screen.findByRole("button", { name: "Retry" });
  const sendBar = within(screen.getByRole("region", { name: "Send and approve" }));
  expect(sendBar.getByText("Could not load this revision.")).toBeTruthy();
  for (const name of [/^Send/, /^Approve/])
    expect((sendBar.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep through failure");
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Overview");
  for (const name of [/^Send/, /^Approve/])
    expect((sendBar.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep through failure");
});
test("unplaced thread navigates through the router to its original revision", async () => {
  newest = 2;
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.includes("/revisions/"))
      return Response.json({
        ...revision,
        seq: Number(path.split("/").at(-1)),
        threads: [
          {
            id,
            target: draftTarget,
            createdOn: 1,
            state: "open",
            placement: { status: "unplaced", reason: "block-gone" },
            comments: [],
          },
        ],
      });
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
  const { history } = mount(`/r/${id}?rev=2&tab=comments`);
  fireEvent.click(await screen.findByRole("link", { name: "revision 1" }));
  await waitFor(() => expect(history.location.search).toContain("rev=1"));
  expect(history.location.search).toContain(`thread=${id}`);
  expect(history.location.hash).toBe(`#thread-${id}`);
});

test("resuming a placed reply focuses its single thread composer and save clears Follow-up", async () => {
  let saved = false;
  const thread: ThreadView = {
    id,
    target: draftTarget,
    createdOn: 1,
    state: "open",
    placement: { status: "placed", location: { kind: "writeup-span", blockId: draftBlock.id, start: 8, end: 12 } },
    comments: [],
  };
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      saved = true;
      return Response.json({ commentId: id }, { status: 201 });
    }
    if (path.includes("/revisions/"))
      return Response.json({
        ...revision,
        writeup: { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [draftBlock] }] },
        threads: [
          { ...thread, comments: saved ? [{ id, author: "user", body: "Follow-up", sent: false, sentOn: null }] : [] },
        ],
      });
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
  localStorage.setItem(draftKey(id, draftTarget, id), "Follow-up");
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history } = mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(screen.getAllByLabelText("Reply")).toHaveLength(1));
  const reply = screen.getByLabelText("Reply") as HTMLTextAreaElement;
  expect(reply.value).toBe("Follow-up");
  expect(screen.queryByRole("region", { name: "Resumed comment" })).toBeNull();
  await waitFor(() => expect(history.location.search).toContain(`thread=${id}`));
  expect(history.location.search).toContain("tab=comments");
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === `thread-${id}`)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await screen.findByText("Follow-up", { selector: "p" });
  expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
  expect(localStorage.getItem(draftKey(id, draftTarget, id))).toBeNull();
});

function queriesIdle() {
  if (client.isFetching() === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = client.getQueryCache().subscribe(() => {
      if (client.isFetching() === 0) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function navigationFixture({ cold = false, threads = true, unplaced = false } = {}) {
  let refresh = 0;
  const delayed = cold ? Promise.withResolvers<Response>() : undefined;
  const thread: ThreadView = {
    id,
    target: draftTarget,
    createdOn: 1,
    state: "open",
    placement: unplaced
      ? { status: "unplaced", reason: "block-gone" }
      : { status: "placed", location: { kind: "writeup-span", blockId: draftBlock.id, start: 8, end: 12 } },
    comments: [],
  };
  const current = () => ({
    ...revision,
    writeup: { sections: [{ key: "overview", label: `Overview ${refresh}`, topic: null, blocks: [draftBlock] }] },
    threads: threads
      ? [{ ...thread, comments: [{ id, author: "user", body: `Comment ${refresh}`, sent: false, sentOn: null }] }]
      : [],
  });
  const fallback = fetchMock.getMockImplementation();
  let requests = 0;
  let requested = Promise.withResolvers<void>();
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/revisions/1")) {
      requests++;
      requested.resolve();
      if (requests === 1 && delayed) return delayed.promise;
      return Response.json(current());
    }
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
  return {
    resolve: () => delayed?.resolve(Response.json(current())),
    async update() {
      refresh++;
      const before = requests;
      requested = Promise.withResolvers<void>();
      await act(async () => {
        Events.opened[0]?.emit("thread", { reviewId: id, revision: 1, threadId: id });
        await requested.promise;
        expect(requests).toBeGreaterThan(before);
        await queriesIdle();
        expect(client.isFetching()).toBe(0);
      });
      expect(
        client.getQueryData<{ writeup: { sections: { label: string }[] } }>(["revision", id, 1])?.writeup.sections[0]
          ?.label,
      ).toBe(`Overview ${refresh}`);
    },
  };
}

const htmlTarget: Target = { kind: "html-span", path: "seed.html", quote: "seed", prefix: "", suffix: "" };
function htmlReviewFixture(
  placement: ThreadView["placement"] = {
    status: "placed",
    location: { kind: "html-span", path: "seed.html", start: 0, end: 4 },
  },
  doc: "html" | "markdown" | "missing" = "html",
) {
  const thread: ThreadView = { id, target: htmlTarget, createdOn: 1, state: "open", comments: [], placement };
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path.includes("/revisions/")
      ? Response.json({
          ...revision,
          seq: Number(path.split("/").at(-1)),
          docs:
            doc === "missing"
              ? []
              : doc === "markdown"
                ? [{ kind: "markdown", path: "seed.html", blocks: [] }]
                : [{ kind: "html", path: "seed.html", contentUrl: "/content/synthetic/seed.html" }],
          threads: [thread],
        })
      : (fallback?.(path, init) ?? Response.error()),
  );
  return thread;
}

test.each(["resume", "thread", "hash-link"])(
  "an unplaced HTML %s opens Comments and its reply composer",
  async (kind) => {
    htmlReviewFixture({ status: "unplaced", reason: "block-gone" });
    localStorage.setItem(draftKey(id, htmlTarget, id), "Unplaced HTML reply");
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { history, container } = mount(
      `/r/${id}?${kind === "resume" ? "tab=comments" : kind === "thread" ? `thread=${id}` : `tab=docs#thread-${id}`}`,
    );
    if (kind === "resume") fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(history.location.search).toContain("tab=comments"));
    const reply = await screen.findByLabelText("Reply");
    await waitFor(() => expect(document.activeElement).toBe(reply));
    expect((reply as HTMLTextAreaElement).value).toBe("Unplaced HTML reply");
    expect(within(screen.getByRole("region", { name: "Unplaced" })).getByLabelText("Reply")).toBe(reply);
    expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === `thread-${id}`)).toBe(true);
    expect(container.querySelector("iframe")).toBeNull();
  },
);

test.each(["missing", "markdown"] as const)("HTML placement on a %s doc routes to Comments", async (doc) => {
  htmlReviewFixture(undefined, doc);
  const { history } = mount(`/r/${id}?thread=${id}`);
  await waitFor(() => expect(history.location.search).toContain("tab=comments"));
  expect(await screen.findByLabelText("Reply")).toBeTruthy();
});

test.each([
  [1280, "Comments"],
  [1280, "Writeup"],
  [390, "Comments"],
  [390, "Writeup"],
] as const)("an incoming HTML thread does not override a later tab choice at %s: %s", async (pixels, tab) => {
  width = pixels;
  htmlReviewFixture();
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history, container } = mount(`/r/${id}?thread=${id}`);
  await waitFor(() => expect(history.location.search).toContain("tab=docs"));
  await waitFor(() =>
    expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === "html-doc-seed.html")).toBe(true),
  );
  const link = screen.getByRole(width < 768 ? "link" : "tab", { name: new RegExp(tab) });
  if (width < 768) expect(new URL((link as HTMLAnchorElement).href).searchParams.has("thread")).toBe(false);
  fireEvent.click(link);
  await waitFor(() => expect(history.location.search).toContain(`tab=${tab.toLowerCase()}`));
  expect(history.location.search).not.toContain("thread=");
  expect(history.location.hash).toBe("");
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["revision", id, 1] });
  });
  expect(
    screen
      .getByRole(width < 768 ? "link" : "tab", { name: new RegExp(tab) })
      .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
  ).toBe(width < 768 ? "page" : "true");
  expect(container.querySelector("iframe")).toBeNull();
});

test.each([false, true])(
  "an HTML thread link waits for a missing cached thread unless the reviewer picks Comments (switch=%s)",
  async (switchTab) => {
    const thread = htmlReviewFixture();
    const cached = {
      ...revision,
      docs: [{ kind: "html", path: "seed.html", contentUrl: "/content/synthetic/seed.html" }],
    };
    client.setQueryData(["revision", id, 1], cached);
    await client.invalidateQueries({ queryKey: ["revision", id, 1], refetchType: "none" });
    const response = Promise.withResolvers<Response>();
    const fallback = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((path, init) =>
      path.endsWith("/revisions/1") ? response.promise : (fallback?.(path, init) ?? Promise.resolve(Response.error())),
    );
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { history, container } = mount(`/r/${id}?thread=${id}`);
    await screen.findByRole(width < 768 ? "link" : "tab", { name: "Writeup" });
    await waitFor(() => expect(client.isFetching({ queryKey: ["revision", id, 1] })).toBe(1));
    expect(container.querySelector("iframe")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    if (switchTab) {
      fireEvent.click(screen.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ }));
      await waitFor(() => expect(history.location.search).toContain("tab=comments"));
      expect(history.location.search).not.toContain("thread=");
    }
    await act(async () => {
      response.resolve(Response.json({ ...cached, threads: [thread] }));
      await queriesIdle();
      expect(client.isFetching()).toBe(0);
    });
    if (switchTab) {
      expect(history.location.search).toContain("tab=comments");
      expect(
        screen
          .getByRole(width < 768 ? "link" : "tab", { name: /Comments/ })
          .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
      ).toBe(width < 768 ? "page" : "true");
      expect(container.querySelector("iframe")).toBeNull();
      expect(scroll).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(history.location.search).toContain("tab=docs"));
      expect(container.querySelector('iframe[title="seed.html"]')).not.toBeNull();
      await waitFor(() =>
        expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === "html-doc-seed.html")).toBe(true),
      );
      fireEvent.click(screen.getByRole("button", { name: "Comments (1)" }));
    }
    await waitFor(() => expect(document.getElementById(`thread-${id}`)).not.toBeNull());
  },
);

test("a consumed HTML navigation does not redirect or refocus when placement changes", async () => {
  const thread = htmlReviewFixture({ status: "unplaced", reason: "block-gone" });
  const { history, container } = mount(`/r/${id}?tab=comments&thread=${id}`);
  const reply = await screen.findByLabelText("Reply");
  await waitFor(() => expect(document.activeElement).toBe(reply));
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  thread.placement = { status: "placed", location: { kind: "html-span", path: "seed.html", start: 0, end: 4 } };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["revision", id, 1] });
  });
  expect(history.location.search).toContain("tab=comments");
  expect(container.querySelector("iframe")).toBeNull();
  expect(document.activeElement).toBe(instructions);
});

test.each(
  [390, 1280].flatMap((pixels) => ["thread", "draft", "reply", "comment-link"].map((kind) => ({ pixels, kind }))),
)(
  "HTML $kind navigation opens docs and waits for the frame before scrolling at $pixels px",
  async ({ kind, pixels }) => {
    width = pixels;
    const target: Target = { kind: "html-span", path: "seed.html", quote: "seed", prefix: "", suffix: "" };
    const thread: ThreadView = {
      id,
      target,
      createdOn: 1,
      state: "open",
      comments: [],
      placement: { status: "placed", location: { kind: "html-span", path: "seed.html", start: 0, end: 4 } },
    };
    const fallback = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (path, init) =>
      path.endsWith("/revisions/1")
        ? Response.json({
            ...revision,
            docs: [{ kind: "html", path: "seed.html", contentUrl: "/content/synthetic/seed.html" }],
            threads: [thread],
          })
        : (fallback?.(path, init) ?? Response.error()),
    );
    if (kind === "draft" || kind === "reply")
      localStorage.setItem(draftKey(id, target, kind === "reply" ? id : undefined), "HTML draft");
    const { history, container } = mount(
      `/r/${id}?${kind === "thread" ? `thread=${id}` : kind === "comment-link" ? `tab=comments&thread=${id}` : "tab=comments"}`,
    );
    if (kind === "draft" || kind === "reply") fireEvent.click(await screen.findByText("Resume"));
    await waitFor(() => expect(container.querySelector('iframe[title="seed.html"]')).not.toBeNull());
    expect(history.location.search).toContain("tab=docs");
    const frame = container.querySelector('iframe[title="seed.html"]') as HTMLIFrameElement;
    const post = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
    expect(post).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { type: "emend:ready" } }));
    });
    if (kind !== "draft") expect(post).toHaveBeenCalledWith({ type: "emend:scroll", threadId: id }, "*");
    if (kind === "draft" || kind === "reply")
      expect(
        ((await screen.findByRole("textbox", { name: kind === "reply" ? "Reply" : "Comment" })) as HTMLTextAreaElement)
          .value,
      ).toBe("HTML draft");
  },
);

test("reply Resume focuses once; a thread SSE update leaves focus in Instructions", async () => {
  const fixture = navigationFixture();
  localStorage.setItem(draftKey(id, draftTarget, id), "Follow-up");
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history } = mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(history.location.search).toContain(`thread=${id}`));
  const reply = screen.getByLabelText("Reply");
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect(scroll).toHaveBeenCalledTimes(1);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  scroll.mockClear();
  await fixture.update();
  expect(document.activeElement).toBe(instructions);
  expect(focus).not.toHaveBeenCalled();
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect(focus).toHaveBeenCalledTimes(1);
  expect(scroll).toHaveBeenCalledTimes(1);
});

test("a resumed span draft scrolls to its block once, including after thread SSE updates", async () => {
  const fixture = navigationFixture({ threads: false });
  localStorage.setItem(draftKey(id, draftTarget), "Span draft");
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await screen.findByText("Plant a seed.");
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
  const blockScroll = scroll.mock.instances.findIndex((node) => (node as HTMLElement).id === `block-${draftBlock.id}`);
  expect(blockScroll).toBeGreaterThanOrEqual(0);
  expect(scroll.mock.calls[blockScroll]).toEqual([{ block: "center" }]);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  expect(scroll.mock.calls).toContainEqual([{ block: "nearest" }]);
  await fixture.update();
  expect(scroll).toHaveBeenCalledTimes(2);
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(instructions);
});

test("a cold hash link scrolls once and a thread SSE update does not scroll it again", async () => {
  const fixture = navigationFixture({ cold: true, threads: false });
  const path = `/r/${id}?tab=writeup#block-${draftBlock.id}`;
  window.history.replaceState(null, "", path);
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mount(path);
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.endsWith("/revisions/1"))).toBe(true));
  expect(scroll).not.toHaveBeenCalled();
  await act(async () => fixture.resolve());
  await screen.findByText("Plant a seed.");
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
  expect((scroll.mock.instances[0] as HTMLElement).id).toBe(`block-${draftBlock.id}`);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await fixture.update();
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(focus).not.toHaveBeenCalled();
});

test("a cold thread link focuses its reply once after loading and never on an SSE refetch", async () => {
  const fixture = navigationFixture({ cold: true });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mount(`/r/${id}?tab=comments&thread=${id}`);
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.endsWith("/revisions/1"))).toBe(true));
  expect(scroll).not.toHaveBeenCalled();
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await act(async () => fixture.resolve());
  const reply = await screen.findByLabelText("Reply");
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect(focus).toHaveBeenCalledTimes(1);
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(scroll.mock.calls[0]).toEqual([{ block: "center" }]);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  focus.mockClear();
  await fixture.update();
  expect(document.activeElement).toBe(instructions);
  expect(focus).not.toHaveBeenCalled();
  expect(scroll).toHaveBeenCalledTimes(1);
});

test("changing the hash on a loaded revision creates one new intent, unaffected by SSE", async () => {
  const fixture = navigationFixture({ threads: false });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const windowScroll = vi.fn();
  vi.stubGlobal("scrollTo", windowScroll);
  const { history } = mount(`/r/${id}?tab=writeup`);
  await screen.findByText("Plant a seed.");
  expect(scroll).not.toHaveBeenCalled();
  expect(windowScroll).not.toHaveBeenCalled();
  await act(async () => history.push(`/r/${id}?tab=writeup#block-${draftBlock.id}`));
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
  await fixture.update();
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(windowScroll).not.toHaveBeenCalled();
});

test("resuming a thread again creates one new intent, unaffected by SSE", async () => {
  const fixture = navigationFixture({ unplaced: true });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  localStorage.setItem(draftKey(id, draftTarget, id), "Resume twice");
  mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  const reply = screen.getByLabelText("Reply");
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect(scroll).toHaveBeenCalledTimes(1);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await fixture.update();
  expect(document.activeElement).toBe(instructions);
  expect(focus).not.toHaveBeenCalled();
  expect(scroll).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect(focus).toHaveBeenCalledTimes(1);
  expect(scroll).toHaveBeenCalledTimes(2);
});

test("Inbox to Devices and Back keeps the router's default uncached scrolling", async () => {
  const scroll = vi.fn();
  vi.stubGlobal("scrollTo", scroll);
  vi.stubGlobal("scrollX", 0);
  vi.stubGlobal("scrollY", 0);
  const { history } = mount();
  await screen.findByRole("heading", { name: "Inbox" });
  await waitFor(() => expect(scroll).toHaveBeenCalledWith({ top: 0, left: 0, behavior: undefined }));
  vi.stubGlobal("scrollY", 240);
  fireEvent.scroll(document);
  scroll.mockClear();
  fireEvent.click(screen.getByRole("link", { name: "Devices" }));
  await screen.findByRole("heading", { name: "Devices" });
  await waitFor(() => expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 0, left: 0, behavior: undefined }));
  vi.stubGlobal("scrollY", 0);
  scroll.mockClear();
  await act(async () => history.back());
  await screen.findByRole("heading", { name: "Inbox" });
  await waitFor(() => expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 0, left: 0, behavior: undefined }));
});

const diffTarget: Target = { kind: "file", path: "new.txt" };
const diffThread: ThreadView = {
  id,
  target: diffTarget,
  createdOn: 1,
  state: "open",
  placement: { status: "placed", location: diffTarget },
  comments: [{ id, author: "user", body: "Diff thread", sent: false, sentOn: null }],
};
function withDiff(threads: ThreadView[] = [diffThread], file: Partial<FileView> = {}) {
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path.includes("/revisions/")
      ? Response.json({
          ...revision,
          files: [{ ...diffFile, ...file }],
          topics: [{ slug: "topic", title: "Topic", summary: "", importance: 1 }],
          threads,
        })
      : (fallback?.(path, init) as Promise<Response>),
  );
}
test("Resume claims the Comments reply from the diff, focuses it and keeps thread ids unique", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  withDiff([
    { ...diffThread, comments: diffThread.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 })) },
  ]);
  mount(`/r/${id}`);
  const diff = within(await screen.findByTestId("diff-pane"));
  fireEvent.click(await diff.findByRole("button", { name: "Reply" }));
  const input = await diff.findByLabelText("Reply");
  input.focus();
  fireEvent.change(input, { target: { value: "Follow-up" } });
  fireEvent.click(screen.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ }));
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  fireEvent.click(drafts.getByRole("button", { name: "Resume" }));
  const reading = within(screen.getByTestId("reading-pane"));
  const reply = await reading.findByLabelText("Reply");
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect((reply as HTMLTextAreaElement).value).toBe("Follow-up");
  expect(diff.queryByLabelText("Reply")).toBeNull();
  expect(diff.getByRole("button", { name: "Reply" })).toBeTruthy();
  expect(document.getElementById(`thread-${id}`)).toBeTruthy();
  expect(document.getElementById(`diff-thread-${id}`)).toBeTruthy();
  const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
  expect(new Set(ids).size).toBe(ids.length);
  fireEvent.focus(diff.getByRole("button", { name: "Reply" }));
  const reclaimed = await diff.findByLabelText("Reply");
  await waitFor(() => expect(document.activeElement).toBe(reclaimed));
  expect((reclaimed as HTMLTextAreaElement).value).toBe("Follow-up");
  expect(reading.queryByLabelText("Reply")).toBeNull();
  expect(reading.getByRole("button", { name: "Reply" })).toBeTruthy();
});
test("Resume of a lines draft opens the phone Diff tab and focuses its file composer", async () => {
  width = 390;
  withDiff([], { flag: null, hasNew: true });
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((path, init) =>
    path.startsWith("/api/v1/files/") ? new Promise<Response>(() => {}) : (fallback?.(path, init) as Promise<Response>),
  );
  const target: Target = {
    kind: "lines",
    path: "new.txt",
    side: "new",
    start: 10,
    end: 12,
    lines: ["a", "b", "c"],
    before: [],
    after: [],
  };
  localStorage.setItem(draftKey(id, target), "Line draft");

  const { history } = mount(`/r/${id}?tab=comments`);
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  fireEvent.click(drafts.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(history.location.search).toContain("tab=diff"));
  const section = await screen.findByRole("region", { name: "File new.txt", hidden: true });
  const input = await within(await screen.findByRole("dialog", { name: "New comment" })).findByLabelText("Comment");
  expect((input as HTMLTextAreaElement).value).toBe("Line draft");
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(section.contains(input)).toBe(false);
  expect(screen.queryByRole("region", { name: "Resumed comment" })).toBeNull();
});
test("a delayed diff reply save cannot clear newer text after Comments claims the key", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  withDiff([
    { ...diffThread, comments: diffThread.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 })) },
  ]);
  const fallback = fetchMock.getMockImplementation();
  let finish = () => {};
  const submitted: string[] = [];
  fetchMock.mockImplementation((path, init) => {
    if (path === `/api/v1/threads/${id}/comments` && init?.method === "POST") {
      submitted.push(String(init.body));
      if (submitted.length === 1)
        return new Promise<Response>((resolve) => {
          finish = () => resolve(Response.json({}));
        });
      return Promise.resolve(Response.json({}));
    }
    return fallback?.(path, init) as Promise<Response>;
  });
  mount(`/r/${id}`);
  const diff = within(await screen.findByTestId("diff-pane"));
  fireEvent.click(await diff.findByRole("button", { name: "Reply" }));
  const input = await diff.findByLabelText("Reply");
  act(() => input.focus());
  fireEvent.change(input, { target: { value: "First reply" } });
  fireEvent.click(diff.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(submitted).toHaveLength(1));
  fireEvent.click(screen.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ }));
  fireEvent.click(
    within(await screen.findByRole("region", { name: "Unsaved comments" })).getByRole("button", { name: "Resume" }),
  );
  const reading = within(screen.getByTestId("reading-pane"));
  const editor = (await reading.findByLabelText("Reply")) as HTMLTextAreaElement;
  expect((reading.getByRole("button", { name: "Save comment" }) as HTMLButtonElement).disabled).toBe(true);
  expect(editor.disabled).toBe(false);
  fireEvent.change(editor, { target: { value: "Second unsent reply" } });
  await act(async () => finish());
  await waitFor(() =>
    expect((reading.getByRole("button", { name: "Save comment" }) as HTMLButtonElement).disabled).toBe(false),
  );
  expect(editor.value).toBe("Second unsent reply");
  expect(localStorage.getItem(draftKey(id, diffTarget, id))).toBe("Second unsent reply");
  fireEvent.click(reading.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(submitted).toEqual([
      JSON.stringify({ body: "First reply" }),
      JSON.stringify({ body: "Second unsent reply" }),
    ]),
  );
  await waitFor(() => expect(reading.queryByRole("textbox", { name: "Reply" })).toBeNull());
});
test("a pending edit resumes in Comments and a completed PATCH preserves newer edit text", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  withDiff();
  const fallback = fetchMock.getMockImplementation();
  let finish = () => {};
  const submitted: string[] = [];
  fetchMock.mockImplementation((path, init) => {
    if (path === `/api/v1/comments/${id}` && init?.method === "PATCH") {
      submitted.push(String(init.body));
      if (submitted.length === 1)
        return new Promise<Response>((resolve) => {
          finish = () => resolve(Response.json({}));
        });
      return Promise.resolve(Response.json({}));
    }
    return fallback?.(path, init) as Promise<Response>;
  });
  mount(`/r/${id}`);
  const diff = within(await screen.findByTestId("diff-pane"));
  fireEvent.click(await diff.findByRole("button", { name: "Edit" }));
  fireEvent.change(diff.getByLabelText("Edit comment"), { target: { value: "First edit" } });
  fireEvent.click(diff.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(submitted).toHaveLength(1));
  fireEvent.click(screen.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ }));
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  expect(drafts.getByText("Unsaved edit")).toBeTruthy();
  fireEvent.click(drafts.getByRole("button", { name: "Resume" }));
  const reading = within(screen.getByTestId("reading-pane"));
  const input = (await reading.findByLabelText("Edit comment")) as HTMLTextAreaElement;
  expect(document.activeElement).toBe(input);
  expect((reading.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "Second unsent edit" } });
  await act(async () => finish());
  await waitFor(() =>
    expect((reading.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false),
  );
  expect(input.value).toBe("Second unsent edit");
  expect(localStorage.getItem(editDraftKey(id, id))).toBe("Second unsent edit");
  fireEvent.click(reading.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(localStorage.getItem(editDraftKey(id, id))).toBeNull());
  expect(submitted).toEqual([JSON.stringify({ body: "First edit" }), JSON.stringify({ body: "Second unsent edit" })]);
});

test.each(
  [390, 1280].flatMap((size) =>
    (["file", "topic"] as const).flatMap((kind) =>
      (["save", "cancel", "discard"] as const).map((end) => ({ size, kind, end })),
    ),
  ),
)("resumed $kind draft keeps empty Diff visible at $size px until $end", async ({ size, kind, end }) => {
  width = size;
  openingRevision({
    writeupEmpty: false,
    topics: [{ slug: "retained", title: "Retained", importance: 1, summary: "" }],
  });
  const target: Target = kind === "file" ? { kind, path: "removed.ts" } : { kind, slug: "retained" };
  const key = draftKey(id, target);
  localStorage.setItem(key, "Resume this draft");
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((path, init) =>
    init?.method === "POST" ? Promise.resolve(Response.json({})) : (fallback?.(path, init) as Promise<Response>),
  );
  const { history } = mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  const pane = await screen.findByTestId("diff-pane");
  const composer = within(size === 390 ? await screen.findByRole("dialog", { name: "New comment" }) : pane);
  const editor = (await composer.findByLabelText("Comment")) as HTMLTextAreaElement;
  expect(editor.value).toBe("Resume this draft");
  await waitFor(() => expect(document.activeElement).toBe(editor));
  if (size === 390) expect(history.location.search).toContain("tab=diff");
  // Deleting the draft's text while editing does not mean Discard.
  fireEvent.change(editor, { target: { value: "" } });
  expect(screen.getByTestId("diff-pane")).toBe(pane);
  fireEvent.change(editor, { target: { value: "Resume this draft" } });
  if (end === "discard") {
    if (size === 390) fireEvent.click(composer.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ }));
    const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
    fireEvent.click(drafts.getByRole("button", { name: "Discard" }));
  } else fireEvent.click(composer.getByRole("button", { name: end === "save" ? "Save comment" : "Cancel" }));
  await waitFor(() => expect(screen.queryByTestId("diff-pane")).toBeNull());
  expect(screen.queryByRole("link", { name: "Diff" })).toBeNull();
  expect(localStorage.getItem(key)).toBe(end === "cancel" ? "Resume this draft" : null);
  if (end === "save")
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) =>
          path === `/api/v1/reviews/${id}/threads` &&
          JSON.stringify(JSON.parse(String(init?.body))) ===
            JSON.stringify({ revision: 1, target, body: "Resume this draft" }),
      ),
    ).toBe(true);
});

test.each([390, 1280])("a removed HTML draft keeps Docs visible at %s px until cancelled", async (size) => {
  width = size;
  openingRevision({ writeupEmpty: false });
  const target: Target = { kind: "html-span", path: "removed.html", quote: "seed", prefix: "", suffix: "" };
  localStorage.setItem(draftKey(id, target), "HTML draft");
  const { history } = mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  const composer = within(
    await screen.findByRole(size === 390 ? "dialog" : "region", {
      name: size === 390 ? "New comment" : "Resumed comment",
    }),
  );
  expect((composer.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("HTML draft");
  await waitFor(() => expect(history.location.search).toContain("tab=docs"));
  fireEvent.click(composer.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole(width < 768 ? "link" : "tab", { name: /^Docs(?: \d+)?$/ })).toBeNull());
  expect(screen.queryByRole("region", { name: "Resumed comment" })).toBeNull();
  expect(
    screen
      .getByRole(width < 768 ? "link" : "tab", { name: "Writeup" })
      .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
  ).toBe(width < 768 ? "page" : "true");
});

test.each(["writeup", "docs"] as const)(
  "an active %s draft keeps its tab across an empty revision until cancelled",
  async (tab) => {
    width = 390;
    newest = 2;
    const block: RenderedBlock =
      tab === "writeup" ? draftBlock : { ...draftBlock, id: "doc-12345678-12345678", section: "doc-12345678" };
    const target: Target =
      tab === "writeup" ? draftTarget : { ...draftTarget, kind: "doc-span", path: "old.md", blockId: block.id };
    openingRevision(
      tab === "writeup"
        ? { docs: [{ path: "next.md", kind: "markdown", blocks: [] }], writeup: { sections: [] } }
        : { writeupEmpty: false },
      tab === "writeup"
        ? {
            writeupEmpty: false,
            writeup: { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [block] }] },
          }
        : { docs: [{ path: "old.md", kind: "markdown", blocks: [block] }] },
    );
    localStorage.setItem(draftKey(id, target), "Keep editing");
    const { history } = mount(`/r/${id}?rev=1&tab=comments`);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    const name = tab === "writeup" ? "Writeup" : "Docs";
    await waitFor(() => expect(history.location.search).toContain(`tab=${tab}`));
    await act(async () => history.push(`/r/${id}?rev=2&tab=${tab}`));
    await waitFor(() => expect(screen.queryByText("Plant a seed.")).toBeNull());
    expect(history.location.search).toContain(`tab=${tab}`);
    const composer = within(screen.getByRole("dialog", { name: "New comment" }));
    expect((composer.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Keep editing");
    fireEvent.click(composer.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("link", { name })).toBeNull());
    expect(
      screen.getByRole("link", { name: tab === "writeup" ? "Docs" : "Writeup" }).getAttribute("aria-current"),
    ).toBe("page");
  },
);

test("an unplaced reading draft resumed beside Diff stays visible when resized to a phone", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  openingRevision({ files: [{ ...diffFile, topic: null }], writeup: { sections: [] } });
  localStorage.setItem(draftKey(id, draftTarget), "Unplaced writeup draft");
  const { history } = mount(`/r/${id}?tab=diff`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  expect(((await screen.findByLabelText("Comment")) as HTMLTextAreaElement).value).toBe("Unplaced writeup draft");
  act(() => resize(390));
  expect(((await screen.findByLabelText("Comment")) as HTMLTextAreaElement).value).toBe("Unplaced writeup draft");
  expect(history.location.search).toContain("tab=comments");
  expect(screen.getByRole("dialog", { name: "New comment" })).toBeTruthy();
});

test.each([null, "2026-01-02T00:00:00.000Z"])("shows provenance only for copied reviews (%s)", async (importedAt) => {
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path === `/api/v1/reviews/${id}`
      ? Response.json({ ...item, importedAt, revisions: [{ seq: 1, createdAt: item.updatedAt }] })
      : (fallback?.(path, init) as Promise<Response>),
  );
  mount(`/r/${id}`);
  await screen.findByRole("heading", { name: item.title });
  if (importedAt)
    expect(
      await screen.findByText(/Copied from Workshop on .*Comments, Sends and approvals before then were made there\./),
    ).toBeTruthy();
  else expect(screen.queryByText(/Copied from/)).toBeNull();
});

function withInbox(items: InboxItem[]) {
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path === "/api/v1/reviews"
      ? Response.json({
          approvedActiveHours: 12,
          approvedActiveLimit: 5,
          serverTime: new Date(Date.now()).toISOString(),
          items,
        })
      : (fallback?.(path, init) as Promise<Response>),
  );
}
const secondItem: InboxItem = {
  ...item,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Another proposal",
  branch: "feature/garden",
  origin: { id: "22222222-2222-4222-8222-222222222222", name: "Garden" },
  unsentCount: 0,
  openThreads: 0,
  agentWaiting: true,
};

test("inbox row shows machine, title, branch, local time, counts and attention without exposing the repo key", async () => {
  mount();
  const row = await screen.findByRole("link", { name: /Synthetic review/ });
  expect(within(row).getByText("Workshop")).toBeTruthy();
  expect(within(row).queryByText("·")).toBeNull();
  expect(screen.queryByRole("link", { name: /From Workshop/ })).toBeNull();
  expect(within(row).queryByRole("img", { name: "From Workshop" })).toBeNull();
  expect(within(row).getByText("main")).toBeTruthy();
  expect(row.textContent).not.toContain(item.repo);
  expect(row.textContent).not.toContain("Revision");
  expect(row.querySelector("time")?.dateTime).toBe(item.updatedAt);
  expect(row.querySelector("time")?.title).toBe(new Date(item.updatedAt).toLocaleString());
  expect(row.textContent).toContain("1 open thread");
  expect(row.textContent).toContain("2 unsent");
  expect(within(row).getByRole("img", { name: "Not picked up yet" })).toBeTruthy();
  expect(within(row).getByText("Needs you.").className).toBe("sr-only");
  expect(row.querySelector('[aria-hidden="true"].bg-accent')).toBeTruthy();
});

test.each(["Orchard", "<img src=x onerror=alert(1)>"])(
  "row project %s is isolated text beside the machine",
  async (project) => {
    withInbox([{ ...item, project }]);
    mount();
    const row = await screen.findByRole("link", { name: /Synthetic review/ });
    const machine = within(row).getByText("Workshop");
    const label = within(row).getByText(project);
    expect(label.getAttribute("dir")).toBe("auto");
    expect(label.parentElement).toBe(machine.parentElement);
    expect(label.previousElementSibling?.textContent).toBe("·");
    expect(label.previousElementSibling?.getAttribute("aria-hidden")).toBe("true");
    expect(label.previousElementSibling?.previousElementSibling).toBe(machine);
    expect(row.querySelector("img")).toBeNull();
    for (const element of [machine, label]) {
      expect(element.classList.contains("min-w-0")).toBe(true);
      expect(element.classList.contains("truncate")).toBe(true);
    }
  },
);

test("project picker groups repository names, sorts them, filters and clears with text", async () => {
  const shared = {
    ...item,
    id: "33333333-3333-4333-8333-333333333333",
    title: "Shared project",
    repo: "d".repeat(64),
    project: "Orchard",
  };
  withInbox([
    { ...item, project: "Orchard" },
    { ...secondItem, project: "Atrium" },
    shared,
    { ...item, id: "44444444-4444-4444-8444-444444444444", title: "No project" },
  ]);
  mount();
  const picker = await screen.findByRole("combobox", { name: "Project" });
  expect(
    within(picker)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["All projects", "Atrium", "Orchard"]);
  fireEvent.change(picker, { target: { value: "Orchard" } });
  expect(screen.getByRole("link", { name: /Synthetic review/ })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Shared project/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Another proposal/ })).toBeNull();
  expect(screen.queryByRole("link", { name: /No project/ })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "Atrium" } });
  expect(screen.getByText("No reviews match this filter.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect((picker as HTMLSelectElement).value).toBe("");
  expect(within(screen.getByRole("list")).getAllByRole("link")).toHaveLength(4);
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "oRCHard" } });
  expect(within(screen.getByRole("list")).getAllByRole("link")).toHaveLength(2);
  expect(screen.queryByRole("link", { name: /Another proposal/ })).toBeNull();
});

test("a project selection is ignored when it disappears from the inbox", async () => {
  withInbox([
    { ...item, project: "Orchard" },
    { ...secondItem, project: "Atrium" },
  ]);
  mount();
  const picker = await screen.findByRole("combobox", { name: "Project" });
  fireEvent.change(picker, { target: { value: "Orchard" } });
  const items = [
    { ...item, project: "Courtyard" },
    { ...secondItem, project: "Atrium" },
  ];
  withInbox(items);
  act(() =>
    client.setQueryData<InboxData>(["inbox"], {
      approvedActiveHours: 12,
      approvedActiveLimit: 5,
      serverTime: new Date().toISOString(),
      receivedAt: Date.now(),
      receivedMono: performance.now(),
      items,
    }),
  );
  await waitFor(() => expect((picker as HTMLSelectElement).value).toBe(""));
  expect(screen.getByRole("link", { name: /Another proposal/ })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Synthetic review/ })).toBeTruthy();
});

test("one named project plus a projectless review can be filtered by project", async () => {
  withInbox([
    { ...item, project: "Orchard" },
    { ...secondItem, project: null },
  ]);
  mount();
  const picker = await screen.findByRole("combobox", { name: "Project" });
  expect(
    within(picker)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["All projects", "Orchard"]);
  fireEvent.change(picker, { target: { value: "Orchard" } });
  expect(screen.getByRole("link", { name: /Synthetic review/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Another proposal/ })).toBeNull();
  fireEvent.change(picker, { target: { value: "" } });
  expect(screen.getByRole("link", { name: /Another proposal/ })).toBeTruthy();
});

test.each([null, "Orchard"])("one distinct project (%s) omits the picker", async (project) => {
  withInbox([
    { ...item, project },
    { ...secondItem, project },
  ]);
  mount();
  await screen.findByRole("link", { name: /Synthetic review/ });
  expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
});

test.each([1280, 900])(
  "compact inbox shows projects and matches their text without a picker at %s px",
  async (size) => {
    width = size;
    withInbox([
      { ...item, project: "Orchard" },
      { ...secondItem, project: "Atrium" },
    ]);
    mount(`/r/${id}`);
    const sidebar = await openReviewInbox();
    const row = await sidebar.findByRole("link", { name: /Synthetic review/ });
    expect(within(row).getByText("Orchard").getAttribute("dir")).toBe("auto");
    expect(sidebar.queryByRole("combobox", { name: "Project" })).toBeNull();
    fireEvent.change(sidebar.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "atrium" } });
    expect(sidebar.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
    expect(sidebar.getByRole("link", { name: /Another proposal/ })).toBeTruthy();
  },
);

test.each(["approved", "settled"] as const)(
  "%s row replaces time with state and has no attention mark",
  async (state) => {
    withInbox([{ ...item, state, list: "done" }]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Done/ }));
    const row = await screen.findByRole("link", { name: /Synthetic review/ });
    expect(within(row).getByText(state === "approved" ? "Approved" : "Retired")).toBeTruthy();
    expect(row.querySelector("time")).toBeNull();
    expect(within(row).queryByText("Needs you.")).toBeNull();
  },
);

test("moved rows are disabled and omit attention, counts and agent glyphs", async () => {
  withInbox([{ ...item, movedTo: "https://hub.example/r/new" }]);
  mount();
  const moved = await screen.findByText("Moved to hub.example");
  const row = moved.closest('[aria-disabled="true"]');
  expect(row?.tagName).toBe("DIV");
  expect(row?.textContent).not.toMatch(/unsent|open thread|Needs you/);
  expect(screen.queryByRole("img", { name: "Not picked up yet" })).toBeNull();
  expect(screen.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
});

test("quiet rows omit zero counts, attention and absent branch", async () => {
  withInbox([{ ...item, branch: null, unsentCount: 0, openThreads: 0, pendingSend: false }]);
  mount();
  const row = await screen.findByRole("link", { name: /Synthetic review/ });
  expect(row.textContent).not.toMatch(/unsent|open thread|Needs you|main/);
  expect(within(row).queryByRole("img", { name: /agent waiting/i })).toBeNull();
  expect(screen.getByText("Nothing needs you · 1 machine")).toBeTruthy();
});

test.each(["SYNTHETIC", "MaIn", "wORKsHOP"])("text filter matches title, branch and machine for %s", async (filter) => {
  withInbox([item, secondItem]);
  mount();
  await screen.findByRole("link", { name: /Another proposal/ });
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: filter } });
  expect(screen.getByRole("link", { name: /Synthetic review/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Another proposal/ })).toBeNull();
});

test("no matches can be cleared and filtering preserves server order without changing the URL", async () => {
  withInbox([secondItem, item]);
  const { history } = mount();
  await screen.findByRole("link", { name: /Another proposal/ });
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "not present" } });
  expect(screen.getByText("No reviews match this filter.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect((screen.getByRole("textbox", { name: "Filter reviews" }) as HTMLInputElement).value).toBe("");
  expect(
    within(screen.getByRole("list"))
      .getAllByRole("link")
      .map((row) => row.getAttribute("href")),
  ).toEqual([`/r/${secondItem.id}?rev=${secondItem.newestRevision}`, `/r/${id}?rev=${item.newestRevision}`]);
  expect(history.location.search).toBe("");
});

test("machine Select appears for multiple origins, sorts names and combines with the text filter", async () => {
  withInbox([item, secondItem]);
  mount();
  const machine = await screen.findByRole("combobox", { name: "Machine" });
  expect(machine.tagName).toBe("SELECT");
  expect(
    within(machine)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["All machines", "Garden", "Workshop"]);
  expect(screen.getByText("2 need you · 2 machines")).toBeTruthy();
  fireEvent.change(machine, { target: { value: secondItem.origin.id } });
  expect(screen.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
  expect(screen.getByRole("link", { name: /Another proposal/ })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "main" } });
  expect(screen.getByText("No reviews match this filter.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(screen.getByRole("link", { name: /Synthetic review/ })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Another proposal/ })).toBeTruthy();
});

test("kind group filters every list, works with the text filter and clears with the rest", async () => {
  const published = { ...secondItem, kind: "publish" as const, agentWaiting: false, title: "Published notes" };
  const doneReview = {
    ...item,
    id: "55555555-5555-4555-8555-555555555555",
    title: "Finished work",
    state: "approved" as const,
    list: "done" as const,
  };
  const donePublish = {
    ...published,
    id: "66666666-6666-4666-8666-666666666666",
    title: "Finished notes",
    state: "approved" as const,
    list: "done" as const,
  };
  withInbox([item, published, doneReview, donePublish]);
  mount();
  const kind = await screen.findByRole("radiogroup", { name: "Kind" });
  expect(
    within(kind)
      .getAllByRole("radio")
      .map((option) => option.textContent),
  ).toEqual(["All", "Reviews", "Pubs"]);
  fireEvent.click(within(kind).getByRole("radio", { name: "Pubs" }));
  expect(screen.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
  expect(screen.getByRole("link", { name: /Published notes/ })).toBeTruthy();
  // Searching makes the Done list visible, still within the kind.
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "finished" } });
  expect(screen.getByRole("link", { name: /Finished notes/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Finished work/ })).toBeNull();
  fireEvent.click(within(kind).getByRole("radio", { name: "Reviews" }));
  expect(screen.getByRole("link", { name: /Finished work/ })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "notes" } });
  expect(screen.getByText("No reviews match this filter.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(within(kind).getByRole("radio", { name: "All", checked: true })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Published notes/ })).toBeTruthy();
});

test("the chosen kind survives an unmount and remount, and Clear filter forgets it", async () => {
  const published = { ...secondItem, kind: "publish" as const, agentWaiting: false, title: "Published notes" };
  withInbox([item, published]);
  const first = mount();
  fireEvent.click(await screen.findByRole("radio", { name: "Pubs" }));
  expect(localStorage.getItem("emend:inbox-kind")).toBe("publish");
  first.unmount();
  mount();
  expect(await screen.findByRole("radio", { name: "Pubs", checked: true })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "zzz" } });
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(localStorage.getItem("emend:inbox-kind")).toBeNull();
});

test("a published item with a waiting agent still shows under Reviews", async () => {
  const waiting = { ...secondItem, kind: "publish" as const, title: "Waiting notes", agentWaiting: true };
  const quiet = {
    ...secondItem,
    id: "77777777-7777-4777-8777-777777777777",
    kind: "publish" as const,
    agentWaiting: false,
    title: "Quiet notes",
  };
  withInbox([item, waiting, quiet]);
  mount();
  fireEvent.click(await screen.findByRole("radio", { name: "Reviews" }));
  expect(screen.getByRole("link", { name: /Waiting notes/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Quiet notes/ })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Pubs" }));
  expect(screen.getByRole("link", { name: /Quiet notes/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
});

test("a stored garbage kind shows All", async () => {
  localStorage.setItem("emend:inbox-kind", "nonsense");
  withInbox([item, secondItem]);
  mount();
  expect(await screen.findByRole("radio", { name: "All", checked: true })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Synthetic review/ })).toBeTruthy();
});

test("kind group is absent from an empty inbox", async () => {
  withInbox([]);
  mount();
  await screen.findByText("No reviews yet.");
  expect(screen.queryByRole("radiogroup", { name: "Kind" })).toBeNull();
});

async function openReviewInbox() {
  await screen.findByRole("heading", { name: item.title, level: 1 });
  if (width < 1280) {
    fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
    return within(await screen.findByRole("dialog", { name: "Inbox" }));
  }
  return within(screen.getByTestId("inbox-pane"));
}

test.each([1280, 900])("sidebar kind group hides the open review under Pubs at %s px", async (size) => {
  width = size;
  const published = {
    ...secondItem,
    id: "77777777-7777-4777-8777-777777777777",
    kind: "publish" as const,
    agentWaiting: false,
    title: "Published notes",
  };
  withInbox([item, secondItem, published]);
  mount(`/r/${id}`);
  const sidebar = await openReviewInbox();
  const kind = await sidebar.findByRole("radiogroup", { name: "Kind" });
  expect(
    within(kind)
      .getAllByRole("radio")
      .map((option) => option.textContent),
  ).toEqual(["All", "Reviews", "Pubs"]);
  expect(sidebar.queryByRole("combobox", { name: "Machine" })).toBeNull();
  fireEvent.click(within(kind).getByRole("radio", { name: "Pubs" }));
  expect(sidebar.getByRole("link", { name: /Published notes/ })).toBeTruthy();
  expect(sidebar.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
  expect(sidebar.queryByRole("link", { name: /Another proposal/ })).toBeNull();
  // The tablet sheet hides the page from accessibility queries while open.
  if (size < 1280) fireEvent.click(sidebar.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("heading", { name: item.title, level: 1 })).toBeTruthy();
  const reopened = size < 1280 ? await openReviewInbox() : sidebar;
  fireEvent.click(reopened.getByRole("radio", { name: "All" }));
  expect(reopened.getByRole("link", { name: /Another proposal/ })).toBeTruthy();
  expect(reopened.getByRole("link", { name: /Synthetic review/ }).getAttribute("aria-current")).toBe("page");
});

test.each([1280, 900])("kind choice is shared across sidebar and page remounts at %s px", async (size) => {
  width = size;
  const published = { ...secondItem, kind: "publish" as const, agentWaiting: false, title: "Published notes" };
  withInbox([item, published]);
  const first = mount(`/r/${id}`);
  const sidebar = await openReviewInbox();
  fireEvent.click(await sidebar.findByRole("radio", { name: "Pubs" }));
  expect(localStorage.getItem("emend:inbox-kind")).toBe("publish");
  first.unmount();
  const page = mount();
  expect(await screen.findByRole("radio", { name: "Pubs", checked: true })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Published notes/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Reviews" }));
  expect(localStorage.getItem("emend:inbox-kind")).toBe("review");
  page.unmount();
  mount(`/r/${id}`);
  const remounted = await openReviewInbox();
  expect(await remounted.findByRole("radio", { name: "Reviews", checked: true })).toBeTruthy();
  expect(remounted.queryByRole("link", { name: /Published notes/ })).toBeNull();
  fireEvent.change(remounted.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "zzz" } });
  fireEvent.click(remounted.getByRole("button", { name: "Clear filter" }));
  expect(remounted.getByRole("radio", { name: "All", checked: true })).toBeTruthy();
  expect(localStorage.getItem("emend:inbox-kind")).toBeNull();
  expect(remounted.getByRole("link", { name: /Published notes/ })).toBeTruthy();
});

test.each([1280, 900])("sidebar Reviews keeps waiting publishes and hides the open publish at %s px", async (size) => {
  width = size;
  localStorage.setItem("emend:inbox-kind", "review");
  const waiting = { ...secondItem, kind: "publish" as const, title: "Waiting notes" };
  const quiet = {
    ...waiting,
    id: "77777777-7777-4777-8777-777777777777",
    agentWaiting: false,
    title: "Quiet notes",
  };
  const plain = {
    ...secondItem,
    id: "88888888-8888-4888-8888-888888888888",
    kind: "review" as const,
    agentWaiting: false,
    title: "Plain proposal",
  };
  withInbox([{ ...item, kind: "publish", agentWaiting: false }, waiting, quiet, plain]);
  mount(`/r/${id}`);
  const sidebar = await openReviewInbox();
  expect(await sidebar.findByRole("radio", { name: "Reviews", checked: true })).toBeTruthy();
  expect(sidebar.getByRole("link", { name: /Plain proposal/ })).toBeTruthy();
  expect(sidebar.getByRole("link", { name: /Waiting notes/ })).toBeTruthy();
  expect(sidebar.queryByRole("link", { name: /Quiet notes/ })).toBeNull();
  expect(sidebar.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
  if (size < 1280) fireEvent.click(sidebar.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("heading", { name: item.title, level: 1 })).toBeTruthy();
});

test.each([
  { path: "/", size: 390 },
  { path: `/r/${id}`, size: 1280 },
  { path: `/r/${id}`, size: 900 },
])("kind storage failures default to All and leave controls usable at $path ($size px)", async ({ path, size }) => {
  width = size;
  const denied = vi.fn(() => {
    throw new Error("Storage denied");
  });
  vi.stubGlobal("localStorage", { getItem: denied, setItem: denied, removeItem: denied });
  withInbox([item, { ...secondItem, kind: "publish", agentWaiting: false }]);
  const first = mount(path);
  if (path !== "/") await openReviewInbox();
  expect(await screen.findByRole("radio", { name: "All", checked: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Reviews" }));
  expect(screen.getByRole("radio", { name: "Reviews", checked: true })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Another proposal/ })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  expect(screen.getByRole("link", { name: /Another proposal/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Pubs" }));
  first.unmount();
  mount(path);
  if (path !== "/") await openReviewInbox();
  expect(await screen.findByRole("radio", { name: "All", checked: true })).toBeTruthy();
  expect(denied).toHaveBeenCalledWith("emend:inbox-kind");
  expect(denied).toHaveBeenCalledWith("emend:inbox-kind", "review");
});

test.each([1280, 900])("collapsed rail ignores the saved kind at %s px", async (size) => {
  width = size;
  localStorage.setItem("emend:inbox-kind", "publish");
  withInbox([item, { ...secondItem, agentWaiting: false }]);
  mount(`/r/${id}`);
  await screen.findByRole("heading", { name: item.title, level: 1 });
  if (size === 1280) fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  const rail = within(screen.getByRole("complementary", { name: "Inbox" }));
  expect(await rail.findByRole("link", { name: /Another proposal/ })).toBeTruthy();
  expect(rail.getByRole("link", { name: /Synthetic review/ })).toBeTruthy();
  expect(rail.queryByRole("radiogroup", { name: "Kind" })).toBeNull();
});

test("single origin omits the machine filter; subtitle excludes moved and completed reviews", async () => {
  withInbox([
    item,
    { ...item, id: secondItem.id, state: "approved" },
    { ...item, id: "44444444-4444-4444-8444-444444444444", movedTo: "https://hub.example/r/new" },
  ]);
  mount();
  await screen.findByText("1 needs you · 1 machine");
  expect(screen.queryByRole("combobox", { name: "Machine" })).toBeNull();
});

test("compact inbox filters too, omits machine Select and keeps the current row active on another tab", async () => {
  withInbox([item, secondItem]);
  mount(`/r/${id}?tab=comments`);
  const inbox = within(await screen.findByRole("complementary", { name: "Inbox" }));
  await inbox.findByRole("link", { name: /Synthetic review/ });
  expect(inbox.getByRole("link", { name: /Synthetic review/ }).getAttribute("aria-current")).toBe("page");
  expect(inbox.queryByRole("combobox", { name: "Machine" })).toBeNull();
  fireEvent.change(inbox.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "garden" } });
  expect(inbox.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
  expect(inbox.getByRole("link", { name: /Another proposal/ })).toBeTruthy();
});

test("one list timer refreshes relative times and is cleared on unmount", async () => {
  let now = Date.parse(item.updatedAt) + 30_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const interval = vi.spyOn(window, "setInterval");
  const clear = vi.spyOn(window, "clearInterval");
  withInbox([item, secondItem]);
  const { unmount } = mount();
  const row = await screen.findByRole("link", { name: /Synthetic review/ });
  expect(row.querySelector("time")?.textContent).toBe("now");
  const ticks = interval.mock.calls.filter(([, delay]) => delay === 60_000);
  expect(ticks).toHaveLength(1);
  const callback = ticks[0]?.[0];
  expect(typeof callback).toBe("function");
  now += 60_000;
  act(() => {
    if (typeof callback === "function") callback();
  });
  expect(row.querySelector("time")?.textContent).toBe("1m");
  const index = interval.mock.calls.findIndex(([, delay]) => delay === 60_000);
  const timer = interval.mock.results[index]?.value;
  unmount();
  expect(clear).toHaveBeenCalledWith(timer);
});

test("desktop frame has wordmark and Devices links, expands its rail and persists both choices", async () => {
  withInbox([item, { ...secondItem, movedTo: "https://hub.example/r/new" }]);
  const first = mount(`/r/${id}?tab=docs`);
  await screen.findByRole("heading", { name: "plan.md" });
  expect(screen.getByRole("link", { name: "emend" }).getAttribute("href")).toBe("/");
  expect(screen.getByRole("link", { name: "Devices" }).getAttribute("href")).toBe("/devices");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  const rail = within(screen.getByRole("complementary", { name: "Inbox" }));
  const link = await rail.findByRole("link", { name: "Needs you: Synthetic review" });
  expect(link.getAttribute("aria-current")).toBe("page");
  expect(within(link).getByRole("img", { name: "From Workshop" })).toBeTruthy();
  expect(rail.queryByRole("link", { name: /Another proposal/ })).toBeNull();
  expect(JSON.parse(localStorage.getItem("emend.layout.v1") ?? "{}").inboxCollapsed).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
  expect(screen.getByTestId("inbox-pane")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("emend.layout.v1") ?? "{}").inboxCollapsed).toBe(false);
  first.unmount();
  mount(`/r/${id}`);
  expect(await screen.findByTestId("inbox-pane")).toBeTruthy();
});

test.each([768, 1279])("tablet %s has a rail and selecting a review closes the left sheet", async (size) => {
  width = size;
  withInbox([item, secondItem]);
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path === `/api/v1/reviews/${secondItem.id}`
      ? Response.json({ ...secondItem, revisions: [{ seq: 1, createdAt: item.updatedAt }] })
      : (fallback?.(path, init) as Promise<Response>),
  );
  const { history } = mount(`/r/${id}`);
  await screen.findByText("Overview");
  const rail = within(screen.getByRole("complementary", { name: "Inbox" }));
  expect(await rail.findByRole("link", { name: "Needs you: Synthetic review" })).toBeTruthy();
  fireEvent.click(rail.getByRole("button", { name: "Show inbox" }));
  const sheet = within(await screen.findByRole("dialog", { name: "Inbox" }));
  expect(sheet.getAllByRole("heading", { name: "Inbox" })).toHaveLength(1);
  expect(sheet.queryByRole("button", { name: "Collapse inbox" })).toBeNull();
  const destination = await sheet.findByRole("link", { name: /Another proposal/ });
  destination.focus();
  fireEvent.click(destination, { button: 0 });
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${secondItem.id}`));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull());
  const heading = await screen.findByRole("heading", { name: "Another proposal", level: 1 });
  await waitFor(() => expect(document.activeElement).toBe(heading));
});

test("phone review shows its title once, back link, and clipboard failure toast", async () => {
  width = 390;
  vi.stubGlobal("navigator", {
    ...navigator,
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(screen.getAllByText("Synthetic review")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Inbox" }).getAttribute("href")).toBe("/");
  expect(screen.queryByText(item.repo ?? "")).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu", { name: "More" }));
  expect(menu.queryByRole("combobox")).toBeNull();
  fireEvent.click(menu.getByRole("menuitem", { name: "Copy link" }));
  expect(await screen.findByText("Could not copy the link. Copy it from the address bar.")).toBeTruthy();
});

for (const size of [390, 768, 1280])
  for (const [path, heading] of [
    ["/", "Inbox"],
    [`/r/${id}`, "Synthetic review"],
    ["/devices", "Devices"],
  ]) {
    test(`one main on ${path} at ${size}px`, async () => {
      width = size;
      const fallback = fetchMock.getMockImplementation();
      fetchMock.mockImplementation(async (url, init) =>
        url === "/api/v1/devices" ? Response.json({ items: [] }) : (fallback?.(url, init) as Promise<Response>),
      );
      mount(path);
      await screen.findByRole("heading", { level: 1, name: heading });
      expect(screen.getAllByRole("main")).toHaveLength(1);
    });
  }

test.each([0, 2])(
  "phone tabs show decorative icons, URL selection and counts only for loaded threads (%s)",
  async (count) => {
    width = 390;
    const fallback = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (path, init) =>
      path.endsWith("/revisions/1")
        ? Response.json({
            ...revision,
            threads: Array.from({ length: count }, (_, index) => ({
              ...diffThread,
              id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
            })),
          })
        : (fallback?.(path, init) as Promise<Response>),
    );
    const { history } = mount(`/r/${id}?tab=writeup`);
    await screen.findByText("Overview");
    const tabs = within(screen.getByRole("navigation", { name: "Review tabs" }));
    const links = tabs.getAllByRole("link");
    expect(links).toHaveLength(5);
    for (const label of ["Writeup", "Files 0/1", "Docs", "Comments", "Diff"])
      expect(tabs.getByRole("link", { name: new RegExp(label) })).toBeTruthy();
    for (const link of links) expect(link.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(tabs.queryByRole("img")).toBeNull();
    expect(tabs.getByRole("link", { name: "Writeup" }).getAttribute("aria-current")).toBe("page");
    const comments = tabs.getByRole("link", {
      name: count ? "Comments 2 unsent, 2 not resolved, 2 threads in all" : "Comments",
    });
    if (count) expect(within(comments).getByText("2 / 2 / 2").getAttribute("aria-hidden")).toBe("true");
    else expect(comments.textContent).toBe("Comments");
    fireEvent.click(comments);
    await waitFor(() => expect(history.location.search).toContain("tab=comments"));
    expect(comments.getAttribute("aria-current")).toBe("page");
  },
);

test.each([1280, 390])("Comments tab counts threads and updates before the Send refetch at %s px", async (size) => {
  width = size;
  const threads: ThreadView[] = (
    ["open", "open", "sent", "answered", "open", "resolved", "resolved", "resolved", "resolved"] as const
  ).map((state, index) => ({
    ...diffThread,
    id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    state,
    comments: [{ id, author: "user", body: `Comment ${index}`, sent: index >= 2, sentOn: index >= 2 ? 1 : null }],
  }));
  const sentThreads = threads.map((thread, index) =>
    index < 2
      ? { ...thread, state: "sent" as const, comments: thread.comments.map((c) => ({ ...c, sent: true, sentOn: 1 })) }
      : thread,
  );
  let sent = false;
  let releaseRevision: ((response: Response) => void) | undefined;
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    if (path === `/api/v1/reviews/${id}/sends` && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toMatchObject({ revision: 1, kind: "go" });
      sent = true;
      return Response.json({ sendId: id }, { status: 201 });
    }
    if (path.endsWith("/revisions/1")) {
      if (sent)
        return new Promise<Response>((resolve) => {
          releaseRevision = resolve;
        });
      return Response.json({ ...revision, threads });
    }
    if (path === `/api/v1/reviews/${id}`)
      return Response.json({ ...item, unsentCount: sent ? 0 : 2, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
    return fallback?.(path, init) as Promise<Response>;
  });
  mount(`/r/${id}?tab=comments`);
  const role = size === 390 ? "link" : "tab";
  const beforeName = "Comments 2 unsent, 5 not resolved, 9 threads in all";
  const comments = await screen.findByRole(role, { name: beforeName });
  const bubble = within(comments).getByText("2 / 5 / 9");
  expect(bubble.getAttribute("aria-hidden")).toBe("true");
  expect(bubble.className).toContain("bg-accent");
  if (size === 390) {
    expect(bubble.classList.contains("translate-x-[min(0px,calc(34px-100%))]")).toBe(true);
    fireEvent.pointerMove(bubble, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toBe("2 unsent, 5 not resolved, 9 threads in all");
    expect(screen.getByRole("link", { name: beforeName })).toBe(comments);
    fireEvent.pointerLeave(bubble, { pointerType: "mouse" });
  }
  const reading = within(screen.getByRole("region", { name: "Reading" }));
  const place = reading.getByRole("region", { name: diffTarget.path });
  expect(place.querySelectorAll('[data-thread-card][data-state="unsent"]')).toHaveLength(2);
  expect(within(place).getAllByRole("article")).toHaveLength(9);
  expect(reading.getAllByRole("article")).toHaveLength(9);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  if (size === 390) fireEvent.click(screen.getByRole("button", { name: "Send 2 comments on revision 1" }));
  const dialog = await screen.findByRole(size === 390 ? "dialog" : "alertdialog", { name: "Sent" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  const afterName = "Comments 0 unsent, 5 not resolved, 9 threads in all";
  const updated = await screen.findByRole(role, { name: afterName });
  const neutral = within(updated).getByText("0 / 5 / 9");
  expect(neutral.className).toContain("bg-active");
  expect(neutral.className).toContain("text-fg-2");
  expect(neutral.className).not.toContain("bg-accent");
  expect(place.querySelectorAll('[data-thread-card][data-state="unsent"]')).toHaveLength(0);
  expect(reading.getAllByRole("article")).toHaveLength(9);
  expect(releaseRevision).toBeTypeOf("function");
  expect(client.getQueryState(["revision", id, 1])?.fetchStatus).toBe("fetching");
  await act(async () => releaseRevision?.(Response.json({ ...revision, threads: sentThreads })));
  await waitFor(() => expect(client.getQueryState(["revision", id, 1])?.fetchStatus).toBe("idle"));
  expect(within(screen.getByRole(role, { name: afterName })).getByText("0 / 5 / 9")).toBeTruthy();
  const key = draftKey(id, diffTarget);
  act(() => saveDraft(key, "A local draft is not a thread"));
  expect(screen.getByRole(role, { name: afterName })).toBe(updated);
  expect(within(comments).getByText("0 / 5 / 9")).toBe(neutral);
  act(() => clearDraft(key));
});

test("task 1.13 at 390 × 844 keeps Send outside the reading scroll area and before bottom tabs", async () => {
  width = 390;
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(screen.getByRole("banner")).toBeTruthy();
  expect(screen.queryByRole("complementary", { name: "Inbox" })).toBeNull();
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  expect(screen.queryByTestId("diff-pane")).toBeNull();
  const reading = screen.getByRole("region", { name: "Reading" });
  expect(reading.className).toContain("overflow-y-auto");
  const send = screen.getByRole("button", { name: /^Send/ });
  const tabs = screen.getByRole("navigation", { name: "Review tabs" });
  expect(reading.contains(send)).toBe(false);
  expect(reading.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(send.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("an approved review at an older revision does not claim that revision was approved", async () => {
  width = 390;
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path === `/api/v1/reviews/${id}`
      ? Response.json({
          ...item,
          state: "approved",
          newestRevision: 2,
          revisions: [
            { seq: 1, createdAt: item.updatedAt },
            { seq: 2, createdAt: item.updatedAt },
          ],
        })
      : (fallback?.(path, init) as Promise<Response>),
  );
  mount(`/r/${id}?rev=1`);
  await screen.findByRole("button", { name: /^Revision 1(?: of|,)/ });
  const header = screen.getByRole("heading", { level: 1, name: item.title }).parentElement?.parentElement;
  if (!header) throw new Error("Missing review header");
  expect(within(header).getAllByText("Approved")).toHaveLength(1);
  expect(within(header).queryByText(/Approved.*rev/i)).toBeNull();
});

test.each(["pane", "rail"])(
  "desktop %s navigation focuses the new review heading once after loading",
  async (source) => {
    withInbox([item, secondItem]);
    let releaseReview: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const fallback = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (path, init) => {
      if (path === `/api/v1/reviews/${secondItem.id}`) {
        await ready;
        return Response.json({ ...secondItem, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
      }
      return fallback?.(path, init) as Promise<Response>;
    });
    mount(`/r/${id}`);
    await screen.findByText("Overview");
    if (source === "rail") fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
    const inbox = within(screen.getByRole("complementary", { name: "Inbox" }));
    const destination = await inbox.findByRole("link", { name: /Another proposal/ });
    destination.focus();
    fireEvent.click(destination, { button: 0 });
    await screen.findByText("Loading review…");
    await act(async () => {
      releaseReview();
    });
    const heading = await screen.findByRole("heading", { name: secondItem.title, level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.tabIndex).toBe(-1);
    const devices = screen.getByRole("link", { name: "Devices" });
    devices.focus();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["review", secondItem.id] });
    });
    expect(document.activeElement).toBe(devices);
  },
);

test.each([768, 1280])("first review load at %s px does not move focus", async (size) => {
  width = size;
  const { getByRole } = render(<button type="button">Keep focus</button>);
  const focused = getByRole("button", { name: "Keep focus" });
  focused.focus();
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(document.activeElement).toBe(focused);
});

test("tablet Sheet stays closed after resizing 768 → 1280 → 768", async () => {
  width = 768;
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
  await screen.findByRole("dialog", { name: "Inbox" });
  act(() => resize(1280));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull());
  expect(screen.getByTestId("inbox-pane")).toBeTruthy();
  act(() => resize(768));
  expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull();
  expect(screen.getByRole("button", { name: "Show inbox" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
  expect(await screen.findByRole("dialog", { name: "Inbox" })).toBeTruthy();
});

test("in-memory collapsed preference survives the phone layout with unavailable localStorage", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Storage denied");
    },
    setItem: () => {
      throw new Error("Storage denied");
    },
  });
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  expect(screen.getByRole("button", { name: "Show inbox" })).toBeTruthy();
  act(() => resize(390));
  expect(screen.queryByRole("complementary", { name: "Inbox" })).toBeNull();
  act(() => resize(1280));
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  expect(screen.getByRole("button", { name: "Show inbox" })).toBeTruthy();
});

test("a row with an invalid cached timestamp has no time text", async () => {
  client.setQueryDefaults(["inbox"], { staleTime: Infinity });
  client.setQueryData<InboxData>(["inbox"], {
    approvedActiveHours: 12,
    approvedActiveLimit: 5,
    serverTime: new Date(Date.now()).toISOString(),
    receivedAt: Date.now(),
    receivedMono: performance.now(),
    items: [{ ...item, updatedAt: "invalid" }],
  });
  mount();
  const row = await screen.findByRole("link", { name: /Synthetic review/ });
  expect(row.querySelector("time")?.textContent).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("phone and desktop tabs retain the shared navigation props", () => {
  expectTypeOf<typeof PhoneTabs>().parameter(0).toEqualTypeOf<ReviewTabsProps>();
  expectTypeOf<typeof ReviewTabs>().parameter(0).toExtend<ReviewTabsProps>();
});

test.each([
  { name: "ctrl", click: { button: 0, ctrlKey: true } },
  { name: "cmd", click: { button: 0, metaKey: true } },
  { name: "shift", click: { button: 0, shiftKey: true } },
  { name: "alt", click: { button: 0, altKey: true } },
  { name: "middle", click: { button: 1 } },
])("$name-click on a tablet row leaves the Sheet open and its href intact", async ({ click }) => {
  width = 768;
  withInbox([item, secondItem]);
  const { history } = mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
  const dialog = await screen.findByRole("dialog", { name: "Inbox" });
  const destination = await within(dialog).findByRole("link", { name: /Another proposal/ });
  expect(destination.getAttribute("href")).toBe(`/r/${secondItem.id}?rev=${secondItem.newestRevision}`);
  destination.focus();
  let defaultPrevented = true;
  const onClick = (event: MouseEvent) => {
    defaultPrevented = event.defaultPrevented;
  };
  document.addEventListener("click", onClick, { once: true });
  fireEvent.click(destination, click);
  expect(defaultPrevented).toBe(false);
  expect(history.location.pathname).toBe(`/r/${id}`);
  expect(screen.getByRole("dialog", { name: "Inbox" })).toBe(dialog);
  expect(document.activeElement).toBe(destination);
});

test("in-memory collapsed preference survives rail navigation with unavailable localStorage", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Storage denied");
    },
    setItem: () => {
      throw new Error("Storage denied");
    },
  });
  withInbox([item, secondItem]);
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path === `/api/v1/reviews/${secondItem.id}`
      ? Response.json({ ...secondItem, revisions: [{ seq: 1, createdAt: item.updatedAt }] })
      : (fallback?.(path, init) as Promise<Response>),
  );
  const { history } = mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  const rail = within(screen.getByRole("complementary", { name: "Inbox" }));
  const destination = await rail.findByRole("link", { name: "Needs you: Another proposal" });
  destination.focus();
  fireEvent.click(destination, { button: 0 });
  await screen.findByRole("heading", { name: secondItem.title, level: 1 });
  expect(history.location.pathname).toBe(`/r/${secondItem.id}`);
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  expect(screen.getByRole("button", { name: "Show inbox" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Needs you: Another proposal" }).getAttribute("aria-current")).toBe("page");
});

test.each([
  { status: 404, recovery: "retry" },
  { status: 500, recovery: "retry" },
  { status: 404, recovery: "refetch" },
  { status: 500, recovery: "refetch" },
])("a $status review load clears pending heading focus before a successful $recovery", async ({ status, recovery }) => {
  withInbox([item, secondItem]);
  let attempts = 0;
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    if (path === `/api/v1/reviews/${secondItem.id}`) {
      attempts++;
      return attempts === 1
        ? Response.json({ error: { code: "failed", message: "Failed" } }, { status })
        : Response.json({ ...secondItem, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
    }
    return fallback?.(path, init) as Promise<Response>;
  });
  const { getByRole } = render(<button type="button">Keep focus after failure</button>);
  const focused = getByRole("button", { name: "Keep focus after failure" });
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  fireEvent.click(await screen.findByRole("link", { name: "Needs you: Another proposal" }), { button: 0 });
  expect((await screen.findByRole("alert")).textContent).toBe("Could not load this review.");
  focused.focus();
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  if (recovery === "retry") fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  else
    await act(async () => {
      await client.refetchQueries({ queryKey: ["review", secondItem.id] });
    });
  const heading = await screen.findByRole("heading", { name: secondItem.title, level: 1 });
  await screen.findByText("Overview");
  expect(attempts).toBe(2);
  expect(document.activeElement).toBe(focused);
  expect(focus.mock.instances).not.toContain(heading);
});

test("a cached review with a failed refetch takes heading focus once while its next fetch is pending", async () => {
  withInbox([item, secondItem]);
  const cachedReview = { ...secondItem, importedAt: null, revisions: [{ seq: 1, createdAt: item.updatedAt }] };
  const query = reviewQuery(secondItem.id);
  client.setQueryData(query.queryKey, cachedReview);
  let attempts = 0;
  let releaseFetch: (response: Response) => void = () => {};
  const nextFetch = new Promise<Response>((resolve) => {
    releaseFetch = resolve;
  });
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    if (path === `/api/v1/reviews/${secondItem.id}`) {
      attempts++;
      return attempts === 1
        ? Response.json({ error: { code: "failed", message: "Failed" } }, { status: 500 })
        : nextFetch;
    }
    return fallback?.(path, init) as Promise<Response>;
  });
  await expect(client.fetchQuery(query)).rejects.toThrow();
  expect(client.getQueryState(query.queryKey)).toMatchObject({ status: "error", data: cachedReview });
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  const inbox = within(screen.getByRole("complementary", { name: "Inbox" }));
  const destination = await inbox.findByRole("link", { name: /Another proposal/ });
  destination.focus();
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  fireEvent.click(destination, { button: 0 });
  const heading = await screen.findByRole("heading", { name: secondItem.title, level: 1 });
  await waitFor(() => expect(attempts).toBe(2));
  expect(client.getQueryState(query.queryKey)).toMatchObject({
    status: "error",
    fetchStatus: "fetching",
    data: cachedReview,
  });
  expect(document.activeElement).toBe(heading);
  expect(focus.mock.instances.filter((element) => element === heading)).toHaveLength(1);
  const devices = screen.getByRole("link", { name: "Devices" });
  devices.focus();
  await act(async () => {
    releaseFetch(Response.json(cachedReview));
  });
  await waitFor(() => expect(client.getQueryState(query.queryKey)?.status).toBe("success"));
  expect(document.activeElement).toBe(devices);
  expect(focus.mock.instances.filter((element) => element === heading)).toHaveLength(1);
});

test("phone header is absent on Diff and returns with its revision picker on every reading tab", async () => {
  width = 390;
  mount(`/r/${id}?tab=writeup`);
  await screen.findByText("Overview");
  expect(screen.getByRole("heading", { level: 1, name: item.title })).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Diff" }));
  await screen.findByTestId("diff-pane");
  expect(screen.queryByRole("heading", { level: 1, name: item.title })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Revision 1/ })).toBeNull();
  for (const tab of ["Docs", "Comments", "Writeup"]) {
    fireEvent.click(screen.getByRole("link", { name: new RegExp(`^${tab}`) }));
    await screen.findByRole("heading", { level: 1, name: item.title });
    expect(screen.getByRole("button", { name: "Revision 1 of 1" })).toBeTruthy();
    expect(screen.queryByTestId("diff-pane")).toBeNull();
  }
});

test("a folded file stays folded when the phone switches from Diff to Writeup and back", async () => {
  width = 390;
  mount(`/r/${id}?tab=diff`);
  const diff = within(await screen.findByTestId("diff-pane"));
  fireEvent.click(await diff.findByRole("button", { name: "Collapse file" }));
  expect(diff.getByRole("button", { name: "Expand file" })).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Writeup" }));
  await screen.findByRole("heading", { level: 1, name: item.title });
  expect(screen.queryByTestId("diff-pane")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Diff" }));
  const back = within(await screen.findByTestId("diff-pane"));
  expect(await back.findByRole("button", { name: "Expand file" })).toBeTruthy();
  expect(back.queryByRole("button", { name: "Collapse file" })).toBeNull();
});

test("a folded topic stays folded when the phone switches from Diff to Writeup and back", async () => {
  width = 390;
  mount(`/r/${id}?tab=diff`);
  const diff = within(await screen.findByTestId("diff-pane"));
  fireEvent.click(await diff.findByRole("button", { name: "Collapse topic" }));
  expect(diff.getByRole("button", { name: "Expand topic" })).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Writeup" }));
  await screen.findByRole("heading", { level: 1, name: item.title });
  expect(screen.queryByTestId("diff-pane")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Diff" }));
  const back = within(await screen.findByTestId("diff-pane"));
  expect(await back.findByRole("button", { name: "Expand topic" })).toBeTruthy();
  expect(back.queryByRole("button", { name: "Collapse topic" })).toBeNull();
});

test("revision picker loads the chosen revision and its commit range", async () => {
  newest = 2;
  openingRevision(
    { writeupEmpty: false, base: `abcdef1${"0".repeat(33)}`, head: `1234567${"0".repeat(33)}` },
    { writeupEmpty: false, base: "0".repeat(40), head: "worktree" },
  );
  const { history } = mount(`/r/${id}`);
  await screen.findByText("abcdef1 → 1234567");
  await chooseRevision(1);
  await screen.findByText("0000000 → working tree");
  expect(history.location.search).toContain("rev=1");
  expect(screen.getByRole("button", { name: "Revision 1, 2 is newer" })).toBeTruthy();
  expect(screen.queryByText("abcdef1 → 1234567")).toBeNull();
});

test("a published revision blocks stale actions even before review metadata catches up", async () => {
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Keep this instruction" } });
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  // newest stays 1 in the metadata fixture; the event is the newest known revision.
  act(() => Events.opened[0]?.emit("publish", { reviewId: id, revision: 2 }));
  const reason = "Revision 2 is newer. Switch to it to send or approve.";
  await screen.findByText(reason);
  for (const name of ["Send", "Approve revision 1"]) {
    const button = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const descriptions = button
      .getAttribute("aria-describedby")
      ?.split(" ")
      .map((key) => document.getElementById(key)?.textContent);
    expect(descriptions).toContain(reason);
  }
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep this instruction");
});

test("phone Diff navigation consumes pending heading focus before a later refetch", async () => {
  width = 390;
  let refreshed = false;
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path === `/api/v1/reviews/${secondItem.id}`
      ? Response.json({
          ...secondItem,
          updatedAt: refreshed ? "2026-01-02T00:00:00.000Z" : item.updatedAt,
          revisions: [{ seq: 1, createdAt: item.updatedAt }],
        })
      : (fallback?.(path, init) as Promise<Response>),
  );
  // A cached Diff revision renders without an intermediate loading header.
  client.setQueryData(["revision", secondItem.id, 1], revision);
  const { history } = mount(`/r/${id}?tab=diff`);
  await screen.findByTestId("diff-pane");
  act(() => history.push(`/r/${secondItem.id}?tab=diff`));
  await waitFor(() =>
    expect(client.getQueryData(reviewQuery(secondItem.id).queryKey)).toMatchObject({ id: secondItem.id }),
  );
  await screen.findByTestId("diff-pane");
  expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Writeup" }));
  const heading = await screen.findByRole("heading", { level: 1, name: secondItem.title });
  const keepFocus = screen.getByRole("button", { name: "More" });
  act(() => keepFocus.focus());
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  refreshed = true;
  await act(async () => {
    await client.refetchQueries({ queryKey: ["review", secondItem.id] });
  });
  expect(document.activeElement).toBe(keepFocus);
  expect(focus.mock.instances).not.toContain(heading);
});

test("pane defaults and choices are independent across desktop, tablet and phone", async () => {
  const { history } = mount(`/r/${id}`);
  await screen.findByText("Overview");
  const paneControls = () => within(screen.getByRole("radiogroup", { name: "Panes" }));
  expect(paneControls().getByRole("radio", { name: "Tabs" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByTestId("diff-pane").hidden).toBe(true);
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Writeup",
    "Files 0/1",
    "Docs1",
    "Comments",
    "Diff",
  ]);
  fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
  await waitFor(() => expect(history.location.search).toContain("tab=diff"));
  expect(screen.getByTestId("reading-pane").hidden).toBe(true);
  expect(screen.getByRole("tab", { name: "Diff" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
    screen.getByRole("tab", { name: "Diff" }).id,
  );
  fireEvent.click(paneControls().getByRole("radio", { name: "Split" }));
  expect(screen.getByTestId("reading-pane")).toBeTruthy();
  expect(screen.getByTestId("diff-pane")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Writeup" }).getAttribute("aria-selected")).toBe("true");
  act(() => resize(900));
  expect(paneControls().getByRole("radio", { name: "Tabs" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(paneControls().getByRole("radio", { name: "Split" }));
  expect(screen.getByRole("separator", { name: "Resize reading pane" })).toBeTruthy();
  expect(screen.queryByRole("separator", { name: "Resize inbox" })).toBeNull();
  act(() => resize(1280));
  fireEvent.click(paneControls().getByRole("radio", { name: "Tabs" }));
  act(() => resize(900));
  expect(paneControls().getByRole("radio", { name: "Split" }).getAttribute("aria-checked")).toBe("true");
  act(() => resize(390));
  expect(screen.queryByRole("radiogroup", { name: "Panes" })).toBeNull();
  expect(screen.queryByRole("separator")).toBeNull();
  expect(screen.getByRole("link", { name: "Diff" }).getAttribute("aria-current")).toBe("page");
});

test("Tabs without code has no Diff tab or reading resize handle", async () => {
  width = 900;
  openingRevision({ files: [] });
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(screen.queryByRole("tab", { name: "Diff" })).toBeNull();
  expect(screen.queryByRole("separator", { name: "Resize reading pane" })).toBeNull();
});

test("thread Show in place opens the Diff tab before navigating in Tabs mode", async () => {
  width = 900;
  withDiff();
  const { history } = mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("link", { name: "Show in place" }));
  await waitFor(() => expect(history.location.search).toContain("tab=diff"));
  expect(history.location.hash).toContain(`diff-thread-${id}`);
  const diff = within(await screen.findByTestId("diff-pane"));
  expect(await diff.findByText("Diff thread")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Diff" }).getAttribute("aria-selected")).toBe("true");
});

test("Topics map links open the Diff tab in Tabs mode", async () => {
  width = 900;
  withDiff();
  const { history } = mount(`/r/${id}`);
  const link = await screen.findByRole("link", { name: "Topic" });
  fireEvent.click(link);
  await waitFor(() => expect(history.location.search).toContain("tab=diff"));
  expect(history.location.hash).toContain("diff-topic-topic");
  expect(screen.getByRole("tab", { name: "Diff" }).getAttribute("aria-selected")).toBe("true");
});

test("phone menu offers Long lines, scroll by default, and saves Wrap", async () => {
  width = 390;
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu", { name: "More" }));
  const group = within(menu.getByRole("group", { name: "Long lines" }));
  expect(group.getByRole("menuitemradio", { name: "Scroll" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(group.getByRole("menuitemradio", { name: "Wrap" }));
  expect(JSON.parse(localStorage.getItem("emend.layout.v1") ?? "{}").wrap).toBe(true);
  expect(group.getByRole("menuitemradio", { name: "Wrap" }).getAttribute("aria-checked")).toBe("true");
});

test("phone menu on the Diff tab still offers Long lines", async () => {
  width = 390;
  withDiff();
  mount(`/r/${id}?tab=diff`);
  await screen.findByRole("region", { name: "Diff" }).catch(() => screen.findByTestId("diff-pane"));
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu", { name: "More" }));
  expect(menu.getByRole("group", { name: "Long lines" })).toBeTruthy();
});

test.each([1280, 900, 390])("text menu changes validated app variables at %s px", async (size) => {
  width = size;
  localStorage.setItem("emend.layout.v1", JSON.stringify({ proseSize: "18px; color: red", codeSize: 100 }));
  const { container } = mount(`/r/${id}`);
  await screen.findByText("Overview");
  const root = container.querySelector<HTMLElement>(".em-app");
  expect(root?.style.getPropertyValue("--reader-prose-size")).toBe("16px");
  expect(root?.style.getPropertyValue("--reader-code-size")).toBe("12px");
  fireEvent.keyDown(screen.getByRole("button", { name: size < 768 ? "More" : "Text size" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu"));
  fireEvent.click(menu.getByRole("menuitemradio", { name: "18 px" }));
  expect(root?.style.getPropertyValue("--reader-prose-size")).toBe("18px");
  fireEvent.click(menu.getByRole("menuitemradio", { name: "14 px" }));
  expect(root?.style.getPropertyValue("--reader-code-size")).toBe("14px");
  fireEvent.keyDown(menu.getByRole("menuitemradio", { name: "14 px" }), { key: "ArrowLeft" });
  expect(root?.style.getPropertyValue("--reader-code-size")).toBe("13px");
  fireEvent.keyDown(menu.getByRole("menuitemradio", { name: "13 px" }), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test.each([1280, 900])("Width menu changes the reading measure at %s px", async (size) => {
  width = size;
  const { container } = mount(`/r/${id}`);
  await screen.findByText("Overview");
  const root = container.querySelector<HTMLElement>(".em-app");
  expect(root?.style.getPropertyValue("--reader-measure")).toBe("1024px");
  for (const [value, label, measure] of [
    ["wide", "Wide 1248px", "1248px"],
    ["narrow", "Narrow 68ch", "68ch"],
    ["comfortable", "Comfortable 1024px", "1024px"],
  ]) {
    fireEvent.keyDown(screen.getByRole("button", { name: "Reading width" }), { key: "ArrowDown" });
    const menu = within(await screen.findByRole("menu", { name: "Reading width" }));
    fireEvent.click(menu.getByRole("menuitemradio", { name: label }));
    expect(layoutStore.getSnapshot().readingWidth).toBe(value);
    expect(root?.style.getPropertyValue("--reader-measure")).toBe(measure);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }
});

test.each(["writeup", "Markdown doc", "Markdown pub"])(
  "reading width reaches the %s content at 1280px",
  async (surface) => {
    width = 1280;
    const block: RenderedBlock = {
      id: "overview-12345678",
      section: "overview",
      kind: "paragraph",
      text: "A synthetic reading-width paragraph.",
      html: "<p>A synthetic reading-width paragraph.</p>",
    };
    openingRevision(
      surface === "writeup"
        ? {
            writeupEmpty: false,
            writeup: { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [block] }] },
          }
        : {
            main: surface === "Markdown pub" ? "plan.md" : null,
            writeup: { sections: [] },
            docs: [{ path: "plan.md", kind: "markdown", blocks: [block] }],
          },
    );
    const { container } = mount(`/r/${id}${surface === "Markdown doc" ? "?tab=docs&doc=plan.md" : ""}`);
    const content = await screen.findByText(block.text);
    const column = content.closest(".em-reading-column");
    const root = container.querySelector<HTMLElement>(".em-app");
    expect(column).not.toBeNull();
    expect(root).not.toBeNull();
    expect(column?.closest(".em-app")).toBe(root);
    expect(root?.style.getPropertyValue("--reader-measure")).toBe("1024px");
    for (const [label, measure] of [
      ["Wide 1248px", "1248px"],
      ["Narrow 68ch", "68ch"],
    ]) {
      fireEvent.keyDown(screen.getByRole("button", { name: "Reading width" }), { key: "ArrowDown" });
      const menu = within(await screen.findByRole("menu", { name: "Reading width" }));
      fireEvent.click(menu.getByRole("menuitemradio", { name: label }));
      expect(container.querySelector(".em-app")).toBe(root);
      expect(screen.getByText(block.text).closest(".em-reading-column")?.closest(".em-app")).toBe(root);
      expect(root?.style.getPropertyValue("--reader-measure")).toBe(measure);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }
  },
);

test("an HTML doc has no reading column at 1280px", async () => {
  width = 1280;
  openingRevision({
    main: "plan.html",
    writeup: { sections: [] },
    docs: [{ path: "plan.html", kind: "html", contentUrl: "/content/key/plan.html" }],
  });
  const { container } = mount(`/r/${id}`);
  await screen.findByRole("heading", { name: "plan.html" });
  const frame = container.querySelector('iframe[title="plan.html"]');
  expect(frame).not.toBeNull();
  const root = container.querySelector<HTMLElement>(".em-app");
  expect(root?.contains(frame)).toBe(true);
  expect(root?.style.getPropertyValue("--reader-measure")).toBe("1024px");
  expect(container.querySelector(".em-reading-column")).toBeNull();
});

test("phone menus omit reading width", async () => {
  width = 390;
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(screen.queryByRole("button", { name: "Reading width" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu", { name: "More" }));
  expect(menu.queryByRole("group", { name: "Reading width" })).toBeNull();
  expect(menu.queryByRole("menuitemradio", { name: "Comfortable 1024px" })).toBeNull();
});

test.each([1280, 800, 390].flatMap((size) => (["topics", "path"] as const).map((fileOrder) => ({ size, fileOrder }))))(
  "Files tab count excludes stale marks and row opens the diff at $size px in $fileOrder order",
  async ({ size, fileOrder }) => {
    onTestFinished(() => layoutStore.update({ fileOrder: "topics" }));
    width = size;
    layoutStore.update({ pane: { desktop: "split", tablet: "tabs" }, fileOrder });
    const viewed = {
      ...diffFile,
      id: "44444444-4444-4444-8444-444444444444",
      path: "viewed.txt",
      order: 1,
      viewed: "viewed" as const,
      viewedOn: 1,
    };
    openingRevision({
      files: [{ ...diffFile, viewed: "stale", viewedOn: 1 }, viewed],
      writeupEmpty: false,
      topics: [{ slug: "topic", title: "Topic", summary: "", importance: 1 }],
    });
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollTo");
    const { history } = mount(`/r/${id}?tab=files`);
    const filesTab = await screen.findByRole(size < 768 ? "link" : "tab", { name: "Files 1/2" });
    expect(filesTab.getAttribute(size < 768 ? "aria-current" : "aria-selected")).toBe(size < 768 ? "page" : "true");
    const reading = within(screen.getByTestId("reading-pane"));
    expect(reading.getByText("1 of 2 viewed")).toBeTruthy();
    expect(reading.getByText("changed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compact comments" })).toBeNull();
    for (const file of fileOrder === "path" ? [diffFile, viewed] : [diffFile]) {
      if (file === viewed && size < 1280) {
        fireEvent.click(screen.getByRole(size < 768 ? "link" : "tab", { name: "Files 1/2" }));
        await waitFor(() => expect(history.location.search).toContain("tab=files"));
      }
      const row = await screen.findByRole("button", { name: `Open diff for ${file.path}, modified` });
      scroll.mockClear();
      fireEvent.click(row);
      await waitFor(() => expect(history.location.hash).toBe(`#diff-file-${file.id}`));
      if (size < 1280) await waitFor(() => expect(history.location.search).toContain("tab=diff"));
      else expect(history.location.search).toContain("tab=files");
      await waitFor(() =>
        expect(
          scroll.mock.instances.some(
            (element) => element instanceof HTMLElement && element.hasAttribute("data-diff-scroll"),
          ),
        ).toBe(true),
      );
      expect(screen.getByTestId("diff-pane").hidden).toBe(false);
      const section = screen.getByRole("region", { name: `File ${file.path}` });
      expect(section.querySelector(`[id="diff-file-${file.id}"]`)).not.toBeNull();
      expect(within(section).getByRole("button", { name: "Collapse file" })).toBeTruthy();
    }
  },
);

test.each([1280, 800, 390])(
  "Files tab is absent and tab=files falls back without diff files at %s px",
  async (size) => {
    width = size;
    openingRevision({ files: [{ ...diffFile, role: "doc" }], writeupEmpty: false });
    mount(`/r/${id}?tab=files`);
    await screen.findByText("Overview");
    expect(screen.queryByRole(size < 768 ? "link" : "tab", { name: /^Files/ })).toBeNull();
    expect(
      screen
        .getByRole(size < 768 ? "link" : "tab", { name: "Writeup" })
        .getAttribute(size < 768 ? "aria-current" : "aria-selected"),
    ).toBe(size < 768 ? "page" : "true");
  },
);

test.each([false, true])("viewed mutation collapses optimistically and handles failure=%s", async (fail) => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  const fallback = fetchMock.getMockImplementation();
  const response = Promise.withResolvers<Response>();
  let viewed = false;
  fetchMock.mockImplementation(async (path, init) => {
    if (path.endsWith("/viewed")) {
      const result = await response.promise;
      if (result.ok) viewed = JSON.parse(String(init?.body)).viewed;
      return result;
    }
    if (path.includes("/revisions/"))
      return Response.json({
        ...revision,
        files: [{ ...diffFile, ...(viewed ? { viewed: "viewed", viewedOn: 1 } : {}) }],
      });
    return fallback?.(path, init) as Promise<Response>;
  });
  mount(`/r/${id}?tab=files`);
  const reading = within(await screen.findByTestId("reading-pane"));
  const toggle = await reading.findByRole("button", { name: "Mark new.txt as viewed" });
  const diff = within(await screen.findByRole("region", { name: "File new.txt" }));
  expect(diff.getByRole("button", { name: "Collapse file" })).toBeTruthy();
  fireEvent.click(toggle);
  await screen.findByRole("tab", { name: "Files 1/1" });
  expect(diff.getByRole("button", { name: "Expand file" })).toBeTruthy();
  expect(diff.getByRole("button", { name: "Unmark new.txt as viewed" }).getAttribute("aria-pressed")).toBe("true");
  expect(toggle.hasAttribute("disabled")).toBe(false);
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/v1/reviews/${id}/viewed`,
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ revision: 1, paths: ["new.txt"], viewed: true }),
    }),
  );
  await act(async () =>
    response.resolve(
      fail
        ? Response.json(
            { error: { code: "invalid_request", message: "Could not save viewed marks." } },
            { status: 400 },
          )
        : new Response(null, { status: 204 }),
    ),
  );
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  if (fail) {
    expect((await screen.findByRole("alert")).textContent).toContain("Could not save viewed marks.");
    expect(screen.getByRole("tab", { name: "Files 0/1" })).toBeTruthy();
    expect(diff.getByRole("button", { name: "Collapse file" })).toBeTruthy();
    expect(diff.queryByRole("button", { name: "Unmark new.txt as viewed" })).toBeNull();
  } else {
    fireEvent.click(diff.getByRole("button", { name: "Unmark new.txt as viewed" }));
    await screen.findByRole("tab", { name: "Files 0/1" });
    expect(diff.getByRole("button", { name: "Collapse file" })).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/reviews/${id}/viewed`,
        expect.objectContaining({ body: JSON.stringify({ revision: 1, paths: ["new.txt"], viewed: false }) }),
      ),
    );
  }
});

test.each(["diff file header", "Files tab"])("stale viewed mark in the %s can be checked once", async (place) => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  const fallback = fetchMock.getMockImplementation();
  let viewed = false;
  fetchMock.mockImplementation(async (path, init) => {
    if (path.endsWith("/viewed") && init?.method === "PUT") {
      viewed = JSON.parse(String(init.body)).viewed === true;
      return new Response(null, { status: 204 });
    }
    if (path.includes("/revisions/"))
      return Response.json({
        ...revision,
        files: [{ ...diffFile, viewed: viewed ? "viewed" : "stale", viewedOn: 1 }],
      });
    return fallback?.(path, init) as Promise<Response>;
  });
  mount(`/r/${id}${place === "Files tab" ? "?tab=files" : ""}`);
  await screen.findByRole("tab", { name: "Files 0/1" });
  const area = within(
    place === "diff file header"
      ? await screen.findByRole("region", { name: "File new.txt" })
      : await screen.findByTestId("reading-pane"),
  );
  const toggle = area.getByRole("button", {
    name: "Viewed in revision 1; this revision differs. Mark new.txt as viewed",
  });
  const box = toggle.querySelector(".em-viewed-mark__box");
  expect(box?.childElementCount).toBe(0);
  expect(box?.querySelector("svg")).toBeNull();
  expect(within(toggle).getByText("changed")).toBeTruthy();
  if (place === "diff file header")
    expect(within(toggle).getByText("Viewed").classList.contains("em-viewed-mark__label")).toBe(true);
  fireEvent.click(toggle);
  await screen.findByRole("tab", { name: "Files 1/1" });
  expect(area.getByRole("button", { name: "Unmark new.txt as viewed" }).getAttribute("aria-pressed")).toBe("true");
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith("/viewed"))).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/v1/reviews/${id}/viewed`,
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ revision: 1, paths: ["new.txt"], viewed: true }),
    }),
  );
});

test("topic viewed box sends every file in one request and marks them all", async () => {
  const fallback = fetchMock.getMockImplementation();
  const paths = ["new.txt", "second.txt"];
  let viewed = false;
  fetchMock.mockImplementation(async (path, init) => {
    if (path.endsWith("/viewed")) {
      viewed = JSON.parse(String(init?.body)).viewed;
      return new Response(null, { status: 204 });
    }
    if (path.includes("/revisions/"))
      return Response.json({
        ...revision,
        topics: [{ slug: "topic", title: "Topic", summary: "", importance: 1 }],
        files: paths.map((path, index) => ({
          ...diffFile,
          id: index ? "44444444-4444-4444-8444-444444444444" : diffFile.id,
          path,
          order: index,
          ...(viewed ? { viewed: "viewed", viewedOn: 1 } : {}),
        })),
      });
    return fallback?.(path, init) as Promise<Response>;
  });
  mount(`/r/${id}?tab=files`);
  fireEvent.click(await screen.findByRole("button", { name: "Mark topic Topic as viewed" }));
  await screen.findByRole("tab", { name: "Files 2/2" });
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith("/viewed"))).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/v1/reviews/${id}/viewed`,
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ revision: 1, paths, viewed: true }) }),
  );
  const toggle = screen.getByRole("button", { name: "Unmark topic Topic as viewed" });
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  fireEvent.click(toggle);
  await screen.findByRole("tab", { name: "Files 0/2" });
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/reviews/${id}/viewed`,
      expect.objectContaining({ body: JSON.stringify({ revision: 1, paths, viewed: false }) }),
    ),
  );
});

test("viewed events update boxes without changing folds; focus alone does not refetch revisions", async () => {
  layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } });
  let state: "viewed" | "stale" = "viewed";
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path.includes("/revisions/")
      ? Response.json({ ...revision, files: [{ ...diffFile, viewed: state, viewedOn: 1 }] })
      : (fallback?.(path, init) as Promise<Response>),
  );
  try {
    mount(`/r/${id}?tab=files`);
    await screen.findByRole("tab", { name: "Files 1/1" });
    const diff = within(await screen.findByRole("region", { name: "File new.txt" }));
    expect(diff.getByRole("button", { name: "Expand file" })).toBeTruthy();
    fireEvent.click(diff.getByRole("button", { name: "Expand file" }));
    state = "stale";
    const reads = () => fetchMock.mock.calls.filter(([path]) => path.includes("/revisions/")).length;
    const before = reads();
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(reads()).toBe(before);
    await waitFor(() => expect(Events.opened.length).toBeGreaterThan(0));
    act(() => Events.opened.at(-1)?.emit("viewed", { reviewId: id }));
    await screen.findByRole("tab", { name: "Files 0/1" });
    expect(diff.getByRole("button", { name: "Collapse file" })).toBeTruthy();
    expect(
      diff
        .getByRole("button", { name: "Viewed in revision 1; this revision differs. Mark new.txt as viewed" })
        .hasAttribute("data-stale"),
    ).toBe(true);
    expect(diff.getByText("changed")).toBeTruthy();
    state = "viewed";
    act(() => Events.opened.at(-1)?.emit("viewed", { reviewId: id }));
    await screen.findByRole("tab", { name: "Files 1/1" });
    expect(diff.getByRole("button", { name: "Collapse file" })).toBeTruthy();
  } finally {
    focusManager.setFocused(undefined);
  }
});

test("a confirmed live event refetches the review and the open Send window shows the pick-up", async () => {
  let pickedUpAt: string | null = null;
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    if (init?.method === "POST") return new Response(null, { status: 201 });
    if (path === `/api/v1/reviews/${id}`)
      return Response.json({
        ...item,
        unsentCount: 0,
        agentWaiting: !pickedUpAt,
        pendingSend: !pickedUpAt,
        pickedUpAt,
        revisions: [{ seq: 1, createdAt: item.updatedAt }],
      });
    return fallback?.(path, init) as Promise<Response>;
  });
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  await waitFor(() => expect(Events.opened).toHaveLength(1));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Carry on" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Waiting for the agent to pick this up…");
  pickedUpAt = "2026-03-05T12:00:00.000Z";
  act(() => {
    Events.opened[0]?.emit("confirmed", {
      reviewId: id,
      revision: 1,
      deliveryId: "44444444-4444-4444-8444-444444444444",
    });
  });
  await screen.findByText("The agent picked up your feedback.");
});
