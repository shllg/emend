import type { Placement, PlacementLocation, Target, TopicMeta } from "@emend/contract";
import { expect, test } from "vitest";
import {
  type DownloadComment,
  type DownloadFile,
  type DownloadThreadInput,
  routeDownloadThreads,
} from "./download-threads.ts";

const comment = (body: string, over: Partial<DownloadComment> = {}): DownloadComment => ({
  author: "user",
  sent: true,
  body,
  html: null,
  createdAt: 0,
  ...over,
});
const span = { prefix: "", suffix: "" };
const thread = (
  target: Target,
  location: PlacementLocation | null,
  over: Partial<DownloadThreadInput> = {},
): DownloadThreadInput => ({
  target,
  placement: location ? { status: "placed", location } : { status: "unplaced", reason: "block-gone" },
  state: "sent",
  createdOn: 2,
  comments: [comment("hello")],
  ...over,
});
const topics: TopicMeta[] = [{ slug: "auth", title: "Auth flow", importance: 50, summary: "s" }];
const writeup: DownloadFile = { kind: "writeup" };
const route = (threads: DownloadThreadInput[], base: DownloadFile = writeup, docs: DownloadFile[] = []) =>
  routeDownloadThreads({ threads, seq: 2, topics, base, docs });
const review = thread({ kind: "review" }, { kind: "review" });
const topic = thread({ kind: "topic", slug: "auth" }, { kind: "topic", slug: "auth" });
const writeupSpan = thread(
  { kind: "writeup-span", blockId: "overview-12345678", quote: "q", ...span },
  { kind: "writeup-span", blockId: "overview-12345678", start: 0, end: 1 },
);
const docSpan = thread(
  { kind: "doc-span", path: "a.md", blockId: "doc-12345678-12345678", quote: "dq", ...span },
  { kind: "doc-span", path: "a.md", blockId: "doc-12345678-12345678", start: 0, end: 2 },
);
const htmlSpan = thread(
  { kind: "html-span", path: "p.html", quote: "hq", ...span },
  { kind: "html-span", path: "p.html", start: 0, end: 2 },
);
const sourceLines = thread(
  { kind: "source-lines", path: "s.ts", start: 2, end: 4, lines: ["a", "b", "c"], before: [], after: [] },
  { kind: "source-lines", path: "s.ts", start: 2, end: 4 },
);
const diffLines = thread(
  { kind: "lines", side: "old", path: "d.ts", start: 3, end: 3, lines: ["x"], before: [], after: [] },
  { kind: "lines", path: "d.ts", side: "old", start: 3, end: 3 },
);
const file = thread({ kind: "file", path: "f.ts" }, { kind: "file", path: "f.ts" });
const docs: DownloadFile[] = [
  { kind: "markdown", path: "a.md" },
  { kind: "html", path: "p.html" },
  { kind: "source", path: "s.ts" },
];

test("routes each placed thread to its place in a code review with all docs selected", () => {
  const { base, docs: routed } = route(
    [review, topic, writeupSpan, docSpan, htmlSpan, sourceLines, diffLines, file],
    writeup,
    docs,
  );
  expect(base.top.map((t) => t.where)).toEqual(["Whole review"]);
  expect(base.topics.get("auth")?.[0]?.where).toBe("Topic · Auth flow");
  expect(base.blocks.get("overview-12345678")?.[0]).toMatchObject({ where: "Writeup", quote: "q" });
  expect(routed[0]?.blocks.get("doc-12345678-12345678")?.[0]).toMatchObject({ where: "a.md", quote: "dq" });
  expect(routed[1]).toEqual(route([]).base);
  expect(base.end[0]).toMatchObject({ where: "p.html", quote: "hq" });
  expect(routed[2]?.lines.get(4)?.[0]).toMatchObject({ where: "s.ts · lines 2–4 (source)", lines: ["a", "b", "c"] });
  expect(base.end.map((t) => t.where)).toEqual(["p.html", "d.ts · line 3 (old)", "f.ts"]);
  expect(base.end[1]?.lines).toEqual(["x"]);
});

test("sends threads without a place in the file to the end of the base file", () => {
  const { base } = route([topic, writeupSpan, docSpan, htmlSpan, sourceLines], { kind: "markdown", path: "main.md" });
  expect(base.topics.size + base.blocks.size + base.lines.size).toBe(0);
  expect(base.end).toHaveLength(5);
});

