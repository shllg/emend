import { type FileView, type RenderedBlock, RenderedWriteup, type RevisionView, type TopicMeta } from "@emend/contract";
import { expect, test } from "vitest";
import { renderWriteup } from "../../../../packages/core/src/render/writeup.ts";
import { type FactPart, readFact, riskFact, sinceFact, undoFact, usesOpeningCard } from "./writeup-facts.ts";

const factText = (parts: FactPart[] | undefined) => parts?.map((part) => part.text).join("");

const topic = (slug: string, attention?: TopicMeta["attention"]): TopicMeta => ({
  slug,
  title: slug,
  summary: "",
  importance: 10,
  attention,
});
const block = (section: RenderedBlock["section"], text: string): RenderedBlock => ({
  id: `${section}-12345678`,
  section,
  text,
  html: "",
  kind: "paragraph",
});
const section = (
  key: RenderedWriteup["sections"][number]["key"],
  text: string,
  topic: string | null = null,
): RenderedWriteup["sections"][number] => ({
  key,
  label: key,
  topic,
  blocks: [block(key, text)],
});
const file: FileView = {
  id: "11111111-1111-4111-8111-111111111111",
  path: "src/retry.ts",
  oldPath: null,
  role: "diff",
  status: "modified",
  topic: null,
  order: 0,
  mediaType: "text/plain",
  flag: null,
  hasOld: true,
  hasNew: true,
};
const empty: RenderedWriteup = { sections: [] };

test("only area or Why it matters opts a writeup into the opening card", () => {
  expect(usesOpeningCard(empty)).toBe(false);
  expect(usesOpeningCard({ sections: [section("tldr", "Summary")] })).toBe(false);
  expect(usesOpeningCard({ ...empty, area: "Garden" })).toBe(true);
  expect(usesOpeningCard({ sections: [section("whyItMatters", "More plants survive.")] })).toBe(true);
});

test("Risk uses the highest attention, preserves rank order and caps names at three", () => {
  expect(factText(riskFact([]))).toBeUndefined();
  expect(factText(riskFact([topic("unknown")]))).toBeUndefined();
  expect(factText(riskFact([topic("first", "skim")]))).toBe("Low: first");
  expect(factText(riskFact([topic("low", "skim"), topic("medium", "review")]))).toBe("Medium: medium");
  const topics = [
    topic("medium", "review"),
    ...["third", "first", "second", "fourth", "fifth"].map((slug) => topic(slug, "critical")),
  ];
  expect(factText(riskFact(topics))).toBe("High: third, first, second and 2 more");
  expect(factText(riskFact([topic("<img src=x onerror=alert(1)>", "critical")]))).toBe(
    "High: <img src=x onerror=alert(1)>",
  );
});

test("Undo chooses the hardest ranked topic, with stable ties and one-way fallback", () => {
  const topics = [topic("first"), { ...topic("second"), door: "one-way" as const }, topic("last")];
  expect(factText(undoFact(empty, []))).toBeUndefined();
  expect(factText(undoFact(empty, [topic("other")]))).toBeUndefined();
  expect(factText(undoFact(empty, [topics[0] as TopicMeta]))).toBe("A revert");
  expect(factText(undoFact(empty, topics))).toBe("A revert is not enough (second)");
  const writeup = {
    sections: [
      section("t-first-why", "  Undo: Restore the saved state.  ", "first"),
      section("t-last-why", "Undo: This cannot be undone.", "last"),
    ],
  };
  expect(factText(undoFact(writeup, topics))).toBe("This cannot be undone (last)");
  expect(factText(undoFact({ sections: writeup.sections.slice(0, 1) }, topics))).toBe(
    "Restore the saved state (first)",
  );
});

test("Undo reads the last matching block in Why, ignoring other sections and nonmatching blocks", () => {
  const why = section("t-first-why", "The change.", "first");
  why.blocks.push(
    block(why.key, "Undo: Cannot be undone"),
    block(why.key, "Undo: <img src=x onerror=alert(1)>"),
    block(why.key, "Check the migration."),
  );
  expect(
    factText(
      undoFact({ sections: [section("t-first-body", "Undo: Cannot be undone", "first"), why] }, [topic("first")]),
    ),
  ).toBe("<img src=x onerror=alert(1)> (first)");
  why.blocks = [block(why.key, "Undo:   ")];
  expect(factText(undoFact({ sections: [why] }, [topic("first")]))).toBe("A revert");
  why.blocks = [block(why.key, "Undo: A revert")];
  expect(factText(undoFact({ sections: [why] }, [topic("first")]))).toBe("A revert");
});

