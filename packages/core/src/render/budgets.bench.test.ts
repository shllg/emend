import { expect, test } from "vitest";
import { renderCommentHtml, renderMarkdown } from "./markdown.ts";

test("rectangular-table", async () => {
  await renderMarkdown("warmup", "overview");
  const source = `${"|x".repeat(1000)}|\n${"|-".repeat(1000)}|\n${"x\n".repeat(30000)}`;
  const start = performance.now();
  const blocks = await renderMarkdown(source, "overview");
  const ms = performance.now() - start;
  expect(JSON.stringify(blocks)).not.toContain("<table");
  process.stdout.write(
    `${JSON.stringify({ bench: "rectangular-table", ms, inputChars: source.length, blocks: blocks.length })}\n`,
  );
});

test("highlight-long-line", async () => {
  const source = `\`\`\`ts\n${"a".repeat(20000)}\n\`\`\``;
  const start = performance.now();
  const blocks = await renderMarkdown(source, "overview");
  const ms = performance.now() - start;
  expect(blocks[0]?.html).not.toContain("shiki");
  process.stdout.write(
    `${JSON.stringify({ bench: "highlight-long-line", ms, inputChars: source.length, blocks: blocks.length })}\n`,
  );
});

test.each([
  { name: "comment-wide-url", source: `[a]: https://x.test/${"€".repeat(10_000)}\n\n${"[a] ".repeat(2500)}` },
  { name: "comment-image-url", source: `[a]: https://x.test/${"p".repeat(10_000)}\n\n${"![A] ".repeat(4)}` },
  { name: "comment-wide-title", source: `[a]: http://x "${"t".repeat(20_000)}"\n\n${"[a] ".repeat(2500)}` },
  {
    name: "comment-hidden-definition",
    source: `[a]: https://x.test/${"€".repeat(9990)}\n\n${"[a] ".repeat(2495)}\n\n[a]: <>`,
  },
])("$name", async ({ name, source }) => {
  const start = performance.now();
  const error = await renderCommentHtml(source).then(
    () => null,
    (error: unknown) => error,
  );
  const ms = performance.now() - start;
  expect(String(error)).toContain("too much URL text");
  process.stdout.write(`${JSON.stringify({ bench: name, ms, inputChars: source.length })}\n`);
});
