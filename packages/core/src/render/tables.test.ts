import type { Processor } from "unified";
import { beforeEach, expect, test, vi } from "vitest";
import { renderMarkdown } from "./markdown.ts";

const { convert } = vi.hoisted(() => ({ convert: vi.fn() }));
vi.mock("remark-rehype", async (original) => {
  const module = await original<typeof import("remark-rehype")>();
  return {
    ...module,
    default: function (this: Processor, ...args: Parameters<typeof module.default>) {
      const transform = module.default.apply(this, args);
      return (tree: Parameters<typeof transform>[0], file: Parameters<typeof transform>[1]) => {
        convert(tree, file);
        return transform(tree, file);
      };
    },
  };
});
beforeEach(() => convert.mockClear());

test("a narrow source with an enormous rectangular table stays a bounded code block", async () => {
  await renderMarkdown("warmup", "overview");
  convert.mockClear();
  const source = `${"|x".repeat(1000)}|\n${"|-".repeat(1000)}|\n${"x\n".repeat(30000)}`;
  const blocks = await renderMarkdown(source, "overview");
  expect(convert).toHaveBeenCalledOnce();
  // The converter receives one code leaf, so it cannot expand 30 million table cells.
  expect(convert.mock.calls[0]?.[0]).toMatchObject({
    type: "root",
    children: [{ type: "code", value: source.trimEnd() }],
  });
  const output = JSON.stringify(blocks);
  expect(output).not.toContain("<table");
  expect(output).toContain("<pre");
  expect(output.length).toBeLessThan(source.length * 6);
});

test("ordinary tables keep their semantics and oversized source stays escaped", async () => {
  const small = await renderMarkdown("| a | b |\n| - | - |\n| x | y |", "overview");
  expect(JSON.stringify(small)).toContain("<table>");
  const source = `${"|<script>evil()</script>".repeat(1000)}|\n${"|-".repeat(1000)}|\n${"x\n".repeat(101)}`;
  const blocks = await renderMarkdown(source, "overview");
  const html = blocks.map((block) => block.html).join("");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&#x3C;script>");
});
