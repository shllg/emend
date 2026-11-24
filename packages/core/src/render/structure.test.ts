import { expect, test } from "vitest";
import { blockText } from "./blocks.ts";
import { blockHash } from "./hash.ts";
import { renderMarkdown } from "./markdown.ts";

test.each([
  ["<section><p>in section</p></section>", ["paragraph"], ["in section"]],
  ["<details><summary>S</summary><p>body</p></details>", ["paragraph", "paragraph"], ["S", "body"]],
  ["<div><h2>T</h2><p>a</p><ul><li>x</li></ul></div>", ["heading", "paragraph", "item"], ["T", "a", "x"]],
  [
    "<section>Before <em>inline</em><div><p>Inside</p></div>After</section>",
    ["paragraph", "paragraph", "paragraph"],
    ["Before inline", "Inside", "After"],
  ],
  ["<section><span>Only</span> <strong>inline</strong></section>", ["paragraph"], ["Only inline"]],
])("splits safe containers in source order: %s", async (markdown, kinds, texts) => {
  const blocks = await renderMarkdown(markdown, "overview");
  expect(blocks.map((block) => block.kind)).toEqual(kinds);
  expect(blocks.map((block) => block.text.trim())).toEqual(texts);
});

test("renders footnote headings and definitions with a single clobber prefix", async () => {
  const blocks = await renderMarkdown("a[^1]\n\n[^1]: note text here", "overview");
  expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "heading", "item"]);
  expect(blocks[0]?.text).toBe("a1");
  expect(blocks[1]?.text).toBe("Footnotes");
  expect(blocks[2]?.text).toContain("note text here");
  expect(blocks[0]?.html).toContain('id="user-content-fnref-1"');
  expect(blocks[2]?.html).toContain('id="user-content-fn-1"');
  for (const block of blocks) {
    expect(block.html).not.toMatch(/user-content-user-content-|\shref=|\sdata-/);
  }
});

test("footnote numbering and extra back references never change an unchanged block's id", async () => {
  const before = await renderMarkdown("A[^a]\n\n[^a]: Original note.", "overview");
  const after = await renderMarkdown(
    "B[^b]\n\nA[^a]\n\nA again[^a]\n\n[^a]: Original note.\n[^b]: New note.",
    "overview",
  );
  const paragraph = before.find((block) => block.text === "A1");
  const revisedParagraph = after.find((block) => block.text === "A2");
  const definition = before.find((block) => block.kind === "item" && block.text.includes("Original note."));
  const revisedDefinition = after.find((block) => block.kind === "item" && block.text.includes("Original note."));
  expect(paragraph?.id).toBe(`overview-${await blockHash("A")}`);
  expect(revisedParagraph?.id).toBe(paragraph?.id);
  expect(definition?.id).toBe(`overview-${await blockHash("Original note.")}`);
  expect(revisedDefinition?.id).toBe(definition?.id);
  expect(revisedDefinition?.text).not.toBe(definition?.text);
  for (const block of [...before, ...after]) expect(block.text).toBe(blockText(block.html));
});

test.each([
  "> Before\n>\n> ```mermaid\n> graph TD; A-->B\n> ```\n>\n> After",
  "<section>\n\nBefore\n\n```mermaid\ngraph TD; A-->B\n```\n\nAfter\n\n</section>",
  "- Before\n\n  ```mermaid\n  graph TD; A-->B\n  ```\n\n  After",
  "> Before\n>\n> - ```mermaid\n>   graph TD; A-->B\n>   ```\n>\n> After",
])("keeps nested Mermaid diagrams between surrounding text: %s", async (markdown) => {
  const blocks = await renderMarkdown(markdown, "overview");
  expect(blocks).toHaveLength(3);
  expect(blocks.map((block) => block.text.trim())).toEqual(["Before", "graph TD; A-->B", "After"]);
  expect(blocks[1]).toMatchObject({ kind: "diagram", source: "graph TD; A-->B", html: "" });
  expect(blocks[0]?.html).not.toContain("graph TD");
  expect(blocks[2]?.html).not.toContain("graph TD");
});

test("a link never wraps a heading or paragraph", async () => {
  const blocks = await renderMarkdown('<a href="https://example.com">\n\n# Heading\n\npara', "overview");
  expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph"]);
  expect(blocks.map((block) => block.text)).toEqual(["Heading", "para"]);
  for (const block of blocks) expect(block.html).not.toMatch(/\s(?:href|rel)=/);
});

test("a block link inside an atomic quote is also inert", async () => {
  const blocks = await renderMarkdown(
    '<blockquote><a href="https://example.com"><p>Text</p></a></blockquote>',
    "overview",
  );
  expect(blocks[0]?.kind).toBe("quote");
  expect(blocks[0]?.text).toBe("Text");
  expect(blocks[0]?.html).not.toMatch(/\s(?:href|rel)=/);
});

