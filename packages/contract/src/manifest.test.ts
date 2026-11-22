import { describe, expect, test } from "vitest";
import {
  GlossaryEntry,
  LIMITS,
  NeedsYouItem,
  NewInRevisionItem,
  NewInRevisionSection,
  normalizeGlossaryForm,
  PublishManifest,
  PublishRequest,
  ReviewVerdict,
  WriteupArea,
  WriteupInput,
  writeupIsEmpty,
  writeupMarkdown,
} from "./index.ts";

const topic = { slug: "routing", title: "Routing", importance: 20, summary: "Simplify route lookup." };
const manifest = {
  version: 1,
  title: "Review the sample router",
  topics: [topic],
  files: [{ path: "src/router.ts", role: "diff", topic: "routing" }],
  writeup: {
    overview: "A small router.",
    tldr: "Fewer branches.",
    decisions: null,
    topics: { routing: { why: "Clarity." } },
  },
};

describe("publish manifest", () => {
  test("preserves old writeups and optional opening fields", () => {
    expect(WriteupInput.parse(manifest.writeup)).toEqual(manifest.writeup);
    expect(PublishManifest.parse(manifest)).toEqual(manifest);
    for (const field of ["outOfScope", "whereToLook", "context"] as const) {
      for (const value of ["", "  **Synthetic context.**\n"]) {
        const writeup = { ...manifest.writeup, [field]: value };
        expect(WriteupInput.parse(writeup)).toEqual(writeup);
        expect(PublishManifest.parse({ ...manifest, writeup }).writeup).toEqual(writeup);
      }
      expect(WriteupInput.safeParse({ ...manifest.writeup, [field]: null }).success).toBe(false);
    }
  });

  test("enumerates all Markdown fields, including optional topic content", () => {
    expect(
      writeupMarkdown({
        overview: "Overview",
        tldr: "Summary",
        review: { level: "skim", reason: "A small change" },
        checked: "Unit tests",
        notChecked: "Browser behavior",
        outOfScope: "Excluded",
        whereToLook: "Guide",
        context: "Context",
        deviations: "None.",
        decisions: null,
        topics: { routing: { why: "Why", example: "Example", body: "Details" }, fallback: { why: "Fallback" } },
      }),
    ).toEqual([
      "Overview",
      "Summary",
      "Unit tests",
      "Browser behavior",
      "Excluded",
      "Guide",
      "Context",
      "None.",
      null,
      undefined,
      "Why",
      "Example",
      "Details",
      "Fallback",
      undefined,
      undefined,
      "A small change",
    ]);
  });

  test("a verdict-only writeup is empty but its reason still counts as Markdown", () => {
    const writeup: WriteupInput = {
      overview: " \n",
      tldr: "\t",
      decisions: " ",
      topics: {},
      review: { level: "skim", reason: "Synthetic reason." },
    };
    expect(writeupIsEmpty(writeup)).toBe(true);
    expect(writeupIsEmpty({ ...writeup, tldr: "Synthetic summary." })).toBe(false);
    expect(writeupMarkdown(writeup)).toContain("Synthetic reason.");
  });

  test.each(["critical", "review", "skim"])("preserves optional attention %s without changing order", (attention) => {
    const topics = [
      { ...topic, importance: 30, attention },
      { ...topic, slug: "other-topic", importance: 1 },
    ];
    expect(PublishManifest.parse({ ...manifest, topics }).topics).toEqual(topics);
    expect(PublishManifest.parse(manifest).topics[0]).not.toHaveProperty("attention");
  });

  test.each([undefined, "writeup", "docs/plan.md"])("accepts main %s", (main) => {
    expect(PublishManifest.parse({ ...manifest, main, files: [{ path: "docs/plan.md", role: "doc" }] }).main).toBe(
      main,
    );
  });

  test.each(["src/router.ts", "missing.md", "diff"])("refuses non-doc main %s", (main) => {
    const result = PublishManifest.safeParse({ ...manifest, main });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["main"], message: "main is not a doc of this revision" }),
      );
  });

  test("accepts docs-only and resolved commit or worktree ranges", () => {
    expect(
      PublishManifest.parse({ ...manifest, files: [{ path: "docs/plan.md", role: "doc", source: "drafts/plan.md" }] }),
    ).toBeDefined();
    for (const head of ["worktree", "b".repeat(40), "c".repeat(64)]) {
      expect(PublishManifest.safeParse({ ...manifest, base: "a".repeat(40), head }).success).toBe(true);
    }
  });

  test.each([{ base: "a".repeat(40) }, { head: "worktree" }])("requires base and head together: %j", (range) => {
    expect(PublishManifest.safeParse({ ...manifest, ...range }).success).toBe(false);
  });

  test.each([
    { version: 2 },
    { title: "" },
    { title: "x".repeat(201) },
    { base: "main", head: "worktree" },
    { base: `${"a".repeat(40)}\n`, head: "worktree" },
    { base: "a".repeat(40), head: "HEAD" },
    { files: [{ path: "a.ts", role: "asset" }] },
    { files: [{ path: "a.ts", role: "diff", topic: "missing" }] },
    { topics: [topic, topic] },
    { files: [manifest.files[0], manifest.files[0]] },
    { writeup: { ...manifest.writeup, topics: { missing: { why: "Unlisted." } } } },
  ])("rejects an invalid manifest: %j", (change) => {
    expect(PublishManifest.safeParse({ ...manifest, ...change }).success).toBe(false);
  });

  test.each([
    { slug: "Other Stuff" },
    { slug: "routing\n" },
    { slug: "a".repeat(65) },
    { importance: 101 },
    { importance: -1 },
    { door: "three-way" },
    { attention: "urgent" },
    { attention: null },
    { blastRadius: { scope: "two words", note: "A note." } },
    { blastRadius: { scope: "module\n", note: "A note." } },
    { blastRadius: { scope: "module", note: "  " } },
  ])("rejects invalid topic metadata: %j", (change) => {
    expect(PublishManifest.safeParse({ ...manifest, topics: [{ ...topic, ...change }] }).success).toBe(false);
  });

  test("reserves the fallback topic slug with the specified error", () => {
    const result = PublishManifest.safeParse({
      ...manifest,
      topics: [{ ...topic, slug: "other" }],
      files: [],
      writeup: { ...manifest.writeup, topics: {} },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.message)).toContain("topic slug other is reserved");
  });

  test("accepts the exact title and file-count limits and refuses one extra file", () => {
    const files = Array.from({ length: 10000 }, (_, i) => ({ path: `src/file-${i}.ts`, role: "diff" }));
    expect(PublishManifest.safeParse({ ...manifest, title: "x".repeat(200), files }).success).toBe(true);
    expect(
      PublishManifest.safeParse({ ...manifest, files: [...files, { path: "extra.ts", role: "diff" }] }).success,
    ).toBe(false);
  });

  test("strips unknown keys throughout the manifest without altering Markdown", () => {
    const parsed = PublishManifest.parse({
      ...manifest,
      owner_id: "untrusted",
      topics: [{ ...topic, extra: true }],
      files: [{ ...manifest.files[0], extra: true }],
      writeup: { ...manifest.writeup, extra: true, topics: { routing: { why: "  **Clarity.**\n", extra: true } } },
    });
    expect(parsed).not.toHaveProperty("owner_id");
    expect(parsed.topics[0]).not.toHaveProperty("extra");
    expect(parsed.files[0]).not.toHaveProperty("extra");
    expect(parsed.writeup).not.toHaveProperty("extra");
    expect(parsed.writeup.topics.routing).toEqual({ why: "  **Clarity.**\n" });
  });

  test("requires decisions to be a string or null and validates writeup topic keys", () => {
    expect(WriteupInput.safeParse({ overview: "", tldr: "", topics: {} }).success).toBe(false);
    expect(WriteupInput.safeParse({ ...manifest.writeup, topics: { "Other Stuff": { why: "" } } }).success).toBe(false);
    expect(
      WriteupInput.safeParse({
        ...manifest.writeup,
        decisions: "Keep the public interface.",
        glossary: "Router: selects a handler.",
      }).success,
    ).toBe(true);
  });
});

