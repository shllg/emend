import { BlockId, type ReviewVerdict, type WriteupInput } from "@emend/contract";
import { fromHtml } from "hast-util-from-html";
import { expect, test, vi } from "vitest";
import { blockText, visitElements } from "./blocks.ts";
import { topics, writeup } from "./fixtures/writeup.ts";
import { HIGHLIGHT_RENDER_BYTES } from "./highlight.ts";
import * as markdown from "./markdown.ts";
import { renderWriteup } from "./writeup.ts";

test("renders sections and labels in importance order with stable ties", async () => {
  const rendered = await renderWriteup(writeup, topics);
  expect(rendered.sections.map((section) => section.key)).toEqual([
    "overview",
    "tldr",
    "decisions",
    "glossary",
    "t-search-why",
    "t-search-example",
    "t-search-body",
    "t-sorting-why",
    "t-labels-why",
    "t-labels-body",
  ]);
  expect(rendered.sections.map((section) => section.label)).toEqual([
    "Overview",
    "TL;DR",
    "Decisions and drift",
    "Glossary",
    "Shelf search — Why",
    "Shelf search — Example",
    "Shelf search — Details",
    "Stable sorting — Why",
    "Clear labels — Why",
    "Clear labels — Details",
  ]);
  expect(rendered.sections.map((section) => section.topic)).toEqual([
    null,
    null,
    null,
    null,
    "search",
    "search",
    "search",
    "sorting",
    "labels",
    "labels",
  ]);
  expect(topics.map((topic) => topic.slug)).toEqual(["labels", "search", "sorting"]);
  for (const section of rendered.sections) {
    for (const block of section.blocks) {
      expect(block.section).toBe(section.key);
      expect(BlockId.safeParse(block.id).success).toBe(true);
    }
  }
});

