import type { TopicMeta } from "@emend/contract";
import { fromHtml } from "hast-util-from-html";
import { toString as hastText } from "hast-util-to-string";
import { expect, test } from "vitest";
import { blockText, type HtmlElement, visitElements } from "./blocks.ts";
import { renderMarkdownWithBudget } from "./markdown.ts";
import { renderWriteup } from "./writeup.ts";

const topic: TopicMeta = { slug: "garden", title: "Garden", summary: "Plant seeds.", importance: 1 };
function withClass(html: string, className: string): HtmlElement[] {
  const matches: HtmlElement[] = [];
  visitElements(fromHtml(html, { fragment: true }), (element) => {
    if (Array.isArray(element.properties.className) && element.properties.className.includes(className))
      matches.push(element);
  });
  return matches;
}
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
  expect(html).toContain(`<span class="emend-example-label">${before}</span><span class="emend-example-value"> `);
  expect(html).toContain(`<span class="emend-example-label">${after}</span>`);
  expect(html.match(/class="emend-example-row"/g)).toHaveLength(2);
  if (md.startsWith("An intro")) expect(html).toContain('<span class="emend-example-line">An intro.</span>\n');
  if (md.includes("  \n")) expect(html).toContain("</span><br>\n");
});

test.each([
  ["> [!NOTE]\n> Before: seed\n> After: plant", "\n"],
  ["> [!NOTE]\\\n> Before: seed\n> After: plant", '<br class="emend-callout-marker-break">\n'],
  [
    "<blockquote><p>[!NOTE] \t<br>Before: seed\nAfter: plant</p></blockquote>",
    ' \t<br class="emend-callout-marker-break">',
  ],
])("keeps a callout marker and its separators outside example rows: %s", async (md, separator) => {
  const blocks = await renderExample(md);
  const plain = await renderMarkdownWithBudget(md, "t-garden-example", { highlightedBytes: 0 });
  expect(blocks.map(({ id, text }) => ({ id, text }))).toEqual(plain.map(({ id, text }) => ({ id, text })));
  const html = blocks[0]?.html ?? "";
  expect(html).toContain(`<p class="emend-example-rows"><span class="emend-callout-marker">[!NOTE]</span>${separator}`);
  const paragraph = withClass(html, "emend-example-rows")[0];
  expect(paragraph?.children[0]).toMatchObject({
    type: "element",
    tagName: "span",
    properties: { className: ["emend-callout-marker"] },
    children: [{ type: "text", value: "[!NOTE]" }],
  });
  const rows = paragraph?.children.filter(
    (child) =>
      child.type === "element" &&
      Array.isArray(child.properties.className) &&
      child.properties.className.includes("emend-example-row"),
  );
  expect(rows?.map((row) => hastText(row))).toEqual(["Before: seed", "After: plant"]);
  expect(withClass(html, "emend-example-line")).toHaveLength(0);
});