describe("review verdicts", () => {
  test.each([
    ["skim", "skim"],
    ["topics", "review"],
    ["everything", "critical"],
  ] as const)("accepts the %s level with consistent %s topics and check details", (level, attention) => {
    const topics = [
      { ...topic, attention },
      { ...topic, slug: "lookup", attention },
      { ...topic, slug: "labels", attention: "skim" },
    ];
    const review: ReviewVerdict = {
      level,
      ...(level === "topics" ? { topics: [topic.slug, "lookup"] } : {}),
      reason: "  **Routing** deserves a look.\n",
    };
    const writeup = { ...manifest.writeup, review, checked: "Unit tests.", notChecked: "Browser behavior." };
    expect(ReviewVerdict.parse(review)).toEqual(review);
    expect(PublishManifest.parse({ ...manifest, topics, writeup }).writeup).toEqual(writeup);
  });

  test("preserves a manifest without a verdict even when topics are critical", () => {
    const input = { ...manifest, topics: [{ ...topic, attention: "critical" }] };
    expect(PublishManifest.parse(input)).toEqual(input);
  });

  test.each([
    ["skim", "critical"],
    ["topics", "critical"],
    ["skim", "review"],
    ["skim", undefined],
    ["topics", "review"],
  ] as const)("accepts level %s with conflicting %s topics", (level, attention) => {
    const result = PublishManifest.safeParse({
      ...manifest,
      topics: [
        { ...topic, attention: level === "topics" ? "review" : "skim" },
        { ...topic, slug: "lookup", attention },
        { ...topic, slug: "labels", attention },
      ],
      writeup: {
        ...manifest.writeup,
        review: { level, ...(level === "topics" ? { topics: [topic.slug] } : {}), reason: "Synthetic reason." },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts an undeclared verdict topic", () => {
    const input = {
      ...manifest,
      writeup: {
        ...manifest.writeup,
        review: { level: "topics", topics: ["missing"], reason: "Synthetic reason." },
      },
    };
    expect(PublishManifest.parse(input)).toEqual(input);
  });

  test.each([
    [{ level: "topics" }, ["topics"], "the topics level names one or more topics"],
    [{ level: "skim", topics: [topic.slug] }, ["topics"], "only the topics level names topics"],
    [{ level: "everything", topics: [topic.slug] }, ["topics"], "only the topics level names topics"],
    [{ level: "topics", topics: [topic.slug, topic.slug] }, ["topics", 1], "duplicate topic slug"],
  ] as const)("refuses invalid review topics: %j", (review, path, message) => {
    const result = PublishManifest.safeParse({
      ...manifest,
      writeup: { ...manifest.writeup, review: { ...review, reason: "Synthetic reason." } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ code: "custom", path: ["writeup", "review", ...path], message }),
      );
    }
  });

  test.each(["checked", "notChecked", "reason"] as const)("refuses blank %s", (field) => {
    for (const value of ["", " \n\t "]) {
      const change = field === "reason" ? { review: { level: "skim", reason: value } } : { [field]: value };
      const result = PublishManifest.safeParse({ ...manifest, writeup: { ...manifest.writeup, ...change } });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ["writeup", ...(field === "reason" ? ["review", "reason"] : [field])],
            message: "must not be blank",
          }),
        );
      }
    }
  });

  test.each([
    { level: "unknown" },
    { level: "topics", topics: [] },
    { level: "topics", topics: ["Invalid slug"] },
    { level: "topics", topics: Array.from({ length: LIMITS.topicsPerReview + 1 }, (_, index) => `topic-${index}`) },
  ])("refuses an invalid review: %j", (review) => {
    expect(
      PublishManifest.safeParse({
        ...manifest,
        writeup: { ...manifest.writeup, review: { ...review, reason: "Synthetic reason." } },
      }).success,
    ).toBe(false);
  });

  test.each(["checked", "notChecked", "reason"] as const)("counts %s toward both Markdown byte limits", (field) => {
    const change = (text: string) =>
      field === "reason" ? { review: { level: "skim", reason: text } } : { [field]: text };
    expect(
      WriteupInput.safeParse({ ...manifest.writeup, ...change("é".repeat(LIMITS.writeupSectionBytes / 2 + 1)) })
        .success,
    ).toBe(false);
    const full = "x".repeat(LIMITS.writeupSectionBytes);
    const writeup = {
      overview: full,
      tldr: "x".repeat(LIMITS.writeupBytes - LIMITS.writeupSectionBytes),
      decisions: "",
      topics: {},
    };
    expect(WriteupInput.safeParse(writeup).success).toBe(true);
    expect(WriteupInput.safeParse({ ...writeup, ...change("x") }).success).toBe(false);
  });
});

