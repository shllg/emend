import { OTHER_TOPIC, type Target, type TopicMeta } from "@emend/contract";
import { FileCode, FileText, ListTree, MessageSquare, TextSelect } from "lucide-react";
import { expect, test } from "vitest";
import { targetLabel } from "./targets.ts";

const topics: TopicMeta[] = [
  { ...OTHER_TOPIC, importance: 0, summary: "" },
  { slug: "seed", title: "Plant seeds", importance: 1, summary: "" },
  { slug: "seed-water", title: "Water seedlings", importance: 2, summary: "" },
];
const span = { quote: "seed", prefix: "", suffix: "", blockId: "overview-12345678" };
const lines = {
  kind: "lines" as const,
  path: "garden.ts",
  side: "new" as const,
  start: 5,
  end: 5,
  lines: ["seed"],
  before: [],
  after: [],
};
const cases: [Target, string, unknown][] = [
  [{ kind: "writeup-span", ...span }, "Writeup · Overview", TextSelect],
  [{ kind: "writeup-span", ...span, blockId: "tldr-12345678" }, "Writeup · TL;DR", TextSelect],
  [{ kind: "writeup-span", ...span, blockId: "review-0123abcd" }, "Writeup · Review", TextSelect],
  [{ kind: "writeup-span", ...span, blockId: "checked-0123abcd" }, "Writeup · Checked", TextSelect],
  [{ kind: "writeup-span", ...span, blockId: "notChecked-0123abcd" }, "Writeup · Not checked", TextSelect],
  [{ kind: "writeup-span", ...span, blockId: "outOfScope-12345678" }, "Writeup · Out of scope", TextSelect],
  [{ kind: "writeup-span", ...span, blockId: "whereToLook-12345678" }, "Writeup · Where to look", TextSelect],
  [{ kind: "writeup-span", ...span, blockId: "context-12345678" }, "Writeup · Context", TextSelect],
  [{ kind: "writeup-span", ...span, blockId: "decisions-12345678" }, "Writeup · Decisions", TextSelect],
  [{ kind: "writeup-span", ...span, blockId: "glossary-12345678" }, "Writeup · Glossary", TextSelect],
  [{ kind: "writeup-span", ...span, blockId: "t-seed-water-why-12345678" }, "Writeup · Water seedlings", TextSelect],
  [{ kind: "writeup-span", ...span, blockId: "unknown-12345678" }, "Writeup", TextSelect],
  [{ kind: "doc-span", ...span, path: "garden.md" }, "garden.md", TextSelect],
  [{ kind: "html-span", quote: "seed", prefix: "", suffix: "", path: "garden.html" }, "garden.html", TextSelect],
  [lines, "garden.ts · line 5", FileCode],
  [{ ...lines, start: 12, end: 18 }, "garden.ts · lines 12–18", FileCode],
  [{ ...lines, side: "old" }, "garden.ts · line 5 (old)", FileCode],
  [{ ...lines, side: "old", start: 12, end: 18 }, "garden.ts · lines 12–18 (old)", FileCode],
  [{ kind: "file", path: "garden.ts" }, "garden.ts", FileText],
  [{ kind: "topic", slug: "seed-water" }, "Topic 02 · Water seedlings", ListTree],
  [{ kind: "topic", slug: OTHER_TOPIC.slug }, `Topic · ${OTHER_TOPIC.title}`, ListTree],
  [{ kind: "topic", slug: "missing" }, "Topic · missing", ListTree],
  [{ kind: "review" }, "Whole review", MessageSquare],
];
test.each(cases)("labels %j as %s", (target, label, icon) => {
  expect(targetLabel(target, topics)).toEqual({ label, icon });
});

test("fixed section prefixes cannot be mistaken for topic ids", () => {
  const overlap = [{ slug: "context", title: "A context topic", importance: 1, summary: "" }];
  expect(targetLabel({ kind: "writeup-span", ...span, blockId: "context-12345678-2" }, overlap).label).toBe(
    "Writeup · Context",
  );
  expect(targetLabel({ kind: "writeup-span", ...span, blockId: "t-context-why-12345678" }, overlap).label).toBe(
    "Writeup · A context topic",
  );
  expect(targetLabel({ kind: "writeup-span", ...span, blockId: "outOfScope-12345678-2" }, overlap).label).toBe(
    "Writeup · Out of scope",
  );
});

test.each(["t-seed-body-12345678", "t-seed-body-12345678-2", "t-seed-why-abcdef12", "t-seed-example-12345678"])(
  "fix1 writeup topic is parsed from the full id %s",
  (blockId) => {
    const overlap = [...topics, { slug: "seed-body", title: "A different topic", importance: 3, summary: "" }];
    expect(targetLabel({ kind: "writeup-span", ...span, blockId }, overlap).label).toBe("Writeup · Plant seeds");
  },
);
test.each(["t-seed-body-nohash", "t-seed-unknown-12345678", "t-seed-body-12345678-trailing"])(
  "fix1 malformed topic id falls back to Writeup: %s",
  (blockId) => {
    expect(targetLabel({ kind: "writeup-span", ...span, blockId }, topics).label).toBe("Writeup");
  },
);
