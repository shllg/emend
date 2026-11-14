import { describe, expect, test } from "vitest";
import {
  GlossaryEntry,
  LIMITS,
  normalizeGlossaryForm,
  OTHER_TOPIC,
  PublishManifest,
  ReviewVerdict,
  reviewVerdictIssues,
  WriteupInput,
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
        decisions: null,
        topics: { routing: { why: "Why", example: "Example", body: "Details" }, fallback: { why: "Fallback" } },
      }),
    ).toEqual([
      "Overview",
      "Summary",
      "A small change",
      "Unit tests",
      "Browser behavior",
      "Excluded",
      "Guide",
      "Context",
      null,
      undefined,
      "Why",
      "Example",
      "Details",
      "Fallback",
      undefined,
      undefined,
    ]);
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

  test("the verdict helper refuses skim when Other changes has no attention", () => {
    expect(reviewVerdictIssues({ level: "skim", reason: "Synthetic reason." }, [{ slug: OTHER_TOPIC.slug }])).toEqual([
      {
        path: ["writeup", "review", "level"],
        message: "level skim needs every changed file in a declared topic",
      },
    ]);
  });

  test("the verdict helper reports both skim conflicts only once", () => {
    expect(
      reviewVerdictIssues({ level: "skim", reason: "Synthetic reason." }, [
        { slug: OTHER_TOPIC.slug },
        { slug: OTHER_TOPIC.slug, attention: "review" },
        { slug: "routing", attention: "review" },
        { slug: "lookup" },
      ]),
    ).toEqual([
      {
        path: ["writeup", "review", "level"],
        message: "level skim needs every changed file in a declared topic",
      },
      {
        path: ["writeup", "review", "level"],
        message: "level skim needs every topic at attention skim",
      },
    ]);
  });

  const criticalIssue = {
    code: "custom",
    path: ["writeup", "review", "level"],
    message: "a critical topic needs level everything",
  };
  const skimIssue = {
    code: "custom",
    path: ["writeup", "review", "level"],
    message: "level skim needs every topic at attention skim",
  };
  const topicsIssue = {
    code: "custom",
    path: ["writeup", "review", "topics"],
    message: "level topics must name every topic at attention review",
  };
  test.each([
    ["skim", "critical", [criticalIssue, skimIssue]],
    ["topics", "critical", [criticalIssue]],
    ["skim", "review", [skimIssue]],
    ["skim", undefined, [skimIssue]],
    ["topics", "review", [topicsIssue]],
  ] as const)("refuses level %s with conflicting %s topics once per rule", (level, attention, issues) => {
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
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(issues.map((issue) => expect.objectContaining(issue)));
  });

  test.each([
    [{ level: "topics" }, ["topics"], "the topics level names one or more topics"],
    [{ level: "skim", topics: [topic.slug] }, ["topics"], "only the topics level names topics"],
    [{ level: "everything", topics: [topic.slug] }, ["topics"], "only the topics level names topics"],
    [{ level: "topics", topics: [topic.slug, topic.slug] }, ["topics", 1], "duplicate topic slug"],
    [{ level: "topics", topics: ["missing"] }, ["topics", 0], "review topic is not declared"],
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
