import { expect, test } from "vitest";
import { htmlHeadings } from "./doc-headings.ts";
import { inferDocTitle } from "./doc-title.ts";
import { HTML_NESTING_LIMIT } from "./place/html.ts";

test.each([
  { name: "title-html-comments", kind: "html", source: "<!--".repeat(2 * 1024 * 1024), title: undefined },
  {
    name: "title-html-textarea",
    kind: "html",
    source: `<textarea>${"<title>fake</title>".repeat(100000)}</textarea>`,
    title: undefined,
  },
  { name: "title-markdown-whitespace", kind: "markdown", source: `#${"\t".repeat(1024 * 1024)}x`, title: "x" },
  { name: "title-markdown-hashes", kind: "markdown", source: `# Title ${"#".repeat(1024 * 1024)}`, title: "Title" },
] as const)("$name", async ({ name, kind, source, title }) => {
  const bytes = new TextEncoder().encode(source);
  const start = performance.now();
  const result = await inferDocTitle(kind, bytes);
  const ms = performance.now() - start;
  expect(result).toBe(title);
  process.stdout.write(`${JSON.stringify({ bench: name, ms, inputBytes: bytes.byteLength })}\n`);
});

test("headings-empty-subtree", () => {
  const depth = Math.floor((HTML_NESTING_LIMIT - 4) / 2);
  const source = `${"<h2><span>".repeat(depth)}${"<b></b>".repeat(500000)}${"</span></h2>".repeat(depth)}`;
  const start = performance.now();
  const headings = htmlHeadings(source);
  const ms = performance.now() - start;
  expect(headings).toEqual(Array.from({ length: depth }, () => ({ level: 2, text: "" })));
  process.stdout.write(
    `${JSON.stringify({ bench: "headings-empty-subtree", ms, inputChars: source.length, headings: headings.length })}\n`,
  );
});
