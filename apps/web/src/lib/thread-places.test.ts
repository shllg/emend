import {
  type FileView,
  OTHER_TOPIC,
  type PlacementLocation,
  type RenderedBlock,
  type RevisionView,
  type ThreadView,
} from "@emend/contract";
import { expect, test } from "vitest";
import { threadPlaces } from "./thread-places.ts";

const topic = (slug: string, importance = 1) => ({
  slug,
  title: slug === "garden" ? "Garden" : slug,
  importance,
  summary: "",
});
const block = (id: string): RenderedBlock => ({
  id,
  section: "overview",
  kind: "paragraph",
  text: "Seed",
  html: "<p>Seed</p>",
});
const file = (path: string, topic: string | null, order = 0): FileView => ({
  id: "11111111-1111-4111-8111-111111111111",
  path,
  topic,
  order,
  oldPath: null,
  role: "diff",
  status: "modified",
  mediaType: "text/plain",
  flag: null,
  hasOld: true,
  hasNew: true,
});
function thread(id: string, location?: PlacementLocation): ThreadView {
  return {
    id,
    target: { kind: "review" },
    state: "open",
    createdOn: 1,
    comments: [],
    placement: location ? { status: "placed", location } : { status: "unplaced", reason: "not-placed" },
  };
}
function places(
  threads: ThreadView[],
  input: Partial<Pick<RevisionView, "topics" | "writeup" | "docs" | "files">> = {},
) {
  return threadPlaces({ threads, topics: [], writeup: { sections: [] }, docs: [], files: [], ...input });
}
const span = (blockId: string, start = 0): PlacementLocation => ({
  kind: "writeup-span",
  blockId,
  start,
  end: start + 1,
});
const docSpan = (path: string, blockId: string, start = 0): PlacementLocation => ({
  kind: "doc-span",
  path,
  blockId,
  start,
  end: start + 1,
});
const lines = (path: string, start: number, end = start): PlacementLocation => ({
  kind: "lines",
  path,
  side: "new",
  start,
  end,
});

test("groups follow the full reading order, with remaining topics in input order and diff files by importance then order", () => {
  const threads = [
    thread("review", { kind: "review" }),
    thread("overview", span("overview-11111111")),
    thread("tldr", span("tldr-11111111")),
    thread("written", span("t-garden-body-11111111")),
    thread("context", span("context-11111111")),
    thread("unwritten-first", { kind: "topic", slug: "tools" }),
    thread("unwritten-second", { kind: "topic", slug: "soil" }),
    thread("other", { kind: "topic", slug: OTHER_TOPIC.slug }),
    thread("doc-z", docSpan("z.md", "doc-11111111-11111111")),
    thread("doc-a", { kind: "html-span", path: "a.html", start: 0, end: 1 }),
    thread("file-z", { kind: "file", path: "z.ts" }),
    thread("file-a", { kind: "file", path: "a.ts" }),
    thread("file-tools", lines("tools.ts", 1)),
    thread("file-other", { kind: "file", path: "other.ts" }),
    thread("unplaced"),
  ];
  const groups = places(threads.toReversed(), {
    topics: [topic(OTHER_TOPIC.slug), topic("tools", 3), topic("garden", 1), topic("soil", 2)],
    writeup: {
      sections: [
        { key: "overview", label: "Overview", topic: null, blocks: [block("overview-11111111")] },
        { key: "tldr", label: "TL;DR", topic: null, blocks: [block("tldr-11111111")] },
        { key: "t-garden-body", label: "Garden", topic: "garden", blocks: [block("t-garden-body-11111111")] },
        { key: "context", label: "Context", topic: null, blocks: [block("context-11111111")] },
        { key: "t-garden-example", label: "Example", topic: "garden", blocks: [] },
      ],
    },
    docs: [
      { kind: "markdown", path: "z.md", blocks: [] },
      { kind: "html", path: "a.html", contentUrl: "/content/key/a.html" },
    ],
    files: [file("other.ts", null), file("tools.ts", "tools"), file("a.ts", "garden", 8), file("z.ts", "garden", 2)],
  });
  expect(groups.flatMap((group) => group.threads.map((thread) => thread.id))).toEqual(
    threads.map((thread) => thread.id),
  );
  expect(groups.map((group) => group.key)).toEqual([
    "review",
    "writeup:overview",
    "writeup:tldr",
    "topic:garden",
    "writeup:context",
    "topic:tools",
    "topic:soil",
    `topic:${OTHER_TOPIC.slug}`,
    "doc:z.md",
    "doc:a.html",
    "file:z.ts",
    "file:a.ts",
    "file:tools.ts",
    "file:other.ts",
    "unplaced",
  ]);
});