test("blockText equals text for HTML blocks, explicitly skipping diagram blocks", async () => {
  const rendered = await renderWriteup(
    { ...writeup, overview: `${writeup.overview}\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`` },
    topics,
  );
  const blocks = rendered.sections.flatMap((section) => section.blocks);
  expect(blocks.filter((block) => block.kind === "diagram")).toHaveLength(1);
  for (const block of blocks) {
    if (block.kind === "diagram") continue;
    expect(blockText(block.html)).toBe(block.text);
  }
});

test("null decisions produce the exact required paragraph", async () => {
  const rendered = await renderWriteup(writeup, topics);
  const blocks = rendered.sections.find((section) => section.key === "decisions")?.blocks;
  expect(blocks).toHaveLength(1);
  expect(blocks?.[0]).toMatchObject({
    kind: "paragraph",
    text: "Decisions and drift: not written. Only the session where the change was asked for can tell what drifted from it.",
  });
});

test("omits missing optional sections but preserves explicitly empty sections", async () => {
  const rendered = await renderWriteup({ overview: "", tldr: "", decisions: "", topics: {} }, topics);
  expect(rendered.sections.map((section) => section.key)).toEqual(["overview", "tldr", "decisions"]);
  expect(rendered.sections.every((section) => section.blocks.length === 0)).toBe(true);
});

test("old manifests keep their overview-first output", async () => {
  const rendered = await renderWriteup(
    { overview: "Existing **overview**.", tldr: "Existing summary.", decisions: "", topics: {} },
    [],
  );
  expect(rendered.sections.map(({ key, blocks }) => ({ key, html: blocks.map((block) => block.html) }))).toEqual([
    { key: "overview", html: ["<p>Existing <strong>overview</strong>.</p>"] },
    { key: "tldr", html: ["<p>Existing summary.</p>"] },
    { key: "decisions", html: [] },
  ]);
});

test("new writeups start with the summary, verdict, checks, overview, scope, guide and context", async () => {
  const rendered = await renderWriteup(
    {
      ...writeup,
      review: { level: "skim", reason: "The change is small." },
      checked: "Unit tests.",
      notChecked: "Browser behavior.",
      outOfScope: "- Delays",
      whereToLook: "- Check the retry loop",
      context: "- No new dependency",
    },
    topics,
  );
  const legacy = await renderWriteup(writeup, topics);
  expect(rendered.sections.map(({ key, label }) => [key, label])).toEqual([
    ["tldr", "TL;DR"],
    ["review", "Review"],
    ["checked", "Checked"],
    ["notChecked", "Not checked"],
    ["overview", "Overview"],
    ["outOfScope", "Out of scope"],
    ["whereToLook", "Where to look"],
    ["context", "Context"],
    ...legacy.sections.slice(2).map(({ key, label }) => [key, label]),
  ]);
  expect(rendered.sections[0]).toEqual(legacy.sections[1]);
  expect(rendered.sections[4]).toEqual(legacy.sections[0]);
  expect(rendered.sections.slice(8)).toEqual(legacy.sections.slice(2));
});

test.each(["review", "checked", "notChecked"] as const)("%s alone selects the new section order", async (field) => {
  const change =
    field === "review"
      ? { review: { level: "skim" as const, reason: "Synthetic reason." } }
      : { [field]: "Synthetic check." };
  const rendered = await renderWriteup({ overview: "", tldr: "", decisions: "", topics: {}, ...change }, []);
  expect(rendered.sections.map((section) => section.key)).toEqual(["tldr", field, "overview", "decisions"]);
});

const verdictCases: [ReviewVerdict, string][] = [
  [{ level: "skim", reason: "Small change." }, "Skim, then merge."],
  [{ level: "everything", reason: "Broad change." }, "Read everything."],
  [{ level: "topics", topics: ["search"], reason: "Search changed." }, "Read topic “Shelf search”."],
  [
    { level: "topics", topics: ["labels", "search"], reason: "Names and search changed." },
    "Read topics “Clear labels” and “Shelf search”.",
  ],
  [
    { level: "topics", topics: ["labels", "search", "sorting"], reason: "The library changed." },
    "Read topics “Clear labels”, “Shelf search” and “Stable sorting”.",
  ],
  [{ level: "topics", topics: ["missing-topic"], reason: "Fallback." }, "Read topic “missing-topic”."],
];
test.each(verdictCases)("renders the verdict %j as one paragraph", async (review, verdict) => {
  const rendered = await renderWriteup({ ...writeup, review }, topics);
  const section = rendered.sections.find((section) => section.key === "review");
  expect(section).toMatchObject({ label: "Review", topic: null });
  expect(section?.blocks).toEqual([
    expect.objectContaining({
      kind: "paragraph",
      text: `${verdict} ${review.reason}`,
      html: `<p><strong>${verdict}</strong> ${review.reason}</p>`,
    }),
  ]);
});

test("verdict reasons keep their Markdown after the generated verdict", async () => {
  const rendered = await renderWriteup(
    { ...writeup, review: { level: "skim", reason: "The **small** change has a [guide](https://example.com)." } },
    [],
  );
  const html = rendered.sections.find((section) => section.key === "review")?.blocks[0]?.html;
  expect(html).toContain("<strong>Skim, then merge.</strong> The <strong>small</strong> change");
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain('rel="noopener noreferrer nofollow"');
});

test.each([
  "[x](javascript:alert(1))",
  "[guide](https://example.com)",
  "*stars* _underscores_ `code` **strong**",
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "&lt;script&gt; &#x3C;b&#x3E;",
  "  Shelf\n\t search  ",
  "  Shelf\u2028search\u2029results  ",
  "a\\b",
  "www.example.com",
  "someone@example.com",
])("verdict topic title stays literal on one line: %j", async (title) => {
  const rendered = await renderWriteup(
    { ...writeup, review: { level: "topics", topics: ["search"], reason: "Check this topic." } },
    [{ slug: "search", title, importance: 10, summary: "Synthetic topic." }],
  );
  const blocks = rendered.sections.find((section) => section.key === "review")?.blocks ?? [];
  const verdict = `Read topic “${title.replace(/\s+/g, " ").trim()}”.`;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.text).toBe(`${verdict} Check this topic.`);
  const html = blocks[0]?.html ?? "";
  expect(html).not.toContain("\n");
  const autolink =
    title === "[guide](https://example.com)"
      ? /^https:\/\/example\.com/
      : title === "www.example.com"
        ? /^https?:\/\/www\.example\.com/
        : title === "someone@example.com"
          ? /^mailto:someone@example\.com/
          : undefined;
  if (autolink) expect(html).not.toMatch(/javascript:/i);
  const tags: string[] = [];
  visitElements(fromHtml(html, { fragment: true }), (element) => {
    tags.push(element.tagName);
    if (autolink && element.tagName === "a") {
      expect(element.properties.href).toMatch(autolink);
      expect(element.properties.rel).toEqual(["noopener", "noreferrer", "nofollow"]);
    } else {
      expect(element.properties).toEqual({});
    }
  });
  expect(tags).toEqual(autolink ? ["p", "strong", "a"] : ["p", "strong"]);
});

test.each(["outOfScope", "whereToLook", "context"] as const)(
  "a present %s selects the new order, including an empty string, and omits absent fields",
  async (field) => {
    for (const value of ["", "Synthetic text"]) {
      const rendered = await renderWriteup({ overview: "", tldr: "", decisions: "", topics: {}, [field]: value }, []);
      expect(rendered.sections.map((section) => section.key)).toEqual(["tldr", "overview", field, "decisions"]);
      expect(rendered.sections[2]?.blocks).toHaveLength(value ? 1 : 0);
    }
  },
);

test.each([
  "whyItMatters",
  "review",
  "checked",
  "notChecked",
  "outOfScope",
  "whereToLook",
  "context",
  "deviations",
] as const)("sanitizes hostile Markdown in %s", async (field) => {
  const source = "graph TD; A-->B; click A callback";
  const markdown = [
    "<script>bad()</script>",
    "Before <img src=x onerror=alert(1)> after",
    "[Unsafe link](javascript:bad())",
    '<div onclick="bad()" style="position:fixed" id="raw" class="injected" data-foo="x">Raw HTML</div>',
    '<svg onload="bad()"><circle /></svg>',
    `\`\`\`mermaid\n${source}\n\`\`\``,
  ].join("\n\n");
  const change =
    field === "review" ? { review: { level: "everything" as const, reason: markdown } } : { [field]: markdown };
  const rendered = await renderWriteup({ ...writeup, ...change }, []);
  const blocks = rendered.sections.find((section) => section.key === field)?.blocks ?? [];
  const html = blocks.map((block) => block.html).join("");
  expect(html).toContain("Raw HTML");
  expect(html).toContain("Unsafe link");
  expect(html).toContain('id="user-content-raw"');
  expect(html).toContain("user-content-injected");
  expect(html).not.toMatch(
    /<(script|style|iframe|object|embed|form|svg)|\s(on\w+|style|data-[\w-]+)=|javascript:|data:|vbscript:/i,
  );
  expect(blocks.filter((block) => block.kind === "diagram")).toEqual([
    expect.objectContaining({ kind: "diagram", source, text: source, html: "" }),
  ]);
  for (const block of blocks) {
    expect(block.section).toBe(field);
    expect(BlockId.parse(block.id)).toMatch(new RegExp(`^${field}-`));
  }
});

test("sanitizes raw glossary HTML through the same pipeline", async () => {
  const rendered = await renderWriteup(
    {
      ...writeup,
      glossary:
        '<div onclick="bad()" style="position:fixed" class="thread-card" id="glossary" data-foo="x"><script>bad()</script><iframe src="https://example.com"></iframe><svg onload="bad()"></svg><a href="javascript:bad()">Term</a><img src=x onerror="bad()"></div>',
    },
    topics,
  );
  const blocks = rendered.sections.find((section) => section.key === "glossary")?.blocks ?? [];
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    expect(block.html).not.toMatch(
      /<(script|style|iframe|object|embed|form|svg)|\s(on\w+|style|data-[\w-]+)=|javascript:|data:|vbscript:/i,
    );
    expect(block.text).toBe("Term");
    expect(block.html).toContain("user-content-thread-card");
    expect(block.html).toContain('id="user-content-glossary"');
  }
});