test.each(["\n", "\n\n"])("Undo survives rendering after the Markdown separator %j", async (separator) => {
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        overview: "",
        tldr: "",
        decisions: "",
        topics: { first: { why: `Retries must end.${separator}**Undo:** Revert, then rerun.` } },
      },
      [topic("first")],
    ),
  );
  const blocks = writeup.sections.find((section) => section.key === "t-first-why")?.blocks;
  expect(blocks).toHaveLength(separator === "\n" ? 1 : 2);
  expect(factText(undoFact(writeup, [topic("first")]))).toBe("Revert, then rerun (first)");
});

test.each(["The undo procedure is documented.", "We mention Undo: rerun the migration."])(
  "Undo ignores a mid-sentence mention: %s",
  (text) => {
    expect(factText(undoFact({ sections: [section("t-first-why", text, "first")] }, [topic("first")]))).toBe(
      "A revert",
    );
  },
);

test.each([
  ["Cannot be undone:\ndrops column x.", "Cannot be undone: drops column x"],
  ["Revert, then\nrestore the saved state.", "Revert, then restore the saved state"],
])("Undo reads a wrapped Markdown paragraph: %s", async (undo, expected) => {
  const writeup = RenderedWriteup.parse(
    await renderWriteup({ overview: "", tldr: "", decisions: "", topics: { first: { why: `**Undo:** ${undo}` } } }, [
      topic("first"),
    ]),
  );
  expect(factText(undoFact(writeup, [topic("first")]))).toBe(`${expected} (first)`);
});

test.each([".", "!", "?", ":"])("Undo scans past mid-sentence mentions to the first boundary after %s", (mark) => {
  const text = `We mention Undo: in passing${mark}\n\tUndo: Restore state. Undo: Rerun.`;
  expect(factText(undoFact({ sections: [section("t-first-why", text, "first")] }, [topic("first")]))).toBe(
    "Restore state. Undo: Rerun (first)",
  );
});

test("Undo handles repeated hostile markers without backtracking", () => {
  const writeup = { sections: [section("t-first-why", `${". Undo: a".repeat(80_000)}\nx`, "first")] };
  const start = performance.now();
  const parts = undoFact(writeup, [topic("first")]);
  const elapsed = performance.now() - start;
  expect(parts?.[0]?.text).toBe(`${"a. Undo: ".repeat(38).slice(0, 299)}…`);
  expect(elapsed).toBeLessThan(500);
});

test.each([
  ["x".repeat(300), "x".repeat(300)],
  ["x".repeat(301), `${"x".repeat(299)}…`],
  [`${"x".repeat(298)}🌱abc`, `${"x".repeat(298)}…`],
  [`${"x".repeat(297)}🌱abc`, `${"x".repeat(297)}🌱…`],
])("Undo caps the shown text without cutting surrogate pairs: %s", (undo, expected) => {
  const parts = undoFact({ sections: [section("t-first-why", `Undo: ${undo}`, "first")] }, [topic("first")]);
  expect(parts?.[0]).toEqual({ text: expected, agent: true });
  expect(parts?.[0]?.text.length).toBeLessThanOrEqual(300);
  expect(parts?.[0]?.text.isWellFormed()).toBe(true);
});

test("Undo ranks the full text before truncating it", () => {
  const writeup = {
    sections: [
      section("t-first-why", "Undo: Restore state.", "first"),
      section("t-last-why", `Undo: ${"x".repeat(301)} Cannot be undone.`, "last"),
    ],
  };
  expect(factText(undoFact(writeup, [topic("first"), topic("last")]))).toBe(`${"x".repeat(299)}… (last)`);
});

test.each([
  ["Cannot be undone: drops column x.", "Cannot be undone: drops column x"],
  ["Cannot be undone: drops column x", "Cannot be undone: drops column x"],
  ["Cannot be undone: drops column x..", "Cannot be undone: drops column x."],
])("Undo trims exactly one trailing period: %s", (undo, expected) => {
  const writeup = { sections: [section("t-cents-why", `Undo: ${undo}`, "cents")] };
  expect(factText(undoFact(writeup, [{ ...topic("cents"), title: "Cents migration" }]))).toBe(
    `${expected} (Cents migration)`,
  );
});

