import { type FileView, type RenderedBlock, RenderedWriteup, type RevisionView, type TopicMeta } from "@emend/contract";
import { expect, test } from "vitest";
import { renderWriteup } from "../../../../packages/core/src/render/writeup.ts";
import { type FactPart, labelledFact, sinceFact, topicsFact, undoFact, usesOpeningCard } from "./writeup-facts.ts";

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

async function renderedFactBlocks(markdown: string, key: "overview" | "whereToLook" = "whereToLook") {
  const writeup = RenderedWriteup.parse(
    await renderWriteup({ overview: "", tldr: "", decisions: "", topics: {}, [key]: markdown }, []),
  );
  return writeup.sections.find((section) => section.key === key)?.blocks ?? [];
}

test.each(["Biggest risk", "Look yourself", "Goal", "Change"] as const)(
  "label lift finds the first eligible %s block without replacing it",
  async (label) => {
    const blocks = await renderedFactBlocks(`Other text.\n\n**${label}:** First.\n\n**${label}:** Later.`);
    expect(blocks).toHaveLength(3);
    const result = labelledFact(blocks, label);
    expect(result).toEqual({ blocks: [blocks[1]], hideLabel: true });
    expect(result?.blocks[0]).toBe(blocks[1]);
  },
);

test.each([
  ["list item", "- **Biggest risk:** A.", "Biggest risk", "item", true],
  ["ordered list item", "1. **Biggest risk:** A.", "Biggest risk", "item", true],
  ["paragraph", "**Biggest risk:** A.", "Biggest risk", "paragraph", true],
  ["wrapped paragraph", "**Biggest risk:** Flooding the\nseed bed.", "Biggest risk", "paragraph", true],
  ["wrapped list item", "- **Biggest risk:** Flooding the\n  seed bed.", "Biggest risk", "item", true],
  ["wrapped Goal paragraph", "**Goal:** Protect the\nseed bed.", "Goal", "paragraph", true],
  ["wrapped Goal item", "- **Goal:** Protect the\n  seed bed.", "Goal", "item", true],
  ["hard break in a fact", "**Biggest risk:** Flooding the  \nseed bed.", "Biggest risk", "paragraph", true],
  ["raw break in a fact", "**Goal:** Protect the<br>seed bed.", "Goal", "paragraph", true],
  ["wrapped bold label", "**Biggest\nrisk:** A.", "Biggest risk", "paragraph", true],
  ["Title casing", "**Biggest Risk:** A.", "Biggest risk", "paragraph", true],
  ["lower casing", "**biggest risk:** A.", "Biggest risk", "paragraph", true],
  ["upper casing", "**BIGGEST RISK:** A.", "Biggest risk", "paragraph", true],
  ["colon outside bold", "**Goal**: A.", "Goal", "paragraph", false],
  ["inline code mentioning a label", "**Goal:** Preserve the `Change:` header.", "Goal", "paragraph", true],
  ["plain text mentioning a label", "**Goal:** Preserve the Change: header.", "Goal", "paragraph", true],
  ["lowercase change in a sentence", "**Goal:** Make one change: water the seeds.", "Goal", "paragraph", true],
  ["bold emphasis without a colon", "**Goal:** Keep the **seed bed** dry.", "Goal", "paragraph", true],
] as const)("label lift accepts %s", async (_name, markdown, label, kind, hideLabel) => {
  const blocks = await renderedFactBlocks(markdown, label === "Goal" ? "overview" : "whereToLook");
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.kind).toBe(kind);
  const result = labelledFact(blocks, label);
  expect(result).toEqual({ blocks, hideLabel });
  expect(result?.blocks[0]).toBe(blocks[0]);
});

test("label lift accepts the paragraph wrapper and surrounding whitespace of a loose list item", async () => {
  const blocks = await renderedFactBlocks("- **Goal:** A.\n\n- Another item.", "overview");
  expect(blocks).toHaveLength(2);
  expect(blocks[0]?.html).toContain("<p><strong>Goal:</strong>");
  expect(labelledFact(blocks, "Goal")).toEqual({ blocks: [blocks[0]], hideLabel: true });
});

