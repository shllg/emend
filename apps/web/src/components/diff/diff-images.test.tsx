import type { FileView } from "@recense/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { diffLoads } from "../../lib/diff-loads.ts";
import { stubIntersectionObserver } from "../../test/intersection.ts";
import { FileDiff, type ParsedDiff } from "./FileDiff.tsx";
import { parsePair } from "./parse.worker.ts";

vi.mock("@pierre/diffs/react", () => ({
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => children,
  FileDiff: ({ fileDiff }: { fileDiff: ParsedDiff }) => (
    <pre data-testid="text-diff">{fileDiff.additionLines.join("")}</pre>
  ),
}));

const png = { mediaType: "image/png", flag: null } as const;
const svg = { mediaType: "image/svg+xml", flag: null } as const;
const file: FileView = {
  id: "11111111-1111-4111-8111-111111111111",
  path: "icons/leaf.png",
  oldPath: null,
  role: "diff",
  status: "modified",
  topic: null,
  order: 0,
  mediaType: "image/png",
  flag: "binary",
  hasOld: false,
  hasNew: false,
  image: { old: png, new: png },
};
const base = `/api/v1/files/${file.id}`;
const svgSource = '<svg onload=""><script>/* fixture */</script></svg>';
let client: QueryClient;
let intersections: ReturnType<typeof stubIntersectionObserver>;
let fetchText: ReturnType<typeof vi.fn<(path: string) => Promise<Response>>>;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchText = vi.fn(async (path: string) => new Response(path.endsWith("/old") ? "<svg/>" : svgSource));
  vi.stubGlobal("fetch", fetchText);
  intersections = stubIntersectionObserver();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(values: Partial<FileView> = {}) {
  const entry = { ...file, ...values };
  const onActive = vi.fn();
  const ui = (topicCollapsed: boolean, revealed: boolean) => (
    <QueryClientProvider client={client}>
      <FileDiff
        file={entry}
        topicCollapsed={topicCollapsed}
        revealedFile={revealed ? entry.id : undefined}
        reviewId="22222222-2222-4222-8222-222222222222"
        revision={1}
        threads={[]}
        changedBlocks={[]}
        active={null}
        onActive={onActive}
        parser={parsePair}
        fileForTarget={() => entry}
        diffStyle="unified"
        counts={new Map()}
        onParsed={vi.fn()}
        collapsedFiles={new Set()}
        toggleFile={vi.fn()}
        onContentRendered={vi.fn()}
      />
    </QueryClientProvider>
  );
  const { container, rerender } = render(ui(false, false));
  return { container, onActive, show: (collapsed: boolean, revealed: boolean) => rerender(ui(collapsed, revealed)) };
}
const button = (name: string) => screen.getByRole("button", { name });
function setNear(near: boolean) {
  act(() => intersections.intersect(screen.getByRole("region", { name: /^File / }), near));
}

test("modified PNG opens side by side and switches between its stored sides", () => {
  const { onActive } = mount();
  const modes = within(screen.getByRole("group", { name: "Compare images" }));
  expect(modes.getAllByRole("button").map((control) => control.textContent)).toEqual([
    "Before",
    "After",
    "Side by side",
  ]);
  expect(modes.getByRole("button", { name: "Side by side", pressed: true })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Show as" })).toBeNull();
  for (const [name, side] of [
    ["Before", "old"],
    ["After", "new"],
  ] as const) {
    const picture = screen.getByRole("img", { name });
    expect(picture.getAttribute("src")).toBe(`${base}/${side}/image`);
    expect(picture.getAttribute("loading")).toBe("lazy");
    expect(picture.getAttribute("decoding")).toBe("async");
  }
  for (const [name, hidden] of [
    ["Before", "After"],
    ["After", "Before"],
  ] as const) {
    fireEvent.click(button(name));
    expect(modes.getByRole("button", { name, pressed: true })).toBeTruthy();
    expect(screen.getByRole("img", { name })).toBeTruthy();
    expect(screen.queryByRole("img", { name: hidden })).toBeNull();
  }
  fireEvent.click(button("Comment on file"));
  expect(onActive).toHaveBeenCalledWith({ kind: "file", path: file.path });
  expect(screen.queryByText(/SVG.* holds?/)).toBeNull();
  expect(fetchText).not.toHaveBeenCalled();
});

test.each([
  ["added", { old: null, new: png }, "After", "After"],
  ["deleted", { old: png, new: null }, "Before", "Before"],
  ["renamed", { old: png, new: png, unchanged: true }, "After", "Unchanged image"],
] as const)("%s image shows one labelled picture", (status, image, name, label) => {
  mount({ status, image });
  expect(screen.queryByRole("group", { name: "Compare images" })).toBeNull();
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getAllByRole("img")).toEqual([screen.getByRole("img", { name })]);
  expect(screen.getByRole("img", { name }).getAttribute("src")).toBe(
    `${base}/${name === "Before" ? "old" : "new"}/image`,
  );
});

