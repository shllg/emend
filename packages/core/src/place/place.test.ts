import { type LinesTarget, Placement } from "@emend/contract";
import { expect, test } from "vitest";
import { renderDoc, renderMarkdown } from "../render/markdown.ts";
import { type PlaceContext, placeThread } from "./place.ts";
import { makeSpan } from "./span.ts";

function context(): PlaceContext {
  return { writeup: [], docs: new Map(), files: new Map(), renamedFrom: new Map(), topics: new Set(), last: null };
}

const topicQuote = {
  kind: "topic",
  slug: "garden",
  part: "title",
  quote: "seed",
  prefix: "Plant a ",
  suffix: ".",
} as const;
test.each([
  { part: "title", title: "Plant a seed.", summary: "Details", start: 8 },
  { part: "summary", title: "Details", summary: "Plant a seed.", start: 8 },
  { part: "title", title: "  Plant\n a  seed.  ", summary: "Details", start: 8 },
] as const)("places a quote on $part at normalized offset $start", ({ part, title, summary, start }) => {
  const ctx = { ...context(), topics: new Set(["garden"]), topicText: new Map([["garden", { title, summary }]]) };
  expect(placeThread({ ...topicQuote, part }, ctx)).toEqual({
    status: "placed",
    location: { kind: "topic", slug: "garden", part, start, end: start + 4 },
  });
});

test("a topic quote follows its context into the summary when the title keeps only the quoted word", () => {
  const ctx = context();
  ctx.topicAnchor = { part: "title", text: "Remove the cache entirely." };
  ctx.topics = new Set(["garden"]);
  ctx.topicText = new Map([["garden", { title: "Increase cache capacity.", summary: "Remove the cache entirely." }]]);
  expect(placeThread({ ...topicQuote, quote: "cache", prefix: "Remove the ", suffix: " entirely." }, ctx)).toEqual({
    status: "placed",
    location: { kind: "topic", slug: "garden", part: "summary", start: 11, end: 16 },
  });
});

test("a topic quote is block-gone when only its surrounding words changed", () => {
  const ctx = context();
  ctx.topicAnchor = { part: "title", text: "Plant a seed." };
  ctx.topics = new Set(["garden"]);
  ctx.topicText = new Map([["garden", { title: "Now plant this seed!", summary: "Details" }]]);
  expect(placeThread(topicQuote, ctx)).toEqual({ status: "unplaced", reason: "block-gone" });
});

test("one context match in the unchanged last part wins over other quote and context matches", () => {
  const ctx = context();
  ctx.topicAnchor = { part: "title", text: "red seed blue seed" };
  ctx.topics = new Set(["garden"]);
  ctx.topicText = new Map([["garden", { title: "red seed blue seed", summary: "red seed" }]]);
  expect(placeThread({ ...topicQuote, prefix: "red ", suffix: "" }, ctx)).toEqual({
    status: "placed",
    location: { kind: "topic", slug: "garden", part: "title", start: 4, end: 8 },
  });
});

test("a changed title with context in both parts is ambiguous", () => {
  const ctx = context();
  ctx.topics = new Set(["garden"]);
  ctx.topicAnchor = { part: "title", text: "remove the cache entirely." };
  ctx.topicText = new Map([
    [
      "garden",
      { title: "Do not remove the cache entirely.", summary: "Previous proposal: remove the cache entirely." },
    ],
  ]);
  expect(placeThread({ ...topicQuote, quote: "cache", prefix: "remove the ", suffix: " entirely." }, ctx)).toEqual({
    status: "unplaced",
    reason: "ambiguous",
  });
});

test.each(["Plant a seed.", "  Plant\n a  seed.  "])(
  "an unchanged normalized title keeps its quote when the summary also has its context: %s",
  (title) => {
    const ctx = context();
    ctx.topics = new Set(["garden"]);
    ctx.topicAnchor = { part: "title", text: "Plant a seed." };
    ctx.topicText = new Map([["garden", { title, summary: "Plant a seed." }]]);
    expect(placeThread(topicQuote, ctx)).toEqual({
      status: "placed",
      location: { kind: "topic", slug: "garden", part: "title", start: 8, end: 12 },
    });
  },
);

