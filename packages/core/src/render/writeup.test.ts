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

test.each(["review", "checked", "notChecked", "outOfScope", "whereToLook", "context"] as const)(
  "sanitizes hostile Markdown in %s",
  async (field) => {
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
  },
);

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