test("oversized and failed sides show their reason in place of the picture", () => {
  mount({ image: { old: { ...png, flag: "oversized" }, new: png } });
  expect(screen.getByText("Not shown: larger than 25 MiB")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Before" })).toBeNull();
  fireEvent.click(button("Open After image"));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.queryByRole("button", { name: "Previous image" })).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  fireEvent.error(screen.getByRole("img", { name: "After" }));
  expect(screen.getByText("Not shown: the image could not be loaded")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open After image" })).toBeNull();
});

test("SVG Pictures warns about the After source and shares its text queries with Text", async () => {
  const suffix = "HTML";
  const writes = vi.spyOn(Element.prototype, `inner${suffix}`, "set");
  const hold = vi.spyOn(diffLoads(client), "hold");
  const { container, show } = mount({
    path: "icons/leaf.svg",
    flag: null,
    hasOld: true,
    hasNew: true,
    image: { old: svg, new: svg },
    notes: [{ id: crypto.randomUUID(), side: "new", start: 1, end: 1, summary: "Inspect the outline." }],
  });
  const section = screen.getByRole("region", { name: "File icons/leaf.svg" });
  const body = section.querySelector(".em-diff-body");
  expect(section.style.minHeight).toBe("");
  expect(screen.getByRole("button", { name: "Pictures", pressed: true })).toBeTruthy();
  expect(body?.querySelectorAll("img")).toHaveLength(2);
  setNear(false);
  expect(fetchText).not.toHaveBeenCalled();
  setNear(true);
  const notice =
    "The After SVG holds a script and an event handler. The picture never runs them. Text shows the source.";
  expect(await screen.findByText(notice)).toBeTruthy();
  expect(body?.querySelector("svg, script, object, embed, iframe, [onload], [onerror]")).toBeNull();
  expect(writes).not.toHaveBeenCalled();
  setNear(false);
  expect(screen.getByText(notice)).toBeTruthy();
  fireEvent.click(button("Before"));
  show(true, false);
  show(false, true);
  expect(screen.getByRole("button", { name: "Before", pressed: true })).toBeTruthy();
  expect(section.hasAttribute("data-diff-loading")).toBe(false);
  expect(container.querySelector("[data-slot-pending]")).toBeNull();
  expect(hold).not.toHaveBeenCalled();

  fireEvent.click(button("Text"));
  expect(screen.getByRole("button", { name: "Text", pressed: true })).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Before" })).toBeNull();
  expect((await screen.findByTestId("text-diff")).textContent).toContain(svgSource);
  expect(fetchText.mock.calls.map(([path]) => path).sort()).toEqual([`${base}/new`, `${base}/old`]);
  fireEvent.click(button("Pictures"));
  expect(screen.queryByTestId("text-diff")).toBeNull();
  expect(screen.getByRole("img", { name: "Before" })).toBeTruthy();
  expect(section.hasAttribute("data-diff-loading")).toBe(false);
  expect(container.querySelector("[data-slot-pending]")).toBeNull();
});

test("a clean SVG opens without a notice and only fetches its existing side", async () => {
  fetchText.mockImplementation(async () => new Response("<svg/>"));
  mount({ path: "leaf.svg", status: "added", flag: null, hasNew: true, image: { old: null, new: svg } });
  setNear(true);
  await waitFor(() => expect(client.getQueryData(["file", "reviews", file.id, "new"])).toBe("<svg/>"));
  expect(screen.queryByText(/SVG.* holds?/)).toBeNull();
  expect(fetchText.mock.calls.map(([path]) => path)).toEqual([`${base}/new`]);
});

test("a raster with text sides does not fetch text for an SVG notice", () => {
  mount({ flag: null, hasOld: true, hasNew: true });
  setNear(true);
  expect(screen.queryByText(/SVG.* holds?/)).toBeNull();
  expect(fetchText).not.toHaveBeenCalled();
});

test("a raster and SVG pair requests only the SVG text when it enters the viewport", async () => {
  mount({
    path: "leaf.svg",
    oldPath: "leaf.png",
    status: "renamed",
    flag: null,
    hasOld: true,
    hasNew: true,
    image: { old: png, new: svg },
  });
  expect(fetchText).not.toHaveBeenCalled();
  setNear(true);
  expect(await screen.findByText(/The After SVG holds a script and an event handler\./)).toBeTruthy();
  expect(fetchText.mock.calls.map(([path]) => path)).toEqual([`${base}/new`]);
  expect(screen.queryByText(/not checked/)).toBeNull();
});

test("a single notice names both active SVG sides", async () => {
  fetchText.mockImplementation(
    async (path) => new Response(path.endsWith("/old") ? "<svg><script/></svg>" : "<svg><foreignObject/></svg>"),
  );
  mount({ path: "leaf.svg", flag: null, hasOld: true, hasNew: true, image: { old: svg, new: svg } });
  setNear(true);
  expect(await screen.findByText(/The Before and After SVGs hold a script and embedded HTML\./)).toBeTruthy();
  expect(screen.getAllByText(/SVGs? holds?/)).toHaveLength(1);
});

test("a failed SVG picture marks only the side without reported kinds unchecked", async () => {
  mount({ path: "leaf.svg", flag: null, hasOld: true, hasNew: true, image: { old: svg, new: svg } });
  setNear(true);
  const active = /The After SVG holds a script and an event handler\./;
  expect(await screen.findByText(active)).toBeTruthy();
  expect(screen.queryByText(/not checked/)).toBeNull();
  fireEvent.error(screen.getByRole("img", { name: "After" }));
  expect(screen.getByText(active)).toBeTruthy();
  expect(screen.queryByText(/not checked/)).toBeNull();
  fireEvent.error(screen.getByRole("img", { name: "Before" }));
  expect(screen.getByText(/The Before SVG source was not checked/)).toBeTruthy();
  expect(screen.getByText(active)).toBeTruthy();
});

test("flagged SVG sides show an unchecked notice without fetching text", () => {
  mount({ path: "large.svg", flag: "oversized", hasOld: true, hasNew: true, image: { old: svg, new: svg } });
  setNear(true);
  expect(
    screen.getByText(
      "The Before and After SVG sources were not checked for scripts or links. The picture never runs scripts.",
    ),
  ).toBeTruthy();
  expect(fetchText).not.toHaveBeenCalled();
});

test("a missing text side and an active side are both reported", async () => {
  mount({ path: "leaf.svg", flag: null, hasNew: true, image: { old: svg, new: svg } });
  setNear(true);
  expect(await screen.findByText(/The After SVG holds a script and an event handler\./)).toBeTruthy();
  expect(screen.getByText(/The Before SVG source was not checked/)).toBeTruthy();
  expect(fetchText.mock.calls.map(([path]) => path)).toEqual([`${base}/new`]);
});

test.each([
  ["failed request", 404, ""],
  ["entity declaration", 200, '<!DOCTYPE svg [<!ENTITY label "Leaf">]><svg/>'],
] as const)("the notice names the unchecked SVG side for a %s", async (_reason, status, source) => {
  fetchText.mockImplementation(async () => new Response(source, { status }));
  mount({ path: "leaf.svg", status: "added", flag: null, hasNew: true, image: { old: null, new: svg } });
  setNear(true);
  expect(
    await screen.findByText(
      "The After SVG source was not checked for scripts or links. The picture never runs scripts.",
    ),
  ).toBeTruthy();
  expect(fetchText.mock.calls.map(([path]) => path)).toEqual([`${base}/new`]);
});

test("an SVG on either side offers Text even when the text diff is flagged", () => {
  mount({ oldPath: "icons/leaf.svg", image: { old: svg, new: png } });
  fireEvent.click(button("Text"));
  expect(screen.getByText("Not shown: binary file")).toBeTruthy();
  expect(screen.getByRole("group", { name: "Compare images" })).toBeTruthy();
  fireEvent.click(button("Pictures"));
  expect(screen.getAllByRole("img")).toHaveLength(2);
  expect(fetchText).not.toHaveBeenCalled();
});

test("lightbox opens at the clicked side and includes both stored sides in order", () => {
  const oldPath = "icons/seed.png";
  mount({ oldPath, status: "renamed" });
  fireEvent.click(button("After"));
  fireEvent.click(button("Open After image"));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByRole("heading").textContent).toBe(`After · ${file.path}`);
  expect(dialog.getByText("2 of 2")).toBeTruthy();
  expect(dialog.getByAltText(`After · ${file.path}`).getAttribute("src")).toBe(`${base}/new/image`);
  expect(dialog.queryByRole("button", { name: /Comment/ })).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Previous image" }));
  expect(dialog.getByRole("heading").textContent).toBe(`Before · ${oldPath}`);
  expect(dialog.getByAltText(`Before · ${oldPath}`).getAttribute("src")).toBe(`${base}/old/image`);
  expect(dialog.getByRole("button", { name: "Next image" })).toBeTruthy();
});

test("a binary file without image metadata keeps its summary", () => {
  mount({ image: undefined });
  expect(screen.getByText("Not shown: binary file")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByRole("group", { name: "Compare images" })).toBeNull();
});
