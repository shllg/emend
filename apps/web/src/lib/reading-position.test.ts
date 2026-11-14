import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  applyAnchor,
  findAnchor,
  loadReadingPosition,
  readingCap,
  readingKey,
  readingPositionKey,
  saveReadingPosition,
} from "./reading-position.ts";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

test("a saved anchor round-trips under review, tab and doc", () => {
  const key = readingPositionKey("r1", "docs", "plan.md");
  saveReadingPosition(key, { id: "block-a-12345678", fraction: 0.25 }, 10);
  expect(loadReadingPosition(key)).toEqual({ id: "block-a-12345678", fraction: 0.25 });
  expect(loadReadingPosition(readingPositionKey("r1", "docs", "other.md"))).toBeUndefined();
  expect(loadReadingPosition(readingPositionKey("r1", "writeup"))).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(readingKey) ?? "{}")[key]).toEqual({
    id: "block-a-12345678",
    fraction: 0.25,
    at: 10,
  });
});

test("saving null forgets the position", () => {
  const key = readingPositionKey("r1", "writeup");
  saveReadingPosition(key, { id: "block-x", fraction: 0 });
  saveReadingPosition(key, null);
  expect(loadReadingPosition(key)).toBeUndefined();
});

test("the store keeps 200 entries and drops the oldest", () => {
  for (let index = 0; index < readingCap + 5; index++)
    saveReadingPosition(readingPositionKey(`r${index}`, "writeup"), { id: `block-${index}`, fraction: 0 }, index);
  const stored = JSON.parse(localStorage.getItem(readingKey) ?? "{}");
  expect(Object.keys(stored)).toHaveLength(readingCap);
  expect(loadReadingPosition(readingPositionKey("r0", "writeup"))).toBeUndefined();
  expect(loadReadingPosition(readingPositionKey("r4", "writeup"))).toBeUndefined();
  expect(loadReadingPosition(readingPositionKey("r5", "writeup"))).toBeTruthy();
  expect(loadReadingPosition(readingPositionKey(`r${readingCap + 4}`, "writeup"))).toBeTruthy();
});

test.each(["not json", "[]", "null", '"x"', '{"k":{"id":"","fraction":9,"at":"now"}}'])(
  "corrupt stored value %s reads as no position and a save repairs it",
  (raw) => {
    localStorage.setItem(readingKey, raw);
    const key = readingPositionKey("r1", "writeup");
    expect(loadReadingPosition(key)).toBeUndefined();
    saveReadingPosition(key, { id: "block-a", fraction: 0.5 });
    expect(loadReadingPosition(key)).toEqual({ id: "block-a", fraction: 0.5 });
  },
);

test("one bad entry does not drop its neighbours", () => {
  const good = readingPositionKey("r1", "writeup");
  localStorage.setItem(
    readingKey,
    JSON.stringify({ [good]: { id: "block-a", fraction: 0.5, at: 1 }, bad: { id: 3, fraction: "x", at: 1 } }),
  );
  expect(loadReadingPosition(good)).toEqual({ id: "block-a", fraction: 0.5 });
});

test("storage that throws never throws out of the helper", () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("denied");
  });
  const key = readingPositionKey("r1", "writeup");
  expect(() => saveReadingPosition(key, { id: "block-a", fraction: 0 })).not.toThrow();
  expect(loadReadingPosition(key)).toBeUndefined();
});

function scene(tops: Record<string, number>, scrollTop: number) {
  const scroller = document.createElement("div");
  document.body.append(scroller);
  scroller.scrollTop = scrollTop;
  for (const id of Object.keys(tops)) {
    const element = document.createElement("p");
    element.id = id;
    scroller.append(element);
  }
  const rect = (top: number, height: number) => new DOMRect(0, top, 300, height);
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(50, 500));
  // Document offsets are relative to the scroller's content; the viewport top is scroller top + scrollTop.
  for (const element of scroller.children)
    vi.spyOn(element, "getBoundingClientRect").mockImplementation(() =>
      rect(50 + (tops[element.id] ?? 0) - scroller.scrollTop, 100),
    );
  return scroller;
}

test("the anchor is the first element whose bottom is below the top edge, with the fraction into it", () => {
  const scroller = scene({ "block-a": 0, "block-b": 100, "block-c": 200 }, 125);
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual({ id: "block-b", fraction: 0.25 });
});

test("no anchor at the top, and the last element when scrolled past everything", () => {
  expect(findAnchor(scene({ "block-a": 0 }, 0), '[id^="block-"]')).toBeNull();
  document.body.replaceChildren();
  const scroller = scene({ "block-a": 0, "block-b": 100 }, 900);
  Object.defineProperty(scroller, "scrollHeight", { value: 1500 });
  Object.defineProperty(scroller, "clientHeight", { value: 500 });
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual({
    id: "block-b",
    fraction: 1,
    gap: 0.875,
  });
});

