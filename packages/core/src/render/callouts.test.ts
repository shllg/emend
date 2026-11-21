import { describe, expect, test } from "vitest";
import { renderCommentHtml, renderDoc, renderMarkdown } from "./markdown.ts";

describe("GitHub alert callouts", () => {
  test("a note stays one quote block with its title and body in the block text", async () => {
    const blocks = await renderMarkdown("> [!NOTE]\n> Body text", "overview");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("quote");
    expect(blocks[0]?.html).toContain('class="emend-callout emend-callout-note"');
    expect(blocks[0]?.html).toContain('<p class="emend-callout-title">Note</p>');
    expect(blocks[0]?.html).toContain("<p>Body text</p>");
    expect(blocks[0]?.html).not.toContain("[!NOTE]");
    expect(blocks[0]?.text).toContain("Note");
    expect(blocks[0]?.text).toContain("Body text");
  });

  test.each([
    ["WARNING", "warning", "Warning"],
    ["warning", "warning", "Warning"],
    ["TIP", "tip", "Tip"],
    ["IMPORTANT", "important", "Important"],
    ["CAUTION", "caution", "Caution"],
  ])("%s has its own class and label", async (marker, type, label) => {
    const [block] = await renderMarkdown(`> [!${marker}]\n> Body`, "overview");
    expect(block?.html).toContain(`class="emend-callout emend-callout-${type}"`);
    expect(block?.html).toContain(`<p class="emend-callout-title">${label}</p>`);
    expect(block?.html).not.toContain(`[!${marker}]`);
  });

  test("a marker in its own paragraph leaves no empty paragraph or doubled separator", async () => {
    const [block] = await renderMarkdown("> [!NOTE]\n>\n> Body", "overview");
    expect(block?.html).toBe(
      '<blockquote class="emend-callout emend-callout-note"><p class="emend-callout-title">Note</p>\n<p>Body</p>\n</blockquote>',
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

  test.each([
    "> [!NOTE] \t\n> Body",
    "> [!NOTE]  \n> Body",
    "> [!NOTE]\\\n> Body",
    "<blockquote><p>[!NOTE] \t<br>Body</p></blockquote>",
  ])("accepts whitespace or a hard break after the marker: %s", async (markdown) => {
    const [block] = await renderMarkdown(markdown, "overview");
    expect(block?.html).toContain('class="emend-callout emend-callout-note"');
    expect(block?.text).toContain("Body");
    expect(block?.html).not.toMatch(/\[!NOTE\]|<br/);
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

  test("author classes cannot forge a callout or its title", async () => {
    const [block] = await renderMarkdown(
      '<blockquote class="emend-callout"><p class="emend-callout-title">Fake</p></blockquote>',
      "overview",
    );
    expect(block?.html).toBe(
      '<blockquote class="user-content-emend-callout"><p class="user-content-emend-callout-title">Fake</p></blockquote>',
    );
  });

  test("keeps namespaced author classes before generated callout classes", async () => {
    const [block] = await renderMarkdown('<blockquote class="note"><p>[!NOTE]\nBody</p></blockquote>', "overview");
    expect(block?.html).toContain('class="user-content-note emend-callout emend-callout-note"');
  });

  test("comments consume the marker's line break", async () => {
    const html = await renderCommentHtml("> [!NOTE]\n> Body");
    expect(html).toContain('class="emend-callout emend-callout-note"');
    expect(html).toContain('<p class="emend-callout-title">Note</p>');
    expect(html).toContain("Body</p>");
    expect(html).not.toMatch(/<br|\[!NOTE\]/);
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
