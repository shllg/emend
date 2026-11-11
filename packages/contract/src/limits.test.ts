import { describe, expect, test } from "vitest";
import {
  AgentNote,
  AgentNotes,
  BlockId,
  Capabilities,
  ErrorBody,
  FilePath,
  HandoffComment,
  PublishManifest,
  PublishResponse,
  Target,
  TopicMeta,
  WaitResult,
  WriteupInput,
} from "./index.ts";

const emptyWriteup = { overview: "", tldr: "", decisions: null, topics: {} };
const note = { side: "new", start: 1, end: 2, summary: "A decision." };
test("agent notes enforce field, file and revision ceilings", () => {
  for (const [count, accepted] of [
    [8, true],
    [9, false],
  ] as const)
    expect(AgentNotes.safeParse(Array.from({ length: count }, () => note)).success).toBe(accepted);
  for (const [count, accepted] of [
    [64, true],
    [65, false],
  ] as const) {
    const files = Array.from({ length: Math.ceil(count / 8) }, (_, i) => ({
      path: `file-${i}.ts`,
      role: "diff",
      notes: Array.from({ length: Math.min(8, count - i * 8) }, () => note),
    }));
    expect(PublishManifest.safeParse({ ...manifest, files }).success).toBe(accepted);
  }
  expect(AgentNote.safeParse({ ...note, summary: "x".repeat(160), rationale: "x".repeat(1200) }).success).toBe(true);
  for (const patch of [
    { summary: "" },
    { summary: "x".repeat(161) },
    { rationale: "x".repeat(1201) },
    { summary: "two\nlines" },
    { summary: "ends with newline\n" },
    { ref: "A\n" },
    { summary: "two\r lines" },
    { summary: "two\u2028lines" },
    { start: 0 },
    { start: 1.5 },
    { start: 3 },
    { ref: "AA" },
    { ref: "a" },
  ])
    expect(AgentNote.safeParse({ ...note, ...patch }).success).toBe(false);
});
const topic = { slug: "routing", title: "Routing", importance: 20, summary: "A sample router." };
const manifest = { version: 1, title: "Sample router", topics: [], files: [], writeup: emptyWriteup };
const lineTarget = {
  kind: "lines",
  path: "src/router.ts",
  side: "new",
  start: 1,
  end: 1,
  lines: [""],
  before: [],
  after: [],
};
const handoffComment = {
  id: "33333333-3333-4333-8333-333333333333",
  threadId: "44444444-4444-4444-8444-444444444444",
  target: { kind: "review" },
  placement: { status: "placed", location: { kind: "review" } },
  body: "Explain the route.",
  history: [],
};
const go = {
  kind: "go",
  reviewId: "11111111-1111-4111-8111-111111111111",
  deliveryId: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  sentOn: 1,
  mode: "fix-clear",
  modeLabel: "Fix what's clear, ask about the rest",
  instructions: [],
  approvalSetAside: false,
  comments: [],
};

describe("path ceilings and encoding", () => {
  test.each([".git/config", ".GIT/x", ".git./x", "git~1/x", ".g\u206ait/x", "a/.GiT. /x", "GIT~1. /x"])(
    "rejects repository metadata path %j",
    (path) => {
      expect(FilePath.safeParse(path).success).toBe(false);
    },
  );
  test.each([
    { length: 4096, accepted: true },
    { length: 4097, accepted: false },
  ])("accepts=$accepted for a $length-character path", ({ length, accepted }) => {
    const path = `${`${"a".repeat(254)}/`.repeat(16)}${"b".repeat(length - 4080)}`;
    expect(path).toHaveLength(length);
    expect(FilePath.safeParse(path).success).toBe(accepted);
  });

  test.each([
    { length: 255, accepted: true },
    { length: 256, accepted: false },
  ])("accepts=$accepted for a $length-character path segment", ({ length, accepted }) => {
    expect(FilePath.safeParse(`docs/${"x".repeat(length)}/plan.md`).success).toBe(accepted);
  });

  test.each(["docs/\ud800.md", "docs/\udc00.md"])("rejects a malformed UTF-16 path %j", (path) => {
    expect(FilePath.safeParse(path).success).toBe(false);
    expect(PublishManifest.safeParse({ ...manifest, files: [{ path, role: "doc" }] }).success).toBe(false);
  });

  test("preserves valid surrogate pairs and replacement characters as distinct paths", () => {
    expect(FilePath.parse("docs/\ud83d\ude80.md")).toBe("docs/\ud83d\ude80.md");
    expect(FilePath.parse("docs/\ufffd.md")).toBe("docs/\ufffd.md");
  });

  test.each([
    { length: 4096, accepted: true },
    { length: 4097, accepted: false },
  ])("accepts=$accepted for a $length-character doc source", ({ length, accepted }) => {
    expect(
      PublishManifest.safeParse({ ...manifest, files: [{ path: "plan.md", role: "doc", source: "x".repeat(length) }] })
        .success,
    ).toBe(accepted);
  });

  test.each(["drafts/plan.md", "../plans/plan.md", "/approved-docs/plan.md"])(
    "leaves realpath containment of %s to the CLI",
    (source) => {
      const parsed = PublishManifest.parse({ ...manifest, files: [{ path: "plan.md", role: "doc", source }] });
      expect(parsed.files[0]?.source).toBe(source);
    },
  );

  test.each(["a\u0000b", "a\u0001b", "a\nb", "a\u001fb", "a\u007fb", "a\ud800b", "a\udc00b"])(
    "rejects control characters and malformed UTF-16 in source %j",
    (source) => {
      expect(
        PublishManifest.safeParse({ ...manifest, files: [{ path: "plan.md", role: "doc", source }] }).success,
      ).toBe(false);
    },
  );
});