test("unknown places follow known places in their category, in first-appearance order; empty groups disappear", () => {
  const groups = places(
    [
      thread("file-b", lines("unknown-b.ts", 1)),
      thread("doc-b", docSpan("unknown-b.md", "doc-11111111-11111111")),
      thread("topic-b", span("t-unknown-b-example-11111111-2")),
      thread("context", span("context-11111111")),
      thread("topic-a", { kind: "topic", slug: "unknown-a" }),
      thread("doc-a", docSpan("unknown-a.md", "doc-11111111-11111111")),
      thread("file-a", lines("unknown-a.ts", 1)),
      thread("known-file", lines("known.ts", 1)),
      thread("known-doc", docSpan("known.md", "doc-11111111-11111111")),
      thread("known-topic", { kind: "topic", slug: "garden" }),
    ],
    {
      topics: [topic("empty"), topic("garden")],
      docs: [{ kind: "markdown", path: "known.md", blocks: [] }],
      files: [file("known.ts", "garden")],
    },
  );
  expect(groups.map((group) => group.key)).toEqual([
    "topic:garden",
    "topic:unknown-b",
    "writeup:context",
    "topic:unknown-a",
    "doc:known.md",
    "doc:unknown-b.md",
    "doc:unknown-a.md",
    "file:known.ts",
    "file:unknown-b.ts",
    "file:unknown-a.ts",
  ]);
  expect(places([])).toEqual([]);
});

test("writeup lookup takes precedence over parsing; blocks follow the flattened writeup then offsets, with stable ties", () => {
  const first = "overview-ffffffff";
  const second = "overview-11111111";
  const groups = places(
    [
      thread("second", span(second)),
      thread("late", span(first, 5)),
      thread("early-a", span(first, 1)),
      thread("early-b", span(first, 1)),
      thread("lookup", span("context-22222222")),
    ],
    {
      writeup: {
        sections: [
          { key: "overview", topic: null, label: "Overview", blocks: [block(first), block(second)] },
          { key: "t-garden-body", topic: "garden", label: "Garden", blocks: [block("context-22222222")] },
        ],
      },
    },
  );
  expect(groups.map((group) => [group.key, group.threads.map((thread) => thread.id)])).toEqual([
    ["writeup:overview", ["early-a", "early-b", "late", "second"]],
    ["topic:garden", ["lookup"]],
  ]);
});

test("topic threads precede title, summary and writeup spans across all its sections", () => {
  const part = (part: "title" | "summary", start: number): PlacementLocation => ({
    kind: "topic",
    slug: "garden",
    part,
    start,
    end: start + 1,
  });
  const ordered = [
    thread("whole-a", { kind: "topic", slug: "garden" }),
    thread("whole-b", { kind: "topic", slug: "garden" }),
    thread("title-first", part("title", 0)),
    thread("title-last", part("title", 5)),
    thread("summary-first", part("summary", 0)),
    thread("summary-last", part("summary", 5)),
    thread("why-first", span("t-garden-why-ffffffff", 1)),
    thread("why-last", span("t-garden-why-ffffffff", 2)),
    thread("body", span("t-garden-body-11111111")),
  ];
  const incoming = [...ordered.slice(2).toReversed(), ...ordered.slice(0, 2)];
  const groups = places(incoming, {
    writeup: {
      sections: [
        { key: "t-garden-why", topic: "garden", label: "Why", blocks: [block("t-garden-why-ffffffff")] },
        { key: "t-garden-body", topic: "garden", label: "Body", blocks: [block("t-garden-body-11111111")] },
      ],
    },
  });
  expect(groups[0]?.threads.map((thread) => thread.id)).toEqual(ordered.map((thread) => thread.id));
});

