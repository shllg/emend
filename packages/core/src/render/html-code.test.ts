import { LIMITS } from "@emend/contract";
import { type DefaultTreeAdapterTypes, defaultTreeAdapter } from "parse5";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { docText, HTML_ELEMENT_LIMIT, HTML_NESTING_LIMIT, nodeText, parseDocHtml } from "../place/html.ts";
import { HIGHLIGHT_FENCE_BYTES, HIGHLIGHT_RENDER_BYTES } from "./highlight.ts";
import * as highlighterModule from "./highlighter.ts";
import {
  applyHtmlCodeColours,
  type HtmlCodeColour,
  highlightHtmlCode,
  htmlCodeCandidate,
  htmlCodeColours,
} from "./html-code.ts";
import { renderMarkdown } from "./markdown.ts";

afterEach(() => vi.restoreAllMocks());

const block = (text: string, language = "ts") => `<pre><code class="language-${language}">${text}</code></pre>`;

beforeAll(async () => {
  // Warm the grammars; cold scans can exhaust Shiki's per-line limit under load.
  await highlightHtmlCode(
    block('const seed: string = "fern"; // note') +
      block('const seed = "fern"; // note', "js") +
      block('&lt;p class="note"&gt;fern&lt;/p&gt;', "html"),
  );
});

function elements(html: string, sourceLocations = false): DefaultTreeAdapterTypes.Element[] {
  const tree = parseDocHtml(html, Infinity, sourceLocations);
  if (!tree) throw new Error("Missing fixture tree");
  const result: DefaultTreeAdapterTypes.Element[] = [];
  const pending: DefaultTreeAdapterTypes.Node[] = [tree];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (defaultTreeAdapter.isElementNode(node)) result.push(node);
    if ("childNodes" in node) pending.push(...node.childNodes.toReversed());
  }
  return result;
}

function tokenStyles(html: string): [string, string][] {
  return elements(html).flatMap<[string, string]>((element) => {
    const style = element.attrs.find((attr) => attr.name === "style")?.value;
    return element.tagName === "span" && style !== undefined ? [[nodeText(element), style]] : [];
  });
}

test("HTML code uses the same token colours and italic comments as Markdown", async () => {
  const text = 'const seed: string = "fern";\nconst count: number = 42; // note\n';
  // Warm both renderers; cold scans can exhaust Shiki's per-line limit under load.
  await renderMarkdown(`\`\`\`ts\n${text}\`\`\``, "overview");
  await highlightHtmlCode(block(text));
  const markdown = await renderMarkdown(`\`\`\`ts\n${text}\`\`\``, "overview");
  const output = await highlightHtmlCode(block(text));
  const tokens = tokenStyles(output);
  expect(tokens.length).toBeGreaterThan(0);
  expect(tokens).toEqual(tokenStyles(markdown.map((entry) => entry.html).join("")));
  expect(tokens).toContainEqual([expect.stringContaining("note"), expect.stringContaining("font-style:italic")]);
  expect(output).not.toContain('class="line"');
});

test.each([
  ["no language class", "<pre><code>const seed = 1;</code></pre>"],
  ["unknown language", block("const seed = 1;", "nosuchlang")],
  ["Mermaid language", block("graph LR; A --&gt; B", "mermaid")],
  ["Mermaid pre", '<pre class="note\tmermaid\nwide"><code class="language-ts">const seed = 1;</code></pre>'],
  ["inline code", '<p><code class="language-ts">const seed = 1;</code></p>'],
  ["element child", block("const <b>seed</b> = 1;")],
  ["comment child", block("const seed = 1;<!-- note -->")],
  ["missing code end tag", '<pre><code class="language-ts">const seed = 1;</pre>'],
  ["reconstructed unclosed code", '<pre><code class="language-ts">before</pre><p>middle</p><pre>after</code></pre>'],
  ["misnested code", '<pre><b><code class="language-ts">xx</b>const y = 2;</code></pre>'],
  ["ignored end tag", '<pre><code class="language-ts">a</span>b</code></pre>'],
  ["merged body attributes", '<pre><code class="language-ts">a<body data-x="1">b</code></pre>'],
  ["template contents", `<template>${block("const seed = 1;")}</template>`],
  ["script contents", `<script>${block("const seed = 1;")}</script>`],
  ["style contents", `<style>${block("const seed = 1;")}</style>`],
  ["noscript contents", `<noscript>${block("const seed = 1;")}</noscript>`],
  ["no language marker", "<!doctype html><p>Plain synthetic doc</p>"],
  ["empty code", block("")],
  ["decimal carriage return", block("a&#13;b")],
  ["hexadecimal carriage return", block("a&#xD;b")],
  ["unescaped script", block("const seed = 1;<script>alert(1)</script>")],
  [
    "excessive nesting",
    `${"<div>".repeat(HTML_NESTING_LIMIT + 1)}${block("const seed = 1;")}${"</div>".repeat(HTML_NESTING_LIMIT + 1)}`,
  ],
])("leaves %s byte-for-byte unchanged", async (_name, input) => {
  const output = await highlightHtmlCode(input);
  expect(output).toBe(input);
  expect(docText(output)).toBe(docText(input));
});

