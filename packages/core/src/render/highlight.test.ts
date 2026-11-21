import { afterEach, expect, test, vi } from "vitest";
import * as core from "../index.ts";
import { highlightLanguage, spendHighlightBudget } from "./highlight.ts";
import { sharedHighlighter } from "./highlighter.ts";
import { renderMarkdown } from "./markdown.ts";
import { renderWriteup } from "./writeup.ts";

const fence = (code: string, language = "ts") => `\`\`\`${language}\n${code}\n\`\`\``;
// 256 short comment lines, exactly 16 KiB including the final newline added by remark.
const budgetFence = (letter: string) => fence(`// ${letter.repeat(60)}\n`.repeat(256).slice(0, -1));
afterEach(() => vi.restoreAllMocks());

test("exports the exact highlighting limits", () => {
  expect(core).toMatchObject({
    HIGHLIGHT_LINE_CHARS: 400,
    HIGHLIGHT_FENCE_BYTES: 16384,
    HIGHLIGHT_RENDER_BYTES: 65536,
  });
});

test("language selection uses the first language class and accepts special languages", () => {
  const loaded = new Set(["ts"]);
  expect(highlightLanguage([null, 1, "note", "language-ts"], loaded)).toBe("ts");
  expect(highlightLanguage(["language-unknown", "language-ts"], loaded)).toBeUndefined();
  expect(highlightLanguage(["language-text"], loaded)).toBe("text");
  expect(highlightLanguage(["language-mermaid"], loaded)).toBeUndefined();
});

test("highlight budgets accept exact limits and spend nothing on rejected blocks", () => {
  const budget = { highlightedBytes: 0 };
  expect(spendHighlightBudget(budget, core.HIGHLIGHT_FENCE_BYTES + 1)).toBe(false);
  expect(budget.highlightedBytes).toBe(0);
  expect(spendHighlightBudget(budget, core.HIGHLIGHT_FENCE_BYTES)).toBe(true);
  expect(budget.highlightedBytes).toBe(core.HIGHLIGHT_FENCE_BYTES);
  budget.highlightedBytes = core.HIGHLIGHT_RENDER_BYTES - 1;
  expect(spendHighlightBudget(budget, 2)).toBe(false);
  expect(budget.highlightedBytes).toBe(core.HIGHLIGHT_RENDER_BYTES - 1);
  expect(spendHighlightBudget(budget, 1)).toBe(true);
  expect(budget.highlightedBytes).toBe(core.HIGHLIGHT_RENDER_BYTES);
  expect(spendHighlightBudget(budget, 0)).toBe(false);
  expect(spendHighlightBudget(budget, 1)).toBe(false);
  expect(budget.highlightedBytes).toBe(core.HIGHLIGHT_RENDER_BYTES);
});

test("a 20000-character single-line TypeScript fence renders", async () => {
  const highlighter = await sharedHighlighter();
  const highlight = vi.spyOn(highlighter, "codeToHast");
  const [block] = await renderMarkdown(fence("a".repeat(20000)), "overview");
  expect(highlight).not.toHaveBeenCalled();
  expect(block?.text).toBe(`${"a".repeat(20000)}\n`);
  expect(block?.html).not.toContain("shiki");
  // Prove the spy observes the renderer's highlighter on an admitted fence.
  await renderMarkdown(fence("const small = 1;"), "overview");
  expect(highlight).toHaveBeenCalledOnce();
  for (const [input] of highlight.mock.calls) {
    expect(new TextEncoder().encode(input).byteLength).toBeLessThanOrEqual(core.HIGHLIGHT_FENCE_BYTES);
  }
});

test("fences above 16 KiB stay plain, including multibyte UTF-8 text", async () => {
  for (const code of ["// note\n".repeat(2176).slice(0, -1), "// éééééé\n".repeat(1200)]) {
    const [block] = await renderMarkdown(fence(code), "overview");
    expect(/shiki|<span/.test(block?.html ?? "")).toBe(false);
    expect(block?.text).toBe(`${code}\n`);
  }
});

test("one writeup shares the 64 KiB highlighting budget across its sections", async () => {
  const rendered = await renderWriteup(
    {
      overview: [budgetFence("a"), budgetFence("b"), budgetFence("c")].join("\n\n"),
      tldr: budgetFence("d"),
      decisions: fence("const decision = 1;"),
      topics: {},
    },
    [],
  );
  const blocks = rendered.sections.flatMap((section) => section.blocks);
  expect(blocks).toHaveLength(5);
  expect(blocks.slice(0, 4).every((block) => block.html.includes("shiki"))).toBe(true);
  expect(blocks[4]?.html.includes("shiki")).toBe(false);
});

test("lines longer than 400 characters skip tokenization even inside a small fence", async () => {
  const code = `const title = "${"a".repeat(400)}";`;
  const [block] = await renderMarkdown(fence(code), "overview");
  expect(block?.html).toContain("shiki");
  expect(block?.html).not.toMatch(/<span[^>]*style=/);
  expect(block?.text).toBe(`${code}\n`);
});

test("after 64 KiB of highlighted fences later fences are plain, with unchanged text and ids", async () => {
  const last = fence("const finalValue = 42;");
  const blocks = await renderMarkdown([..."abcd"].map(budgetFence).concat(last).join("\n\n"), "overview");
  expect(blocks).toHaveLength(5);
  for (const block of blocks.slice(0, 4)) expect(block.html).toContain("shiki");
  expect(blocks[4]?.html).not.toMatch(/shiki|<span/);
  const [highlighted] = await renderMarkdown(last, "overview");
  expect(highlighted?.html).toContain("shiki");
  expect(blocks[4]?.id).toBe(highlighted?.id);
  expect(blocks[4]?.text).toBe(highlighted?.text);
});

test("unknown and oversized code do not consume the highlighting budget", async () => {
  const unknown = budgetFence("x").replace("```ts", "```unknown-synthetic");
  const huge = fence("// note\n".repeat(2500));
  const blocks = await renderMarkdown(
    [unknown, unknown, unknown, unknown, huge, fence("let small = 1;")].join("\n\n"),
    "overview",
  );
  expect(blocks.at(-1)?.html).toContain("shiki");
  expect(blocks[4]?.html.includes("shiki")).toBe(false);
});