test("a base doc takes its own doc threads", () => {
  const { base } = route([docSpan, htmlSpan], { kind: "markdown", path: "a.md" });
  expect(base.blocks.get("doc-12345678-12345678")).toHaveLength(1);
  expect(base.end.map((t) => t.where)).toEqual(["p.html"]);
  expect(route([htmlSpan], { kind: "html", path: "p.html" }).comments?.end).toHaveLength(1);
  expect(route([sourceLines], { kind: "source", path: "s.ts" }).base.lines.get(4)).toHaveLength(1);
});

test("drops unsent user comments and threads left empty, and keeps the rest in order", () => {
  const { base } = route([
    thread({ kind: "review" }, { kind: "review" }, { comments: [comment("draft", { sent: false })] }),
    thread(
      { kind: "review" },
      { kind: "review" },
      {
        comments: [
          comment("sent"),
          comment("reply", { author: "agent", sent: false }),
          comment("follow-up draft", { sent: false }),
        ],
      },
    ),
  ]);
  expect(base.top).toHaveLength(1);
  expect(base.top[0]?.comments.map((c) => c.body)).toEqual(["sent", "reply"]);
});

test("unplaced threads carry a reason and the revision they were made on", () => {
  const same = thread(writeupSpan.target, null);
  const older = thread(writeupSpan.target, null, { createdOn: 1 });
  const placement: Placement = { status: "unplaced", reason: "ambiguous" };
  const { base } = route([same, older, { ...docSpan, placement }]);
  expect(base.end[0]?.note).toBe("The block this comment was on is gone.");
  expect(base.end[1]?.note).toBe("The block this comment was on is gone. Made on revision 1.");
  expect(base.end[2]).toMatchObject({ where: "a.md", note: "The quoted text now appears more than once." });
  expect(base.end[0]?.where).toBe("Writeup");
});

test("unplaced topic threads fall back to the slug when the topic is unknown", () => {
  const unknown = thread({ kind: "topic", slug: "gone" }, null);
  const known = thread({ kind: "topic", slug: "auth" }, null);
  const { base } = route([
    unknown,
    known,
    thread({ kind: "review" }, null),
    thread({ kind: "file", path: "x.ts" }, null),
  ]);
  expect(base.end.map((t) => t.where)).toEqual(["Topic · gone", "Topic · Auth flow", "Whole review", "x.ts"]);
});

test("an HTML pub uses a separate home and HTML files never receive threads", () => {
  const routed = route(
    [review, topic, writeupSpan, htmlSpan, diffLines, thread(htmlSpan.target, null)],
    { kind: "html", path: "p.html" },
    docs,
  );
  expect(routed.base).toEqual(route([]).base);
  expect(routed.docs[1]).toEqual(route([]).base);
  expect(routed.comments?.top).toHaveLength(1);
  expect(routed.comments?.end.map((t) => t.where)).toEqual([
    "Topic · Auth flow",
    "Writeup",
    "p.html",
    "d.ts · line 3 (old)",
    "p.html",
  ]);
  expect(route([])).not.toHaveProperty("comments");
  expect(route([], { kind: "html", path: "p.html" }).comments).toEqual(route([]).base);
});

test.each([undefined, null, 0, Date.UTC(2026, 10, 13, 10, 5)])(
  "carries the copy time to the base, docs and comments files: %s",
  (importedAt) => {
    for (const base of [writeup, { kind: "html", path: "p.html" }] as DownloadFile[]) {
      const routed = routeDownloadThreads({ threads: [review, docSpan], seq: 2, topics, base, docs, importedAt });
      for (const file of [routed.base, ...routed.docs, ...(routed.comments ? [routed.comments] : [])]) {
        if (importedAt == null) expect(file).not.toHaveProperty("copiedAt");
        else expect(file.copiedAt).toBe(importedAt);
      }
    }
  },
);

test.each([
  [docSpan, { kind: "markdown", path: "a.md" }],
  [sourceLines, { kind: "source", path: "s.ts" }],
] as const)("a base doc selected again receives its threads only once", (thread, file) => {
  const routed = route([thread], file, [file]);
  expect([...routed.base.blocks.values(), ...routed.base.lines.values()].flat()).toHaveLength(1);
  expect(routed.docs[0]).toEqual(route([]).base);
});