test("an unchanged title places by its unique quote alone even without matching context", () => {
  const ctx = context();
  ctx.topics = new Set(["garden"]);
  ctx.topicAnchor = { part: "title", text: "Now plant this seed!" };
  ctx.topicText = new Map([["garden", { title: "Now plant this seed!", summary: "Plant a seed." }]]);
  expect(placeThread(topicQuote, ctx)).toEqual({
    status: "placed",
    location: { kind: "topic", slug: "garden", part: "title", start: 15, end: 19 },
  });
});

test("a changed title places through a globally unique context match", () => {
  const ctx = context();
  ctx.topics = new Set(["garden"]);
  ctx.topicAnchor = { part: "title", text: "Plant a seed." };
  ctx.topicText = new Map([["garden", { title: "Now Plant a seed.", summary: "The seed grows." }]]);
  expect(placeThread(topicQuote, ctx)).toEqual({
    status: "placed",
    location: { kind: "topic", slug: "garden", part: "title", start: 12, end: 16 },
  });
});

test("a whole-title quote in a changed title places when the bare quote is globally unique", () => {
  const ctx = context();
  ctx.topics = new Set(["garden"]);
  ctx.topicAnchor = { part: "title", text: "Plant a seed." };
  ctx.topicText = new Map([["garden", { title: "Now Plant a seed.", summary: "Details" }]]);
  expect(placeThread({ ...topicQuote, quote: "Plant a seed.", prefix: "", suffix: "" }, ctx)).toEqual({
    status: "placed",
    location: { kind: "topic", slug: "garden", part: "title", start: 4, end: 17 },
  });
});

test.each([false, true])("without an anchor neither the target nor last part gets priority (last: %s)", (last) => {
  const ctx = context();
  ctx.topics = new Set(["garden"]);
  ctx.last = last ? { location: { kind: "topic", slug: "garden", part: "title", start: 8, end: 12 } } : null;
  ctx.topicText = new Map([["garden", { title: "Plant a seed.", summary: "Plant a seed." }]]);
  expect(placeThread(topicQuote, ctx)).toEqual({ status: "unplaced", reason: "ambiguous" });
  ctx.topicText = new Map([["garden", { title: "Now plant this seed!", summary: "Details" }]]);
  expect(placeThread(topicQuote, ctx)).toEqual({ status: "unplaced", reason: "block-gone" });
});

test("a present topic quote requires its text to be loaded", () => {
  const ctx = context();
  ctx.topics = new Set(["garden"]);
  expect(() => placeThread(topicQuote, ctx)).toThrow("Missing topic placement text");
  ctx.topicText = new Map();
  expect(() => placeThread(topicQuote, ctx)).toThrow("Missing topic placement text");
});

test("topic quotes cannot silently land on other text, topics or writeup blocks", async () => {
  const ctx = context();
  ctx.topics = new Set(["garden", "other"]);
  ctx.topicText = new Map([
    ["garden", { title: "Plant a flower.", summary: "Different seed." }],
    ["other", { title: "Plant a seed.", summary: "" }],
  ]);
  ctx.writeup = await renderMarkdown("Plant a seed.", "overview");
  expect(placeThread(topicQuote, ctx)).toEqual({ status: "unplaced", reason: "block-gone" });
  expect(placeThread({ ...topicQuote, slug: "gone" }, ctx)).toEqual({ status: "unplaced", reason: "topic-gone" });
  ctx.topicText = new Map([["garden", { title: "Plant a seed. Plant a seed.", summary: "" }]]);
  expect(placeThread(topicQuote, ctx)).toEqual({ status: "unplaced", reason: "ambiguous" });
});