test("list glossaries emit item blocks and plain text terms, without marking glossary entries", async () => {
  const rendered = await renderWriteup(
    {
      overview: "Budget and budget.",
      tldr: "",
      decisions: "",
      topics: {},
      glossary: [
        { term: " Budget ", definition: "The **attempts** allowed." },
        { term: "Retry", definition: "Try again.\r\n\r\nKeep the budget.", aliases: ["Attempt"] },
      ],
    },
    [],
  );
  const blocks = rendered.sections.find((section) => section.key === "glossary")?.blocks ?? [];
  expect(blocks).toHaveLength(2);
  expect(blocks.every((block) => block.kind === "item")).toBe(true);
  expect(blocks[0]?.html).toContain("<strong>Budget:</strong> The <strong>attempts</strong> allowed.");
  expect(blocks.map((block) => block.html).join("")).not.toContain("emend-term");
  expect(rendered.terms).toEqual([
    { term: "Budget", definition: "The attempts allowed.", blockId: blocks[0]?.id },
    { term: "Retry", definition: "Try again. Keep the budget.", blockId: blocks[1]?.id },
  ]);
});

test("list glossary marks reset in every section without changing block text or ids", async () => {
  const source: WriteupInput = {
    overview: "Budget budget.",
    tldr: "Budget budget.",
    review: { level: "skim", reason: "Budget budget." },
    checked: "Budget budget.",
    notChecked: "Budget budget.",
    decisions: "Budget budget.",
    outOfScope: "Budget budget.",
    whereToLook: "Budget budget.",
    context: "Budget budget.",
    topics: { search: { why: "Budget budget.", example: "Budget budget.", body: "Budget budget." } },
  };
  const plain = await renderWriteup(source, topics);
  const marked = await renderWriteup({ ...source, glossary: [{ term: "Budget", definition: "Attempts." }] }, topics);
  const sections = marked.sections.filter((section) => section.key !== "glossary");
  expect(sections).toHaveLength(12);
  for (const [index, section] of sections.entries()) {
    expect(section.blocks.map(({ id, text }) => ({ id, text }))).toEqual(
      plain.sections[index]?.blocks.map(({ id, text }) => ({ id, text })),
    );
    expect(
      section.blocks
        .map((block) => block.html)
        .join("")
        .match(/data-emend-term="0"/g),
    ).toHaveLength(1);
  }
});

test.each([false, true])(
  "mark indexes stay aligned or reject a missing first glossary block: %s",
  async (omitFirst) => {
    const glossary = [
      { term: "Missing", definition: "A missing target." },
      { term: "Budget", definition: "Attempts allowed.", aliases: ["Allowance"] },
      { term: "Retry", definition: "Try again." },
      { term: "Timeout", definition: "The wait limit.", aliases: ["Deadline"] },
    ];
    const renderSection = markdown.renderMarkdownWithBudget;
    const rendering = vi.spyOn(markdown, "renderMarkdownWithBudget").mockImplementation((...args) => {
      if (omitFirst && args[1] === "glossary" && args[0].startsWith("- **Missing:**")) return Promise.resolve([]);
      return renderSection(...args);
    });
    try {
      const overview = glossary.map((entry) => entry.aliases?.[0] ?? entry.term).join(" ");
      const renderingWriteup = renderWriteup({ overview, tldr: "", decisions: "", topics: {}, glossary }, []);
      if (omitFirst) {
        await expect(renderingWriteup).rejects.toThrow("glossary entry rendered no block");
        return;
      }
      const rendered = await renderingWriteup;
      const expected = glossary;
      expect(rendered.terms?.map((entry) => entry.term)).toEqual(expected.map((entry) => entry.term));
      expect(rendered.sections.map((section) => section.key)).toEqual(["overview", "tldr", "decisions", "glossary"]);
      const marks: { index: number; text: string }[] = [];
      for (const block of rendered.sections[0]?.blocks ?? []) {
        visitElements(fromHtml(block.html, { fragment: true }), (element) => {
          if (element.properties.dataEmendTerm === undefined) return;
          const child = element.children[0];
          marks.push({
            index: Number(element.properties.dataEmendTerm),
            text: child?.type === "text" ? child.value : "",
          });
        });
      }
      expect(marks).toEqual(expected.map((entry, index) => ({ index, text: entry.aliases?.[0] ?? entry.term })));
      for (const { index, text } of marks) {
        const term = rendered.terms?.[index];
        const entry = glossary.find((entry) => entry.term === term?.term);
        expect([entry?.term, ...(entry?.aliases ?? [])]).toContain(text);
        expect(rendered.sections.at(-1)?.blocks.some((block) => block.id === term?.blockId)).toBe(true);
      }
    } finally {
      rendering.mockRestore();
    }
  },
);