test.each([
  ["soft", "\n", "\n", false],
  ["hard", "  \n", "\n", true],
  ["raw", "<br>", "", true],
] as const)(
  "label lift preserves a fact across a rendered %s break",
  async (_name, sourceBreak, textBreak, hasBreak) => {
    const blocks = await renderedFactBlocks(`**Goal:** A.${sourceBreak}B.`, "overview");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(`Goal: A.${textBreak}B.`);
    expect(blocks[0]?.html.includes("<br>")).toBe(hasBreak);
    expect(labelledFact(blocks, "Goal")).toEqual({ blocks, hideLabel: true });
  },
);

test.each([
  ["exact casing", "**Biggest risk:** A.\n**Look yourself:** B."],
  ["Title casing", "**Biggest Risk:** A.\n**Look Yourself:** B."],
  ["lower casing", "**biggest risk:** A.\n**look yourself:** B."],
  ["upper casing", "**BIGGEST RISK:** A.\n**LOOK YOURSELF:** B."],
  ["same line", "**Biggest risk:** A. **Look yourself:** B."],
  ["hard break", "**Biggest risk:** A.  \n**Look yourself:** B."],
  ["raw break", "**Biggest risk:** A.<br>**Look yourself:** B."],
  ["second colon outside bold", "**Biggest risk:** A. **Look yourself**: B."],
  ["unknown second bold label", "**Biggest risk:** A. **Impact:** B."],
])("label lift leaves two bold label runs together: %s", async (_name, markdown) => {
  const blocks = await renderedFactBlocks(markdown);
  expect(blocks).toHaveLength(1);
  expect(labelledFact(blocks, "Biggest risk")).toBeUndefined();
  expect(labelledFact(blocks, "Look yourself")).toBeUndefined();
});

test.each(["Biggest risk", "Look yourself", "Check first", "Goal", "Change"])(
  "label lift refuses a plain second label at the start of a later line: %s",
  async (label) => {
    for (const later of [label, label.toLowerCase(), label.toUpperCase()]) {
      const blocks = await renderedFactBlocks(`**Biggest risk:** A.\n${later}: B.`);
      expect(blocks).toHaveLength(1);
      expect(labelledFact(blocks, "Biggest risk")).toBeUndefined();
    }
  },
);

test.each(["Look yourself", "look yourself"])(
  "label lift refuses a plain second label after a raw break: %s",
  async (label) => {
    const blocks = await renderedFactBlocks(`**Biggest risk:** A.<br>${label}: B.`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(`Biggest risk: A.${label}: B.`);
    expect(labelledFact(blocks, "Biggest risk")).toBeUndefined();
  },
);

test.each([
  ["nested sub-list", "- **Biggest risk:** A.\n  - B.", "item"],
  ["second paragraph in an item", "- **Biggest risk:** A.\n\n  B.", "item"],
  ["fenced code", "```text\nBiggest risk: A.\n```", "code"],
  ["quote", "> **Biggest risk:** A.", "quote"],
  ["nested code", "- **Biggest risk:** A.\n\n  ```text\n  B.\n  ```", "item"],
  ["nested quote", "- **Biggest risk:** A.\n  > B.", "item"],
  ["nested table", "- **Biggest risk:** A.<table><tr><td>B.</td></tr></table>", "item"],
  ["nested details", "- **Biggest risk:** A.<details><summary>B.</summary>C.</details>", "item"],
  ["plain label", "Biggest risk: A.", "paragraph"],
  ["plain item label", "- Biggest risk: A.", "item"],
  ["old Check first label", "**Check first:** A.", "paragraph"],
  ["text before bold label", "Read **Biggest risk:** A.", "paragraph"],
  ["label inside emphasis", "***Biggest risk:*** A.", "paragraph"],
  ["whitespace before the outside colon", "**Biggest risk** : A.", "paragraph"],
] as const)("label lift refuses %s", async (_name, markdown, kind) => {
  const blocks = await renderedFactBlocks(markdown);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.kind).toBe(kind);
  expect(labelledFact(blocks, "Biggest risk")).toBeUndefined();
});