test("each description-list term and definition is an item", async () => {
  const blocks = await renderMarkdown(
    "<dl><dt>Shelf</dt><dd>A named group.</dd><dt>Loan</dt><dd><p>A borrowed book.</p></dd></dl>",
    "glossary",
  );
  expect(blocks.map((block) => block.kind)).toEqual(["item", "item", "item", "item"]);
  expect(blocks.map((block) => block.text)).toEqual(["Shelf", "A named group.", "Loan", "A borrowed book."]);
  for (const block of blocks) expect(block.text).toBe(blockText(block.html));
});

test.each([
  ["hidden one", "totally different"],
  ["1", "2"],
])("raw footnote reference attributes cannot hide %s from identity", async (before, after) => {
  const render = (text: string) => renderMarkdown(`A <sup><a data-footnote-ref>${text}</a></sup>`, "overview");
  const [first] = await render(before);
  const [second] = await render(after);
  expect(first?.id).toBe(`overview-${await blockHash(`A ${before}`)}`);
  expect(second?.id).toBe(`overview-${await blockHash(`A ${after}`)}`);
  expect(second?.id).not.toBe(first?.id);
});

test.each([
  ["hidden one", "totally different"],
  ["↩", "↩2"],
])("raw footnote back-reference attributes cannot hide %s from identity", async (before, after) => {
  const render = (text: string) => renderMarkdown(`A <a data-footnote-backref>${text}</a>`, "overview");
  const [first] = await render(before);
  const [second] = await render(after);
  expect(first?.id).toBe(`overview-${await blockHash(`A ${before}`)}`);
  expect(second?.id).toBe(`overview-${await blockHash(`A ${after}`)}`);
  expect(second?.id).not.toBe(first?.id);
});

test("author footnote attributes remain ordinary text inside a genuine definition", async () => {
  const blocks = await renderMarkdown("A[^a]\n\n[^a]: Note <a data-footnote-backref>↩2</a>.", "overview");
  const definition = blocks.find((block) => block.kind === "item");
  expect(definition?.id).toBe(`overview-${await blockHash("Note ↩2.")}`);
  expect(blocks[0]?.id).toBe(`overview-${await blockHash("A")}`);
});

test.each([
  ["<ul><p>lost</p><li>x</li></ul>", ["lost", "x"]],
  ["<ol>text<li>y</li></ol>", ["text", "y"]],
])("preserves stray list content in source order: %s", async (markdown, texts) => {
  const blocks = await renderMarkdown(markdown, "overview");
  expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "item"]);
  expect(blocks.map((block) => block.text)).toEqual(texts);
});

test("drops empty non-diagram blocks left by misnested markup", async () => {
  const blocks = await renderMarkdown('<a href="https://example.com"><h1>H</h1></a>', "overview");
  expect(blocks.map((block) => ({ kind: block.kind, text: block.text }))).toEqual([{ kind: "heading", text: "H" }]);
  const empty = await renderMarkdown("<p> \t</p>\n\n```ts\n```\n\n```mermaid\n```", "overview");
  expect(empty).toHaveLength(1);
  expect(empty[0]).toMatchObject({ kind: "diagram", html: "", text: "" });
});

test("stops splitting containers at depth 64", async () => {
  const render = (depth: number) =>
    renderMarkdown(`${"<div>".repeat(depth)}<p>One</p><p>Two</p>${"</div>".repeat(depth)}`, "overview");
  expect((await render(63)).map((block) => block.text)).toEqual(["One", "Two"]);
  expect((await render(64)).map((block) => block.text)).toEqual(["OneTwo"]);
});

// Production depth is covered through the worker in apps/recense/src/server/publish/render-depth.test.ts.
test("renders 1000 nested divs without overflowing the stack", async () => {
  const blocks = await renderMarkdown(`${"<div>".repeat(1000)}<p>Deep content</p>${"</div>".repeat(1000)}`, "overview");
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ kind: "paragraph", text: "Deep content" });
  expect(blockText(blocks[0]?.html ?? "")).toBe("Deep content");
});

test("1000 nested containers preserve sanitized markup, escaped text and identity", async () => {
  const content =
    '<p title="&quot;quoted&quot; &amp; text">Deep <strong>&lt;content&gt;</strong><br>&amp; more<img src="https://example.com/a.png" onerror="bad()"></p>';
  const [shallow] = await renderMarkdown(content, "overview");
  const [deep] = await renderMarkdown(`${"<div>".repeat(1000)}${content}${"</div>".repeat(1000)}`, "overview");
  expect(deep?.id).toBe(shallow?.id);
  expect(deep?.text).toBe("Deep <content>& more");
  expect(deep?.html).toContain(shallow?.html);
  expect(deep?.html).not.toContain("onerror");
});