test("Read counts every writeup and Markdown doc block and only counted diff files", () => {
  const writeup = { sections: [section("tldr", "word ".repeat(400))] };
  const docs: RevisionView["docs"] = [
    { kind: "markdown", path: "design.md", blocks: [block("doc-12345678", "word\n\t".repeat(400))] },
    { kind: "html", path: "preview.html", contentUrl: "/content/preview" },
    { kind: "source", path: "source.ts", language: "text", lines: [] },
  ];
  const files: FileView[] = [
    { ...file, counts: { additions: 40, deletions: 24 } },
    { ...file, role: "doc", counts: { additions: 500, deletions: 500 } },
    file,
  ];
  expect(readFact(writeup, docs, files)).toBe(
    "About 12 min: writeup and docs 4 min, diff 8 min (64 lines); HTML docs not counted",
  );
  expect(readFact(writeup, [], [])).toBe("About 2 min: writeup 2 min");
  expect(readFact(empty, [], [files[0] as FileView])).toBe("About 8 min: diff 8 min (64 lines)");
});

test("Read omits empty content, handles under a minute and rounds hours to five minutes", () => {
  expect(readFact(empty, [], [file])).toBeUndefined();
  expect(readFact({ sections: [section("tldr", " \n ")] }, [], [])).toBeUndefined();
  expect(readFact({ sections: [section("tldr", "One word")] }, [], [])).toBe("Under 1 min");
  expect(readFact(empty, [], [{ ...file, counts: { additions: 7, deletions: 0 } }])).toBe("Under 1 min");
  expect(readFact(empty, [], [{ ...file, counts: { additions: 8, deletions: 0 } }])).toBe(
    "About 1 min: diff 1 min (8 lines)",
  );
  expect(readFact(empty, [], [{ ...file, counts: { additions: 480, deletions: 0 } }])).toBe(
    "About 1 h: diff 1 h (480 lines)",
  );
  expect(readFact(empty, [], [{ ...file, counts: { additions: 664, deletions: 0 } }])).toBe(
    "About 1 h 25 min: diff 1 h 25 min (664 lines)",
  );
});

test("Read counts source words across lines without inserting spaces between tokens", () => {
  const source: RevisionView["docs"][number] = {
    kind: "source",
    path: "source.ts",
    language: "ts",
    lines: Array.from({ length: 200 }, () => [{ text: "seed" }, { text: "ling" }]),
  };
  expect(readFact({ sections: [section("tldr", "word ".repeat(200))] }, [source], [])).toBe(
    "About 2 min: writeup and docs 2 min",
  );
  expect(readFact(empty, [source], [])).toBe("About 1 min: writeup and docs 1 min");
});

test("Read notes skipped HTML docs once, including under a minute and diff-only estimates", () => {
  const docs: RevisionView["docs"] = [
    { kind: "html", path: "preview.html", contentUrl: "/content/preview" },
    { kind: "html", path: "other.html", contentUrl: "/content/other" },
  ];
  expect(readFact({ sections: [section("tldr", "word ".repeat(200))] }, docs, [])).toBe(
    "About 1 min: writeup 1 min; HTML docs not counted",
  );
  expect(readFact({ sections: [section("tldr", "Summary")] }, docs, [])).toBe("Under 1 min; HTML docs not counted");
  expect(readFact(empty, docs, [{ ...file, counts: { additions: 8, deletions: 0 } }])).toBe(
    "About 1 min: diff 1 min (8 lines); HTML docs not counted",
  );
  expect(readFact(empty, docs, [])).toBeUndefined();
});

const since = {
  writeup: {
    sections: [
      section("tldr", "Summary"),
      section("whyItMatters", "Responsive"),
      section("t-retry-why", "Why", "retry"),
      section("t-retry-body", "Body", "retry"),
    ],
  },
  topics: [{ ...topic("retry"), title: "Retry budget" }],
  docs: [{ kind: "markdown" as const, path: "docs/design.md", blocks: [block("doc-12345678", "Design")] }],
  files: [] as FileView[],
  revision: 3,
  changedSince: 2,
  changedBlocks: [] as RevisionView["changedBlocks"],
};

