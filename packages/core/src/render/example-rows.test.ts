import type { TopicMeta } from "@emend/contract";
import { expect, test } from "vitest";
import { blockText } from "./blocks.ts";
import { renderMarkdownWithBudget } from "./markdown.ts";
import { renderWriteup } from "./writeup.ts";

const topic: TopicMeta = { slug: "garden", title: "Garden", summary: "Plant seeds.", importance: 1 };
const renderExample = async (markdown: string) => {
  const writeup = await renderWriteup(
    {
      overview: "",
      tldr: "",
      decisions: null,
      topics: { garden: { why: markdown, example: markdown, body: markdown } },
    },
    [topic],
  );
  return writeup.sections.find((section) => section.key === "t-garden-example")?.blocks ?? [];
};

test.each([
  ["Before: one seed\nAfter: two seeds", "Before:", "After:"],
  ["Before: one seed  \nAfter: two seeds", "Before:", "After:"],
  ["**Before:** one seed\n**After:** two seeds", "<strong>Before:</strong>", "<strong>After:</strong>"],
  ["**Before**: one seed\n**After**: two seeds", "<strong>Before</strong>:", "<strong>After</strong>:"],
  ["An intro.\nBefore: one seed\nAfter, on a second conflict: two seeds", "Before:", "After, on a second conflict:"],
  ["Before: `seed`\nAfter: **seeds**", "Before:", "After:"],
])("aligns labelled lines without changing text or ids: %s", async (md, before, after) => {
  const blocks = await renderExample(md);
  const original = await renderMarkdownWithBudget(md, "t-garden-example", { highlightedBytes: 0 });
  expect(blocks).toHaveLength(original.length);
  for (const [index, block] of blocks.entries()) {
    expect(block.text).toBe(original[index]?.text);
    expect(block.id).toBe(original[index]?.id);
    expect(blockText(block.html)).toBe(blockText(original[index]?.html ?? ""));
  }
  const html = blocks[0]?.html ?? "";
  expect(html).toContain('<p class="emend-example-rows">');
  expect(html).toContain(`<span class="emend-example-label">${before}</span> <span class="emend-example-value">`);
  expect(html).toContain(`<span class="emend-example-label">${after}</span>`);
  expect(html.match(/class="emend-example-row"/g)).toHaveLength(2);
  if (md.startsWith("An intro")) expect(html).toContain('<span class="emend-example-line">An intro.</span>\n');
  if (md.includes("  \n")) expect(html).toContain('</span><br><span class="emend-example-line"></span>\n');
});

test("a colon inside a longer bold span leaves that line unlabelled", async () => {
  const [block] = await renderExample("**Before: one seed**\nAfter: two seeds");
  expect(block?.html).toContain('<span class="emend-example-line"><strong>Before: one seed</strong></span>');
  expect(block?.html.match(/class="emend-example-row"/g)).toHaveLength(1);
});

test.each([
  "Beforehand: one seed\nAfterwards: two seeds",
  `Before${" ".repeat(49)}: one seed`,
  "**Before: one seed**",
  "- Before: one seed\n\n- After: two seeds",
  "| Before: | After: |\n| --- | --- |\n| One | Two |",
  "```text\nBefore: one seed\nAfter: two seeds\n```",
  "**Before\nAfter:** seeds",
])("leaves other markup alone: %s", async (md) => {
  const blocks = await renderExample(md);
  const plain = await renderMarkdownWithBudget(md, "t-garden-example", { highlightedBytes: 0 });
  expect(blocks).toEqual(plain);
});

test("only Example sections opt into rows", async () => {
  const md = "Before: one seed\nAfter: two seeds";
  const writeup = await renderWriteup(
    { overview: md, tldr: md, decisions: null, topics: { garden: { why: md, example: md, body: md } } },
    [topic],
  );
  for (const section of writeup.sections) {
    expect(section.blocks.some((block) => block.html.includes("emend-example-rows"))).toBe(
      section.key === "t-garden-example",
    );
  }
  const doc = await renderMarkdownWithBudget(md, "doc-12345678", { highlightedBytes: 0 });
  expect(doc[0]?.html).not.toContain("emend-example");
});

test("example wrappers cannot be forged and hostile inline content stays inert", async () => {
  const md =
    'Before: <script>bad()</script><img src=x onerror=bad()> [bad](javascript:bad())\nAfter: <span class="emend-example-label">safe</span> <svg onload=bad()></svg>\n\n<p class="emend-example-rows">Plain</p>';
  const blocks = await renderExample(md);
  const html = blocks.map((block) => block.html).join("");
  expect(html).toContain('class="emend-example-label"');
  expect(html).toContain('class="user-content-emend-example-label"');
  expect(html).toContain('class="user-content-emend-example-rows"');
  expect(html).not.toMatch(/<script|<svg|onerror|onload|javascript:/i);
  const plain = await renderMarkdownWithBudget(md, "t-garden-example", { highlightedBytes: 0 });
  expect(blocks.map(({ id, text }) => ({ id, text }))).toEqual(plain.map(({ id, text }) => ({ id, text })));
});

test("Example and glossary keep hostile HTML inert and isolate Mermaid click directives", async () => {
  const source = 'graph TD; A-->B\nclick A "javascript:bad()"';
  const md = `Before: <script>bad()</script><img onerror=bad()><svg onload=bad()></svg> [bad](javascript:bad())\nAfter: safe\n\n\`\`\`mermaid\n${source}\n\`\`\``;
  const writeup = await renderWriteup(
    { overview: "", tldr: "", decisions: null, glossary: md, topics: { garden: { why: "Plant seeds.", example: md } } },
    [topic],
  );
  for (const section of writeup.sections.filter((section) => ["glossary", "t-garden-example"].includes(section.key))) {
    const html = section.blocks.map((block) => block.html).join("");
    expect(html).not.toMatch(/<script|<svg|onerror|onload|javascript:/i);
    expect(section.blocks.find((block) => block.kind === "diagram")?.source).toBe(source);
    expect(html.includes("emend-example-rows")).toBe(section.key === "t-garden-example");
  }
});
