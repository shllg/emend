import { fromHtml } from "hast-util-from-html";
import { describe, expect, test } from "vitest";
import { makeSpan, placeSpan } from "../place/span.ts";
import { blockText, type HtmlElement, visitElements } from "./blocks.ts";
import { blockHash } from "./hash.ts";
import { renderCommentHtml, renderDoc, renderMarkdown } from "./markdown.ts";
import { normalizeText } from "./normalize.ts";
import { renderWriteup } from "./writeup.ts";

describe("GitHub alert callouts", () => {
  test("a note stays one quote block with the original marker and body text", async () => {
    const oldHtml = "<blockquote>\n<p>[!NOTE]\nBody text</p>\n</blockquote>";
    const blocks = await renderMarkdown("> [!NOTE]\n> Body text", "overview");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("quote");
    expect(blocks[0]?.html).toContain('class="emend-callout emend-callout-note"');
    expect(blocks[0]?.html).toContain('<span class="emend-callout-marker">[!NOTE]</span>\nBody text</p>');
    expect(blocks[0]?.html).not.toContain("emend-callout-title");
    expect(blocks[0]?.text).toBe("\n[!NOTE]\nBody text\n");
    expect(blocks[0]?.text).toBe(blockText(oldHtml));
  });

  test.each([
    ["WARNING", "warning"],
    ["warning", "warning"],
    ["TIP", "tip"],
    ["IMPORTANT", "important"],
    ["CAUTION", "caution"],
    ["nOtE", "note"],
  ])("%s has its own class and preserves the marker's case", async (marker, type) => {
    const [block] = await renderMarkdown(`> [!${marker}]\n> Body`, "overview");
    expect(block?.html).toContain(`class="emend-callout emend-callout-${type}"`);
    expect(block?.html).toContain(`<span class="emend-callout-marker">[!${marker}]</span>`);
    expect(block?.html).not.toContain("emend-callout-title");
  });

  test.each([
    ["> [!NOTE]\n> Body text", "\n[!NOTE]\nBody text\n"],
    ["> [!NOTE]\n>\n> Body", "\n[!NOTE]\nBody\n"],
    ["> [!warning]\n> Body", "\n[!warning]\nBody\n"],
  ])("keeps the original block text and id: %s", async (markdown, oldText) => {
    const section = "overview";
    const [block] = await renderMarkdown(markdown, section);
    expect(block?.text).toBe(oldText);
    expect(block?.id).toBe(`${section}-${await blockHash(normalizeText(oldText))}`);
  });

  test("a selection anchored to the old quote still places at the same block id", async () => {
    const section = "overview";
    const oldText = "\n[!NOTE]\nBody text\n";
    const oldBlock = {
      id: `${section}-${await blockHash(normalizeText(oldText))}`,
      section,
      kind: "quote" as const,
      html: "<blockquote>\n<p>[!NOTE]\nBody text</p>\n</blockquote>",
      text: oldText,
    };
    const start = normalizeText(oldText).indexOf("Body text");
    const end = start + "Body text".length;
    const target = { kind: "writeup-span" as const, ...makeSpan(oldBlock, start, end) };
    expect(target).toEqual({
      kind: "writeup-span",
      blockId: oldBlock.id,
      quote: "Body text",
      prefix: "[!NOTE] ",
      suffix: "",
    });
    const blocks = await renderMarkdown("> [!NOTE]\n> Body text", section);
    expect(placeSpan(blocks, target)).toEqual({
      status: "placed",
      location: { kind: "writeup-span", blockId: oldBlock.id, start, end },
    });
  });

  test("a marker in its own paragraph keeps that paragraph and its separators", async () => {
    const [block] = await renderMarkdown("> [!NOTE]\n>\n> Body", "overview");
    expect(block?.html).toBe(
      '<blockquote class="emend-callout emend-callout-note">\n' +
        '<p class="emend-callout-marker-line"><span class="emend-callout-marker">[!NOTE]</span></p>\n' +
        "<p>Body</p>\n</blockquote>",
    );
  });

  test("a plain quote keeps its exact HTML", async () => {
    const [block] = await renderMarkdown("> A plain quote.", "overview");
    expect(block?.html).toBe("<blockquote>\n<p>A plain quote.</p>\n</blockquote>");
  });

  test.each([
    ["> [!NOTE] same line", "[!NOTE]"],
    ["> [!NOTE]", "[!NOTE]"],
    ["> [!NOTE]\n>   ", "[!NOTE]"],
    ["> [!FOO]\n> body", "[!FOO]"],
    ["> Intro\n> [!NOTE]\n> body", "[!NOTE]"],
    ["- > [!NOTE]\n  > body", "[!NOTE]"],
    ["> > [!NOTE]\n> > body", "[!NOTE]"],
    ["> [!NOTE] **bold**\n> body", "[!NOTE]"],
    ["> [!NOTE][link](https://example.com)\n> body", "[!NOTE]"],
    ["> **[!NOTE]**\n> body", "[!NOTE]"],
    ["<blockquote><p> [!NOTE]\nbody</p></blockquote>", "[!NOTE]"],
    ["<blockquote><h2>Intro</h2><p>[!NOTE]\nbody</p></blockquote>", "[!NOTE]"],
  ])("leaves an unsupported quote untouched: %s", async (markdown, marker) => {
    const blocks = await renderMarkdown(markdown, "overview");
    const html = blocks.map((block) => block.html).join("");
    expect(html).not.toContain("emend-callout");
    expect(html).toContain(marker);
  });

  test.each(["> [!NOTE]<br>", "> [!NOTE]\n> <br>", "<blockquote><p>[!NOTE]<br><br></p></blockquote>"])(
    "line breaks alone after a marker leave the quote plain: %s",
    async (markdown) => {
      const [block] = await renderMarkdown(markdown, "overview");
      expect(block?.kind).toBe("quote");
      expect(block?.html).toContain("[!NOTE]");
      expect(block?.html).toContain("<br>");
      expect(block?.html).not.toContain("emend-callout");
    },
  );

  test.each([
    "> [!NOTE] \t\n> Body",
    "> [!NOTE]  \n> Body",
    "> [!NOTE]\\\n> Body",
    "<blockquote><p>[!NOTE] \t<br>Body</p></blockquote>",
  ])("accepts whitespace or a hard break after the marker: %s", async (markdown) => {
    const [block] = await renderMarkdown(markdown, "overview");
    expect(block?.html).toContain('class="emend-callout emend-callout-note"');
    expect(block?.html).toContain('<span class="emend-callout-marker">[!NOTE]</span>');
    expect(block?.text).toContain("Body");
    expect(block?.html).not.toContain("emend-callout-title");
  });

  test("a later hard break stays visible and keeps the quote's text and id", async () => {
    const section = "overview";
    const oldText = "\n[!NOTE]\nline one\nline two\n";
    const [block] = await renderMarkdown("> [!NOTE]\n> line one  \n> line two", section);
    expect(block?.html).toContain('class="emend-callout emend-callout-note"');
    expect(block?.html).toContain("line one<br>\nline two");
    expect(block?.html).not.toContain("emend-callout-marker-break");
    expect(block?.text).toBe(oldText);
    expect(block?.id).toBe(`${section}-${await blockHash(normalizeText(oldText))}`);
  });

  test("only the hard break ending the marker line gets the generated break class", async () => {
    const [block] = await renderMarkdown("> [!NOTE]\\\n> Body", "overview");
    expect(block?.html).toContain(
      '<span class="emend-callout-marker">[!NOTE]</span><br class="emend-callout-marker-break">\nBody',
    );
    expect(block?.text).toBe("\n[!NOTE]\nBody\n");
  });

  test("preserves whitespace and a hard break after the marker", async () => {
    const [block] = await renderMarkdown("<blockquote><p>[!note] \t<br>Body</p></blockquote>", "overview");
    expect(block?.html).toBe(
      '<blockquote class="emend-callout emend-callout-note">' +
        '<p><span class="emend-callout-marker">[!note]</span> \t' +
        '<br class="emend-callout-marker-break">Body</p></blockquote>',
    );
  });

  test("a marker-only paragraph keeps its author classes, whitespace and breaks", async () => {
    const [block] = await renderMarkdown(
      '<blockquote><p class="marker">[!NOTE] \t<br class="break">\n</p><p>Body</p></blockquote>',
      "overview",
    );
    expect(block?.html).toBe(
      '<blockquote class="emend-callout emend-callout-note">' +
        '<p class="user-content-marker emend-callout-marker-line">' +
        '<span class="emend-callout-marker">[!NOTE]</span> \t' +
        '<br class="user-content-break emend-callout-marker-break">\n</p><p>Body</p></blockquote>',
    );
  });

  test.each([
    "> [!NOTE]\n> **Body**",
    "> [!NOTE]\n>\n> - Body",
    "<blockquote><p>[!NOTE]\n<img alt=Body></p></blockquote>",
  ])("accepts elements as content after the marker line: %s", async (markdown) => {
    const [block] = await renderMarkdown(markdown, "overview");
    expect(block?.kind).toBe("quote");
    expect(block?.html).toContain('class="emend-callout emend-callout-note"');
    expect(block?.html).toContain("Body");
  });

  test.each([
    '<img src=x onerror="alert(1)">',
    "<script>alert(1)</script>",
    "[link](javascript:alert(1))",
    "<svg><script>alert(1)</script></svg>",
  ])("sanitizes hostile content inside a callout: %s", async (payload) => {
    const markdown = `> [!WARNING]\n> Body\n>\n> ${payload}`;
    const blocks = await renderMarkdown(markdown, "overview");
    const doc = await renderDoc(markdown, "guide.md");
    for (const html of [blocks[0]?.html, doc[0]?.html, await renderCommentHtml(markdown)]) {
      expect(html).toContain('class="emend-callout emend-callout-warning"');
      expect(html).not.toMatch(/<script|onerror|javascript:|<svg/i);
      expect(html).not.toMatch(/\shref=/);
      if (payload.startsWith("[link]")) expect(html).toContain("<a>link</a>");
    }
  });

  test("author classes cannot forge a callout or its marker", async () => {
    const [block] = await renderMarkdown(
      '<blockquote class="emend-callout"><p><span class="emend-callout-marker">[!NOTE]</span> Fake</p></blockquote>',
      "overview",
    );
    expect(block?.html).toBe(
      '<blockquote class="user-content-emend-callout">' +
        '<p><span class="user-content-emend-callout-marker">[!NOTE]</span> Fake</p></blockquote>',
    );
  });

  test("author marker classes stay namespaced inside a real callout", async () => {
    const markdown = [
      "> [!NOTE]",
      '> Body <span class="emend-callout-marker">forged</span>',
      ">",
      '> <p class="emend-callout-marker-line">forged line</p>',
      ">",
      '> <br class="emend-callout-marker-break">',
    ].join("\n");
    const blocks = await renderMarkdown(markdown, "overview");
    expect(blocks).toHaveLength(1);
    const html = blocks[0]?.html ?? "";
    expect(html).toContain('class="emend-callout emend-callout-note"');
    expect(html).toContain('<span class="user-content-emend-callout-marker">forged</span>');
    expect(html).toContain('<p class="user-content-emend-callout-marker-line">forged line</p>');
    expect(html).toContain('<br class="user-content-emend-callout-marker-break">');
    const markers: HtmlElement[] = [];
    visitElements(fromHtml(html, { fragment: true }), (element) => {
      if (Array.isArray(element.properties.className) && element.properties.className.includes("emend-callout-marker"))
        markers.push(element);
    });
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ tagName: "span", children: [{ type: "text", value: "[!NOTE]" }] });
    expect(html).not.toContain('class="emend-callout-marker-line"');
    expect(html).not.toContain('class="emend-callout-marker-break"');
  });

  test("keeps namespaced author classes before generated callout classes", async () => {
    const [block] = await renderMarkdown('<blockquote class="note"><p>[!NOTE]\nBody</p></blockquote>', "overview");
    expect(block?.html).toContain('class="user-content-note emend-callout emend-callout-note"');
  });

  test("comments keep the marker and its line break", async () => {
    const html = await renderCommentHtml("> [!NOTE]\n> Body");
    expect(html).toContain('class="emend-callout emend-callout-note"');
    expect(html).toContain(
      '<span class="emend-callout-marker">[!NOTE]</span><br class="emend-callout-marker-break">\nBody</p>',
    );
    expect(html).not.toContain("emend-callout-title");
  });

  test("a quote with a Mermaid diagram stays plain across every text piece", async () => {
    const click = '  click A "javascript:alert(1)"';
    const blocks = await renderDoc(
      `> [!NOTE]\n> intro\n>\n> \`\`\`mermaid\n> flowchart LR\n>   A --> B\n> ${click}\n> \`\`\`\n>\n> outro`,
      "guide.md",
    );
    expect(blocks.map((block) => block.kind)).toEqual(["quote", "diagram", "quote"]);
    for (const block of blocks) expect(block.html).not.toMatch(/emend-callout|<script|javascript:/i);
    expect(blocks[1]?.source).toContain(click);
    expect(blocks[1]?.html).toBe("");
    expect(blocks[0]?.html).toContain("<p>[!NOTE]\nintro</p>");
    expect(blocks[0]?.text).toContain("[!NOTE]");
    expect(blocks[2]?.text).toContain("outro");
  });

  test("glossary definitions stay sanitized list items without callout markup", async () => {
    const rendered = await renderWriteup(
      {
        overview: "",
        tldr: "",
        decisions: "",
        topics: {},
        glossary: [
          { term: "Note", definition: '> [!NOTE] <img src=x onerror="alert(1)"> <script>alert(1)</script> body' },
          {
            term: "Warning",
            definition: '\n> [!WARNING]\n> <img src=x onerror="alert(1)"> <script>alert(1)</script> body',
          },
        ],
      },
      [],
    );
    const blocks = rendered.sections.find((section) => section.key === "glossary")?.blocks ?? [];
    expect(blocks.map((block) => block.kind)).toEqual(["item", "item"]);
    for (const block of blocks) expect(block.html).not.toMatch(/emend-callout|onerror|<script/i);
    expect(blocks[0]?.text).toContain("[!NOTE]");
    expect(blocks[1]?.text).toContain("[!WARNING]");
  });

  test("an ordinary Markdown doc keeps its headings, list, code and plain quote", async () => {
    const blocks = await renderDoc(
      "# Guide\n\n## Details\n\n- Item\n\n```text\nExample\n```\n\n> A plain quote.",
      "guide.md",
    );
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "heading", "item", "code", "quote"]);
    expect(blocks.map((block) => block.html).join("")).not.toContain("emend-callout");
    expect(blocks.at(-1)?.html).toBe("<blockquote>\n<p>A plain quote.</p>\n</blockquote>");
  });
});

test("a quote split by a chart stays plain on both sides", async () => {
  const source = '{"type":"sparkline","series":[{"name":"Daily","values":[1,2]}]}';
  const blocks = await renderDoc(`> [!NOTE]\n> First\n>\n> \`\`\`chart\n> ${source}\n> \`\`\`\n>\n> Last`, "guide.md");
  expect(blocks.map(({ kind }) => kind)).toEqual(["quote", "chart", "quote"]);
  expect(blocks[1]).toMatchObject({ source, html: "" });
  expect(blocks.map(({ html }) => html).join("")).not.toContain("emend-callout");
});