describe("glossary lists", () => {
  test.each([
    ["  Cafe\u0301 \u00a0 budget  ", "Café budget"],
    [" \u0344 ", "\u0308\u0301"],
    ["  API  ", "API"],
  ])("exports canonical glossary form normalization: %j", (source, expected) => {
    expect(normalizeGlossaryForm(source)).toBe(expected);
  });

  test.each(["term", "alias"])("bounds the %s after NFC normalization expands its characters", (field) => {
    for (const [count, accepted] of [
      [33, true],
      [34, false],
    ] as const) {
      const form = "\ufb2c".repeat(count);
      const entry = {
        term: field === "term" ? form : "Budget",
        definition: "Attempts allowed.",
        ...(field === "alias" ? { aliases: [form] } : {}),
      };
      const result = GlossaryEntry.safeParse(entry);
      expect(form).toHaveLength(count);
      expect(form.normalize("NFC")).toHaveLength(count * 3);
      expect(result.success).toBe(accepted);
      expect(WriteupInput.safeParse({ ...manifest.writeup, glossary: [entry] }).success).toBe(accepted);
      if (!result.success)
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: field === "term" ? ["term"] : ["aliases", 0],
            message: "glossary term exceeds the character limit after normalization",
          }),
        );
    }
  });

  test("accepts lists and legacy Markdown and enumerates each list string", () => {
    const glossary = [{ term: "Budget", definition: "Attempts allowed.", aliases: ["Allowance"] }];
    for (const value of [glossary, [], "- **Budget:** Attempts allowed."])
      expect(WriteupInput.parse({ ...manifest.writeup, glossary: value }).glossary).toEqual(value);
    expect(writeupMarkdown({ ...manifest.writeup, glossary })).toContain("Budget");
    expect(writeupMarkdown({ ...manifest.writeup, glossary })).toContain("Attempts allowed.");
    expect(writeupMarkdown({ ...manifest.writeup, glossary })).toContain("Allowance");
  });

  test.each([
    { term: "" },
    { term: "  " },
    { term: "two\nlines" },
    { term: "two\u2028lines" },
    { term: "two\u2029lines" },
    { term: "\ud800" },
    { aliases: ["\udc00"] },
    { aliases: ["bad\u0001alias"] },
    { aliases: ["bad\u007falias"] },
    { aliases: ["bad\u009falias"] },
    { aliases: [" "] },
    { definition: "" },
    { definition: " \n " },
  ])("refuses invalid entry %j", (patch) => {
    expect(
      WriteupInput.safeParse({ ...manifest.writeup, glossary: [{ term: "Budget", definition: "Attempts.", ...patch }] })
        .success,
    ).toBe(false);
  });

  test.each([
    [
      { term: "Budget", definition: "One." },
      { term: "budget", definition: "Two." },
    ],
    [
      { term: "Budget", definition: "One.", aliases: ["Allowance"] },
      { term: "ALLOWANCE", definition: "Two." },
    ],
    [
      { term: "Café budget", definition: "One." },
      { term: "Other", definition: "Two.", aliases: ["  CAFE\u0301   BUDGET "] },
    ],
    [{ term: "Budget", definition: "One.", aliases: ["BUDGET"] }],
  ])("refuses duplicate forms with an entry path: %j", (...glossary) => {
    const result = WriteupInput.safeParse({ ...manifest.writeup, glossary });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((issue) => issue.message === "duplicate glossary term");
      expect(issue?.path).toEqual(
        glossary.length === 1
          ? ["glossary", 0, "aliases", 0]
          : glossary[1] && "aliases" in glossary[1]
            ? ["glossary", 1, "aliases", 0]
            : ["glossary", 1, "term"],
      );
    }
  });
});