test("Since respects the baseline and names changed sections, each topic once, docs and stale files", () => {
  for (const change of [{ revision: 1 }, { revision: 2 }, { changedSince: undefined }, { changedSince: 4 }]) {
    expect(factText(sinceFact({ ...since, ...change }))).toBeUndefined();
  }
  expect(sinceFact(since)).toBeUndefined();
  const changedBlocks = ["doc-12345678", "t-retry-body", "t-retry-why", "tldr"].map((section) => ({
    blockId: `${section}-12345678`,
    revision: 3,
  }));
  expect(factText(sinceFact({ ...since, changedBlocks }))).toBe(
    "Since revision 2: new or changed text in TL;DR, topic “Retry budget” and docs/design.md.",
  );
  changedBlocks.push({ blockId: "whyItMatters-12345678", revision: 3 });
  expect(
    factText(
      sinceFact({
        ...since,
        changedBlocks,
        files: [
          { ...file, viewed: "stale" },
          { ...file, viewed: "viewed" },
        ],
      }),
    ),
  ).toBe(
    "Since revision 2: new or changed text in TL;DR, Why it matters, topic “Retry budget” and docs/design.md; 1 file you viewed changed.",
  );
  expect(
    factText(
      sinceFact({
        ...since,
        changedBlocks: [changedBlocks[0] as RevisionView["changedBlocks"][number]],
        docs: [
          {
            ...(since.docs[0] as Extract<RevisionView["docs"][number], { kind: "markdown" }>),
            title: "<img src=x onerror=alert(1)>",
          },
        ],
      }),
    ),
  ).toBe("Since revision 2: new or changed text in docs/design.md.");
});

test("Since uses bare section labels, including Checked", () => {
  const sections = [
    section("tldr", "Summary"),
    section("checked", "Unit tests"),
    section("t-retry-why", "Why", "retry"),
  ];
  expect(
    factText(
      sinceFact({
        ...since,
        writeup: { sections },
        changedBlocks: sections.flatMap((section) =>
          section.blocks.map((block) => ({ blockId: block.id, revision: 3 })),
        ),
      }),
    ),
  ).toBe("Since revision 2: new or changed text in TL;DR, Checked and topic “Retry budget”.");
});

test("Since separates new text from stale viewed files and can show only stale files", () => {
  const files: FileView[] = [
    { ...file, viewed: "stale" },
    { ...file, path: "src/other.ts", viewed: "stale" },
    { ...file, path: "src/viewed.ts", viewed: "viewed" },
    { ...file, path: "src/unviewed.ts" },
  ];
  expect(factText(sinceFact({ ...since, files, changedBlocks: [{ blockId: "tldr-12345678", revision: 3 }] }))).toBe(
    "Since revision 2: new or changed text in TL;DR; 2 files you viewed changed.",
  );
  expect(factText(sinceFact({ ...since, files }))).toBe("Since revision 2: 2 files you viewed changed.");
});

test("Since names docs with identical titles by their isolated paths", () => {
  const docs: RevisionView["docs"] = [
    { kind: "markdown", title: "Design", path: "docs/design.md", blocks: [block("doc-12345678", "One")] },
    { kind: "markdown", title: "Design", path: "docs/other.md", blocks: [block("doc-87654321", "Two")] },
  ];
  const parts = sinceFact({
    ...since,
    docs,
    changedBlocks: ["doc-12345678-12345678", "doc-87654321-12345678"].map((blockId) => ({ blockId, revision: 3 })),
  });
  expect(factText(parts)).toBe("Since revision 2: new or changed text in docs/design.md and docs/other.md.");
  expect(parts?.filter((part) => part.agent)).toEqual([
    { text: "docs/design.md", agent: true },
    { text: "docs/other.md", agent: true },
  ]);
});

test("facts mark only agent titles and undo text for isolation", () => {
  const title = "Retry \u202ebudget";
  const topics = [{ ...topic("retry", "critical"), title }];
  expect(riskFact(topics)).toEqual([{ text: "High: " }, { text: title, agent: true }]);
  expect(undoFact({ sections: [section("t-retry-why", "Undo: Restore state.", "retry")] }, topics)).toEqual([
    { text: "Restore state", agent: true },
    { text: " (" },
    { text: title, agent: true },
    { text: ")" },
  ]);
  expect(sinceFact({ ...since, topics, changedBlocks: [{ blockId: "t-retry-why-12345678", revision: 3 }] })).toEqual([
    { text: "Since revision 2: " },
    { text: "new or changed text in " },
    { text: "topic “" },
    { text: title, agent: true },
    { text: "”" },
    { text: "." },
  ]);
});