test("the search reads O(log n) rects and skips elements with an all-zero rect", () => {
  const tops: Record<string, number> = {};
  for (let index = 0; index < 512; index++) tops[`block-${index}`] = index * 100;
  const scroller = scene(tops, 30050);
  const reads = { count: 0 };
  for (const element of scroller.children) {
    const rect = vi.mocked(element.getBoundingClientRect);
    const impl = rect.getMockImplementation();
    rect.mockImplementation(() => {
      reads.count++;
      return (impl as () => DOMRect)();
    });
  }
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual({ id: "block-300", fraction: 0.5 });
  expect(reads.count).toBeLessThan(20);
});

test("a hidden element is never the anchor or the fallback", () => {
  const scroller = scene({ "block-a": 0, "block-b": 100, "block-c": 200 }, 120);
  const hide = (id: string) =>
    vi.spyOn(document.getElementById(id) as HTMLElement, "getBoundingClientRect").mockReturnValue(new DOMRect());
  hide("block-b");
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual({ id: "block-a", fraction: 1, gap: 0.2 });
  hide("block-c");
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual({ id: "block-a", fraction: 1 });
  hide("block-a");
  expect(findAnchor(scroller, '[id^="block-"]')).toBeNull();
});

test("applying an anchor puts element top plus fraction of its height at the scroller top", () => {
  const scroller = scene({ "block-a": 0, "block-b": 100, "block-c": 200 }, 0);
  expect(applyAnchor(scroller, { id: "block-b", fraction: 0.25 })).toBe(125);
  expect(scroller.scrollTop).toBe(125);
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual({ id: "block-b", fraction: 0.25 });
});

test("applying a missing anchor changes nothing", () => {
  const scroller = scene({ "block-a": 0 }, 0);
  expect(applyAnchor(scroller, { id: "block-gone", fraction: 0.5 })).toBeUndefined();
  expect(scroller.scrollTop).toBe(0);
});

test("restore rejects an arbitrary hash even if that element exists", () => {
  const scroller = scene({ "user-content-x": 100 }, 0);
  const lookup = vi.spyOn(document, "getElementById");
  expect(applyAnchor(scroller, { id: "user-content-x", fraction: 0 })).toBeUndefined();
  expect(lookup).not.toHaveBeenCalled();
});
test("heading restore validates and scopes the heading to its doc", () => {
  const outside = document.createElement("h2");
  outside.id = "thread-pretend";
  document.body.append(outside);
  const scroller = scene({}, 0);
  const doc = document.createElement("section");
  scroller.dataset.readingScroll = "";
  doc.dataset.readingDoc = "doc.md";
  const target = document.createElement("h2");
  target.id = outside.id;
  const block = document.createElement("div");
  block.id = "block-doc-heading";
  block.dataset.blockId = "doc-heading";
  block.dataset.blockKind = "heading";
  block.append(target);
  doc.append(block);
  scroller.append(doc);
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 150, 100, 100));
  const lookup = vi.spyOn(document, "getElementById");
  expect(
    applyAnchor(
      scroller,
      { id: "h-thread-pretend", fraction: 0.5 },
      {
        path: "doc.md",
        blocks: [{ id: "doc-heading", kind: "heading" }],
        headings: [{ level: 2, text: "Secret heading", id: target.id }],
      },
    ),
  ).toBe(150);
  expect(lookup).not.toHaveBeenCalled();
});
test("position keys separate revisions and views and storage strips content fields", () => {
  const key = readingPositionKey("r", "docs", "a.md", 2);
  expect(key).not.toBe(readingPositionKey("r", "docs", "a.md", 1));
  saveReadingPosition(key, {
    id: "block-a",
    fraction: 0.5,
    text: "Secret quote",
    contentUrl: "/content/private",
  } as never);
  expect(localStorage.getItem(readingKey)).not.toMatch(/Secret|content|quote/);
});

test("passage offsets account for the sticky doc bar", () => {
  const scroller = scene({ "block-a": 0, "block-b": 100, "block-c": 200 }, 0);
  const bar = document.createElement("div");
  bar.className = "em-doc-bar";
  scroller.prepend(bar);
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 50, 300, 100));
  expect(applyAnchor(scroller, { id: "block-c", fraction: 0.25 })).toBe(125);
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual({ id: "block-c", fraction: 0.25 });
});

