import { expect, test } from "vitest";
import { renderCommentHtml, renderDoc, renderMarkdownWithBudget, renderMetadataBlocks } from "./markdown.ts";
import { termMatcher } from "./terms.ts";

async function html(source: string, entries: { term: string; aliases?: string[] }[]) {
  const blocks = await renderMarkdownWithBudget(
    source,
    "overview",
    { highlightedBytes: 0 },
    "https://github.com/example/project",
    new Map([["shot.png", "a".repeat(64)]]),
    undefined,
    "",
    undefined,
    undefined,
    termMatcher(entries),
  );
  return blocks.map((block) => block.html).join("");
}
const mark = (text: string, index = 0) => `<span class="emend-term" data-emend-term="${index}">${text}</span>`;

test.each([
  ["budgeting _budget budget2 ébudget budgeté budget\u0301 BUDGET budget", "BUDGET"],
  ["budgets budget", "budgets"],
  ["budgetes budget", "budgetes"],
])("marks whole words and simple plurals once: %s", async (source, match) => {
  const rendered = await html(source, [{ term: "budget" }]);
  expect(rendered).toContain(mark(match));
  expect(rendered.match(/data-emend-term=/g)).toHaveLength(1);
});

test("matches aliases, normalized forms, whitespace runs and literal regex syntax", async () => {
  expect(await html("Allowance budget", [{ term: "budget", aliases: ["allowance"] }])).toContain(mark("Allowance"));
  expect(await html("Café\n  budget", [{ term: "  Cafe\u0301   budget " }])).toContain(mark("Café\nbudget"));
  expect(await html("aXbc a.b(c)", [{ term: "a.b(c)" }])).toContain(mark("a.b(c)"));
  expect(await html("cost-benefit", [{ term: "cost-benefit" }])).toContain(mark("cost-benefit"));
});

test("acronyms require exact case and allow simple plurals", async () => {
  expect(await html("pr Pr PRs PR", [{ term: "PR" }])).toContain(mark("PRs"));
  expect(await html("mcp Mcp MCPes MCP", [{ term: "MCP" }])).toContain(mark("MCPes"));
  expect(await html("pr budget PR", [{ term: "PR BUDGET" }, { term: "pr" }])).toContain(mark("pr", 1));
});

test.each([
  ["Café", "Cafe\u0301"],
  ["Cafe\u0301", "Café"],
  ["Cafe\u0301", "Cafe\u0301"],
  ["Cafe\u0301 résumé", "Café re\u0301sume\u0301"],
  ["Café re\u0301sume\u0301", "Cafe\u0301 résumé"],
])("matches term %s against prose %s without changing the prose characters", async (term, prose) => {
  const rendered = await html(`Before ${prose} after.`, [{ term }]);
  expect(rendered).toBe(`<p>Before ${mark(prose)} after.</p>`);
});

test("normalization keeps one regex alternative per term or alias", () => {
  const matcher = termMatcher([{ term: "Café résumé", aliases: ["Resume\u0301"] }, { term: "Budget" }]);
  expect(matcher.forms).toHaveLength(3);
  expect(matcher.pattern.exec("Café résumé")).toHaveLength(4);
});

test("normalized offsets preserve text before, between and after multiple marks", async () => {
  const prose = "Préface\u0301: Cafe\u0301 and re\u0301sume\u0301. Après.";
  expect(await html(prose, [{ term: "Café" }, { term: "résumé" }])).toBe(
    `<p>Préface\u0301: ${mark("Cafe\u0301")} and ${mark("re\u0301sume\u0301", 1)}. Après.</p>`,
  );
});

test("rejects matches inside a normalized grapheme and resumes at the next code point", async () => {
  const prose = "Cafe\u0301 👩‍👧 then 👧.";
  expect(await html(prose, [{ term: "👩" }, { term: "👧" }])).toBe(`<p>Cafe\u0301 👩‍👧 then ${mark("👧", 1)}.</p>`);
});

test("acronym fallback resumes after the shorter match instead of the rejected longer form", async () => {
  const entries = ["PR BUDGET", "pr", "budget"].map((term) => ({ term }));
  expect(await html("pr budget PR BUDGET", entries)).toBe(
    `<p>${mark("pr", 1)} ${mark("budget", 2)} ${mark("PR BUDGET")}</p>`,
  );
});

test("a rejected acronym still lets a later word inside its span match", async () => {
  const entries = ["PR BUDGET", "budget"].map((term) => ({ term }));
  expect(await html("pr budget", entries)).toBe(`<p>pr ${mark("budget", 1)}</p>`);
});

test("the longest form wins and matches never cross text nodes", async () => {
  const rendered = await html("retry budget budget retry budget", [{ term: "budget" }, { term: "retry budget" }]);
  expect(rendered).toContain(`${mark("retry budget", 1)} ${mark("budget")} retry budget`);
  expect(await html("retry **budget**", [{ term: "retry budget" }])).not.toContain("emend-term");
});

test("skips headings, code, links, generated issue links, media and diagrams", async () => {
  const rendered = await html(
    [
      "# Budget",
      "`Budget`",
      "```text\nBudget\n```",
      "<kbd>Budget</kbd> <samp>Budget</samp>",
      "[Budget](https://example.com)",
      "#123",
      "![Budget](shot.png)",
      "```mermaid\ngraph TD; Budget-->B\n```",
      "Budget 123",
    ].join("\n\n"),
    [{ term: "Budget" }, { term: "123" }],
  );
  expect(rendered).toContain(`${mark("Budget")} ${mark("123", 1)}`);
  expect(rendered.match(/data-emend-term=/g)).toHaveLength(2);
  expect(rendered).toContain('class="emend-media-caption">Budget');
});

test("docs, comments and metadata never gain marks", async () => {
  expect(JSON.stringify(await renderDoc("Budget", "guide.md"))).not.toContain("emend-term");
  expect(await renderCommentHtml("Budget")).not.toContain("emend-term");
  expect(JSON.stringify(await renderMetadataBlocks("Budget"))).not.toContain("emend-term");
});