describe("writeup opening", () => {
  test.each([
    "cli › serve",
    "リクエスト › 再試行",
    "x".repeat(60),
    "  requests   › retries  ",
    "<img src=x onerror=alert(1)>",
  ])("accepts a plain-text area: %j", (area) => {
    expect(WriteupArea.parse(area)).toBe(area);
    expect(WriteupInput.parse({ ...manifest.writeup, area }).area).toBe(area);
  });
  test.each([
    "",
    "   ",
    "x".repeat(61),
    "bad\u0001area",
    "bad\u200earea",
    "two\u2028lines",
    "two\u2029lines",
    "two\nlines",
    "\ud800",
  ])("rejects an invalid area: %j", (area) => {
    expect(WriteupArea.safeParse(area).success).toBe(false);
    expect(WriteupInput.safeParse({ ...manifest.writeup, area }).success).toBe(false);
  });
  test.each(["\u115f", "\u1160", "\u3164", "\uffa0", "\u2800"])("rejects area filler %j", (filler) => {
    for (const area of [filler, `cli${filler}serve`]) {
      const result = WriteupArea.safeParse(area);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("area must be plain visible text");
      expect(WriteupInput.safeParse({ ...manifest.writeup, area }).success).toBe(false);
    }
  });
  test("whyItMatters is nonblank Markdown and spends both writeup byte budgets", () => {
    for (const whyItMatters of ["", " \n\t ", "é".repeat(LIMITS.writeupSectionBytes / 2 + 1)]) {
      expect(WriteupInput.safeParse({ ...manifest.writeup, whyItMatters }).success).toBe(false);
    }
    const full = {
      overview: "x".repeat(LIMITS.writeupSectionBytes),
      tldr: "x".repeat(LIMITS.writeupSectionBytes),
      decisions: "",
      topics: {},
    };
    expect(WriteupInput.safeParse({ ...full, area: "Requests" }).success).toBe(true);
    expect(WriteupInput.safeParse({ ...full, whyItMatters: "x" }).success).toBe(false);
    const input = { ...manifest.writeup, whyItMatters: "**Resilience.**", area: "Requests" };
    expect(WriteupInput.parse(input)).toEqual(input);
    expect(writeupMarkdown(input).slice(0, 3)).toEqual([input.overview, input.tldr, input.whyItMatters]);
    expect(writeupMarkdown(input)).not.toContain(input.area);
    expect(
      writeupMarkdown({ overview: "", tldr: "", decisions: "", topics: {}, area: "Requests" }).some((text) =>
        text?.trim(),
      ),
    ).toBe(false);
  });
});