test("mixed-case Goal and change lines stay together in Overview", async () => {
  const blocks = await renderedFactBlocks("**Goal:** A.\n**change:** B.", "overview");
  expect(blocks).toHaveLength(1);
  expect(labelledFact(blocks, "Goal")).toBeUndefined();
  expect(labelledFact(blocks, "Change")).toBeUndefined();
});

test("label lift leaves an empty section empty", async () => {
  expect(labelledFact(await renderedFactBlocks(""), "Biggest risk")).toBeUndefined();
});

test("Topics lists High then Medium in ranked order, caps each level and counts Low", () => {
  const topics = [
    topic("low", "skim"),
    topic("medium", "review"),
    ...["third", "first", "second", "fourth", "fifth"].map((slug) => topic(slug, "critical")),
    ...["next", "last", "extra"].map((slug) => topic(slug, "review")),
    topic("another-low", "skim"),
  ];
  expect(factText(topicsFact(topics))).toBe(
    "High: third, first, second and 2 more; Medium: medium, next, last and 1 more; and 2 Low",
  );
  expect(factText(topicsFact([topic("first", "skim"), topic("second", "skim")]))).toBe("2 Low");
  expect(factText(topicsFact([topic("medium", "review"), topic("low", "skim")]))).toBe("Medium: medium; and 1 Low");
  expect(factText(topicsFact([topic("high", "critical"), topic("medium", "review")]))).toBe(
    "High: high; Medium: medium",
  );
  expect(topicsFact([])).toBeUndefined();
  expect(topicsFact([topic("unknown")])).toBeUndefined();
  expect(topicsFact([topic("other", "skim")])).toBeUndefined();
});