test("topic quotes use the last placed part only while its text is unchanged", () => {
  const ctx = context();
  ctx.topicAnchor = { part: "title", text: "Plant a seed." };
  ctx.topics = new Set(["garden"]);
  ctx.topicText = new Map([["garden", { title: "New title", summary: "Plant a seed." }]]);
  const moved = placeThread(topicQuote, ctx);
  expect(moved).toEqual({
    status: "placed",
    location: { kind: "topic", slug: "garden", part: "summary", start: 8, end: 12 },
  });
  if (moved.status !== "placed") throw new Error("Expected placement");
  ctx.last = { location: moved.location };
  ctx.topicAnchor = { part: "summary", text: "Plant a seed." };
  ctx.topicText = new Map([["garden", { title: "Plant a seed.", summary: "Plant a seed." }]]);
  expect(placeThread(topicQuote, ctx)).toEqual({
    status: "placed",
    location: { kind: "topic", slug: "garden", part: "summary", start: 8, end: 12 },
  });
  ctx.topicText = new Map([["garden", { title: "Plant a seed.", summary: "Now Plant a seed." }]]);
  expect(placeThread(topicQuote, ctx)).toEqual({ status: "unplaced", reason: "ambiguous" });
  ctx.topicText = new Map([["garden", { title: "Plant a seed.", summary: "The seed grows." }]]);
  expect(placeThread(topicQuote, ctx)).toEqual({
    status: "placed",
    location: { kind: "topic", slug: "garden", part: "title", start: 8, end: 12 },
  });
  ctx.last = null;
  ctx.topicText = new Map([["garden", { title: "Gone", summary: "Plant a seed. Plant a seed." }]]);
  expect(placeThread(topicQuote, ctx)).toEqual({ status: "unplaced", reason: "ambiguous" });
});

test("an unreadable HTML document leaves its spans unplaced", () => {
  const ctx = context();
  ctx.docs.set("docs/seed.html", { kind: "html", text: null });
  expect(
    placeThread({ kind: "html-span", path: "docs/seed.html", quote: "seed", prefix: "", suffix: "" }, ctx),
  ).toEqual({ status: "unplaced", reason: "block-gone" });
});

test("review is always placed and topic slugs must still exist", () => {
  const ctx = context();
  ctx.topics = new Set(["new-garden"]);
  expect(placeThread({ kind: "review" }, ctx)).toEqual({ status: "placed", location: { kind: "review" } });
  expect(placeThread({ kind: "topic", slug: "new-garden" }, ctx)).toEqual({
    status: "placed",
    location: { kind: "topic", slug: "new-garden" },
  });
  expect(placeThread({ kind: "topic", slug: "old-garden" }, ctx)).toEqual({ status: "unplaced", reason: "topic-gone" });
});

test("files use their latest placed path across successive renames and handle deletion", () => {
  const ctx = context();
  const target = { kind: "file" as const, path: "src/seed.ts" };
  ctx.files.set("src/plant.ts", {});
  ctx.renamedFrom.set(target.path, "src/plant.ts");
  const first = placeThread(target, ctx);
  expect(first).toEqual({ status: "placed", location: { kind: "file", path: "src/plant.ts" } });
  if (first.status !== "placed") throw new Error("Expected placement");
  ctx.last = { location: first.location };
  ctx.renamedFrom = new Map([["src/plant.ts", "src/grow.ts"]]);
  ctx.files = new Map([["src/grow.ts", {}]]);
  expect(placeThread(target, ctx)).toEqual({ status: "placed", location: { kind: "file", path: "src/grow.ts" } });
  ctx.files.clear();
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "file-gone" });
});

test("explicit renames win over a newly created file at the original path", () => {
  const ctx = context();
  ctx.files = new Map([
    ["src/seed.ts", {}],
    ["src/grow.ts", {}],
  ]);
  ctx.renamedFrom.set("src/seed.ts", "src/grow.ts");
  expect(placeThread({ kind: "file", path: "src/seed.ts" }, ctx)).toEqual({
    status: "placed",
    location: { kind: "file", path: "src/grow.ts" },
  });
});

test("Markdown spans stay within their document even if identical text exists elsewhere", async () => {
  const [block] = await renderDoc("Sprout keeps seeds.", "docs/seeds.md");
  if (!block) throw new Error("Missing block");
  const target = { kind: "doc-span" as const, path: "docs/seeds.md", ...makeSpan(block, 0, 6) };
  const ctx = context();
  ctx.writeup = [block];
  ctx.docs.set("docs/other.md", { kind: "markdown", blocks: [block] });
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "file-gone" });
  ctx.docs.set(target.path, { kind: "markdown", blocks: [] });
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "block-gone" });
});