test("R1.2 existing saved HTML frame anchors remain readable; topics are never saved", () => {
  const key = readingPositionKey("r", "docs", "page.html", 1);
  localStorage.setItem(readingKey, JSON.stringify({ [key]: { id: "html-doc-page.html", fraction: 0.25, at: 1 } }));
  expect(loadReadingPosition(key)).toEqual({ id: "html-doc-page.html", fraction: 0.25 });
  saveReadingPosition("topic", { id: "topic-seed", fraction: 0.5 });
  expect(loadReadingPosition("topic")).toBeUndefined();
});

test("R2.2 existing Comments thread anchors remain readable", () => {
  const key = readingPositionKey("r", "comments", "", 1);
  localStorage.setItem(readingKey, JSON.stringify({ [key]: { id: "thread-synthetic", fraction: 0.25, at: 1 } }));
  expect(loadReadingPosition(key)).toEqual({ id: "thread-synthetic", fraction: 0.25 });
});

test.each([6, 400])("a line in a %s px gap uses the previous shown block", (gap) => {
  const scroller = scene({ "block-a": 0, "block-b": 100 + gap, "block-c": 200 + gap }, 100 + gap / 2);
  const anchor = { id: "block-a", fraction: 1, gap: 0.5 };
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual(anchor);
  scroller.scrollTop = 0;
  expect(applyAnchor(scroller, anchor, undefined, '[id^="block-"]')).toBe(100 + gap / 2);
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual(anchor);
});

test("above the first shown block uses a gap from the start", () => {
  const scroller = scene({ "block-hidden": 0, "block-first": 100 }, 30);
  vi.mocked(scroller.children[0]?.getBoundingClientRect as () => DOMRect).mockReturnValue(new DOMRect());
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual({ id: "block-first", fraction: 0, gap: 0.3 });
});

test.each([0, 40])("a gap before the first anchor round-trips after resizing with a %s px sticky bar", (barHeight) => {
  const tops = { "block-hidden": 0, "block-first": 200 + barHeight };
  const scroller = scene(tops, 60);
  vi.mocked(scroller.children[0]?.getBoundingClientRect as () => DOMRect).mockReturnValue(new DOMRect());
  const bar = document.createElement("div");
  bar.className = "em-review-tabs";
  scroller.prepend(bar);
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 50, 300, barHeight));
  const anchor = findAnchor(scroller, '[id^="block-"]');
  expect(anchor).toEqual({ id: "block-first", fraction: 0, gap: 0.3 });
  if (!anchor) throw new Error("Missing anchor");
  tops["block-first"] += 200;
  scroller.scrollTop = 17;
  expect(applyAnchor(scroller, anchor, undefined, '[id^="block-"]')).toBe(120);
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual(anchor);
});

test.each([0, 40])("a gap after the last anchor round-trips after resizing with a %s px sticky bar", (barHeight) => {
  const tops = { "block-last": 200 + barHeight, "block-hidden": 1000 };
  const scroller = scene(tops, 500);
  let scrollHeight = 1600;
  Object.defineProperty(scroller, "scrollHeight", { get: () => scrollHeight });
  Object.defineProperty(scroller, "clientHeight", { value: 500 });
  vi.mocked(scroller.children[1]?.getBoundingClientRect as () => DOMRect).mockReturnValue(new DOMRect());
  const bar = document.createElement("div");
  bar.className = "em-review-tabs";
  scroller.prepend(bar);
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 50, 300, barHeight));
  const anchor = findAnchor(scroller, '[id^="block-"]');
  expect(anchor).toEqual({ id: "block-last", fraction: 1, gap: 0.25 });
  if (!anchor) throw new Error("Missing anchor");
  tops["block-last"] += 200;
  scrollHeight += 600;
  scroller.scrollTop = 17;
  expect(applyAnchor(scroller, anchor, undefined, '[id^="block-"]')).toBe(800);
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual(anchor);
});

test.each([0, 1])("a stored fraction %s without a gap still restores the element edge", (fraction) => {
  localStorage.setItem(readingKey, JSON.stringify({ old: { id: "block-a", fraction, at: 1 } }));
  const anchor = loadReadingPosition("old");
  expect(anchor).toEqual({ id: "block-a", fraction });
  if (!anchor) throw new Error("Missing anchor");
  const scroller = scene({ "block-a": 100 }, 30);
  Object.defineProperty(scroller, "scrollHeight", { value: 1500 });
  Object.defineProperty(scroller, "clientHeight", { value: 500 });
  expect(applyAnchor(scroller, anchor, undefined, '[id^="block-"]')).toBe(100 + fraction * 100);
});