test.each([
  ["<p>Plain synthetic doc</p>", false],
  ["<codex>const seed = 1;</codex>", false],
  ["<CODE>", true],
  ["<code\n", true],
  ["<code/>", true],
] as const)("candidate detection for %j returns %s", (input, candidate) => {
  expect(htmlCodeCandidate(input)).toBe(candidate);
});

test("candidate detection rejects a doc over the character cap", () => {
  expect(htmlCodeCandidate(`${"x".repeat(LIMITS.markdownDocBytes)}<code>`)).toBe(false);
});

test.each(["<p>Plain synthetic doc</p>", "<!-- language-ts --><pre><code>const seed = 1;</code></pre>"])(
  "docs without a candidate block skip highlighter loading: %s",
  async (input) => {
    const highlighter = vi.spyOn(highlighterModule, "sharedHighlighter");
    expect(await htmlCodeColours(input)).toEqual([]);
    expect(await highlightHtmlCode(input)).toBe(input);
    expect(highlighter).not.toHaveBeenCalled();
  },
);

test("character references in a language class still colour the block", async () => {
  const input = '<pre><code class="language&#45;ts">const seed = 1;</code></pre>';
  const output = await highlightHtmlCode(input);
  expect(tokenStyles(output).length).toBeGreaterThan(0);
  expect(output).toContain('class="language&#45;ts"');
  expect(docText(output)).toBe(docText(input));
});

test.each(["x", "é"])("oversized docs stay unchanged with %s bytes", async (letter) => {
  const highlighter = vi.spyOn(highlighterModule, "sharedHighlighter");
  const bytes = new TextEncoder().encode(letter).byteLength;
  const input = block("const seed = 1;") + letter.repeat(Math.floor(LIMITS.markdownDocBytes / bytes) + 1);
  expect(new TextEncoder().encode(input).byteLength).toBeGreaterThan(LIMITS.markdownDocBytes);
  if (bytes > 1) expect(input.length).toBeLessThan(LIMITS.markdownDocBytes);
  expect(await highlightHtmlCode(input)).toBe(input);
  expect(highlighter).not.toHaveBeenCalled();
});

test("docs exceeding the parsed element limit stay unchanged", async () => {
  const highlighter = vi.spyOn(highlighterModule, "sharedHighlighter");
  const formatting = Array.from({ length: 100 }, (_, index) => `<b data-i="${index}">`).join("");
  const input = `${block("const seed = 1;")}<p>${formatting}x</p>${"<p>x</p>".repeat(Math.ceil(HTML_ELEMENT_LIMIT / 100))}`;
  expect(new TextEncoder().encode(input).byteLength).toBeLessThan(LIMITS.markdownDocBytes);
  expect(await highlightHtmlCode(input)).toBe(input);
  expect(highlighter).not.toHaveBeenCalled();
});

test("applying colours skips overlapping and out-of-range splices", () => {
  const colours: readonly HtmlCodeColour[] = Object.freeze([
    { start: 7, end: 9, markup: "Y" },
    { start: -1, end: 1, markup: "negative" },
    { start: 1, end: 3, markup: "X" },
    { start: 2, end: 5, markup: "overlap" },
    { start: 3, end: 11, markup: "past end" },
    { start: 4, end: 3, markup: "reversed" },
    { start: 11, end: 12, markup: "outside" },
  ]);
  expect(applyHtmlCodeColours("abcdefghij", colours)).toBe("aXdefgYj");
});

test.each(["", "\uFEFF"])("only code contents change with BOM %j and CRLF", async (bom) => {
  const prefix = `${bom}<!doctype html>\r\n<p>Before 🌱</p>\r\n<pre data-x="1"><code id="c" class="note language-ts" data-y="2">`;
  const text = 'const seed: string = "fern";\r\n// note\r\n';
  const suffix = "</code></pre>\r\n<p>After</p>";
  const input = prefix + text + suffix;
  const output = await highlightHtmlCode(input);
  expect(tokenStyles(output).length).toBeGreaterThan(0);
  expect(output.slice(0, output.indexOf(">", output.indexOf("<code")) + 1)).toBe(prefix);
  expect(output.slice(output.indexOf("</code>"))).toBe(suffix);
  const code = elements(input, true).find((node) => node.tagName === "code");
  expect(code?.sourceCodeLocation?.startTag?.endOffset).toBe(prefix.length);
  expect(code?.sourceCodeLocation?.endTag?.startOffset).toBe(prefix.length + text.length);
});

