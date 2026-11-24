import { BlockId } from "@recense/contract";
import { describe, expect, test } from "vitest";
import { blockText } from "./blocks.ts";
import { changedBlockIds } from "./changed.ts";
import { blockHash } from "./hash.ts";
import { renderDoc, renderMarkdown } from "./markdown.ts";
import { normalizeText } from "./normalize.ts";

test("normalizes NFC, Unicode whitespace and trimming", () => {
  expect(normalizeText(" \tCafe\u0301\n\u00a0 on  shelves\r\n")).toBe("Café on shelves");
  expect(normalizeText("\n\t")).toBe("");
});

test("Unicode White_Space characters produce identical block ids", async () => {
  const blocks = await Promise.all(["A\u0085B", "A\u2028B", "A B"].map((text) => renderMarkdown(text, "overview")));
  expect(new Set(blocks.map((rendered) => rendered[0]?.id)).size).toBe(1);
  expect(normalizeText("\u0085A\u0085")).toBe("A");
});

test("hashes the supplied UTF-8 text with SHA-256, without normalizing paths", async () => {
  expect(await blockHash("abc")).toBe("ba7816bf");
  expect(await blockHash("")).toBe("e3b0c442");
  expect(await blockHash(" a ")).not.toBe(await blockHash("a"));
});

test("blockText returns textContent, not rendered whitespace or HTML", () => {
  expect(blockText("<p>A &amp; <em>B</em></p><p>C<br>D</p><!-- hidden -->")).toBe("A & BCD");
  expect(blockText("<pre><code>&lt;img onerror=x&gt;\n  x</code></pre>")).toBe("<img onerror=x>\n  x");
});

describe("content-based block ids", () => {
  test("suffixes identical normalized text within a section, across kinds", async () => {
    const blocks = await renderMarkdown("Same\n\nSame\n\n# Same", "overview");
    const base = `overview-${await blockHash("Same")}`;
    expect(blocks.map((block) => block.id)).toEqual([base, `${base}-2`, `${base}-3`]);
    for (const block of blocks) expect(BlockId.safeParse(block.id).success).toBe(true);
    expect((await renderMarkdown("Same", "overview"))[0]?.id).toBe(base);
  });

  test("inserting, changing, and reformatting paragraphs affects only their own ids", async () => {
    const before = await renderMarkdown("First paragraph.\n\nSecond paragraph.", "overview");
    const inserted = await renderMarkdown("New paragraph.\n\nFirst paragraph.\n\nSecond paragraph.", "overview");
    expect(inserted.slice(1).map((block) => block.id)).toEqual(before.map((block) => block.id));
    const changed = await renderMarkdown("First paragraph.\n\nChanged paragraph.", "overview");
    expect(changed[0]?.id).toBe(before[0]?.id);
    expect(changed[1]?.id).not.toBe(before[1]?.id);
    const whitespace = await renderMarkdown("First   paragraph.\n\nSecond\nparagraph.", "overview");
    expect(whitespace.map((block) => block.id)).toEqual(before.map((block) => block.id));
    expect((await renderMarkdown("Cafe\u0301", "tldr"))[0]?.id).toBe((await renderMarkdown("Café", "tldr"))[0]?.id);
  });

  test("validates section keys against the contract", async () => {
    await expect(renderMarkdown("Hello", "app-root")).rejects.toThrow();
    await expect(renderMarkdown("", "app-root")).rejects.toThrow();
  });

  test("documents use the hash of the exact path as their section", async () => {
    const blocks = await renderDoc("A guide.", "docs/guide.md");
    expect(blocks[0]?.section).toBe(`doc-${await blockHash("docs/guide.md")}`);
    expect(BlockId.safeParse(blocks[0]?.id).success).toBe(true);
    expect((await renderDoc("A guide.", "docs/other.md"))[0]?.id).not.toBe(blocks[0]?.id);
  });
});

test("changedBlockIds returns new ids in next order, including duplicate occurrences", async () => {
  const prev = await renderMarkdown("One\n\nTwo", "overview");
  const next = await renderMarkdown("New\n\nTwo\n\nOne\n\nOne", "overview");
  expect(changedBlockIds(null, prev)).toEqual(prev.map((block) => block.id));
  expect(changedBlockIds(prev, prev)).toEqual([]);
  expect(changedBlockIds(prev, next)).toEqual([next[0]?.id, next[3]?.id]);
  expect(changedBlockIds(prev, [])).toEqual([]);
});
