import type { RenderedBlock } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { blockAnchor } from "../../lib/selection.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import { BlockReader, type ReaderGroup } from "./BlockReader.tsx";
import { DIAGRAM_DRAW_TIMEOUT_MS } from "./MermaidBlock.tsx";

const reviewId = "11111111-1111-4111-8111-111111111111";
const media = (hash: string) => `/api/v1/media/${hash.repeat(64)}`;
const imageHtml = (hash: string, caption: string, alt = caption) =>
  `<span class="emend-media"><img src="${media(hash)}" alt="${alt}"><span class="emend-media-caption">${caption}</span></span>`;
const row: RenderedBlock = {
  id: "overview-11111111",
  section: "overview",
  kind: "paragraph",
  text: "Before After",
  html: `<p class="emend-media-row">${imageHtml("a", "Before")}${imageHtml("b", "After")}</p>`,
};
const paragraph: RenderedBlock = {
  id: "overview-22222222",
  section: "overview",
  kind: "paragraph",
  text: "Plant a seed.",
  html: "<p>Plant a seed.</p>",
};
const later: RenderedBlock = {
  id: "overview-33333333",
  section: "overview",
  kind: "paragraph",
  text: "garden.png",
  html: `<p>${imageHtml("c", "garden.png", "")}<span class="emend-media"><img alt="No source"></span><span class="emend-media"><img src="/other.png" alt="Other source"></span></p>`,
};
const groups: ReaderGroup[] = [
  { key: "overview", blocks: [row, paragraph] },
  { key: "details", blocks: [], subsections: [{ key: "body", kind: "body", heading: "Details", blocks: [later] }] },
];
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
let stageSize: { width: number; height: number };
let resize: () => void;
function viewport(phone: boolean) {
  vi.stubGlobal("matchMedia", () => ({ matches: !phone, addEventListener() {}, removeEventListener() {} }));
}
beforeEach(() => {
  localStorage.clear();
  window.getSelection()?.removeAllRanges();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  fetchMock = vi.fn(async () => Response.json({ threadId: reviewId, commentId: reviewId }, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  viewport(false);
  stageSize = { width: 832, height: 632 };
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-lightbox-stage")
      ? { ...stageSize, x: 0, y: 0, top: 0, left: 0, right: stageSize.width, bottom: stageSize.height, toJSON() {} }
      : rect.call(this);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(readerGroups = groups) {
  const ui = (next: ReaderGroup[], id = reviewId, revision = 1) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BlockReader reviewId={id} revision={revision} changedBlocks={[]} threads={[]} groups={next} />
      </ToastProvider>
    </QueryClientProvider>
  );
  const result = render(ui(readerGroups));
  return {
    ...result,
    replace: (next: ReaderGroup[], id = reviewId, revision = 1) => result.rerender(ui(next, id, revision)),
  };
}
function open(name = "Before") {
  const opener = screen.getByRole("button", { name: `Open screenshot: ${name}` });
  act(() => opener.focus());
  fireEvent.click(opener);
  return opener;
}
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
function expectUnavailable(control: HTMLButtonElement) {
  expect(control.getAttribute("aria-disabled")).toBe("true");
  expect(control.hasAttribute("disabled")).toBe(false);
}
function enter(control: HTMLButtonElement) {
  fireEvent.keyDown(control, { key: "Enter" });
  // happy-dom does not synthesize the native button click from a keyboard event.
  fireEvent.click(control, { detail: 0 });
  fireEvent.keyUp(control, { key: "Enter" });
}
const dialog = () => screen.getByRole("dialog");
const stage = () => {
  const element = dialog().querySelector<HTMLElement>("[data-lightbox-stage]");
  if (!element) throw new Error("Missing stage");
  return element;
};
function load() {
  const image = dialog().querySelector("img");
  if (!image) throw new Error("Missing image");
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 1600 },
    naturalHeight: { configurable: true, value: 1200 },
  });
  fireEvent.load(image);
  return image;
}
function drag(element: Element, from: [number, number], to: [number, number], pointerType = "touch", pointerId = 1) {
  fireEvent.pointerDown(element, { pointerId, pointerType, button: 0, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(element, { pointerId, pointerType, clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(element, { pointerId, pointerType, clientX: to[0], clientY: to[1] });
}

function dispatchAt(element: Element, event: Event, timeStamp: number) {
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  fireEvent(element, event);
}
const pointer = (type: string) =>
  new PointerEvent(type, {
    bubbles: true,
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    clientX: 400,
    clientY: 300,
  });
const clickOnly = () => new MouseEvent("click", { bubbles: true, detail: 0, clientX: 400, clientY: 300 });

test("marks only direct, declared media images, and refreshes marks when block HTML changes", () => {
  const { container, replace } = mount();
  const images = [...container.querySelectorAll("img")];
  for (const [index, caption] of ["Before", "After", "garden.png"].entries()) {
    expect(images[index]?.tabIndex).toBe(0);
    expect(images[index]?.getAttribute("role")).toBe("button");
    expect(images[index]?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(images[index]?.getAttribute("aria-label")).toBe(`Open screenshot: ${caption}`);
  }
  for (const image of images.slice(3)) {
    expect(image.hasAttribute("tabindex")).toBe(false);
    expect(image.hasAttribute("role")).toBe(false);
    fireEvent.click(image);
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  replace([{ key: "overview", blocks: [{ ...row, html: `<p>${imageHtml("a", "Updated")}</p>` }] }]);
  expect(button("Open screenshot: Updated").tabIndex).toBe(0);
});

test.each([
  "/api/v1/media/short",
  `/api/v1/media/${"A".repeat(64)}`,
  `${media("a")}?size=2`,
  `//localhost${media("a")}`,
  `${media("a")}/extra`,
])("rejects non-exact media src %s", (src) => {
  const { container } = mount([
    {
      key: "overview",
      blocks: [{ ...row, html: `<span class="emend-media"><img src="${src}" alt="Invalid"></span>` }],
    },
  ]);
  const image = container.querySelector("img");
  expect(image?.hasAttribute("role")).toBe(false);
});

test("ignores unwrapped images, nested images and author-prefixed wrappers", () => {
  const { container } = mount([
    {
      key: "overview",
      blocks: [
        {
          ...row,
          html: `<p><img src="${media("a")}"><span class="emend-media"><span><img src="${media("b")}"></span></span><span class="user-content-emend-media"><img src="${media("c")}"></span></p>`,
        },
      ],
    },
  ]);
  expect(container.querySelectorAll("img[role]")).toHaveLength(0);
});

test("opens in the shared reader with a plain caption and counter", () => {
  const { container } = mount(groups);
  open();
  expect(dialog().getAttribute("aria-modal")).toBe("true");
  expect(within(dialog()).getByRole("heading", { name: "Before" })).toBeTruthy();
  expect(within(dialog()).getByText("1 of 3")).toBeTruthy();
  expect(container.contains(dialog())).toBe(false);
  expect(document.activeElement).toBe(button("Close"));
});

test.each(["Enter", " "])("%s opens a focused screenshot and prevents the default action", (key) => {
  mount();
  const image = button("Open screenshot: After");
  act(() => image.focus());
  expect(fireEvent.keyDown(image, { key })).toBe(false);
  expect(within(dialog()).getByRole("heading", { name: "After" })).toBeTruthy();
  expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
});

test("arrows and buttons navigate DOM order without wrapping; focus remains on the toolbar", () => {
  mount();
  open();
  expectUnavailable(button("Previous screenshot"));
  fireEvent.keyDown(dialog(), { key: "ArrowLeft" });
  fireEvent.keyDown(dialog(), { key: "ArrowRight" });
  expect(within(dialog()).getByRole("heading", { name: "After" })).toBeTruthy();
  const next = button("Next screenshot");
  act(() => next.focus());
  fireEvent.click(next);
  expect(within(dialog()).getByText("3 of 3")).toBeTruthy();
  expect(within(dialog()).getByRole("heading", { name: "garden.png" })).toBeTruthy();
  expect(next.isConnected).toBe(true);
  expectUnavailable(next);
  fireEvent.keyDown(dialog(), { key: "ArrowRight" });
  expect(within(dialog()).getByText("3 of 3")).toBeTruthy();
  fireEvent.keyDown(dialog(), { key: "ArrowLeft" });
  fireEvent.click(button("Previous screenshot"));
  expect(within(dialog()).getByText("1 of 3")).toBeTruthy();
});

test.each([
  ["Previous screenshot", "1 of 3", "ArrowRight"],
  ["Next screenshot", "3 of 3", "ArrowLeft"],
])("%s retains focus at the end and arrow navigation still works", (name, position, key) => {
  mount();
  open("After");
  const control = button(name);
  act(() => control.focus());
  enter(control);
  expect(within(dialog()).getByText(position)).toBeTruthy();
  expectUnavailable(control);
  expect(document.activeElement).toBe(control);
  enter(control);
  expect(within(dialog()).getByText(position)).toBeTruthy();
  expect(document.activeElement).toBe(control);
  fireEvent.keyDown(document.activeElement as HTMLElement, { key });
  expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
  expect(control.getAttribute("aria-disabled")).toBe("false");
  expect(document.activeElement).toBe(control);
});

test.each(["Zoom in", "Zoom out", /^Fit to screen/])(
  "%s keeps focus through navigation and loading, and arrows keep working",
  (name) => {
    mount();
    open();
    load();
    fireEvent.click(button("Zoom in"));
    const control = button(name);
    act(() => control.focus());
    expect(control.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(button(/^Fit to screen/));
    expect(document.activeElement).toBe(control);
    fireEvent.keyDown(control, { key: "ArrowRight" });
    expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
    expectUnavailable(control);
    expect(document.activeElement).toBe(control);
    enter(control);
    expect(dialog().querySelector("img")?.style.visibility).toBe("hidden");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(within(dialog()).getByText("3 of 3")).toBeTruthy();
    expect(document.activeElement).toBe(control);
    expect(load().style.transform).toContain("scale(0.5)");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
    expect(document.activeElement).toBe(control);
  },
);

test.each([
  ["Zoom out", 1, "scale(0.5)"],
  ["Zoom in", 6, "scale(4)"],
] as const)("%s retains focus and stops acting at its zoom limit", (name, presses, transform) => {
  mount();
  open();
  const image = load();
  if (name === "Zoom out") fireEvent.click(button("Zoom in"));
  const control = button(name);
  act(() => control.focus());
  for (let i = 0; i < presses; i++) enter(control);
  expect(image.style.transform).toContain(transform);
  expectUnavailable(control);
  expect(document.activeElement).toBe(control);
  const atLimit = image.style.transform;
  enter(control);
  expect(image.style.transform).toBe(atLimit);
  expect(document.activeElement).toBe(control);
});

test.each(["Zoom in", "Zoom out", /^Fit to screen/])("%s stays focusable and inert after an image error", (name) => {
  mount();
  open();
  const image = load();
  fireEvent.click(button("Zoom in"));
  const control = button(name);
  act(() => control.focus());
  const zoomBeforeError = button(/^Fit to screen/).textContent;
  fireEvent.error(image);
  expectUnavailable(control);
  expect(document.activeElement).toBe(control);
  enter(control);
  expect(button(/^Fit to screen/).textContent).toBe(zoomBeforeError);
  expect(within(dialog()).getByRole("status").textContent).toBe("The screenshot could not load.");
});

test.each(["Escape", "Close", "backdrop"])("%s closes and returns focus to the opener", async (method) => {
  mount();
  const opener = open();
  if (method === "Escape") fireEvent.keyDown(dialog(), { key: "Escape" });
  else if (method === "Close") fireEvent.click(button("Close"));
  else drag(stage(), [5, 5], [5, 5]);
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

test.each([false, true])(
  "comment handoff preserves textarea focus and cancellation restores the screenshot (phone=%s)",
  async (phone) => {
    viewport(phone);
    mount();
    const opener = open("After");
    fireEvent.click(button("Comment on screenshot"));
    const input = screen.getByRole("textbox", { name: "Comment" });
    // Let FocusScope's delayed unmount restoration run before checking the new editor.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("heading", { name: "After" })).toBeNull();
    expect(screen.getByText("Before After", { selector: "mark" })).toBeTruthy();
    if (phone) expect(screen.getByRole("dialog", { name: "New comment" })).toBeTruthy();
    else
      expect(input.closest(".em-reading-block")?.querySelector("[data-block-id]")?.getAttribute("data-block-id")).toBe(
        row.id,
      );
    fireEvent.click(button("Cancel"));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  },
);

test.each(["skim topic", "glossary"])("commenting on a gallery screenshot reveals its folded %s", async (kind) => {
  const folded: ReaderGroup = {
    key: "folded",
    heading: "Garden details",
    blocks: [later],
    ...(kind === "glossary"
      ? { presentation: "glossary" as const }
      : {
          topic: {
            slug: "garden",
            title: "Garden details",
            summary: "A synthetic garden",
            importance: 1,
            door: "two-way" as const,
            attention: "skim" as const,
          },
        }),
  };
  const { container } = mount([{ key: "overview", blocks: [row, paragraph] }, folded]);
  const section = container.querySelector<HTMLElement>('[data-reading-section="folded"]');
  if (!section) throw new Error("Missing folded group");
  const isFolded = () =>
    kind === "glossary"
      ? section.querySelector("details")?.open === false
      : section.querySelector('[hidden="until-found"]') !== null;
  expect(isFolded()).toBe(true);
  open();
  fireEvent.click(button("Next screenshot"));
  expect(within(dialog()).getByRole("heading", { name: "After" })).toBeTruthy();
  fireEvent.keyDown(dialog(), { key: "ArrowRight" });
  expect(within(dialog()).getByText("3 of 3")).toBeTruthy();
  expect(within(dialog()).getByRole("heading", { name: "garden.png" })).toBeTruthy();
  expect(isFolded()).toBe(true);
  fireEvent.click(button("Comment on screenshot"));
  const input = screen.getByRole("textbox", { name: "Comment" });
  expect(section.contains(input)).toBe(true);
  expect(isFolded()).toBe(false);
  expect(input.closest("[hidden], details:not([open])")).toBeNull();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test.each([
  ["revision", reviewId, 2],
  ["review", "22222222-2222-4222-8222-222222222222", 1],
] as const)("changing the %s closes the gallery snapshot", async (_kind, id, revision) => {
  const { replace } = mount();
  const opener = open();
  replace(groups, id, revision);
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(opener.isConnected).toBe(false);
  const nextOpener = open();
  expect(nextOpener).not.toBe(opener);
  expect(within(dialog()).getByText("1 of 3")).toBeTruthy();
});

test.each([undefined, "garden.md"])("comment submits the same block target with path %s", async (path) => {
  mount([{ key: "overview", blocks: [row], path }]);
  open("After");
  fireEvent.click(button("Comment on screenshot"));
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "A synthetic note" } });
  fireEvent.click(button("Save comment"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body).target).toEqual(
    path ? { kind: "doc-span", path, ...blockAnchor(row) } : { kind: "writeup-span", ...blockAnchor(row) },
  );
});

test.each(["heading", "empty", "removed"])("hides Comment when the block is %s", (kind) => {
  const block = {
    ...row,
    ...(kind === "heading" ? { kind: "heading" as const } : kind === "empty" ? { text: "" } : {}),
  };
  const view = mount([{ key: "overview", blocks: [block] }]);
  open();
  if (kind === "removed") view.replace([]);
  expect(screen.queryByRole("button", { name: "Comment on screenshot" })).toBeNull();
});

test("loading, zoom buttons, image clicks, wheel and fit update the natural-size transform", () => {
  mount();
  open();
  expect(dialog().querySelector("img")?.style.visibility).toBe("hidden");
  expectUnavailable(button("Zoom in"));
  const image = load();
  expect(image.style.visibility).toBe("visible");
  expect(image.style.transform).toContain("scale(0.5)");
  expectUnavailable(button("Zoom out"));
  fireEvent.click(button("Zoom in"));
  expect(image.style.transform).toContain("scale(0.75)");
  fireEvent.click(image, { clientX: 400, clientY: 300 });
  expect(image.style.transform).toContain("scale(1)");
  fireEvent.click(button(/^Fit to screen/));
  expect(image.style.transform).toContain("scale(0.5)");
  expect(fireEvent.wheel(stage(), { deltaY: -1000, clientX: 400, clientY: 300 })).toBe(false);
  expect(image.style.transform).not.toContain("scale(0.5)");
  fireEvent.wheel(stage(), { deltaY: -1000 });
  expect(image.style.transform).toContain("scale(4)");
  expectUnavailable(button("Zoom in"));
  fireEvent.click(button("Next screenshot"));
  expect(dialog().querySelector("img")?.style.visibility).toBe("hidden");
  expect(load().style.transform).toContain("scale(0.5)");
});

test("arrow keys pan a zoomed image and navigate screenshots after fitting", () => {
  mount();
  open();
  const image = load();
  const zoomIn = button("Zoom in");
  act(() => zoomIn.focus());
  enter(zoomIn);
  const position = () => {
    const values = image.style.transform.match(/^translate\(([-\d.]+)px, ([-\d.]+)px\)/);
    if (!values) throw new Error("Missing image translation");
    return { x: Number(values[1]), y: Number(values[2]) };
  };
  const initial = position();
  expect(fireEvent.keyDown(zoomIn, { key: "ArrowRight" })).toBe(false);
  expect(position().x).toBeCloseTo(initial.x - stageSize.width * 0.15);
  expect(within(dialog()).getByText("1 of 3")).toBeTruthy();
  expect(fireEvent.keyDown(zoomIn, { key: "ArrowDown" })).toBe(false);
  expect(position().y).toBeCloseTo(initial.y - stageSize.height * 0.15);
  expect(fireEvent.keyDown(zoomIn, { key: "ArrowLeft" })).toBe(false);
  expect(position().x).toBeCloseTo(initial.x);
  expect(fireEvent.keyDown(zoomIn, { key: "ArrowUp" })).toBe(false);
  expect(position().y).toBeCloseTo(initial.y);
  expect(within(dialog()).getByText(/when zoomed in, the arrow keys move the image/)).toBeTruthy();
  fireEvent.click(button(/^Fit to screen/));
  expect(fireEvent.keyDown(zoomIn, { key: "ArrowRight" })).toBe(false);
  expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
  expect(document.activeElement).toBe(zoomIn);
  load();
  enter(zoomIn);
  fireEvent.click(button("Previous screenshot"));
  expect(within(dialog()).getByText("1 of 3")).toBeTruthy();
});

test("the fit button's accessible name includes its visible zoom percentage", () => {
  mount();
  open();
  const fit = button(/^Fit to screen/);
  expect(fit.textContent).toBe("Fit");
  expect(fit.getAttribute("aria-label")).toBe("Fit to screen");
  load();
  expect(fit.textContent).toBe("50%");
  expect(button("Fit to screen, 50%")).toBe(fit);
  fireEvent.click(button("Zoom in"));
  expect(fit.textContent).toBe("75%");
  expect(button("Fit to screen, 75%")).toBe(fit);
  fireEvent.click(button("Next screenshot"));
  expect(fit.textContent).toBe("Fit");
  expect(fit.getAttribute("aria-label")).toBe("Fit to screen");
});

test.each(["pointercancel", "lostpointercapture"])("%s does not swallow the next click-only activation", (type) => {
  mount();
  open();
  const image = load();
  dispatchAt(image, pointer("pointerdown"), 100);
  dispatchAt(image, pointer(type), 150);
  dispatchAt(image, clickOnly(), 151);
  expect(image.style.transform).toContain("scale(1)");
});

test("the compatibility click immediately after a handled tap is ignored", () => {
  mount();
  open();
  const image = load();
  dispatchAt(image, pointer("pointerdown"), 100);
  dispatchAt(image, pointer("pointerup"), 200);
  expect(image.style.transform).toContain("scale(1)");
  dispatchAt(stage(), clickOnly(), 201);
  expect(image.style.transform).toContain("scale(1)");
  expect(screen.getByRole("dialog")).toBeTruthy();
  dispatchAt(image, clickOnly(), 202);
  expect(image.style.transform).toContain("scale(0.5)");
});

test("click-only activation after the suppression window toggles on its first try", () => {
  mount();
  open();
  const image = load();
  dispatchAt(image, pointer("pointerdown"), 100);
  dispatchAt(image, pointer("pointerup"), 200);
  expect(image.style.transform).toContain("scale(1)");
  dispatchAt(image, clickOnly(), 701);
  expect(image.style.transform).toContain("scale(0.5)");
});

test("a new pointerdown clears pending compatibility-click suppression", () => {
  mount();
  open();
  const image = load();
  dispatchAt(image, pointer("pointerdown"), 100);
  dispatchAt(image, pointer("pointerup"), 200);
  dispatchAt(image, pointer("pointerdown"), 250);
  dispatchAt(image, pointer("pointercancel"), 260);
  dispatchAt(image, clickOnly(), 261);
  expect(image.style.transform).toContain("scale(0.5)");
});

test("resize refits at fit and clamps while zoomed, including without ResizeObserver", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  mount();
  open();
  const image = load();
  stageSize = { width: 432, height: 332 };
  fireEvent(window, new Event("resize"));
  expect(image.style.transform).toContain("scale(0.25)");
  fireEvent.click(image);
  expect(image.style.transform).toContain("scale(1)");
  stageSize = { width: 832, height: 632 };
  fireEvent(window, new Event("resize"));
  expect(image.style.transform).toContain("scale(1)");
});

test("ResizeObserver refits the stage", () => {
  mount();
  open();
  const image = load();
  stageSize = { width: 432, height: 332 };
  act(() => resize());
  expect(image.style.transform).toContain("scale(0.25)");
});

test("swipes navigate at fit, vertical moves do not close, and zoomed drags pan", () => {
  mount();
  open();
  load();
  drag(stage(), [400, 300], [100, 310]);
  expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
  load();
  drag(stage(), [400, 300], [410, 500]);
  expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
  drag(stage(), [100, 300], [400, 310], "mouse");
  expect(within(dialog()).getByText("1 of 3")).toBeTruthy();
  const image = load();
  drag(image, [400, 300], [400, 300]);
  const before = image.style.transform;
  expect(before).toContain("scale(1)");
  drag(image, [400, 300], [300, 250]);
  expect(image.style.transform).not.toBe(before);
  expect(within(dialog()).getByText("1 of 3")).toBeTruthy();
});

test("two touch pointers pinch without tapping or swiping on release", () => {
  mount();
  open();
  const image = load();
  const pointer = (pointerId: number, clientX: number) => ({
    pointerId,
    pointerType: "touch",
    button: 0,
    clientX,
    clientY: 300,
  });
  fireEvent.pointerDown(image, pointer(1, 300));
  fireEvent.pointerDown(image, pointer(2, 500));
  fireEvent.pointerMove(image, pointer(2, 700));
  expect(image.style.transform).toContain("scale(1)");
  fireEvent.pointerUp(image, pointer(2, 700));
  fireEvent.pointerUp(image, pointer(1, 300));
  expect(image.style.transform).toContain("scale(1)");
  expect(within(dialog()).getByText("1 of 3")).toBeTruthy();
});

test("image errors retain the caption and navigation; a single image has no navigation", () => {
  mount([{ key: "overview", blocks: [later] }]);
  open("garden.png");
  const image = dialog().querySelector("img");
  if (!image) throw new Error("Missing image");
  fireEvent.error(image);
  expect(within(dialog()).getByRole("status").textContent).toBe("The screenshot could not load.");
  expect(within(dialog()).getByRole("heading", { name: "garden.png" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Previous screenshot" })).toBeNull();
  expect(screen.queryByText("1 of 1")).toBeNull();
});

test.each(["click", "Enter", " "])(
  "%s opens a screenshot after text selection and clears the selection prompt",
  (activation) => {
    const { container } = mount();
    const node = container.querySelector(`[data-block-id="${paragraph.id}"] p`)?.firstChild;
    if (!node) throw new Error("Missing paragraph");
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    const selection = window.getSelection();
    selection?.addRange(range);
    fireEvent.mouseUp(node.parentElement as HTMLElement);
    expect(button("Comment on selection")).toBeTruthy();
    expect(selection?.isCollapsed).toBe(false);
    const image = button("Open screenshot: Before");
    if (activation === "click") fireEvent.click(image);
    else {
      act(() => image.focus());
      expect(fireEvent.keyDown(image, { key: activation })).toBe(false);
    }
    expect(within(dialog()).getByRole("heading", { name: "Before" })).toBeTruthy();
    expect(selection?.rangeCount).toBe(0);
    expect(selection?.isCollapsed).toBe(true);
    expect(container.textContent).not.toContain("Comment on selection");
  },
);

test.each([".emend-media-caption", "p.emend-media-row"])(
  "clicking %s does not open a screenshot or clear selection",
  (selector) => {
    const { container } = mount();
    const element = container.querySelector(selector);
    if (!element) throw new Error("Missing screenshot caption or row");
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.addRange(range);
    fireEvent.click(element);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(selection?.isCollapsed).toBe(false);
  },
);

test.each(["ctrlKey", "metaKey", "altKey", "shiftKey"])("modifier %s does not open a screenshot", (modifier) => {
  mount();
  fireEvent.click(button("Open screenshot: Before"), { [modifier]: true });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("hostile captions stay literal text and caption fallbacks remain accessible", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  mount([
    { key: "overview", blocks: [{ ...row, html: `<p>${imageHtml("a", "&lt;img src=x onerror=alert(1)&gt;")}</p>` }] },
  ]);
  open(hostile);
  expect(within(dialog()).getByRole("heading").textContent).toBe(hostile);
  expect(dialog().querySelectorAll("img")).toHaveLength(1);
  expect(dialog().querySelector("[onerror]")).toBeNull();
  expect(dialog().querySelector("img")?.getAttribute("src")).toBe(media("a"));
});

test.each([
  ["Alternative", "Alternative"],
  ["", "Screenshot"],
])("missing caption falls back from alt '%s' to '%s'", (alt, name) => {
  mount([
    {
      key: "overview",
      blocks: [
        {
          ...row,
          html: `<span class="emend-media"><img src="${media("a")}" alt="${alt}"><span class="emend-media-caption"> </span></span>`,
        },
      ],
    },
  ]);
  open(name);
  expect(within(dialog()).getByRole("heading", { name })).toBeTruthy();
});

const diagramBlock: RenderedBlock = {
  id: "overview-44444444",
  section: "overview",
  kind: "diagram",
  text: "graph TD; A-->B",
  source: "graph TD; A-->B",
  html: "",
};
const mixedGroups: ReaderGroup[] = [
  {
    key: "overview",
    blocks: [
      { ...row, text: "Before", html: `<p>${imageHtml("a", "Before")}</p>` },
      diagramBlock,
      { ...later, text: "After", html: `<p>${imageHtml("b", "After")}</p>` },
    ],
  },
];
function diagramFrame() {
  const frame = dialog().querySelector("iframe");
  if (!frame) throw new Error("Missing diagram frame");
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  return { frame, post };
}
function frameSize(frame: HTMLIFrameElement, data: unknown) {
  fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data }));
}
function diagramSubject() {
  const subject = dialog().querySelector<HTMLElement>("div[data-lightbox-subject]");
  if (!subject) throw new Error("Missing diagram subject");
  return subject;
}
function loadDiagram() {
  const { frame, post } = diagramFrame();
  fireEvent.load(frame);
  frameSize(frame, { type: "size", height: 200, natural: { width: 400, height: 200 } });
  return { frame, post, subject: diagramSubject() };
}

test("Enlarge joins screenshots and diagrams in DOM order, with mixed labels and arrow navigation", () => {
  mount(mixedGroups);
  const icon = button("Enlarge diagram").querySelector("svg");
  if (!icon) throw new Error("Missing Enlarge icon");
  fireEvent.click(icon);
  expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
  expect(within(dialog()).getByRole("heading", { name: "Diagram" }).className).toBe("sr-only");
  expect(dialog().querySelector("footer")).toBeNull();
  expect(
    within(dialog()).getByText(
      "Diagram 2 of 3. Left and Right arrows move between screenshots and diagrams; when zoomed in, the arrow keys move the diagram. Escape closes.",
    ),
  ).toBeTruthy();
  expect(button("Next")).toBeTruthy();
  fireEvent.click(button("Previous"));
  expect(within(dialog()).getByText("1 of 3")).toBeTruthy();
  expect(within(dialog()).getByRole("heading", { name: "Before" })).toBeTruthy();
  expect(dialog().querySelector("footer")).not.toBeNull();
  expect(dialog().querySelector("iframe")).toBeNull();
  expect(load().style.transform).toContain("scale(0.5)");
  fireEvent.click(button("Next"));
  expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
  const first = loadDiagram();
  expect(first.subject.style.transform).toContain("scale(2)");
  fireEvent.click(button("Next"));
  expect(within(dialog()).getByText("3 of 3")).toBeTruthy();
  expect(within(dialog()).getByRole("heading", { name: "After" })).toBeTruthy();
  expect(load().style.transform).toContain("scale(0.5)");
  fireEvent.keyDown(dialog(), { key: "ArrowLeft" });
  expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
  expect(diagramSubject().style.visibility).toBe("hidden");
  expect(loadDiagram().frame).not.toBe(first.frame);
  fireEvent.keyDown(dialog(), { key: "ArrowLeft" });
  expect(within(dialog()).getByText("1 of 3")).toBeTruthy();
  fireEvent.keyDown(dialog(), { key: "ArrowRight" });
  fireEvent.keyDown(dialog(), { key: "ArrowRight" });
  expect(within(dialog()).getByText("3 of 3")).toBeTruthy();
});

test("lightbox frame sends only one render and accepts the first valid non-pending size from its own window", () => {
  const { container } = mount(mixedGroups);
  const inline = container.querySelector("iframe");
  fireEvent.click(button("Enlarge diagram"));
  const { frame, post } = diagramFrame();
  expect(frame).not.toBe(inline);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toBe("/mermaid-frame.html");
  expect(frame.getAttribute("tabindex")).toBe("-1");
  expect(frame.hasAttribute("loading")).toBe(false);
  for (const className of ["pointer-events-none", "block", "h-full", "w-full", "border-0", "bg-transparent"])
    expect(frame.classList.contains(className)).toBe(true);
  expect(post).not.toHaveBeenCalled();
  fireEvent.load(frame);
  fireEvent.load(frame);
  expect(post).toHaveBeenCalledExactlyOnceWith({ type: "render", source: diagramBlock.source }, "*");
  const subject = diagramSubject();
  const hidden = () => {
    expect(subject.style.visibility).toBe("hidden");
    expect(subject.style.width).toBe("100%");
    expect(subject.style.height).toBe("100%");
    expectUnavailable(button("Zoom in"));
  };
  hidden();
  fireEvent(
    window,
    new MessageEvent("message", {
      source: window,
      data: { type: "size", height: 200, natural: { width: 400, height: 200 } },
    }),
  );
  hidden();
  for (const data of [
    { type: "size", height: 200 },
    { type: "size", height: 200, natural: undefined },
    { type: "size", height: 200, natural: { width: 0, height: 200 } },
    { type: "size", height: 200, natural: { width: 400, height: Infinity } },
    { type: "size", height: 0, natural: { width: 400, height: 200 } },
    { type: "navigate", height: 200, natural: { width: 400, height: 200 } },
  ]) {
    frameSize(frame, data);
    hidden();
  }
  frameSize(frame, { type: "size", height: 200, natural: { width: 400, height: 200 } });
  expect(subject.style.width).toBe("400px");
  expect(subject.style.height).toBe("200px");
  expect(subject.style.visibility).toBe("visible");
  expect(subject.style.transform).toBe("translate(16px, 116px) scale(2)");
  fireEvent.click(button("Zoom in"));
  const zoomed = subject.style.transform;
  expect(zoomed).toContain("scale(3)");
  frameSize(frame, { type: "size", height: 400, natural: { width: 800, height: 400 } });
  frameSize(frame, { type: "size", height: 42, natural: null });
  expect(subject.style.transform).toBe(zoomed);
  expect(subject.style.width).toBe("400px");
  expect(subject.style.height).toBe("200px");
  expect(within(dialog()).queryByRole("status")).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
});

test("a failed diagram keeps its title, comment action and navigation", () => {
  mount(mixedGroups);
  fireEvent.click(button("Enlarge diagram"));
  const { frame } = diagramFrame();
  frameSize(frame, { type: "size", height: 42, natural: null });
  expect(within(dialog()).getByRole("status").textContent).toBe("The diagram could not be drawn.");
  expect(within(dialog()).getByRole("heading", { name: "Diagram" })).toBeTruthy();
  expect(button("Comment on diagram")).toBeTruthy();
  expectUnavailable(button("Zoom in"));
  expectUnavailable(button("Zoom out"));
  expectUnavailable(button(/^Fit to screen/));
  fireEvent.click(button("Next"));
  expect(within(dialog()).getByRole("heading", { name: "After" })).toBeTruthy();
});

test("diagram taps, clicks, wheel and toolbar zoom share fit, pan and navigation behavior", () => {
  mount(mixedGroups);
  fireEvent.click(button("Enlarge diagram"));
  const { subject } = loadDiagram();
  expectUnavailable(button("Zoom out"));
  fireEvent.click(subject, { clientX: 400, clientY: 300, detail: 0 });
  expect(subject.style.transform).toContain("scale(4)");
  fireEvent.click(subject, { clientX: 400, clientY: 300, detail: 0 });
  expect(subject.style.transform).toContain("scale(2)");
  drag(subject, [400, 300], [400, 300]);
  expect(subject.style.transform).toContain("scale(4)");
  const beforePan = subject.style.transform;
  drag(subject, [400, 300], [300, 250]);
  expect(subject.style.transform).not.toBe(beforePan);
  const beforeArrow = subject.style.transform;
  fireEvent.keyDown(dialog(), { key: "ArrowRight" });
  expect(subject.style.transform).not.toBe(beforeArrow);
  expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
  fireEvent.click(button(/^Fit to screen/));
  expect(subject.style.transform).toContain("scale(2)");
  fireEvent.click(button("Zoom in"));
  expect(subject.style.transform).toContain("scale(3)");
  fireEvent.click(button("Zoom out"));
  expect(subject.style.transform).toContain("scale(2)");
  expect(fireEvent.wheel(subject, { deltaY: -100, clientX: 400, clientY: 300 })).toBe(false);
  expect(subject.style.transform).not.toContain("scale(2)");
  fireEvent.wheel(subject, { deltaY: -10000, clientX: 400, clientY: 300 });
  expect(subject.style.transform).toContain("scale(8)");
  expectUnavailable(button("Zoom in"));
  fireEvent.click(button(/^Fit to screen/));
  fireEvent.keyDown(dialog(), { key: "ArrowRight" });
  expect(within(dialog()).getByText("3 of 3")).toBeTruthy();
});

test.each([undefined, "garden.md"])(
  "diagram comment closes the gallery and saves its block target with path %s",
  async (path) => {
    const { container } = mount(mixedGroups.map((group) => ({ ...group, path })));
    // Each open Markdown doc has its own reader; neither gallery includes the other's items.
    mount([{ key: "other-doc", path: "other.md", blocks: [{ ...row, id: "other-11111111" }] }]);
    const enlarge = within(container).getByRole("button", { name: "Enlarge diagram" });
    act(() => enlarge.focus());
    fireEvent.click(enlarge);
    expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
    fireEvent.click(button("Previous"));
    expect(within(dialog()).getByText("1 of 3")).toBeTruthy();
    expectUnavailable(button("Previous"));
    fireEvent.click(button("Next"));
    fireEvent.click(button("Next"));
    expect(within(dialog()).getByText("3 of 3")).toBeTruthy();
    expectUnavailable(button("Next"));
    fireEvent.click(button("Previous"));
    fireEvent.click(button("Comment on diagram"));
    expect(screen.queryByRole("dialog")).toBeNull();
    const input = screen.getByRole("textbox", { name: "Comment" });
    expect(input.closest(".em-reading-block")?.querySelector("[data-block-id]")?.getAttribute("data-block-id")).toBe(
      diagramBlock.id,
    );
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: "A synthetic diagram note" } });
    fireEvent.click(button("Save comment"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body).target).toEqual(
      path
        ? { kind: "doc-span", path, ...blockAnchor(diagramBlock) }
        : { kind: "writeup-span", ...blockAnchor(diagramBlock) },
    );
    await waitFor(() => expect(document.activeElement).toBe(enlarge));
  },
);

test("diagram-only galleries have diagram labels and an invisible title without a caption footer", () => {
  mount([{ key: "overview", blocks: [diagramBlock, { ...diagramBlock, id: "overview-55555555", source: undefined }] }]);
  fireEvent.click(screen.getAllByRole("button", { name: "Enlarge diagram" })[0] as HTMLElement);
  expect(screen.getByRole("dialog", { name: "Diagram" })).toBeTruthy();
  expect(within(dialog()).getByRole("heading").className).toBe("sr-only");
  expect(dialog().querySelector("footer")).toBeNull();
  expect(
    within(dialog()).getByText(
      "Diagram 1 of 2. Left and Right arrows move between diagrams; when zoomed in, the arrow keys move the diagram. Escape closes.",
    ),
  ).toBeTruthy();
  expectUnavailable(button("Previous diagram"));
  fireEvent.click(button("Next diagram"));
  expect(within(dialog()).getByText("2 of 2")).toBeTruthy();
  const { post } = loadDiagram();
  expect(post).toHaveBeenCalledExactlyOnceWith({ type: "render", source: diagramBlock.text }, "*");
  expectUnavailable(button("Next diagram"));
});

test.each(["Enter", " "])("native %s activates Enlarge once, through its click only", (key) => {
  mount(mixedGroups);
  const enlarge = button("Enlarge diagram");
  act(() => enlarge.focus());
  expect(fireEvent.keyDown(enlarge, { key })).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(enlarge, { detail: 0 });
  const frame = dialog().querySelector("iframe");
  fireEvent.keyUp(enlarge, { key });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(dialog().querySelector("iframe")).toBe(frame);
  expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
});

test.each(["ctrlKey", "metaKey", "altKey", "shiftKey"])("modifier %s does not enlarge a diagram", (modifier) => {
  mount(mixedGroups);
  fireEvent.click(button("Enlarge diagram"), { [modifier]: true });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test.each(["unmarked", "non-diagram", "unknown-block", "outside-reader", "not-a-button", "prevented"])(
  "rejects %s diagram activation and excludes invalid entries from collection",
  (kind) => {
    const { container } = mount(mixedGroups);
    const real = button("Enlarge diagram");
    const block = real.closest("[data-block-id]");
    if (!block) throw new Error("Missing diagram block");
    const candidate = document.createElement(kind === "not-a-button" ? "span" : "button");
    candidate.textContent = "Invalid enlarge";
    if (kind !== "unmarked") candidate.setAttribute("data-lightbox-diagram", "");
    if (kind === "non-diagram") container.querySelector(`[data-block-id="${row.id}"]`)?.append(candidate);
    else if (kind === "unknown-block" || kind === "outside-reader") {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-block-id", kind === "unknown-block" ? "unknown" : diagramBlock.id);
      wrapper.setAttribute("data-block-kind", "diagram");
      wrapper.append(candidate);
      (kind === "outside-reader" ? container : block).append(wrapper);
    } else block.append(candidate);
    const target = kind === "prevented" ? real : candidate;
    if (kind === "prevented") candidate.remove();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    if (kind === "prevented") event.preventDefault();
    fireEvent(target, event);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(real);
    expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
  },
);

test("all-screenshot gallery description stays unchanged", () => {
  mount();
  open();
  expect(
    within(dialog()).getByText(
      "Screenshot 1 of 3. Left and Right arrows move between screenshots; when zoomed in, the arrow keys move the image. Escape closes.",
    ),
  ).toBeTruthy();
});

test("a diagram frame that never reports shows the failure after the draw timeout", () => {
  vi.useFakeTimers();
  try {
    mount(mixedGroups);
    fireEvent.click(button("Enlarge diagram"));
    const { frame } = diagramFrame();
    fireEvent.load(frame);
    expect(within(dialog()).queryByRole("status")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(DIAGRAM_DRAW_TIMEOUT_MS);
    });
    expect(within(dialog()).getByRole("status").textContent).toBe("The diagram could not be drawn.");
  } finally {
    vi.useRealTimers();
  }
});

test("a size that arrives before the draw timeout keeps the diagram visible", () => {
  vi.useFakeTimers();
  try {
    mount(mixedGroups);
    fireEvent.click(button("Enlarge diagram"));
    const { subject } = loadDiagram();
    act(() => {
      vi.advanceTimersByTime(DIAGRAM_DRAW_TIMEOUT_MS * 2);
    });
    expect(within(dialog()).queryByRole("status")).toBeNull();
    expect(subject.style.visibility).toBe("visible");
    expect(subject.style.width).toBe("400px");
    expect(subject.style.height).toBe("200px");
  } finally {
    vi.useRealTimers();
  }
});

test("a size message from a stale lightbox frame is ignored", () => {
  mount(mixedGroups);
  fireEvent.click(button("Enlarge diagram"));
  const first = diagramFrame().frame;
  const stale = first.contentWindow;
  fireEvent.click(button("Next"));
  fireEvent.click(button("Previous"));
  const { frame } = diagramFrame();
  expect(frame).not.toBe(first);
  const subject = diagramSubject();
  fireEvent(
    window,
    new MessageEvent("message", {
      source: stale,
      data: { type: "size", height: 200, natural: { width: 400, height: 200 } },
    }),
  );
  expect(subject.style.visibility).toBe("hidden");
  expect(subject.style.width).toBe("100%");
  expect(subject.style.height).toBe("100%");
  expect(within(dialog()).queryByRole("status")).toBeNull();
  frameSize(frame, { type: "size", height: 200, natural: { width: 400, height: 200 } });
  expect(subject.style.visibility).toBe("visible");
  expect(subject.style.width).toBe("400px");
  expect(subject.style.height).toBe("200px");
});

test.each(["Close", "Escape"])("closing a diagram lightbox with %s returns focus to Enlarge", (how) => {
  mount(mixedGroups);
  const enlarge = button("Enlarge diagram");
  act(() => enlarge.focus());
  fireEvent.click(enlarge);
  expect(document.activeElement).not.toBe(enlarge);
  if (how === "Close") fireEvent.click(button("Close"));
  else fireEvent.keyDown(dialog(), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  return waitFor(() => expect(document.activeElement).toBe(enlarge));
});