test("docs order rendered blocks and offsets before source lines, and HTML spans by offset", () => {
  const md = "garden.md";
  const html = "garden.html";
  const source = (path: string, start: number): PlacementLocation => ({
    kind: "source-lines",
    path,
    start,
    end: start,
  });
  const threads = [
    thread("md-source-late", source(md, 5)),
    thread("md-block-two", docSpan(md, "doc-11111111-11111111")),
    thread("md-block-one-late", docSpan(md, "doc-11111111-ffffffff", 5)),
    thread("md-source-early", source(md, 1)),
    thread("md-block-one-early", docSpan(md, "doc-11111111-ffffffff", 1)),
    thread("html-source", source(html, 1)),
    thread("html-late", { kind: "html-span", path: html, start: 5, end: 6 }),
    thread("html-early", { kind: "html-span", path: html, start: 1, end: 2 }),
  ];
  const groups = places(threads, {
    docs: [
      { kind: "markdown", path: md, blocks: [block("doc-11111111-ffffffff"), block("doc-11111111-11111111")] },
      { kind: "html", path: html, contentUrl: "/content/key/garden.html" },
    ],
  });
  expect(groups.map((group) => group.threads.map((thread) => thread.id))).toEqual([
    ["md-block-one-early", "md-block-one-late", "md-block-two", "md-source-early", "md-source-late"],
    ["html-early", "html-late", "html-source"],
  ]);
});

test("files precede line ranges ordered by start then end; old-side lines use the renamed file", () => {
  const groups = places(
    [
      thread("later", lines("new.ts", 5)),
      thread("long", lines("new.ts", 1, 3)),
      thread("old", { kind: "lines", side: "old", path: "old.ts", start: 1, end: 2 }),
      thread("tie", lines("new.ts", 1, 2)),
      thread("file", { kind: "file", path: "new.ts" }),
    ],
    { files: [{ ...file("new.ts", null), oldPath: "old.ts", status: "renamed" }] },
  );
  expect(groups.map((group) => [group.key, group.label, group.threads.map((thread) => thread.id)])).toEqual([
    ["file:new.ts", "new.ts", ["file", "old", "tie", "long", "later"]],
  ]);
});

test("labels share writeup section names and topic ranks; review and unplaced preserve incoming order", () => {
  const sections = ["overview", "tldr", "outOfScope", "whereToLook", "context", "decisions", "glossary"];
  const groups = places(
    [
      thread("unplaced-a"),
      thread("review-a", { kind: "review" }),
      ...sections.map((key) => thread(key, span(`${key}-11111111`))),
      thread("topic", { kind: "topic", slug: "garden" }),
      thread("review-b", { kind: "review" }),
      thread("unplaced-b"),
    ],
    { topics: [topic("garden")] },
  );
  expect(groups.map((group) => group.label)).toEqual([
    "Whole review",
    "Topic 01 · Garden",
    "Writeup · Overview",
    "Writeup · TL;DR",
    "Writeup · Out of scope",
    "Writeup · Where to look",
    "Writeup · Context",
    "Writeup · Decisions",
    "Writeup · Glossary",
    "Unplaced",
  ]);
  expect(groups[0]?.threads.map((thread) => thread.id)).toEqual(["review-a", "review-b"]);
  expect(groups.at(-1)?.threads.map((thread) => thread.id)).toEqual(["unplaced-a", "unplaced-b"]);
});