describe("needsYou", () => {
  const items = [
    { kind: "decide", text: "Choose the **retry limit**.", topic: "routing" },
    { kind: "accept", text: "Accept the shorter wait." },
  ] as const;

  test("preserves two items and an empty list and counts item text as Markdown", () => {
    expect(
      PublishManifest.parse({ ...manifest, writeup: { ...manifest.writeup, needsYou: items } }).writeup.needsYou,
    ).toEqual(items);
    expect(WriteupInput.parse({ ...manifest.writeup, needsYou: [] }).needsYou).toEqual([]);
    const input = { overview: "", tldr: "", decisions: "", topics: {}, needsYou: [...items] };
    expect(writeupMarkdown(input).filter((text) => text?.trim())).toEqual(items.map((item) => item.text));
    const full = {
      ...input,
      overview: "x".repeat(LIMITS.writeupSectionBytes),
      tldr: "x".repeat(LIMITS.writeupSectionBytes),
    };
    expect(WriteupInput.safeParse({ ...full, needsYou: [] }).success).toBe(true);
    expect(WriteupInput.safeParse(full).success).toBe(false);
  });

  test("refuses a fifth item with the limit message", () => {
    const result = PublishManifest.safeParse({
      ...manifest,
      writeup: { ...manifest.writeup, needsYou: Array.from({ length: 5 }, () => items[0]) },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: ["writeup", "needsYou"], message: "at most 4 needsYou items" }),
    );
    expect(
      WriteupInput.safeParse({ ...manifest.writeup, needsYou: Array.from({ length: 4 }, () => items[0]) }).success,
    ).toBe(true);
  });

  test.each(["\r", "\n", "\u2028", "\u2029"])("refuses line break %j", (breakChar) => {
    const result = NeedsYouItem.safeParse({ ...items[0], text: `First${breakChar}second` });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: ["text"], message: "needsYou text must be one line" }),
    );
  });

  test.each(["", " \t ", "\ud800", "x".repeat(301)])("refuses invalid text %j", (text) => {
    expect(NeedsYouItem.safeParse({ ...items[0], text }).success).toBe(false);
  });

  test.each(["decide", "accept", "confirm-drift", "answer"])("accepts kind %s and the exact text limit", (kind) => {
    expect(NeedsYouItem.parse({ kind, text: "x".repeat(300) }).kind).toBe(kind);
  });

  test("refuses undeclared topics in both publish schemas", () => {
    const writeup = { ...manifest.writeup, needsYou: [{ ...items[0], topic: "missing" }] };
    const results = [
      PublishManifest.safeParse({ ...manifest, writeup }),
      PublishRequest.safeParse({
        reviewKey: "a".repeat(64),
        repo: null,
        branch: null,
        title: manifest.title,
        base: null,
        head: null,
        topics: manifest.topics,
        files: [],
        writeup,
      }),
    ];
    for (const result of results) {
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ["writeup", "needsYou", 0, "topic"],
          message: "needsYou topic is not declared",
        }),
      );
    }
  });
});