test("a gap restore skips hidden anchors", () => {
  const scroller = scene({ "block-a": 0, "block-hidden": 150, "block-b": 300 }, 0);
  vi.mocked(scroller.children[1]?.getBoundingClientRect as () => DOMRect).mockReturnValue(new DOMRect());
  const anchor = { id: "block-a", fraction: 1, gap: 0.25 };
  expect(applyAnchor(scroller, anchor, undefined, '[id^="block-"]')).toBe(150);
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual(anchor);
});

test.each([undefined, ".missing", "#block-b"])(
  "a gap without its anchor in selector %s falls back to the bottom",
  (selector) => {
    const scroller = scene({ "block-a": 0, "block-b": 300 }, 0);
    Object.defineProperty(scroller, "scrollHeight", { value: 1500 });
    Object.defineProperty(scroller, "clientHeight", { value: 500 });
    expect(applyAnchor(scroller, { id: "block-a", fraction: 1, gap: 0.5 }, undefined, selector)).toBe(100);
  },
);

test("a gap after the last anchor falls back to its bottom when the content ends sooner", () => {
  const scroller = scene({ "block-a": 400 }, 0);
  Object.defineProperty(scroller, "scrollHeight", { value: 800 });
  Object.defineProperty(scroller, "clientHeight", { value: 500 });
  expect(applyAnchor(scroller, { id: "block-a", fraction: 1, gap: 0.5 }, undefined, '[id^="block-"]')).toBe(500);
});

test("gap anchors round-trip and clamp without changing old entries", () => {
  const old = { id: "block-old", fraction: 0.25 };
  localStorage.setItem(readingKey, JSON.stringify({ old: { ...old, at: 1 } }));
  const anchor = { id: "block-a", fraction: 1, gap: 0.25 };
  saveReadingPosition("gap", anchor);
  expect(loadReadingPosition("gap")).toEqual(anchor);
  expect(loadReadingPosition("old")).toEqual(old);
  const scroller = scene({ "block-old": 0, "block-a": 200 }, 0);
  expect(applyAnchor(scroller, loadReadingPosition("old") ?? old)).toBe(25);
  saveReadingPosition("high", { ...anchor, gap: 2 });
  saveReadingPosition("low", { ...anchor, gap: -1 });
  expect(loadReadingPosition("high")).toEqual({ ...anchor, gap: 1 });
  expect(loadReadingPosition("low")).toEqual({ ...anchor, gap: 0 });
});

test.each([-0.1, 1.1, "0.5", null])("stored gap %s drops only the invalid entry", (gap) => {
  localStorage.setItem(
    readingKey,
    JSON.stringify({
      bad: { id: "block-a", fraction: 1, gap, at: 1 },
      good: { id: "block-b", fraction: 0.5, at: 1 },
    }),
  );
  expect(loadReadingPosition("bad")).toBeUndefined();
  expect(loadReadingPosition("good")).toEqual({ id: "block-b", fraction: 0.5 });
});

test("a gap search still reads O(log n) rects", () => {
  const tops = Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`block-${index}`, index * 106]));
  const scroller = scene(tops, 300 * 106 + 103);
  expect(findAnchor(scroller, '[id^="block-"]')).toEqual({ id: "block-300", fraction: 1, gap: 0.5 });
  const reads = Array.from(scroller.children).reduce(
    (count, element) => count + vi.mocked(element.getBoundingClientRect).mock.calls.length,
    0,
  );
  expect(reads).toBeLessThan(20);
});

test.each(["finding", "applying"])("%s anchors ignores every element inside a reading popover", (operation) => {
  const scroller = scene({ "thread-popover": 100 }, 125);
  const card = document.getElementById("thread-popover") as HTMLElement;
  const popover = document.createElement("div");
  popover.dataset.readingThreadPopover = "";
  scroller.append(popover);
  popover.append(card);
  if (operation === "finding") expect(findAnchor(scroller, '[id^="thread-"]')).toBeNull();
  else expect(applyAnchor(scroller, { id: card.id, fraction: 0.5 })).toBeUndefined();
  expect(scroller.scrollTop).toBe(125);
});

test("gap restoration skips a popover between two passage anchors", () => {
  const scroller = scene({ "block-before": 0, "thread-popover": 150, "block-after": 300 }, 0);
  const card = document.getElementById("thread-popover") as HTMLElement;
  const popover = document.createElement("div");
  popover.dataset.readingThreadPopover = "";
  card.before(popover);
  popover.append(card);
  expect(applyAnchor(scroller, { id: "block-before", fraction: 1, gap: 0.5 }, undefined, "[id]")).toBe(200);
  expect(findAnchor(scroller, "[id]")).toEqual({ id: "block-before", fraction: 1, gap: 0.5 });
});
