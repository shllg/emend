import { LIMITS } from "@emend/contract";
import { defaultTreeAdapter } from "parse5";
import { afterEach, expect, test, vi } from "vitest";
import { htmlHeadings, markdownHeadings } from "./doc-headings.ts";
import { inferDocTitle } from "./doc-title.ts";
import * as html from "./place/html.ts";
import { docText, HTML_NESTING_LIMIT, htmlPart, nodeText, parseDocHtml } from "./place/html.ts";
import { renderDoc } from "./render/markdown.ts";

const encode = (text: string) => new TextEncoder().encode(text);
afterEach(() => vi.restoreAllMocks());
test.each(["script", "style", "textarea"])("Markdown titles ignore raw %s content", async (tag) => {
  expect(await inferDocTitle("markdown", encode(`<${tag}>\n# Hidden\n</${tag}>\n\n# **Visible**`))).toBe("Visible");
});
test.each([
  ["<svg><title>Wrong</title></svg><h1>Right</h1>", "Right"],
  ["<head><title>First</title></head><body><h1>Second</h1></body>", "First"],
  ["<title>\u200b</title><h1>Fallback</h1>", "Fallback"],
  ["<svg><title>Wrong</title></svg>", undefined],
  ["<template><h1>Hidden</h1></template><h1>Visible</h1>", "Visible"],
])("HTML title uses head title, then body HTML h1", async (source, title) => {
  expect(await inferDocTitle("html", encode(source))).toBe(title);
});
test("HTML Contents follows docText parsing, skips hidden elements and keeps empty positions", () => {
  const source =
    "<h1>Title</h1><h2> A\u200b  <b>B</b><script>hidden</script> </h2><h3>\u202e C &amp; D</h3><h2>\u200b</h2>" +
    ["script", "style", "template", "noscript"].map((tag) => `<${tag}><h2>omitted</h2></${tag}>`).join("") +
    "<h4>Ignored</h4>";
  expect(docText(source)).not.toContain("omitted");
  expect(htmlHeadings(source)).toEqual([
    { level: 2, text: "A B" },
    { level: 3, text: "C & D" },
    { level: 2, text: "" },
  ]);
  expect(htmlHeadings(`${"<div>".repeat(HTML_NESTING_LIMIT)}<h2>too deep</h2>`)).toEqual([]);
});
test("large synthetic Contents has bounded count and cleaned labels", () => {
  const source = Array.from({ length: 1200 }, (_, i) => `<h2>${i}: ${"long ".repeat(80)}</h2>`).join("");
  const headings = htmlHeadings(source);
  expect(headings).toHaveLength(LIMITS.headingsPerDoc);
  expect(headings.every((h) => h.text.length <= LIMITS.headingTextChars && h.text === h.text.trim())).toBe(true);
});
test("Markdown Contents declares exactly the rendered h2/h3 anchors, including duplicates", async () => {
  const blocks = await renderDoc("# Title\n\n## First\n\n### Second\n\n## First\n\n#### Fourth", "doc.md");
  const headings = markdownHeadings(blocks);
  expect(headings.map((h) => [h.level, h.text])).toEqual([
    [2, "First"],
    [3, "Second"],
    [2, "First"],
  ]);
  expect(new Set(headings.map((h) => h.id)).size).toBe(3);
  for (const heading of headings) expect(blocks.some((b) => b.html.includes(`id="${heading.id}"`))).toBe(true);
});

test("Markdown heading metadata retains only sanitized author IDs", async () => {
  const blocks = await renderDoc('<h2 id="thread-x" onclick="bad()">Heading</h2>', "doc.md");
  expect(markdownHeadings(blocks)).toEqual([{ level: 2, text: "Heading", id: "user-content-thread-x" }]);
  expect(blocks[0]?.html).not.toContain("onclick");
});

test("bounded node text stops before walking a large trailing subtree", () => {
  const tree = parseDocHtml(`<h2><span>${"x".repeat(1000)}</span><span>${"<b>tail</b>".repeat(20000)}</span></h2>`);
  const body = tree && htmlPart(tree, "body");
  if (!body || !("childNodes" in body)) throw new Error("missing body");
  const heading = body.childNodes[0];
  if (!heading || !("childNodes" in heading)) throw new Error("missing heading");
  const tail = heading.childNodes[1];
  if (!tail) throw new Error("missing tail");
  Object.defineProperty(tail, "childNodes", {
    get() {
      throw new Error("walk exceeded text bound");
    },
  });
  expect(nodeText(heading, 4 * LIMITS.headingTextChars)).toBe("x".repeat(4 * LIMITS.headingTextChars));
  expect(htmlHeadings(`<h2><span>${"x".repeat(1000000)}</span></h2>`)).toEqual([
    { level: 2, text: "x".repeat(LIMITS.headingTextChars) },
  ]);
});

test.each(["span", "script"])("bounded node text also stops after empty %s nodes", (tag) => {
  const tree = parseDocHtml(`<h2>${`<${tag}></${tag}>`.repeat(100)}<b>too late</b></h2>`);
  const body = tree && htmlPart(tree, "body");
  if (!body || !("childNodes" in body)) throw new Error("missing body");
  const heading = body.childNodes[0];
  if (!heading || !("childNodes" in heading)) throw new Error("missing heading");
  const tail = heading.childNodes[80];
  if (!tail) throw new Error("missing tail");
  Object.defineProperty(tail, "childNodes", {
    get() {
      throw new Error("walk exceeded node bound");
    },
  });
  expect(nodeText(heading, 10)).toBe("");
});

test("nested headings over a large empty subtree have bounded text work", () => {
  const depth = Math.floor((HTML_NESTING_LIMIT - 4) / 2);
  const source = `${"<h2><span>".repeat(depth)}${"<b></b>".repeat(500000)}${"</span></h2>".repeat(depth)}`;
  const isText = vi.spyOn(defaultTreeAdapter, "isTextNode");
  const readText = html.nodeText;
  const visits: number[] = [];
  const text = vi.spyOn(html, "nodeText").mockImplementation((...args) => {
    isText.mockClear();
    const result = readText(...args);
    visits.push(isText.mock.calls.length);
    return result;
  });
  expect(htmlHeadings(source)).toEqual(Array.from({ length: depth }, () => ({ level: 2, text: "" })));
  expect(text).toHaveBeenCalledTimes(depth);
  expect(text.mock.calls.every(([, limit]) => limit === 4 * LIMITS.headingTextChars)).toBe(true);
  // nodeText visits at most eight nodes per requested character, including empty elements.
  expect(visits).toHaveLength(depth);
  for (const count of visits) expect(count).toBeLessThanOrEqual(8 * 4 * LIMITS.headingTextChars);
}, 30000);

test.each([
  '<h2 id="x">One</h2><h2 id="x">Two</h2>',
  '<p id="x">Before</p><h2 id="x">One</h2>',
  `<h2 id="${"x".repeat(300)}">One</h2>`,
])("ambiguous or overlong author ids get unique generated headings: %s", async (source) => {
  const blocks = await renderDoc(source, "doc.md");
  const headings = markdownHeadings(blocks);
  expect(new Set(headings.map((heading) => heading.id)).size).toBe(headings.length);
  for (const heading of headings) {
    expect(heading.id).toMatch(/^heading-/);
    expect(heading.id?.length).toBeLessThanOrEqual(256);
    expect(heading.id).not.toMatch(/^(thread|diff|block|doc|html-doc|h)-/);
  }
  expect(markdownHeadings([...blocks, ...blocks])).toEqual(headings);
});
