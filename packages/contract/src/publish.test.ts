import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { FileView, LIMITS, OTHER_TOPIC, PublishRequest } from "./index.ts";

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

test("diff image sides follow the file status and each side's extension", () => {
  const old = { blob: "b".repeat(64) };
  const next = { flag: "oversized" };
  const file = {
    path: "icons/a.PNG",
    oldPath: "icons/old.jpg",
    role: "diff",
    status: "renamed",
    oldBlob: null,
    newBlob: null,
    flag: "binary",
    image: { old, new: next },
  };
  const parse = (patch: object) => PublishRequest.safeParse({ ...request, files: [{ ...file, ...patch }] });
  expect(parse({}).data?.files[0]?.image).toEqual(file.image);
  expect(parse({ status: "added", image: { old: null, new: next } }).success).toBe(true);
  expect(parse({ status: "deleted", image: { old, new: null } }).success).toBe(true);
  for (const patch of [
    { role: "asset", oldPath: null, newBlob: old.blob, flag: null },
    { status: undefined },
    { status: "added" },
    { status: "deleted" },
    { image: { old: null, new: next } },
    { image: { old, new: null } },
    { oldPath: "icons.png/file" },
    { path: "a.woff2" },
    { image: { old: { ...old, ...next }, new: next } },
    { image: { old: {}, new: next } },
  ])
    expect(parse(patch).success, JSON.stringify(patch)).toBe(false);
});

test("file views optionally describe images on diff files", () => {
  const file = {
    id: randomUUID(),
    path: "a.png",
    oldPath: null,
    role: "diff",
    status: "added",
    topic: null,
    order: 0,
    mediaType: "text/plain",
    flag: "binary",
    hasOld: false,
    hasNew: false,
  };
  const image = { old: null, new: { mediaType: "image/png", flag: null } };
  expect(FileView.parse(file)).toEqual(file);
  expect(FileView.parse({ ...file, image }).image).toEqual(image);
  expect(FileView.safeParse({ ...file, role: "doc", image }).success).toBe(false);
});
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
test("publish accepts an undeclared verdict topic", () => {
  const input = {
    ...request,
    writeup: {
      ...request.writeup,
      review: { level: "topics", topics: ["missing"], reason: "Inspect the changed lookup." },
    },
  };
  expect(PublishRequest.parse(input)).toEqual(input);
});

test.each([
  { level: "unknown", reason: "Synthetic reason." },
  { level: "topics", reason: "Synthetic reason." },
  { level: "skim", topics: ["routing"], reason: "Synthetic reason." },
  { level: "everything", topics: ["routing"], reason: "Synthetic reason." },
  { level: "topics", topics: ["routing", "routing"], reason: "Synthetic reason." },
  { level: "skim", reason: " \n\t " },
])("publish still refuses an invalid verdict shape: %j", (review) => {
  expect(PublishRequest.safeParse({ ...request, writeup: { ...request.writeup, review } }).success).toBe(false);
});

test.each([
  ["skim", "critical"],
  ["topics", "critical"],
  ["skim", "review"],
  ["skim", undefined],
  ["topics", "review"],
] as const)("publish accepts level %s with conflicting %s topics", (level, attention) => {
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
  expect(result.success).toBe(true);
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
  ["skim", undefined],
  ["skim", "skim"],
  ["skim", "review"],
  ["skim", "critical"],
  ["topics", "critical"],
  ["topics", undefined],
  ["topics", "skim"],
  ["everything", undefined],
  ["everything", "critical"],
] as const)("publish accepts level %s with Other changes at attention %s", (level, attention) => {
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
  expect(PublishRequest.parse(input)).toEqual(input);
});

test("a topics verdict can omit Other changes at attention review", () => {
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