test("the overview spends the shared highlight budget before glossary code", async () => {
  const code = "const overview = 1;\n";
  const renderSection = markdown.renderMarkdownWithBudget;
  let initialized = false;
  const rendering = vi.spyOn(markdown, "renderMarkdownWithBudget").mockImplementation((...args) => {
    if (!initialized) {
      args[2].highlightedBytes = HIGHLIGHT_RENDER_BYTES - new TextEncoder().encode(code).byteLength;
      initialized = true;
    }
    return renderSection(...args);
  });
  try {
    const rendered = await renderWriteup(
      {
        overview: `\`\`\`js\n${code}\`\`\``,
        tldr: "",
        decisions: "",
        topics: {},
        glossary: [{ term: "Budget", definition: "Attempts.\n\n```js\nconst glossary = 2;\n```" }],
      },
      [],
    );
    expect(rendered.sections[0]?.blocks[0]?.html).toContain('class="shiki');
    expect(
      rendered.sections
        .at(-1)
        ?.blocks.map((block) => block.html)
        .join(""),
    ).not.toContain('class="shiki');
  } finally {
    rendering.mockRestore();
  }
});

test("Markdown glossary output is identical to independently rendered sections", async () => {
  const { renderMarkdown } = await import("./markdown.ts");
  const source = {
    overview: "Budget budget.",
    tldr: "Budget.",
    decisions: "Budget.",
    glossary: "- **Budget:** Attempts.",
    topics: {},
  };
  const rendered = await renderWriteup(source, []);
  expect(rendered).toEqual({
    sections: await Promise.all(
      [
        ["overview", "Overview"],
        ["tldr", "TL;DR"],
        ["decisions", "Decisions and drift"],
        ["glossary", "Glossary"],
      ].map(async ([key, label]) => ({
        key,
        label,
        topic: null,
        blocks: await renderMarkdown(source[key as keyof Omit<typeof source, "topics">], key ?? ""),
      })),
    ),
  });
  expect(JSON.stringify(rendered)).not.toContain("emend-term");
  expect(rendered).not.toHaveProperty("terms");
  const empty = await renderWriteup({ ...source, glossary: [] }, []);
  expect(empty.sections.at(-1)?.blocks).toEqual([]);
  expect(empty).not.toHaveProperty("terms");
});

test("list glossary duplicate block ids follow one section's occurrence counts", async () => {
  const source = "graph TD; A-->B";
  const glossary = ["First", "Second"].map((term) => ({
    term,
    definition: `Before.\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nRepeated.\n\n\`\`\`mermaid\n${source}\n\`\`\``,
  }));
  const rendered = await renderWriteup({ overview: "", tldr: "", decisions: "", topics: {}, glossary }, []);
  const blocks = rendered.sections.at(-1)?.blocks ?? [];
  const diagrams = blocks.filter((block) => block.kind === "diagram");
  expect(diagrams).toHaveLength(4);
  expect(diagrams.map((block) => block.id)).toEqual([
    diagrams[0]?.id,
    `${diagrams[0]?.id}-2`,
    `${diagrams[0]?.id}-3`,
    `${diagrams[0]?.id}-4`,
  ]);
  expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
  expect(rendered.terms?.map((term) => term.definition)).toEqual(["Before. Repeated.", "Before. Repeated."]);
});