test("writeup spans never search document blocks", async () => {
  const [block] = await renderMarkdown("Sprout keeps seeds.", "overview");
  if (!block) throw new Error("Missing block");
  const ctx = context();
  ctx.docs.set("docs/seeds.md", { kind: "markdown", blocks: [block] });
  expect(placeThread({ kind: "writeup-span", ...makeSpan(block, 0, 6) }, ctx)).toEqual({
    status: "unplaced",
    reason: "block-gone",
  });
});

test("follows renamed Markdown and HTML documents without crossing formats", async () => {
  const [block] = await renderDoc("Sprout keeps seeds.", "docs/seeds.md");
  if (!block) throw new Error("Missing block");
  const ctx = context();
  ctx.renamedFrom.set("docs/seeds.md", "docs/grow.md");
  ctx.docs.set("docs/grow.md", { kind: "markdown", blocks: await renderDoc("Sprout keeps seeds.", "docs/grow.md") });
  const target = { kind: "doc-span" as const, path: "docs/seeds.md", ...makeSpan(block, 0, 6) };
  const result = placeThread(target, ctx);
  expect(result).toMatchObject({
    status: "placed",
    location: { kind: "doc-span", path: "docs/grow.md", start: 0, end: 6 },
  });
  expect(Placement.safeParse(result).success).toBe(true);
  ctx.docs.set("docs/grow.md", { kind: "html", text: "Sprout keeps seeds." });
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "block-gone" });
  const htmlTarget = {
    kind: "html-span" as const,
    path: "docs/seeds.md",
    quote: "Sprout",
    prefix: "",
    suffix: " keeps seeds.",
  };
  expect(placeThread(htmlTarget, ctx)).toEqual({
    status: "placed",
    location: { kind: "html-span", path: "docs/grow.md", start: 0, end: 6 },
  });
  ctx.docs.clear();
  expect(placeThread(htmlTarget, ctx)).toEqual({ status: "unplaced", reason: "file-gone" });
});

test("uses the latest placed block identity when an older original block reappears", async () => {
  const [original] = await renderMarkdown("Sprout keeps seeds.", "overview");
  const [moved] = await renderMarkdown("Sprout keeps seeds.", "t-garden-body");
  if (!original || !moved) throw new Error("Missing blocks");
  const ctx = context();
  ctx.writeup = [original, moved];
  ctx.last = { location: { kind: "writeup-span", blockId: moved.id, start: 0, end: 6 } };
  expect(placeThread({ kind: "writeup-span", ...makeSpan(original, 0, 6) }, ctx)).toEqual({
    status: "placed",
    location: { kind: "writeup-span", blockId: moved.id, start: 0, end: 6 },
  });
});

test("uses the latest line range and sides, and keeps the original target immutable", () => {
  const target: LinesTarget = {
    kind: "lines",
    path: "src/seed.ts",
    side: "old",
    start: 1,
    end: 1,
    lines: ["seed"],
    before: [],
    after: [],
  };
  const ctx = context();
  ctx.last = {
    location: { kind: "lines", path: "src/grow.ts", side: "old", start: 3, end: 3 },
    sides: { oldText: "one\ntwo\nseed\n" },
  };
  ctx.files.set("src/grow.ts", { oldText: "zero\none\ntwo\nseed\n", newText: "seed\n" });
  expect(placeThread(target, ctx)).toEqual({
    status: "placed",
    location: { kind: "lines", path: "src/grow.ts", side: "old", start: 4, end: 4 },
  });
  expect(target.path).toBe("src/seed.ts");
  expect(target.start).toBe(1);
  ctx.last = null;
  ctx.files.set(target.path, { oldText: "seed\n" });
  expect(placeThread(target, ctx)).toMatchObject({
    status: "placed",
    location: { path: target.path, start: 1, end: 1 },
  });
});