test("Topics keeps hostile titles literal and isolates them after cleaning control and bidi characters", () => {
  const title = "<img src=x onerror=alert(1)>\u0000\u2069\u202eSeed";
  expect(topicsFact([{ ...topic("seed", "critical"), title }])).toEqual([
    { text: "High: " },
    { text: "<img src=x onerror=alert(1)> Seed", agent: true },
  ]);
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

test("Undo handles repeated hostile markers", () => {
  const writeup = { sections: [section("t-first-why", `${". Undo: a".repeat(80_000)}\nx`, "first")] };
  const parts = undoFact(writeup, [topic("first")]);
  expect(parts?.[0]?.text).toBe(`${"a. Undo: ".repeat(38).slice(0, 299)}…`);
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
  expect(factText(sinceFact(since))).toBe(
    "Since revision 2: no new text in the writeup or Markdown docs. Removed text is not tracked.",
  );
  expect(factText(sinceFact({ ...since, revision: 2, changedSince: 1 }))).toBe(
    "Since revision 1: no new text in the writeup or Markdown docs. Removed text is not tracked.",
  );
  const changedBlocks = ["doc-12345678", "t-retry-body", "t-retry-why", "tldr"].map((section) => ({
    blockId: `${section}-12345678`,
    revision: 3,
  }));
  expect(factText(sinceFact({ ...since, changedBlocks }))).toBe(
    "Since revision 2: TL;DR, topic “Retry budget” and docs/design.md.",
  );
  changedBlocks.push({ blockId: "whyItMatters-12345678", revision: 3 });
  expect(
    factText(
      sinceFact({
        ...since,
        changedBlocks,
        files: [
          { ...file, viewed: "stale", viewedOn: 2 },
          { ...file, viewed: "viewed" },
        ],
      }),
    ),
  ).toBe(
    "Since revision 2: TL;DR, Why it matters, topic “Retry budget” and docs/design.md; 1 file you viewed changed.",
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
  ).toBe("Since revision 2: docs/design.md.");
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
  ).toBe("Since revision 2: TL;DR, Checked and topic “Retry budget”.");
});

test("Since links the first changed block in each section and each topic once, never review or doc paths", () => {
  const checked = section("checked", "Unchanged first check.");
  const changed = { ...block("checked", "Changed second check."), id: "checked-87654321" };
  checked.blocks.push(changed, { ...block("checked", "Later check."), id: "checked-11111111" });
  const verdict = section("review", "Read everything.");
  const parts = sinceFact({
    ...since,
    writeup: { sections: [...since.writeup.sections, checked, verdict] },
    changedBlocks: [
      "checked-11111111",
      changed.id,
      "review-12345678",
      "t-retry-body-12345678",
      "t-retry-why-12345678",
      "doc-12345678-12345678",
    ].map((blockId) => ({ blockId, revision: 3 })),
  });
  expect(factText(parts)).toBe("Since revision 2: topic “Retry budget”, Checked and docs/design.md.");
  expect(parts?.filter((part) => part.target)).toEqual([
    { text: "Retry budget", agent: true, target: "block-t-retry-why-12345678" },
    { text: "Checked", target: `block-${changed.id}` },
  ]);
  expect(parts?.find((part) => part.text === "docs/design.md")).toEqual({ text: "docs/design.md", agent: true });
  expect(
    factText(
      sinceFact({
        ...since,
        writeup: { sections: [verdict] },
        changedBlocks: [{ blockId: verdict.blocks[0]?.id ?? "", revision: 3 }],
      }),
    ),
  ).toBe("Since revision 2: no new text in the writeup or Markdown docs. Removed text is not tracked.");
});

test.each([true, false])("Since links a body-only topic change even without metadata (metadata=%s)", (metadata) => {
  const body = section("t-retry-body", "Unchanged details.", "retry");
  const firstChanged = { ...block(body.key, "Changed details."), id: "t-retry-body-87654321" };
  const lastChanged = { ...block(body.key, "Later changed details."), id: "t-retry-body-11111111" };
  body.blocks.push(firstChanged, lastChanged);
  const parts = sinceFact({
    ...since,
    topics: metadata ? since.topics : [],
    writeup: { sections: [section("t-retry-why", "Unchanged reason.", "retry"), body] },
    changedBlocks: [lastChanged, firstChanged].map((block) => ({ blockId: block.id, revision: 3 })),
  });
  expect(factText(parts)).toBe(`Since revision 2: topic “${metadata ? "Retry budget" : "retry"}”.`);
  expect(parts?.filter((part) => part.target)).toEqual([
    { text: metadata ? "Retry budget" : "retry", agent: true, target: `block-${firstChanged.id}` },
  ]);
});

test("Since separates new text from stale viewed files and can show only stale files", () => {
  const files: FileView[] = [
    { ...file, viewed: "stale", viewedOn: 2 },
    { ...file, path: "src/other.ts", viewed: "stale", viewedOn: 2 },
    { ...file, path: "src/viewed.ts", viewed: "viewed", viewedOn: 2 },
    { ...file, path: "src/unviewed.ts" },
  ];
  expect(factText(sinceFact({ ...since, files, changedBlocks: [{ blockId: "tldr-12345678", revision: 3 }] }))).toBe(
    "Since revision 2: TL;DR; 2 files you viewed changed.",
  );
  expect(factText(sinceFact({ ...since, files }))).toBe("Since revision 2: 2 files you viewed changed.");
});

test("Since stops counting a revision-1 Viewed mark after a Send on revision 2", () => {
  const files: FileView[] = [{ ...file, viewed: "stale", viewedOn: 1 }];
  expect(factText(sinceFact({ ...since, revision: 2, changedSince: 1, files }))).toBe(
    "Since revision 1: 1 file you viewed changed.",
  );
  expect(factText(sinceFact({ ...since, files, changedBlocks: [{ blockId: "tldr-12345678", revision: 3 }] }))).toBe(
    "Since revision 2: TL;DR.",
  );
});

test.each([
  [undefined, false],
  [1, false],
  [2, true],
  [3, true],
] as const)("Since counts a stale file viewed on %s only at or after the baseline", (viewedOn, counted) => {
  expect(factText(sinceFact({ ...since, revision: 4, files: [{ ...file, viewed: "stale", viewedOn }] }))).toBe(
    counted
      ? "Since revision 2: 1 file you viewed changed."
      : "Since revision 2: no new text in the writeup or Markdown docs. Removed text is not tracked.",
  );
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
  expect(factText(parts)).toBe("Since revision 2: docs/design.md and docs/other.md.");
  expect(parts?.filter((part) => part.agent)).toEqual([
    { text: "docs/design.md", agent: true },
    { text: "docs/other.md", agent: true },
  ]);
});

test.each([
  ["PDI followed by RLO", "\u2069\u202e"],
  ["all bidi controls", "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"],
])("agent fact parts strip %s while preserving isolated text", (_label, controls) => {
  const title = `Docs${controls}`;
  const topics = [{ ...topic("retry", "critical"), title }];
  expect(topicsFact(topics)).toEqual([{ text: "High: " }, { text: "Docs", agent: true }]);
  expect(undoFact({ sections: [section("t-retry-why", `Undo: Restore state${controls}`, "retry")] }, topics)).toEqual([
    { text: "Restore state", agent: true },
    { text: " (" },
    { text: "Docs", agent: true },
    { text: ")" },
  ]);
  expect(
    sinceFact({
      ...since,
      topics,
      docs: [{ kind: "markdown", path: `docs/${controls}design.md`, blocks: [block("doc-12345678", "Design")] }],
      changedBlocks: ["t-retry-why-12345678", "doc-12345678-12345678"].map((blockId) => ({ blockId, revision: 3 })),
    }),
  ).toEqual([
    { text: "Since revision 2: " },
    { text: "topic “" },
    { text: "Docs", agent: true, target: "block-t-retry-why-12345678" },
    { text: "”" },
    { text: " and " },
    { text: "docs/design.md", agent: true },
    { text: "." },
  ]);
});

test.each(["\u2029", "\u0085", "\u001c", "\u001d", "\u001e", "\u2028", "\n", "\t", "\u0000"])(
  "agent fact parts replace separator or control %j before stripping bidi controls",
  (separator) => {
    const topics = [{ ...topic("retry", "critical"), title: `Retry${separator}\u2069\u202e12` }];
    expect(topicsFact(topics)).toEqual([{ text: "High: " }, { text: "Retry 12", agent: true }]);
    expect(undoFact(empty, [{ ...(topics[0] as TopicMeta), door: "one-way" }])).toEqual([
      { text: "A revert is not enough" },
      { text: " (" },
      { text: "Retry 12", agent: true },
      { text: ")" },
    ]);
    expect(
      factText(sinceFact({ ...since, topics, changedBlocks: [{ blockId: "t-retry-why-12345678", revision: 3 }] })),
    ).toBe("Since revision 2: topic “Retry 12”.");
  },
);

test.each([
  [false, false, undefined],
  [true, false, "Since revision 2: docs/design.md."],
  [false, true, "Since revision 2: 1 file you viewed changed."],
  [true, true, "Since revision 2: docs/design.md; 1 file you viewed changed."],
] as const)(
  "Since can omit writeup changes while keeping docs=%s and files=%s",
  (docChanged, fileChanged, expected) => {
    const input = {
      ...since,
      omitWriteup: true,
      changedBlocks: ["tldr-12345678", "t-retry-why-12345678", ...(docChanged ? ["doc-12345678-12345678"] : [])].map(
        (blockId) => ({ blockId, revision: 3 }),
      ),
      files: [{ ...file, viewed: "stale" as const, viewedOn: fileChanged ? 2 : 1 }],
    };
    expect(factText(sinceFact(input))).toBe(expected);
    for (const baseline of [{ revision: 1 }, { revision: 2 }, { changedSince: undefined }])
      expect(sinceFact({ ...input, ...baseline })).toBeUndefined();
  },
);