test("several coloured blocks preserve exact parsed text, entities, CRLF and a leading BOM", async () => {
  const input =
    "\uFEFF<!doctype html>\r\n<p>Before 🌱</p>\r\n" +
    block('const seed = "&amp;&lt;&#x27;&nbsp;";\r\n// note\r\n') +
    "\r\n<p>Between</p>\r\n" +
    block("let count: number = 42;\r\n", "ts") +
    "\r\n<p>After</p>";
  const output = await highlightHtmlCode(input);
  const codes = (html: string) => elements(html).filter((node) => node.tagName === "code");
  expect(codes(output)).toHaveLength(2);
  for (const code of codes(output)) expect(code.childNodes.some(defaultTreeAdapter.isElementNode)).toBe(true);
  expect(codes(output).map((code) => nodeText(code))).toEqual(codes(input).map((code) => nodeText(code)));
  expect(docText(output)).toBe(docText(input));
  expect(output.startsWith("\uFEFF<!doctype html>\r\n<p>Before 🌱</p>\r\n")).toBe(true);
  expect(output).toContain("\r\n<p>Between</p>\r\n");
  expect(output.endsWith("\r\n<p>After</p>")).toBe(true);
});

test("hostile code remains escaped text inside spans with only Shiki styles", async () => {
  const input =
    block(
      "&lt;script&gt;alert(1)&lt;/script&gt;\n" +
        "&lt;img src=x onerror=alert(1)&gt;\n" +
        '&lt;a href="javascript:alert(1)"&gt;x&lt;/a&gt;\n' +
        "&lt;svg onload=alert(1)&gt;",
      "html",
    ) + block('const s = "&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;";', "js");
  const output = await highlightHtmlCode(input);
  const nodes = elements(output);
  expect(nodes.some((node) => ["script", "img", "a", "svg"].includes(node.tagName))).toBe(false);
  const codes = nodes.filter((node) => node.tagName === "code");
  expect(codes).toHaveLength(2);
  for (const code of codes) {
    const spans = code.childNodes.filter(defaultTreeAdapter.isElementNode);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.tagName).toBe("span");
      expect(span.attrs).toEqual([
        {
          name: "style",
          value: expect.stringMatching(/^(?:(?:color|font-style|font-weight|text-decoration):[^;"<>]+;?)+$/),
        },
      ]);
      expect(span.childNodes.every(defaultTreeAdapter.isTextNode)).toBe(true);
    }
  }
  expect(codes.map((code) => nodeText(code))).toEqual(
    elements(input)
      .filter((node) => node.tagName === "code")
      .map((code) => nodeText(code)),
  );
  expect(docText(output)).toBe(docText(input));
});

test("a 5000-character line keeps its exact text", async () => {
  const text = `// ${"x".repeat(4997)}`;
  const output = await highlightHtmlCode(block(text));
  const code = elements(output).find((node) => node.tagName === "code");
  if (!code) throw new Error("Missing code element");
  expect(nodeText(code)).toBe(text);
});

test.each(["x", "é"])("oversized fences stay unchanged with %s bytes", async (letter) => {
  const text = letter.repeat(Math.floor(HIGHLIGHT_FENCE_BYTES / new TextEncoder().encode(letter).byteLength) + 1);
  const input = block(text);
  expect(await highlightHtmlCode(input)).toBe(input);
});

test("one budget colours the first blocks and leaves later blocks unchanged", async () => {
  const text = `// ${"x".repeat(60)}\n`.repeat(HIGHLIGHT_FENCE_BYTES / 64);
  const count = HIGHLIGHT_RENDER_BYTES / HIGHLIGHT_FENCE_BYTES;
  const tail = block("const later = 42;") + block("const last = 7;");
  const input = block(text).repeat(count) + tail;
  const output = await highlightHtmlCode(input);
  const codes = elements(output).filter((node) => node.tagName === "code");
  expect(codes).toHaveLength(count + 2);
  for (const code of codes.slice(0, count)) expect(code.childNodes.some(defaultTreeAdapter.isElementNode)).toBe(true);
  expect(output.endsWith(tail)).toBe(true);
  expect(docText(output)).toBe(docText(input));
  expect(tokenStyles(await highlightHtmlCode(tail)).length).toBeGreaterThan(0);
});

test("highlighter failures return the original doc", async () => {
  vi.spyOn(highlighterModule, "sharedHighlighter").mockRejectedValueOnce(new Error("Synthetic failure"));
  const input = block("const seed = 1;");
  expect(await highlightHtmlCode(input)).toBe(input);
});

test("colour computation rejects highlighter failures", async () => {
  vi.spyOn(highlighterModule, "sharedHighlighter").mockRejectedValueOnce(new Error("Synthetic failure"));
  await expect(htmlCodeColours(block("const seed = 1;"))).rejects.toThrow("Synthetic failure");
});

test("a changed token text leaves the block unchanged", async () => {
  const highlighter = await highlighterModule.sharedHighlighter();
  const changed = highlighter.codeToHast("const changed = 2;", { lang: "ts", theme: "emend" });
  vi.spyOn(highlighter, "codeToHast").mockReturnValueOnce(changed);
  const input = block("const seed = 1;");
  expect(await highlightHtmlCode(input)).toBe(input);
});
