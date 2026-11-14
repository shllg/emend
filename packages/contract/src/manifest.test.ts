import { describe, expect, test } from "vitest";
import { GlossaryEntry, normalizeGlossaryForm, PublishManifest, WriteupInput, writeupMarkdown } from "./index.ts";

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
        outOfScope: "Excluded",
        whereToLook: "Guide",
        context: "Context",
        decisions: null,
        topics: { routing: { why: "Why", example: "Example", body: "Details" }, fallback: { why: "Fallback" } },
      }),
    ).toEqual([
      "Overview",
      "Summary",
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
