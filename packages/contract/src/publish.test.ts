import { expect, test } from "vitest";
import { LIMITS, OTHER_TOPIC, PublishRequest } from "./index.ts";

const request = {
  reviewKey: "a".repeat(64),
  repo: null,
  branch: null,
  title: "Synthetic review",
  base: null,
  head: null,
  topics: [],
  writeup: { overview: "Overview", tldr: "Summary", decisions: null, topics: {} },
  files: [],
};
const doc = {
  path: "plan.html",
  oldPath: null,
  role: "doc",
  assets: [],
  oldBlob: null,
  newBlob: "b".repeat(64),
  flag: null,
};
test.each([undefined, "writeup", "plan.html"])("publish request retains main %s", (main) => {
  expect(PublishRequest.parse({ ...request, files: [doc], main }).main).toBe(main);
});
test.each(["diff", "missing.md", "style.css"])("publish request refuses non-doc main %s", (main) => {
  const result = PublishRequest.safeParse({ ...request, files: [doc], main });
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ path: ["main"], message: "main is not a doc of this revision" }),
    );
});
test("publish accepts resolved docs and assets and rejects undeclared references", () => {
  expect(PublishRequest.parse(request)).toMatchObject(request);
  const asset = { ...doc, path: "style.css", role: "asset", assets: undefined, parent: "plan.html" };
  expect(PublishRequest.safeParse({ ...request, files: [doc, asset] }).success).toBe(true);
  for (const files of [[asset], [doc, doc], [{ ...doc, topic: "missing" }], [{ ...asset, parent: "missing.html" }]]) {
    expect(PublishRequest.safeParse({ ...request, files }).success).toBe(false);
  }
});
test("publish accepts a verdict naming a declared topic", () => {
  const input = {
    ...request,
    topics: [{ slug: "routing", title: "Routing", importance: 20, summary: "Simplify route lookup." }],
    writeup: {
      ...request.writeup,
      review: { level: "topics", topics: ["routing"], reason: "Route lookup changed." },
    },
  };
  expect(PublishRequest.parse(input)).toEqual(input);
});
test("publish refuses an undeclared verdict topic", () => {
  const result = PublishRequest.safeParse({
    ...request,
    writeup: {
      ...request.writeup,
      review: { level: "topics", topics: ["missing"], reason: "Inspect the changed lookup." },
    },
  });
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ code: "custom", path: [], message: "review topic is not declared" }),
    );
});

const criticalVerdictIssue = {
  code: "custom",
  path: ["writeup", "review", "level"],
  message: "a critical topic needs level everything",
};
const skimVerdictIssue = {
  code: "custom",
  path: ["writeup", "review", "level"],
  message: "level skim needs every topic at attention skim",
};
const topicsVerdictIssue = {
  code: "custom",
  path: ["writeup", "review", "topics"],
  message: "level topics must name every topic at attention review",
};
test.each([
  ["skim", "critical", [criticalVerdictIssue, skimVerdictIssue]],
  ["topics", "critical", [criticalVerdictIssue]],
  ["skim", "review", [skimVerdictIssue]],
  ["skim", undefined, [skimVerdictIssue]],
  ["topics", "review", [topicsVerdictIssue]],
] as const)("publish refuses level %s with conflicting %s topics once per rule", (level, attention, issues) => {
  const topic = { slug: "routing", title: "Routing", importance: 20, summary: "Simplify route lookup." };
  const result = PublishRequest.safeParse({
    ...request,
    topics: [
      { ...topic, attention: level === "topics" ? "review" : "skim" },
      { ...topic, slug: "lookup", attention },
      { ...topic, slug: "labels", attention },
    ],
    writeup: {
      ...request.writeup,
      review: { level, ...(level === "topics" ? { topics: [topic.slug] } : {}), reason: "Synthetic reason." },
    },
  });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues).toEqual(issues.map((issue) => expect.objectContaining(issue)));
});