describe("topic ceilings", () => {
  test.each([
    { count: 200, accepted: true },
    { count: 201, accepted: false },
  ])("accepts=$accepted for $count declared topics", ({ count, accepted }) => {
    const topics = Array.from({ length: count }, (_, index) => ({ ...topic, slug: `topic-${index}` }));
    expect(PublishManifest.safeParse({ ...manifest, topics }).success).toBe(accepted);
  });

  test.each([
    { count: 200, accepted: true },
    { count: 201, accepted: false },
  ])("accepts=$accepted for $count writeup topic keys", ({ count, accepted }) => {
    const topics = Object.fromEntries(Array.from({ length: count }, (_, index) => [`topic-${index}`, { why: "" }]));
    expect(WriteupInput.safeParse({ ...emptyWriteup, topics }).success).toBe(accepted);
  });

  test.each([
    { field: "summary", length: 2000, accepted: true },
    { field: "summary", length: 2001, accepted: false },
    { field: "scope", length: 32, accepted: true },
    { field: "scope", length: 33, accepted: false },
    { field: "note", length: 2000, accepted: true },
    { field: "note", length: 2001, accepted: false },
  ])("accepts=$accepted for $length characters in $field", ({ field, length, accepted }) => {
    const input =
      field === "summary"
        ? { ...topic, summary: "x".repeat(length) }
        : { ...topic, blastRadius: { scope: "module", note: "A note.", [field]: "x".repeat(length) } };
    expect(TopicMeta.safeParse(input).success).toBe(accepted);
  });

  test("uses a null-prototype writeup topic dictionary, including nested manifest parsing", () => {
    for (const writeup of [WriteupInput.parse(emptyWriteup), PublishManifest.parse(manifest).writeup]) {
      expect(Object.getPrototypeOf(writeup.topics)).toBeNull();
      expect(writeup.topics.constructor).toBeUndefined();
      expect(writeup.topics.toString).toBeUndefined();
    }
    const topics = { constructor: { why: "An explicitly declared topic.", unknown: "stripped" } };
    const parsed = WriteupInput.parse({ ...emptyWriteup, topics });
    expect(Object.getPrototypeOf(parsed.topics)).toBeNull();
    expect(parsed.topics.constructor).toEqual({ why: "An explicitly declared topic." });
    expect(JSON.stringify(parsed.topics)).toBe('{"constructor":{"why":"An explicitly declared topic."}}');
  });
});

describe("UTF-8 writeup budgets", () => {
  test.each([
    "overview",
    "tldr",
    "outOfScope",
    "whereToLook",
    "context",
    "decisions",
    "glossary",
    "why",
    "example",
    "body",
  ])("bounds %s by bytes, preserving text at the limit", (field) => {
    const text = "é".repeat(524288);
    expect(new TextEncoder().encode(text).byteLength).toBe(1048576);
    const input = (value: string) =>
      ["why", "example", "body"].includes(field)
        ? { ...emptyWriteup, topics: { routing: { why: "", [field]: value } } }
        : { ...emptyWriteup, [field]: value };
    const parsed = WriteupInput.parse(input(text));
    expect(parsed).toEqual(input(text));
    // A two-byte character repeated to the limit, plus one ASCII byte, is exactly one byte over.
    const tooLarge = `${text}x`;
    expect(new TextEncoder().encode(tooLarge).byteLength).toBe(1048577);
    expect(WriteupInput.safeParse(input(tooLarge)).success).toBe(false);
  });

  test("accepts exactly the total byte budget across every section and refuses one extra byte", () => {
    const section = "é".repeat(131072);
    const writeup = {
      overview: section,
      tldr: section,
      decisions: section,
      glossary: section,
      topics: {
        routing: { why: section, example: section, body: section },
        fallback: { why: section },
      },
    };
    expect(new TextEncoder().encode(section).byteLength * 8).toBe(2097152);
    expect(WriteupInput.parse(writeup)).toEqual(writeup);
    for (const field of ["outOfScope", "whereToLook", "context"]) {
      const result = WriteupInput.safeParse({ ...writeup, [field]: "x" });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ message: "writeup exceeds the total UTF-8 byte limit" }),
        );
    }
    expect(
      WriteupInput.safeParse({ ...writeup, topics: { ...writeup.topics, fallback: { why: `${section}x` } } }).success,
    ).toBe(false);
  });
});

