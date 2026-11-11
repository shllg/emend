import { BlockId } from "@emend/contract";
import { expect, test } from "vitest";
import { blockText } from "./blocks.ts";
import { topics, writeup } from "./fixtures/writeup.ts";
import { renderWriteup } from "./writeup.ts";

test("renders sections and labels in importance order with stable ties", async () => {
  const rendered = await renderWriteup(writeup, topics);
  expect(rendered.sections.map((section) => section.key)).toEqual([
    "overview",
    "tldr",
    "decisions",
    "glossary",
    "t-search-why",
    "t-search-example",
    "t-search-body",
    "t-sorting-why",
    "t-labels-why",
    "t-labels-body",
  ]);
  expect(rendered.sections.map((section) => section.label)).toEqual([
    "Overview",
    "TL;DR",
    "Decisions and drift",
    "Glossary",
    "Shelf search — Why",
    "Shelf search — Example",
    "Shelf search — Details",
    "Stable sorting — Why",
    "Clear labels — Why",
    "Clear labels — Details",
  ]);
  expect(rendered.sections.map((section) => section.topic)).toEqual([
    null,
    null,
    null,
    null,
    "search",
    "search",
    "search",
    "sorting",
    "labels",
    "labels",
  ]);
  expect(topics.map((topic) => topic.slug)).toEqual(["labels", "search", "sorting"]);
  for (const section of rendered.sections) {
    for (const block of section.blocks) {
      expect(block.section).toBe(section.key);
      expect(BlockId.safeParse(block.id).success).toBe(true);
    }
  }
});

test("blockText equals text for HTML blocks, explicitly skipping diagram blocks", async () => {
  const rendered = await renderWriteup(
    { ...writeup, overview: `${writeup.overview}\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`` },
    topics,
  );
  const blocks = rendered.sections.flatMap((section) => section.blocks);
  expect(blocks.filter((block) => block.kind === "diagram")).toHaveLength(1);
  for (const block of blocks) {
    if (block.kind === "diagram") continue;
    expect(blockText(block.html)).toBe(block.text);
  }
});

test("null decisions produce the exact required paragraph", async () => {
  const rendered = await renderWriteup(writeup, topics);
  const blocks = rendered.sections.find((section) => section.key === "decisions")?.blocks;
  expect(blocks).toHaveLength(1);
  expect(blocks?.[0]).toMatchObject({
    kind: "paragraph",
    text: "Decisions and drift: not written. Only the session where the change was asked for can tell what drifted from it.",
  });
});

test("omits missing optional sections but preserves explicitly empty sections", async () => {
  const rendered = await renderWriteup({ overview: "", tldr: "", decisions: "", topics: {} }, topics);
  expect(rendered.sections.map((section) => section.key)).toEqual(["overview", "tldr", "decisions"]);
  expect(rendered.sections.every((section) => section.blocks.length === 0)).toBe(true);
});

test("new writeups start with the summary, overview, scope, guide and context", async () => {
  const rendered = await renderWriteup(
    { ...writeup, outOfScope: "- Delays", whereToLook: "- Check the retry loop", context: "- No new dependency" },
    topics,
  );
  const legacy = await renderWriteup(writeup, topics);
  expect(rendered.sections.map(({ key, label }) => [key, label])).toEqual([
    ["tldr", "TL;DR"],
    ["overview", "Overview"],
    ["outOfScope", "Out of scope"],
    ["whereToLook", "Where to look"],
    ["context", "Context"],
    ...legacy.sections.slice(2).map(({ key, label }) => [key, label]),
  ]);
  expect(rendered.sections.slice(5)).toEqual(legacy.sections.slice(2));
});

test.each(["outOfScope", "whereToLook", "context"] as const)(
  "a present %s selects the new order, including an empty string, and omits absent fields",
  async (field) => {
    for (const value of ["", "Synthetic text"]) {
      const rendered = await renderWriteup({ overview: "", tldr: "", decisions: "", topics: {}, [field]: value }, []);
      expect(rendered.sections.map((section) => section.key)).toEqual(["tldr", "overview", field, "decisions"]);
      expect(rendered.sections[2]?.blocks).toHaveLength(value ? 1 : 0);
    }
  },
);

test.each(["outOfScope", "whereToLook", "context"] as const)("sanitizes hostile Markdown in %s", async (field) => {
  const source = "graph TD; A-->B; click A callback";
  const markdown = [
    "<script>bad()</script>",
    'Before <img src=x onerror="bad()"> after',
    "[Unsafe link](javascript:bad())",
    '<div onclick="bad()" style="position:fixed" id="raw" class="injected" data-foo="x">Raw HTML</div>',
    '<svg onload="bad()"><circle /></svg>',
    `\`\`\`mermaid\n${source}\n\`\`\``,
  ].join("\n\n");
  const rendered = await renderWriteup({ ...writeup, [field]: markdown }, []);
  const blocks = rendered.sections.find((section) => section.key === field)?.blocks ?? [];
  const html = blocks.map((block) => block.html).join("");
  expect(html).toContain("Raw HTML");
  expect(html).toContain("Unsafe link");
  expect(html).toContain('id="user-content-raw"');
  expect(html).toContain("user-content-injected");
  expect(html).not.toMatch(
    /<(script|style|iframe|object|embed|form|svg)|\s(on\w+|style|data-[\w-]+)=|javascript:|data:|vbscript:/i,
  );
  expect(blocks.filter((block) => block.kind === "diagram")).toEqual([
    expect.objectContaining({ kind: "diagram", source, text: source, html: "" }),
  ]);
  for (const block of blocks) {
    expect(block.section).toBe(field);
    expect(BlockId.parse(block.id)).toMatch(new RegExp(`^${field}-`));
  }
});

test("sanitizes raw glossary HTML through the same pipeline", async () => {
  const rendered = await renderWriteup(
    {
      ...writeup,
      glossary:
        '<div onclick="bad()" style="position:fixed" class="thread-card" id="glossary" data-foo="x"><script>bad()</script><iframe src="https://example.com"></iframe><svg onload="bad()"></svg><a href="javascript:bad()">Term</a><img src=x onerror="bad()"></div>',
    },
    topics,
  );
  const blocks = rendered.sections.find((section) => section.key === "glossary")?.blocks ?? [];
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    expect(block.html).not.toMatch(
      /<(script|style|iframe|object|embed|form|svg)|\s(on\w+|style|data-[\w-]+)=|javascript:|data:|vbscript:/i,
    );
    expect(block.text).toBe("Term");
    expect(block.html).toContain("user-content-thread-card");
    expect(block.html).toContain('id="user-content-glossary"');
  }
});