test("a callout introduction stays outside its marker's prefix", async () => {
  const md = "> [!NOTE]\n> An intro.\n> Before: seed\n> After: plant";
  const blocks = await renderExample(md);
  const plain = await renderMarkdownWithBudget(md, "t-garden-example", { highlightedBytes: 0 });
  expect(blocks.map(({ id, text }) => ({ id, text }))).toEqual(plain.map(({ id, text }) => ({ id, text })));
  const html = blocks[0]?.html ?? "";
  expect(html).toContain(
    '<span class="emend-callout-marker">[!NOTE]</span>\n<span class="emend-example-line">An intro.</span>',
  );
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
  "> [!NOTE]\n> Body",
  "> [!NOTE]\n> **Before: seed**",
  "> [!NOTE]\n> Beforehand: seed\n> Afterwards: plant",
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

test("hostile continuation content stays sanitized inside the first row without changing text or ids", async () => {
  const md =
    'Before: one seed\nContinued: <script>bad()</script> <img src=x onerror=bad()> [bad](javascript:bad()) <svg onload=bad()></svg> <span class="emend-example-value">x</span>\nAfter: safe';
  const blocks = await renderExample(md);
  const plain = await renderMarkdownWithBudget(md, "t-garden-example", { highlightedBytes: 0 });
  expect(blocks).toHaveLength(1);
  expect(blocks.map(({ id, text }) => ({ id, text }))).toEqual(plain.map(({ id, text }) => ({ id, text })));
  for (const [index, block] of blocks.entries()) {
    expect(block.html).not.toMatch(/<script|<svg|onerror|onload|javascript:/i);
    expect(blockText(block.html)).toBe(blockText(plain[index]?.html ?? ""));
  }
  const html = blocks[0]?.html ?? "";
  expect(html).toContain('class="user-content-emend-example-value"');
  const rows = withClass(html, "emend-example-row");
  expect(rows).toHaveLength(2);
  const before = rows[0]?.children[1];
  if (before?.type !== "element") throw new Error("Missing first row value");
  expect(before).toMatchObject({ tagName: "span", properties: { className: ["emend-example-value"] } });
  expect(hastText(before)).toBe(" one seed\nContinued:   bad  x");
  expect(before.children.find((node) => node.type === "element" && node.tagName === "span")).toMatchObject({
    properties: { className: ["user-content-emend-example-value"] },
    children: [{ type: "text", value: "x" }],
  });
  expect(rows[1] && hastText(rows[1])).toBe("After: safe");
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

test.each([
  ["Before: one\nwrapped line\nAfter: two", " one\nwrapped line", undefined],
  ["Before: one  \nwrapped line\nAfter: two", " one\nwrapped line", undefined],
  [
    "An intro.\nAnother intro.\nBefore: one\nwrapped line\nAfter: two",
    " one\nwrapped line",
    "An intro.\nAnother intro.",
  ],
  ["Before: one\n**Before: another note**\nAfter: two", " one\nBefore: another note", undefined],
] as const)("keeps continuations in one value without changing text or ids: %s", async (md, before, intro) => {
  const blocks = await renderExample(md);
  const plain = await renderMarkdownWithBudget(md, "t-garden-example", { highlightedBytes: 0 });
  expect(blocks.map(({ id, text }) => ({ id, text }))).toEqual(plain.map(({ id, text }) => ({ id, text })));
  const html = blocks[0]?.html ?? "";
  expect(blockText(html)).toBe(blockText(plain[0]?.html ?? ""));
  const values = withClass(html, "emend-example-value");
  expect(values).toHaveLength(2);
  const first = values[0];
  expect(first && hastText(first)).toBe(before);
  const intros = withClass(html, "emend-example-line");
  expect(intros).toHaveLength(intro ? 1 : 0);
  if (intro) expect(intros[0] && hastText(intros[0])).toBe(intro);
  if (!md.includes("**"))
    expect(first?.children.filter((node) => node.type === "text")).toHaveLength(md.includes("  \n") ? 2 : 1);
});

test("a glossary term spanning a soft break stays marked inside one value", async () => {
  const md = "Before: exceeds the rate\nlimit.\nAfter: accepted.";
  const writeup = await renderWriteup(
    {
      overview: "",
      tldr: "",
      decisions: null,
      glossary: [{ term: "rate limit", definition: "The allowed request count." }],
      topics: { garden: { why: "A reason.", example: md } },
    },
    [topic],
  );
  const blocks = writeup.sections.find((section) => section.key === "t-garden-example")?.blocks ?? [];
  const plain = await renderMarkdownWithBudget(md, "t-garden-example", { highlightedBytes: 0 });
  expect(blocks.map(({ id, text }) => ({ id, text }))).toEqual(plain.map(({ id, text }) => ({ id, text })));
  expect(blocks[0]?.html).toContain(
    '<span class="emend-example-value"> exceeds the <span class="emend-term" data-emend-term="0">rate\nlimit</span>.</span>',
  );
  expect(blockText(blocks[0]?.html ?? "")).toBe(blockText(plain[0]?.html ?? ""));
});

test.each([" ", "&nbsp;"])("keeps %s after the label inside the value", async (space) => {
  const md = `Before:${space}one\nAfter:${space}two`;
  const blocks = await renderExample(md);
  const plain = await renderMarkdownWithBudget(md, "t-garden-example", { highlightedBytes: 0 });
  expect(blocks.map(({ id, text }) => ({ id, text }))).toEqual(plain.map(({ id, text }) => ({ id, text })));
  const html = blocks[0]?.html ?? "";
  expect(blockText(html)).toBe(blockText(plain[0]?.html ?? ""));
  const rows = withClass(html, "emend-example-row");
  expect(rows).toHaveLength(2);
  for (const [index, row] of rows.entries()) {
    expect(row.children).toHaveLength(2);
    expect(row.children[0]).toMatchObject({ type: "element", properties: { className: ["emend-example-label"] } });
    expect(row.children[1]).toMatchObject({
      type: "element",
      properties: { className: ["emend-example-value"] },
      children: [{ type: "text", value: `${space === "&nbsp;" ? "\u00a0" : " "}${index === 0 ? "one" : "two"}` }],
    });
  }
});

test("Example screenshot captions with colons keep their media pair and effect", async () => {
  const md = "![Before:](media/a.png) ![After:](media/b.png)\nMore room for seeds.";
  const media = new Map([
    ["media/a.png", "a".repeat(64)],
    ["media/b.png", "b".repeat(64)],
  ]);
  const writeup = await renderWriteup(
    { overview: "", tldr: "", decisions: null, topics: { garden: { why: "A reason.", example: md } } },
    [topic],
    { media },
  );
  const blocks = writeup.sections.find((section) => section.key === "t-garden-example")?.blocks ?? [];
  const plain = await renderMarkdownWithBudget(md, "t-garden-example", { highlightedBytes: 0 }, undefined, media);
  expect(blocks).toEqual(plain);
  const html = blocks[0]?.html ?? "";
  const pairs = withClass(html, "emend-media-pair");
  expect(pairs).toHaveLength(1);
  expect(pairs[0]?.tagName).toBe("p");
  expect(
    pairs[0]?.children.filter((node) => node.type === "element" && node.properties.className?.includes("emend-media")),
  ).toHaveLength(2);
  expect(withClass(html, "emend-media-effect")).toHaveLength(1);
  expect(html).not.toContain("emend-example-");
});