test("hostile glossary forms stay text and definitions use sanitized blocks", async () => {
  const glossary = [
    "<script>bad()</script>",
    '<img src=x onerror="bad()">',
    '<svg onload="bad()">',
    "[link](javascript:bad())",
  ].map((term, index) => ({
    term,
    aliases: [`Alias ${index} ${term}`],
    definition:
      '<script>bad()</script>\n\n<img src=x onerror="bad()">\n\n[Unsafe](javascript:bad())\n\n<div class="raw" onclick="bad()">Raw HTML</div>\n\n<svg onload="bad()"></svg>\n\n```mermaid\ngraph TD; A-->B; click A callback\n```',
  }));
  const overview = `${glossary.map((entry) => entry.aliases[0]?.replace(/[!-/:-@[-`{-~]/g, "\\$&")).join(" ")}\n\n<span class="emend-term" data-emend-term="0">x</span>`;
  const rendered = await renderWriteup({ overview, tldr: "", decisions: "", topics: {}, glossary }, []);
  const blocks = rendered.sections.find((section) => section.key === "glossary")?.blocks ?? [];
  const html = blocks.map((block) => block.html).join("");
  const assertSanitized = (html: string) => {
    visitElements(fromHtml(html, { fragment: true }), (element) => {
      expect(["script", "svg", "iframe"]).not.toContain(element.tagName);
      expect(Object.keys(element.properties)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(on|style$)/i)]),
      );
      if (element.tagName === "img") expect(element.properties).toEqual({});
      expect(element.properties.href ?? "").not.toMatch(/^javascript:/i);
    });
  };
  assertSanitized(html);
  expect(html).not.toContain("data-emend-term");
  expect(html).toContain("user-content-raw");
  expect(rendered.terms?.map((entry) => entry.term)).toEqual(glossary.map((entry) => entry.term));
  expect(rendered.terms?.map((entry) => entry.definition)).toEqual(glossary.map(() => "Unsafe Raw HTML"));
  expect(blocks.filter((block) => block.kind === "diagram")).toHaveLength(4);
  const prose = rendered.sections[0]?.blocks.map((block) => block.html).join("") ?? "";
  expect(prose).toContain('<span class="user-content-emend-term">x</span>');
  expect(prose.match(/data-emend-term=/g)).toHaveLength(4);
  for (const section of rendered.sections) {
    if (section.key === "glossary") continue;
    for (const block of section.blocks) {
      if (block.html.includes("data-emend-term=")) assertSanitized(block.html);
    }
  }
  expect(prose).toContain(
    '<span class="emend-term" data-emend-term="0">Alias 0 &#x3C;script>bad()&#x3C;/script></span>',
  );
  expect(prose).not.toContain("<script");
});

test("plain glossary definitions truncate within the character limit", async () => {
  const rendered = await renderWriteup(
    { overview: "", tldr: "", decisions: "", topics: {}, glossary: [{ term: "Budget", definition: "x".repeat(2100) }] },
    [],
  );
  const definition = rendered.terms?.[0]?.definition ?? "";
  expect(definition).toBe(`${"x".repeat(1999)}…`);
});

test("definition truncation keeps astral characters well-formed at the cut", async () => {
  const rendered = await renderWriteup(
    {
      overview: "",
      tldr: "",
      decisions: "",
      topics: {},
      glossary: [{ term: "Budget", definition: `${"x".repeat(1998)}🚀ending` }],
    },
    [],
  );
  const definition = rendered.terms?.[0]?.definition ?? "";
  expect(definition.isWellFormed()).toBe(true);
  expect(definition.length).toBeLessThanOrEqual(2000);
  expect(definition).toBe(`${"x".repeat(1998)}…`);
});

test("whyItMatters follows the TL;DR without changing the other sections or block ids", async () => {
  const input: WriteupInput = {
    ...writeup,
    review: { level: "skim", reason: "Small change." },
    checked: "Unit tests.",
    notChecked: "Browser.",
    outOfScope: "Delays.",
    whereToLook: "Search.",
    context: "Library.",
  };
  const before = await renderWriteup(input, topics);
  const rendered = await renderWriteup(
    { ...input, whyItMatters: "The library stays responsive.", area: "  library  ›  search  " },
    topics,
  );
  expect(rendered.area).toBe("library › search");
  expect(rendered.sections[1]).toMatchObject({
    key: "whyItMatters",
    label: "Why it matters",
    topic: null,
    blocks: [expect.objectContaining({ text: "The library stays responsive." })],
  });
  expect(rendered.sections.filter((section) => section.key !== "whyItMatters")).toEqual(before.sections);
});

test("area alone selects the non-legacy branch even with no Markdown", async () => {
  const rendered = await renderWriteup({ overview: "", tldr: "", decisions: "", topics: {}, area: "Library" }, []);
  expect(rendered.area).toBe("Library");
  expect(rendered.sections.map((section) => section.key)).toEqual(["tldr", "overview", "decisions"]);
  expect(rendered.sections.every((section) => section.blocks.length === 0)).toBe(true);
});

test.each([false, true])("renders needsYou items after the opening in new layout=%s", async (newLayout) => {
  const input: WriteupInput = {
    ...writeup,
    ...(newLayout ? { whyItMatters: "Readers can find books.", checked: "Search tests." } : {}),
    needsYou: [
      { kind: "decide", text: "Choose the **search limit**.", topic: "search" },
      { kind: "accept", text: "Accept the shorter list." },
    ],
  };
  const rendered = await renderWriteup(input, topics);
  const index = rendered.sections.findIndex((section) => section.key === "needsYou");
  expect(rendered.sections[index - 1]?.key).toBe(newLayout ? "whyItMatters" : "tldr");
  expect(rendered.sections[0]?.key).toBe(newLayout ? "tldr" : "overview");
  const section = rendered.sections[index];
  expect(section).toMatchObject({ key: "needsYou", label: "Needs you", topic: null });
  expect(section?.blocks).toHaveLength(2);
  expect(section?.blocks[0]?.html).toContain("<strong>search limit</strong>");
  expect(rendered.needsYou).toEqual([
    { kind: "decide", topic: "search", blockIds: [section?.blocks[0]?.id] },
    { kind: "accept", blockIds: [section?.blocks[1]?.id] },
  ]);
  for (const block of section?.blocks ?? []) expect(BlockId.parse(block.id)).toMatch(/^needsYou-/);
});

test("preserves empty needsYou and omits missing needsYou without rendering a section", async () => {
  const absent = await renderWriteup(writeup, topics);
  const empty = await renderWriteup({ ...writeup, needsYou: [] }, topics);
  expect(absent).not.toHaveProperty("needsYou");
  expect(empty.needsYou).toEqual([]);
  expect(empty.sections).toEqual(absent.sections);
  expect(empty.sections.some((section) => section.key === "needsYou")).toBe(false);
});

test("needsYou repeats get unique ids and glossary marks through the Markdown pipeline", async () => {
  const rendered = await renderWriteup(
    {
      ...writeup,
      glossary: [{ term: "Budget", definition: "Attempts allowed." }],
      needsYou: (["decide", "accept", "answer"] as const).map((kind) => ({
        kind,
        text: "Budget budget.",
      })),
    },
    topics,
  );
  const blocks = rendered.sections.find((section) => section.key === "needsYou")?.blocks ?? [];
  expect(blocks).toHaveLength(3);
  expect(blocks.map((block) => block.id)).toEqual([blocks[0]?.id, `${blocks[0]?.id}-2`, `${blocks[0]?.id}-3`]);
  expect(rendered.needsYou?.map((item) => item.blockIds)).toEqual(blocks.map((block) => [block.id]));
  for (const block of blocks) expect(block.html).toContain('data-emend-term="0"');
});

test.each([
  "Before <script>bad()</script> after",
  "Before <img src=x onerror=bad()> after",
  "[Unsafe link](javascript:bad())",
  '<div onclick="bad()" style="position:fixed" id="raw" class="injected" data-foo="x">Raw HTML</div>',
  'Before <svg onload="bad()"><circle /></svg> after',
  '<pre><code class="language-mermaid">graph TD; A--&gt;B; click A callback</code></pre>',
])("sanitizes hostile needsYou text %j", async (text) => {
  const rendered = await renderWriteup({ ...writeup, needsYou: [{ kind: "answer", text }] }, []);
  const blocks = rendered.sections.find((section) => section.key === "needsYou")?.blocks ?? [];
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks.map((block) => block.html).join("")).not.toMatch(
    /<(script|style|iframe|object|embed|form|svg)|\s(on\w+|style|data-[\w-]+)=|javascript:|data:|vbscript:/i,
  );
  if (text.includes("language-mermaid"))
    expect(blocks).toMatchObject([{ kind: "diagram", html: "", source: "graph TD; A-->B; click A callback" }]);
  expect(rendered.needsYou?.[0]?.blockIds).toEqual(blocks.map((block) => block.id));
});

test.each([false, true])("renders newInRevision items after the opening in new layout=%s", async (newLayout) => {
  const input: WriteupInput = {
    ...writeup,
    ...(newLayout
      ? {
          whyItMatters: "Readers can find books.",
          review: { level: "everything" as const, reason: "Check the search limit." },
          checked: "Search tests.",
        }
      : {}),
    needsYou: [{ kind: "answer", text: "Choose the shelf." }],
    newInRevision: [
      { text: "Raised the **search limit**.", topic: "search" },
      { section: "checked", text: "Checked the shorter list." },
    ],
  };
  const rendered = await renderWriteup(input, topics);
  const index = rendered.sections.findIndex((section) => section.key === "newInRevision");
  expect(rendered.sections[index - 1]?.key).toBe(newLayout ? "whyItMatters" : "tldr");
  expect(rendered.sections[index + 1]?.key).toBe("needsYou");
  expect(rendered.sections[index + 2]?.key).toBe(newLayout ? "review" : "decisions");
  expect(rendered.sections[0]?.key).toBe(newLayout ? "tldr" : "overview");
  const section = rendered.sections[index];
  expect(section).toMatchObject({ key: "newInRevision", label: "New in this revision", topic: null });
  expect(section?.blocks).toHaveLength(2);
  expect(section?.blocks[0]?.html).toContain("<strong>search limit</strong>");
  expect(rendered.newInRevision).toEqual([
    { topic: "search", blockIds: [section?.blocks[0]?.id] },
    { section: "checked", blockIds: [section?.blocks[1]?.id] },
  ]);
  for (const block of section?.blocks ?? []) expect(BlockId.parse(block.id)).toMatch(/^newInRevision-/);
});

test("omits empty and missing newInRevision without rendering a section", async () => {
  const absent = await renderWriteup(writeup, topics);
  const empty = await renderWriteup({ ...writeup, newInRevision: [] }, topics);
  expect(absent).not.toHaveProperty("newInRevision");
  expect(empty).not.toHaveProperty("newInRevision");
  expect(empty.sections).toEqual(absent.sections);
  expect(empty.sections.some((section) => section.key === "newInRevision")).toBe(false);
});

test("newInRevision repeats get unique ids and glossary marks through the Markdown pipeline", async () => {
  const rendered = await renderWriteup(
    {
      ...writeup,
      glossary: [{ term: "Budget", definition: "Attempts allowed." }],
      newInRevision: Array.from({ length: 3 }, () => ({
        text: "Budget budget.",
      })),
    },
    topics,
  );
  const blocks = rendered.sections.find((section) => section.key === "newInRevision")?.blocks ?? [];
  expect(blocks).toHaveLength(3);
  expect(blocks.map((block) => block.id)).toEqual([blocks[0]?.id, `${blocks[0]?.id}-2`, `${blocks[0]?.id}-3`]);
  expect(rendered.newInRevision?.map((item) => item.blockIds)).toEqual(blocks.map((block) => [block.id]));
  for (const block of blocks) expect(block.html).toContain('data-emend-term="0"');
});

test.each([
  "Before <script>bad()</script> after",
  "Before <img src=x onerror=bad()> after",
  "[Unsafe link](javascript:bad())",
  '<div onclick="bad()" style="position:fixed" id="raw" class="injected" data-foo="x">Raw HTML</div>',
  'Before <svg onload="bad()"><circle /></svg> after',
  '<pre><code class="language-mermaid">graph TD; A--&gt;B; click A callback</code></pre>',
])("sanitizes hostile newInRevision text %j", async (text) => {
  const rendered = await renderWriteup({ ...writeup, newInRevision: [{ text, quote: text }] }, []);
  const blocks = rendered.sections.find((section) => section.key === "newInRevision")?.blocks ?? [];
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks.map((block) => block.html).join("")).not.toMatch(
    /<(script|style|iframe|object|embed|form|svg)|\s(on\w+|style|data-[\w-]+)=|javascript:|data:|vbscript:/i,
  );
  if (text.includes("language-mermaid"))
    expect(blocks).toMatchObject([{ kind: "diagram", html: "", source: "graph TD; A-->B; click A callback" }]);
  expect(rendered.newInRevision?.[0]?.blockIds).toEqual(blocks.map((block) => block.id));
  expect(rendered.newInRevision?.[0]).not.toHaveProperty("quote");
});

test("revision quotes resolve different blocks in one topic after all sections render", async () => {
  const rendered = await renderWriteup(
    {
      overview: "",
      tldr: "",
      decisions: "",
      topics: {
        search: {
          why: "First **search limit**.\n\nSecond _retry budget_.",
          example: "Use `max_count` café.",
          body: "A final detail.",
        },
      },
      newInRevision: [
        { text: "Raised the search limit.", topic: "search", quote: "search limit" },
        { text: "Adjusted the retry budget.", topic: "search", quote: "retry budget" },
        { text: "Corrected the example.", topic: "search", quote: "`max_count`   cafe\u0301" },
        { text: "Explained the detail.", quote: "final detail" },
      ],
    },
    topics,
  );
  const blocks = rendered.sections.filter((section) => section.topic === "search").flatMap((section) => section.blocks);
  expect(rendered.newInRevision?.map((item) => item.blockId)).toEqual(blocks.map((block) => block.id));
  expect(new Set(rendered.newInRevision?.map((item) => item.blockId)).size).toBe(4);
  for (const item of rendered.newInRevision ?? []) expect(item).not.toHaveProperty("quote");
});

test("bare and Markdown code quotes preserve identifiers across the whole scope", async () => {
  const rendered = await renderWriteup(
    {
      overview: "",
      tldr: "",
      decisions: "",
      topics: { search: { why: "Use maxcount café.", example: "Use `max_count` café." } },
      newInRevision: [
        { text: "Corrected the identifier.", topic: "search", quote: "max_count" },
        { text: "Corrected the code identifier.", topic: "search", quote: "`max_count`" },
        { text: "Clarified the example.", topic: "search", quote: "max_count   cafe\u0301" },
        { text: "Clarified the code example.", topic: "search", quote: "`max_count`   cafe\u0301" },
      ],
    },
    topics,
  );
  const blocks = rendered.sections.filter((section) => section.topic === "search").flatMap((section) => section.blocks);
  expect(blocks.map((block) => block.text)).toEqual(["Use maxcount café.", "Use max_count café."]);
  expect(rendered.newInRevision?.map((item) => item.blockId)).toEqual([
    blocks[1]?.id,
    blocks[1]?.id,
    blocks[1]?.id,
    blocks[1]?.id,
  ]);
});

test("revision quotes read Markdown emphasis only when the plain pass has no match", async () => {
  const rendered = await renderWriteup(
    {
      overview: "Fix: the loop stops here.",
      tldr: "**Fix:** the loop stops again.",
      decisions: "",
      topics: {},
      newInRevision: [{ text: "Fixed the loop.", quote: "**Fix:** the loop stops" }],
    },
    [],
  );
  const block = rendered.sections.find((section) => section.key === "overview")?.blocks[0];
  expect(block?.text).toBe("Fix: the loop stops here.");
  expect(rendered.newInRevision?.[0]?.blockId).toBe(block?.id);
});

test("revision quotes prefer literal marks in a later block to an earlier Markdown match", async () => {
  const rendered = await renderWriteup(
    {
      overview: "Fix: the loop stops here.",
      tldr: "`**Fix:** the loop stops` here.",
      decisions: "",
      topics: {},
      newInRevision: [{ text: "Clarified the literal example.", quote: "**Fix:** the loop stops" }],
    },
    [],
  );
  const block = rendered.sections.find((section) => section.key === "tldr")?.blocks[0];
  expect(block?.text).toBe("**Fix:** the loop stops here.");
  expect(rendered.newInRevision?.[0]?.blockId).toBe(block?.id);
});

test.each([
  "[the retry PRD](https://example.test/prd)",
  "[the retry PRD](javascript:bad())",
  "the ~~retry~~ **PRD**",
  "the <!-- ignored -->retry `PRD`",
  "the retry\\\nPRD",
])("revision quote %j uses only Markdown text, inline code and breaks", async (quote) => {
  const rendered = await renderWriteup(
    {
      overview: "See the retry PRD for details.",
      tldr: "",
      decisions: "",
      topics: {},
      newInRevision: [{ text: "Updated the reference.", quote }],
    },
    [],
  );
  const block = rendered.sections.find((section) => section.key === "overview")?.blocks[0];
  expect(block?.text).toBe("See the retry PRD for details.");
  expect(rendered.newInRevision?.[0]?.blockId).toBe(block?.id);
  expect(rendered.newInRevision?.[0]).not.toHaveProperty("quote");
  expect(rendered.sections.find((section) => section.key === "newInRevision")?.blocks[0]?.html).toBe(
    "<p>Updated the reference.</p>",
  );
});

test.each([
  "",
  " \t ",
  "**",
  "_",
  "`",
  " *\t_ ` ",
  "\u0085*\u00a0_\ufeff`",
  "<!-- note -->",
  "<script>bad()</script>",
  "<img src=x onerror=bad()>",
  '<div onclick="bad()">First eligible block.</div>',
  '<pre><code class="language-mermaid">graph TD; A--&gt;B; click A callback</code></pre>',
])("unmatched stored revision quote %j has no block destination", async (quote) => {
  const rendered = await renderWriteup(
    {
      overview: "First eligible block.",
      tldr: "",
      decisions: "",
      topics: {},
      newInRevision: [{ text: "Updated the opening.", quote }],
    },
    [],
  );
  expect(rendered.sections.find((section) => section.key === "overview")?.blocks).toHaveLength(1);
  expect(rendered.newInRevision).toHaveLength(1);
  expect(rendered.newInRevision?.[0]).not.toHaveProperty("blockId");
});