test.each([
  ["skim", "skim"],
  ["topics", "review"],
  ["everything", "critical"],
  [undefined, "critical"],
] as const)("publish accepts level %s with consistent %s topics", (level, attention) => {
  const topic = { slug: "routing", title: "Routing", importance: 20, summary: "Simplify route lookup." };
  const input = {
    ...request,
    topics: [
      { ...topic, attention },
      { ...topic, slug: "lookup", attention },
      { ...topic, slug: "labels", attention: "skim" },
    ],
    writeup: {
      ...request.writeup,
      ...(level
        ? { review: { level, ...(level === "topics" ? { topics: [topic.slug, "lookup"] } : {}), reason: "Synthetic." } }
        : {}),
    },
  };
  expect(PublishRequest.parse(input)).toEqual(input);
});

test.each([undefined, "skim", "review", "critical"] as const)(
  "publish ignores Other changes with attention %s when checking a skim verdict",
  (attention) => {
    const input = {
      ...request,
      topics: [
        { slug: "routing", title: "Routing", importance: 20, summary: "Simplify route lookup.", attention: "skim" },
        { ...OTHER_TOPIC, importance: 100, summary: "Generated changes.", ...(attention ? { attention } : {}) },
      ],
      writeup: { ...request.writeup, review: { level: "skim", reason: "Every declared topic is low risk." } },
    };
    expect(PublishRequest.parse(input)).toEqual(input);
  },
);

test("a topics verdict does not need to name Other changes at attention review", () => {
  const input = {
    ...request,
    topics: [
      { slug: "routing", title: "Routing", importance: 20, summary: "Simplify route lookup.", attention: "review" },
      { ...OTHER_TOPIC, importance: 100, summary: "Generated changes.", attention: "review" },
    ],
    writeup: { ...request.writeup, review: { level: "topics", topics: ["routing"], reason: "Check route lookup." } },
  };
  expect(PublishRequest.parse(input)).toEqual(input);
});

test("publish bounds identifiers, arrays, and every string", () => {
  for (const patch of [
    { reviewKey: "a" },
    { branch: "x".repeat(LIMITS.pathChars + 1) },
    { repo: { key: "b".repeat(64), name: "x".repeat(LIMITS.titleChars + 1) } },
    { files: Array(LIMITS.filesPerRevision + 1).fill(doc) },
    { base: "a".repeat(40), head: null },
    { writeup: { ...request.writeup, topics: { missing: { why: "why" } } } },
  ])
    expect(PublishRequest.safeParse({ ...request, ...patch }).success).toBe(false);
});

test("assets must use the allowlist and stay in their parent's visible folder", () => {
  const parent = { ...doc, path: "docs/plan.html" };
  for (const path of [
    "elsewhere/style.css",
    "docs-extra/style.css",
    "docs/.hidden/style.css",
    "docs/.style.css",
    "docs/file.exe",
    "docs/../style.css",
  ]) {
    expect(
      PublishRequest.safeParse({
        ...request,
        files: [parent, { ...doc, role: "asset", assets: undefined, path, parent: parent.path }],
      }).success,
      path,
    ).toBe(false);
  }
  expect(
    PublishRequest.safeParse({
      ...request,
      files: [parent, { ...doc, role: "asset", assets: undefined, path: "docs/assets/style.CSS", parent: parent.path }],
    }).success,
  ).toBe(true);
});

test("diff and doc/asset namespaces each enforce path uniqueness", () => {
  const diff = { ...doc, role: "diff", assets: undefined };
  expect(PublishRequest.safeParse({ ...request, files: [doc, diff] }).success).toBe(true);
  expect(PublishRequest.safeParse({ ...request, files: [doc, diff, diff] }).success).toBe(false);
  expect(PublishRequest.safeParse({ ...request, files: [doc, doc, diff] }).success).toBe(false);
});
test("HTML asset lists require existing assets in the doc folder", () => {
  for (const assets of [undefined, ["missing.png"], ["outside/a.png"], ["docs/a.png", "docs/a.png"]]) {
    expect(
      PublishRequest.safeParse({
        ...request,
        files: [
          { ...doc, path: "docs/plan.html", assets },
          { ...doc, assets: undefined, path: "docs/a.png", role: "asset", parent: "docs/plan.html" },
        ],
      }).success,
    ).toBe(false);
  }
});