describe("newInRevision", () => {
  const items = [
    { text: "Raised the **retry limit**.", topic: "routing" },
    { section: "checked", text: "Checked the shorter wait." },
  ] as const;

  test("preserves two items and an empty list and counts item text as Markdown", () => {
    expect(
      PublishManifest.parse({ ...manifest, writeup: { ...manifest.writeup, newInRevision: items } }).writeup
        .newInRevision,
    ).toEqual(items);
    expect(WriteupInput.parse({ ...manifest.writeup, newInRevision: [] }).newInRevision).toEqual([]);
    const input = { overview: "", tldr: "", decisions: "", topics: {}, newInRevision: [...items] };
    expect(writeupMarkdown(input).filter((text) => text?.trim())).toEqual(items.map((item) => item.text));
    const full = {
      ...input,
      overview: "x".repeat(LIMITS.writeupSectionBytes),
      tldr: "x".repeat(LIMITS.writeupSectionBytes),
    };
    expect(WriteupInput.safeParse({ ...full, newInRevision: [] }).success).toBe(true);
    expect(WriteupInput.safeParse(full).success).toBe(false);
  });

  test("refuses a thirteenth item with the limit message", () => {
    const result = PublishManifest.safeParse({
      ...manifest,
      writeup: { ...manifest.writeup, newInRevision: Array.from({ length: 13 }, () => items[0]) },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: ["writeup", "newInRevision"], message: "at most 12 newInRevision items" }),
    );
    expect(
      WriteupInput.safeParse({ ...manifest.writeup, newInRevision: Array.from({ length: 12 }, () => items[0]) })
        .success,
    ).toBe(true);
  });

  test.each(["\r", "\n", "\u2028", "\u2029"])("refuses line break %j", (breakChar) => {
    const result = NewInRevisionItem.safeParse({ ...items[0], text: `First${breakChar}second` });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: ["text"], message: "newInRevision text must be one line" }),
    );
  });

  test.each(["", " \t ", "\ud800", "x".repeat(301)])("refuses invalid text %j", (text) => {
    expect(NewInRevisionItem.safeParse({ ...items[0], text }).success).toBe(false);
  });

  test.each(NewInRevisionSection.options)("accepts section %s and the exact text limit", (section) => {
    expect(NewInRevisionItem.parse({ section, text: "x".repeat(300) }).section).toBe(section);
  });

  test("refuses both destinations at section and unknown sections", () => {
    const result = NewInRevisionItem.safeParse({ ...items[0], section: "checked" });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["section"],
        message: "a newInRevision item names a topic or a section, not both",
      }),
    );
    for (const section of ["newInRevision", "needsYou", "review", "t-routing-why", "missing"])
      expect(NewInRevisionItem.safeParse({ text: "Updated the checks.", section }).success).toBe(false);
    expect(NewInRevisionItem.parse({ text: "Updated the checks." })).toEqual({ text: "Updated the checks." });
  });

  test.each([{}, { topic: "routing" }, { section: "checked" }] as const)(
    "accepts a quote with destination %j",
    (destination) => {
      const item = { text: "Raised the retry limit.", quote: "Retry budget", ...destination };
      expect(NewInRevisionItem.parse(item)).toEqual(item);
      expect(
        PublishManifest.parse({ ...manifest, writeup: { ...manifest.writeup, newInRevision: [item] } }).writeup
          .newInRevision,
      ).toEqual([item]);
      expect(
        NewInRevisionItem.parse({ ...item, quote: "x".repeat(LIMITS.newInRevisionQuoteChars) }).quote,
      ).toHaveLength(120);
    },
  );

  test.each([
    ["", "newInRevision quote must not be blank"],
    [" \t ", "newInRevision quote must not be blank"],
    ...["**", "_", "`", " *\t_ ` ", "\u0085*\u00a0_\ufeff`"].map((quote) => [
      quote,
      "newInRevision quote must contain text",
    ]),
    ["\ud800", "newInRevision quote must be well-formed UTF-16"],
    ...["\r", "\n", "\u2028", "\u2029"].map((lineBreak) => [
      `First${lineBreak}second`,
      "newInRevision quote must be one line",
    ]),
  ])("refuses invalid quote %j", (quote, message) => {
    const result = NewInRevisionItem.safeParse({ ...items[0], quote });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(expect.objectContaining({ path: ["quote"], message }));
  });

  test.each(["max_count", "**Fix:** the loop", "`max_count`"])("accepts quote text with marks %j", (quote) => {
    expect(NewInRevisionItem.parse({ ...items[0], quote }).quote).toBe(quote);
  });

  test("bounds quotes and preserves topic/section exclusivity with a quote", () => {
    expect(NewInRevisionItem.safeParse({ ...items[0], quote: "x".repeat(121) }).success).toBe(false);
    const result = NewInRevisionItem.safeParse({ ...items[0], section: "checked", quote: "Retry budget" });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["section"],
        message: "a newInRevision item names a topic or a section, not both",
      }),
    );
  });

  test("refuses undeclared topics in both publish schemas", () => {
    const writeup = { ...manifest.writeup, newInRevision: [{ ...items[0], topic: "missing" }] };
    const results = [
      PublishManifest.safeParse({ ...manifest, writeup }),
      PublishRequest.safeParse({
        reviewKey: "a".repeat(64),
        repo: null,
        branch: null,
        title: manifest.title,
        base: null,
        head: null,
        topics: manifest.topics,
        files: [],
        writeup,
      }),
    ];
    for (const result of results) {
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ["writeup", "newInRevision", 0, "topic"],
          message: "newInRevision topic is not declared",
        }),
      );
    }
  });
});

test("PublishManifest pairs intentReview with nonblank deviations", () => {
  const intentReview = "22222222-2222-4222-8222-222222222222";
  const paired = { ...manifest, intentReview, writeup: { ...manifest.writeup, deviations: "None." } };
  expect(PublishManifest.parse(paired)).toEqual(paired);
  for (const [input, path, message] of [
    [{ ...manifest, intentReview }, ["writeup", "deviations"], "deviations is required with intentReview"],
    [{ ...manifest, writeup: paired.writeup }, ["intentReview"], "intentReview is required with deviations"],
  ] as const) {
    const result = PublishManifest.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path, message }));
  }
  for (const deviations of ["", " \n\t", null])
    expect(PublishManifest.safeParse({ ...paired, writeup: { ...paired.writeup, deviations } }).success).toBe(false);
});
