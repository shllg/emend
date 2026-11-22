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
const unassignedVerdictIssue = {
  code: "custom",
  path: ["writeup", "review", "level"],
  message: "level skim needs every changed file in a declared topic",
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

test.each([
  ["skim", undefined, [unassignedVerdictIssue]],
  ["skim", "skim", []],
  ["skim", "review", [unassignedVerdictIssue]],
  ["skim", "critical", [criticalVerdictIssue, unassignedVerdictIssue]],
  ["topics", "critical", [criticalVerdictIssue]],
  ["topics", undefined, []],
  ["topics", "skim", []],
  ["everything", undefined, []],
  ["everything", "critical", []],
] as const)("publish checks level %s against Other changes with attention %s", (level, attention, issues) => {
  const input = {
    ...request,
    topics: [
      { slug: "routing", title: "Routing", importance: 20, summary: "Simplify route lookup.", attention: "skim" },
      { ...OTHER_TOPIC, importance: 100, summary: "Generated changes.", ...(attention ? { attention } : {}) },
    ],
    writeup: {
      ...request.writeup,
      review: { level, ...(level === "topics" ? { topics: ["routing"] } : {}), reason: "Inspect the changes." },
    },
  };
  if (issues.length === 0) {
    expect(PublishRequest.parse(input)).toEqual(input);
  } else {
    const result = PublishRequest.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(issues.map((issue) => expect.objectContaining(issue)));
  }
});

test("a topics verdict must name Other changes at attention review", () => {
  const input = {
    ...request,
    topics: [
      { slug: "routing", title: "Routing", importance: 20, summary: "Simplify route lookup.", attention: "review" },
      { ...OTHER_TOPIC, importance: 100, summary: "Generated changes.", attention: "review" },
    ],
    writeup: { ...request.writeup, review: { level: "topics", topics: ["routing"], reason: "Check route lookup." } },
  };
  const result = PublishRequest.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues).toEqual([expect.objectContaining(topicsVerdictIssue)]);
  input.writeup.review.topics.push(OTHER_TOPIC.slug);
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

test("rendered Markdown docs list image assets, including shared writeup media", () => {
  const markdown = { ...doc, path: "docs/plan.md", assets: ["docs/a.PNG"] };
  const image = { ...doc, path: "docs/a.PNG", role: "asset", assets: undefined, parent: markdown.path };
  for (const parent of [markdown.path, undefined]) {
    expect(PublishRequest.safeParse({ ...request, files: [markdown, { ...image, parent }] }).success).toBe(true);
  }
  for (const assets of [undefined, []])
    expect(PublishRequest.safeParse({ ...request, files: [{ ...markdown, assets }] }).success).toBe(true);
  const html = { ...doc, path: "docs/plan.html", assets: [image.path] };
  expect(
    PublishRequest.safeParse({ ...request, files: [html, markdown, { ...image, parent: html.path }] }).success,
  ).toBe(true);
  expect(
    PublishRequest.safeParse({ ...request, files: [html, markdown, { ...image, parent: undefined }] }).success,
  ).toBe(false);
});

test("Markdown asset lists reject duplicates, non-images, hidden paths and missing or out-of-folder rows", () => {
  const markdown = { ...doc, path: "docs/plan.md", assets: ["docs/a.png"] };
  const image = { ...doc, path: "docs/a.png", role: "asset", assets: undefined, parent: markdown.path };
  for (const files of [
    [{ ...markdown, assets: [image.path, image.path] }, image],
    [{ ...markdown, assets: ["docs/missing.png"] }, image],
    [{ ...markdown, assets: [markdown.path] }, image],
    [{ ...markdown, view: "source" }, image],
    [markdown, { ...image, parent: "missing.md" }],
    [markdown, { ...image, parent: image.path }],
  ])
    expect(PublishRequest.safeParse({ ...request, files }).success).toBe(false);
  for (const path of [
    "elsewhere/a.png",
    "docs-extra/a.png",
    "docs/.hidden/a.png",
    "docs/.a.png",
    "docs/a.svg",
    "docs/a.ico",
    "docs/a.bmp",
    "docs/a.mp4",
    "docs/a.css",
  ]) {
    const files = [
      { ...markdown, assets: [path] },
      { ...image, path },
    ];
    expect(PublishRequest.safeParse({ ...request, files }).success, path).toBe(false);
    // Even when unlisted, a Markdown parent's assets must be visible images.
    expect(
      PublishRequest.safeParse({
        ...request,
        files: [
          { ...markdown, assets: [] },
          { ...image, path },
        ],
      }).success,
      path,
    ).toBe(false);
  }
  // An HTML parent does not allow a non-image into a Markdown doc's list.
  const html = { ...doc, path: "docs/plan.html" };
  expect(
    PublishRequest.safeParse({
      ...request,
      files: [html, { ...markdown, assets: ["docs/a.svg"] }, { ...image, path: "docs/a.svg", parent: html.path }],
    }).success,
  ).toBe(false);
});

test("Markdown doc images count as files, without spending the writeup media count", () => {
  const images = Array.from({ length: LIMITS.mediaPerRevision + 1 }, (_, i) => ({
    ...doc,
    path: `shots/${i}.png`,
    role: "asset",
    assets: undefined,
    parent: "plan.md",
  }));
  expect(
    PublishRequest.safeParse({
      ...request,
      files: [{ ...doc, path: "plan.md", assets: images.map((file) => file.path) }, ...images],
    }).success,
  ).toBe(true);
});

test("PublishRequest pairs intentReview with nonblank deviations", () => {
  const intentReview = "22222222-2222-4222-8222-222222222222";
  const paired = { ...request, intentReview, writeup: { ...request.writeup, deviations: "None." } };
  expect(PublishRequest.parse(paired)).toEqual(paired);
  for (const [input, path, message] of [
    [{ ...request, intentReview }, ["writeup", "deviations"], "deviations is required with intentReview"],
    [{ ...request, writeup: paired.writeup }, ["intentReview"], "intentReview is required with deviations"],
  ] as const) {
    const result = PublishRequest.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path, message }));
  }
  for (const deviations of ["", " \n\t", null])
    expect(PublishRequest.safeParse({ ...paired, writeup: { ...paired.writeup, deviations } }).success).toBe(false);
});

test("a publish request cannot name itself as its intent review", () => {
  const reviewId = "22222222-2222-4222-8222-222222222222";
  const result = PublishRequest.safeParse({
    ...request,
    reviewId,
    intentReview: reviewId,
    writeup: { ...request.writeup, deviations: "None." },
  });
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ path: ["intentReview"], message: "a review cannot be its own intent review" }),
    );
});