test("stored revision quotes match inline HTML text without rendering the HTML", async () => {
  const rendered = await renderWriteup(
    {
      overview: "First eligible block.",
      tldr: "",
      decisions: "",
      topics: {},
      newInRevision: [
        { text: "Updated the opening.", quote: '<svg onload="bad()"><text>First eligible block.</text></svg>' },
      ],
    },
    [],
  );
  const block = rendered.sections.find((section) => section.key === "overview")?.blocks[0];
  expect(block?.text).toBe("First eligible block.");
  expect(rendered.newInRevision).toHaveLength(1);
  expect(rendered.newInRevision?.[0]?.blockId).toBe(block?.id);
  expect(rendered.newInRevision?.[0]).not.toHaveProperty("quote");
  for (const section of rendered.sections)
    expect(section.blocks.map((block) => block.html).join("")).not.toMatch(/svg|onload|bad\(/i);
});

test("revision quote scopes, case and first match follow section order", async () => {
  const rendered = await renderWriteup(
    {
      overview: "Shared **search limit**.",
      tldr: "Shared search limit.",
      decisions: "",
      topics: { search: { why: "Only here.", body: "Shared search limit." }, labels: { why: "Outside topic words." } },
      newInRevision: [
        { text: "Updated the scope.", section: "tldr", quote: "**search limit**" },
        { text: "Updated the opening.", quote: "search limit" },
        { text: "Updated the detail.", topic: "search", quote: "search limit" },
        { text: "Unmatched outside topic.", topic: "search", quote: "Outside topic words" },
        { text: "Unmatched outside section.", section: "tldr", quote: "Only here" },
        { text: "Unmatched case.", quote: "SEARCH LIMIT" },
        { text: "Unmatched words.", quote: "Missing words" },
      ],
    },
    topics,
  );
  const id = (key: string) => rendered.sections.find((section) => section.key === key)?.blocks[0]?.id;
  expect(rendered.newInRevision?.slice(0, 3).map((item) => item.blockId)).toEqual([
    id("tldr"),
    id("overview"),
    id("t-search-body"),
  ]);
  for (const item of rendered.newInRevision?.slice(3) ?? []) expect(item).not.toHaveProperty("blockId");
});

test("revision quotes never match review, needsYou or their own news", async () => {
  const rendered = await renderWriteup(
    {
      overview: "",
      tldr: "",
      decisions: "",
      topics: {},
      review: { level: "everything", reason: "Hidden verdict words." },
      needsYou: [{ kind: "answer", text: "Decision question words." }],
      newInRevision: [
        { text: "Own news words.", quote: "Own news words" },
        { text: "Changed the review.", quote: "Hidden verdict words" },
        { text: "Changed the question.", quote: "Decision question words" },
      ],
    },
    [],
  );
  expect(rendered.newInRevision).toHaveLength(3);
  for (const item of rendered.newInRevision ?? []) expect(item).not.toHaveProperty("blockId");
});

test.each([false, true])(
  "drops empty revision lines without changing needsYou (has visible line=%s)",
  async (visible) => {
    const rendered = await renderWriteup(
      {
        overview: "",
        tldr: "",
        decisions: "",
        topics: {},
        checked: "A real check.",
        newInRevision: [
          { text: "<!-- Corrected date. -->", quote: "real check" },
          ...(visible ? [{ text: "Added a check.", quote: "real check" }] : []),
        ],
        needsYou: [{ kind: "answer", text: "<!-- Still awaiting an answer. -->" }],
      },
      [],
    );
    const news = rendered.sections.find((section) => section.key === "newInRevision");
    if (visible) {
      expect(news?.blocks.map((block) => block.text)).toEqual(["Added a check."]);
      expect(rendered.newInRevision).toEqual([
        {
          blockIds: [news?.blocks[0]?.id],
          blockId: rendered.sections.find((section) => section.key === "checked")?.blocks[0]?.id,
        },
      ]);
    } else {
      expect(news).toBeUndefined();
      expect(rendered).not.toHaveProperty("newInRevision");
    }
    expect(rendered.needsYou).toEqual([{ kind: "answer", blockIds: [] }]);
    expect(rendered.sections.find((section) => section.key === "needsYou")?.blocks).toEqual([]);
  },
);

test.each([false, true])(
  "deviations render just before decisions without switching layouts (new layout: %s)",
  async (opening) => {
    const rendered = await renderWriteup(
      {
        overview: "Overview.",
        tldr: "Summary.",
        decisions: "No drift.",
        topics: {},
        deviations: "None.",
        ...(opening ? { context: "Synthetic context." } : {}),
      },
      [],
    );
    expect(rendered.sections.map(({ key }) => key)).toEqual(
      opening
        ? ["tldr", "overview", "context", "deviations", "decisions"]
        : ["overview", "tldr", "deviations", "decisions"],
    );
    const section = rendered.sections.find(({ key }) => key === "deviations");
    expect(section).toMatchObject({
      key: "deviations",
      label: "Deviations from the approved intent",
      topic: null,
      blocks: [{ text: "None.", html: "<p>None.</p>" }],
    });
    expect(section?.blocks[0]?.id).toMatch(/^deviations-[0-9a-f]{8}$/);
  },
);
