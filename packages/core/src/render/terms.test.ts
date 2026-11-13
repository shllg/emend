import { LIMITS, normalizeGlossaryForm, WriteupInput } from "@emend/contract";
import { expect, test } from "vitest";
import { renderCommentHtml, renderDoc, renderMarkdownWithBudget, renderMetadataBlocks } from "./markdown.ts";
import { TERM_MATCH_WORK_BUDGET, termMatcher } from "./terms.ts";
import { renderWriteup } from "./writeup.ts";

async function html(
  source: string,
  entries: { term: string; aliases?: string[] }[],
  matcher = termMatcher(entries),
  section = "overview",
) {
  const blocks = await renderMarkdownWithBudget(
    source,
    section,
    { highlightedBytes: 0 },
    "https://github.com/example/project",
    new Map([["shot.png", "a".repeat(64)]]),
    undefined,
    "",
    undefined,
    undefined,
    matcher,
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

test.each([
  ["**budget**ing budget", "budget", `<p><strong>budget</strong>ing ${mark("budget")}</p>`],
  ["re*try* retry", "retry", `<p>re<em>try</em> ${mark("retry")}</p>`],
  ["re*try* try", "try", `<p>re<em>try</em> ${mark("try")}</p>`],
  ["**re**try try", "try", `<p><strong>re</strong>try ${mark("try")}</p>`],
  ["**API**s API", "API", `<p><strong>API</strong>s ${mark("API")}</p>`],
])("rejects word fragments across inline formatting: %s", async (source, term, expected) => {
  expect(await html(source, [{ term }])).toBe(expected);
});

test.each([
  ["**budget** is set", `<p><strong>${mark("budget")}</strong> is set</p>`],
  ["the *budget*.", `<p>the <em>${mark("budget")}</em>.</p>`],
])("accepts whole words inside inline formatting: %s", async (source, expected) => {
  expect(await html(source, [{ term: "budget" }])).toBe(expected);
});

test.each([
  ["`x`budget budget", `<p><code>x</code>budget ${mark("budget")}</p>`],
  ["`.`budget", `<p><code>.</code>${mark("budget")}</p>`],
  ["budget`x` budget", `<p>budget<code>x</code> ${mark("budget")}</p>`],
  ["budget`.`", `<p>${mark("budget")}<code>.</code></p>`],
])("counts inline code as a word-boundary neighbour: %s", async (source, expected) => {
  expect(await html(source, [{ term: "budget" }])).toBe(expected);
});

test.each(["[x](https://example.com)budget budget", "budget[x](https://example.com) budget"])(
  "counts skipped links as word-boundary neighbours: %s",
  async (source) => {
    const rendered = await html(source, [{ term: "budget" }]);
    expect(rendered).toContain(` ${mark("budget")}</p>`);
    expect(rendered.match(/data-emend-term=/g)).toHaveLength(1);
  },
);

test.each(["x\n\nbudget", "budget\n\nx", "- x\n- budget", "- budget\n- x"])(
  "ends inline runs at block boundaries: %s",
  async (source) => {
    expect(await html(source, [{ term: "budget" }])).toContain(mark("budget"));
  },
);

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

test("matcher weight uses the contract's normalized terms and aliases", () => {
  const term = "  Cafe\u0301   budget ";
  const forms = [term, "\u0344"];
  const matcher = termMatcher([{ term, aliases: forms.slice(1) }]);
  expect(matcher.weight).toBe(forms.reduce((weight, form) => weight + normalizeGlossaryForm(form).length, 0));
  expect(matcher.pattern.exec(normalizeGlossaryForm(term))?.[0]).toBe("Café budget");
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

test.each(["", "Cafe\u0301 "])("protects joined emoji independently of unrelated normalization: %j", async (prefix) => {
  expect(await html(`${prefix}👩‍👧 then 👧.`, [{ term: "👧" }])).toBe(`<p>${prefix}👩‍👧 then ${mark("👧")}.</p>`);
});

test.each(["\u200d", "\u200c"])("rejects a term followed by a grapheme joiner: %j", async (joiner) => {
  for (const prefix of ["", "Cafe\u0301 "]) {
    expect(await html(`${prefix}budget${joiner} then budget.`, [{ term: "budget" }])).toBe(
      `<p>${prefix}budget${joiner} then ${mark("budget")}.</p>`,
    );
  }
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

test("a shared work budget stops at the first oversized node and preserves later sections byte for byte", async () => {
  const entries = [{ term: "budget" }, { term: "a" }];
  const matcher = termMatcher(entries, 70);
  const source = "Budget\n\nCafe\u0301 a\n\na";
  const rendered = await html(source, entries, matcher);
  expect(rendered).toBe(`<p>${mark("Budget")}</p><p>Cafe\u0301 a</p><p>a</p>`);
  expect(rendered.replace(mark("Budget"), "Budget")).toBe(await html(source, []));
  expect(await html("a", entries, matcher, "tldr")).toBe(await html("a", []));
  expect(await html("Budget a", entries, matcher, "decisions")).toBe(await html("Budget a", []));
});

test("acronym fallback spends the shared work budget on repeated wrong-case hits", async () => {
  const entries = [{ term: "budget" }, { term: "PR" }];
  const source = "budget\n\npr pr PR";
  // Scans cost (6 + 1 + 8) * 8 units; only one fallback fits in the remaining 8.
  const matcher = termMatcher(entries, 128);
  const rendered = await html(source, entries, matcher);
  expect(rendered).toBe(`<p>${mark("budget")}</p><p>pr pr PR</p>`);
  expect(rendered.replace(mark("budget"), "budget")).toBe(await html(source, []));
  expect(await html("PR", entries, matcher, "tldr")).toBe("<p>PR</p>");
  expect(await html(source, entries, termMatcher(entries, 144))).toBe(
    `<p>${mark("budget")}</p><p>pr pr ${mark("PR", 1)}</p>`,
  );
});

test("a typical twelve-term glossary fits the maximum writeup budget and marks its last section", async () => {
  const glossary = [
    "budget",
    "retry",
    "queue",
    "cache",
    "worker",
    "lease",
    "route",
    "token",
    "scope",
    "batch",
    "entry",
    "limit",
  ].map((term) => ({ term, definition: "A synthetic definition." }));
  // The default scan budget covers a glossary of weight up to about 190 at the writeup byte limit.
  expect(termMatcher(glossary).weight * LIMITS.writeupBytes).toBeLessThanOrEqual(TERM_MATCH_WORK_BUDGET);
  const prose = "This section explains the proposed change. ".repeat(40);
  const rendered = await renderWriteup(
    WriteupInput.parse({
      overview: prose,
      tldr: prose,
      decisions: "",
      topics: { final: { why: "budget" } },
      glossary,
    }),
    [{ slug: "final", title: "Final", importance: 10, summary: "Last section." }],
  );
  expect(rendered.sections.at(-1)?.key).toBe("t-final-why");
  expect(rendered.sections.at(-1)?.blocks[0]?.html).toBe(`<p>${mark("budget")}</p>`);
});