describe("line target budgets", () => {
  test.each([
    { count: 1000, accepted: true },
    { count: 1001, accepted: false },
  ])("accepts=$accepted for $count quoted lines", ({ count, accepted }) => {
    expect(
      Target.safeParse({ ...lineTarget, end: count, lines: Array.from({ length: count }, () => "") }).success,
    ).toBe(accepted);
  });

  test.each([
    { length: 65536, accepted: true },
    { length: 65537, accepted: false },
  ])("accepts=$accepted for one quoted line of $length characters", ({ length, accepted }) => {
    const input = { ...lineTarget, lines: ["x".repeat(length)] };
    const parsed = Target.safeParse(input);
    expect(parsed.success).toBe(accepted);
    if (parsed.success) expect(parsed.data).toEqual(input);
    else expect(parsed.error.issues.some((issue) => issue.path.join(".") === "lines")).toBe(true);
  });

  test.each(["before", "after"])("limits each %s context line independently", (side) => {
    expect(Target.safeParse({ ...lineTarget, [side]: ["x".repeat(2000)] }).success).toBe(true);
    expect(Target.safeParse({ ...lineTarget, [side]: ["x".repeat(2001)] }).success).toBe(false);
  });

  test("counts all quoted lines and both context arrays in the shared budget without truncating", () => {
    const input = {
      ...lineTarget,
      end: 2,
      lines: ["x".repeat(32768), "y".repeat(28768)],
      before: ["b".repeat(2000)],
      after: ["a".repeat(2000)],
    };
    expect(Target.parse(input)).toEqual(input);
    const result = Target.safeParse({ ...input, after: [...input.after, "x"] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path.join(".") === "lines")).toBe(true);
  });
});

describe("handoff budgets", () => {
  test.each([
    { count: 500, accepted: true },
    { count: 501, accepted: false },
  ])("accepts=$accepted for $count history entries", ({ count, accepted }) => {
    const history = Array.from({ length: count }, () => ({ author: "user", body: "Explain this." }));
    expect(HandoffComment.safeParse({ ...handoffComment, history }).success).toBe(accepted);
  });

  test.each([
    { count: 5000, accepted: true },
    { count: 5001, accepted: false },
  ])("accepts=$accepted for $count handoff comments", ({ count, accepted }) => {
    expect(WaitResult.safeParse({ ...go, comments: Array.from({ length: count }, () => handoffComment) }).success).toBe(
      accepted,
    );
  });

  test.each([
    { count: 100, accepted: true },
    { count: 101, accepted: false },
  ])("accepts=$accepted for $count handoff instructions", ({ count, accepted }) => {
    expect(
      WaitResult.safeParse({ ...go, instructions: Array.from({ length: count }, () => "Explain this.") }).success,
    ).toBe(accepted);
  });
});

describe("response text budgets", () => {
  test("publish defaults an omitted unrendered list", () => {
    expect(
      PublishResponse.parse({
        reviewId: go.reviewId,
        revision: 1,
        url: "http://127.0.0.1:3636/r/synthetic",
        placed: 0,
        unplaced: 0,
      }).unrendered,
    ).toEqual([]);
  });
  test.each([
    { field: "version", size: 64, accepted: true },
    { field: "version", size: 65, accepted: false },
    { field: "feature", size: 64, accepted: true },
    { field: "feature", size: 65, accepted: false },
    { field: "features", size: 64, accepted: true },
    { field: "features", size: 65, accepted: false },
  ])("accepts=$accepted for $field size $size", ({ field, size, accepted }) => {
    const input = {
      api: 1,
      version: field === "version" ? "v".repeat(size) : "0.1.0",
      features:
        field === "features"
          ? Array.from({ length: size }, () => "feature")
          : [field === "feature" ? "f".repeat(size) : "attach"],
    };
    expect(Capabilities.safeParse(input).success).toBe(accepted);
  });

  test.each([
    { length: 1000, accepted: true },
    { length: 1001, accepted: false },
  ])("accepts=$accepted for a $length-character error message", ({ length, accepted }) => {
    expect(ErrorBody.safeParse({ error: { code: "invalid_request", message: "x".repeat(length) } }).success).toBe(
      accepted,
    );
  });

  test.each([
    { length: 4096, accepted: true },
    { length: 4097, accepted: false },
  ])("bounds remaining URL and block-id strings at $length characters (accepts=$accepted)", ({ length, accepted }) => {
    const prefix = "http://127.0.0.1:3636/";
    const url = prefix + "a".repeat(length - prefix.length);
    expect(
      PublishResponse.safeParse({ reviewId: go.reviewId, revision: 1, url, placed: 0, unplaced: 0, unrendered: [] })
        .success,
    ).toBe(accepted);
    const blockPrefix = "overview-1234abcd-";
    expect(BlockId.safeParse(blockPrefix + "2".repeat(length - blockPrefix.length)).success).toBe(accepted);
  });
});
