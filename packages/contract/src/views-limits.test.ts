import { expect, test } from "vitest";
import {
  FileView,
  InboxItem,
  LIMITS,
  OTHER_TOPIC,
  PublishRequest,
  RenderedBlock,
  RenderedWriteup,
  ReviewView,
  RevisionView,
  ThreadView,
} from "./index.ts";

const id = "11111111-1111-4111-8111-111111111111";
const block = { id: "overview-12345678", section: "overview", kind: "paragraph", html: "", text: "" };
const section = { key: "overview", label: "Overview", topic: null, blocks: [] };
const file = {
  id,
  path: "a.ts",
  oldPath: null,
  role: "diff",
  status: "added",
  topic: null,
  order: 0,
  mediaType: "text/plain",
  flag: null,
  hasOld: false,
  hasNew: true,
};
const input = {
  reviewKey: "a".repeat(64),
  repo: null,
  branch: null,
  title: "Synthetic",
  base: null,
  head: null,
  topics: [],
  files: [],
  writeup: { overview: "", tldr: "", decisions: null, topics: {} },
};

test.each(["title", "branch"] as const)("%s has the same exact boundary as publish", (field) => {
  const limit = field === "title" ? LIMITS.titleChars : LIMITS.pathChars;
  for (const size of [limit, limit + 1]) {
    const value = "x".repeat(size);
    expect(PublishRequest.shape[field].safeParse(value).success).toBe(size === limit);
    expect(InboxItem.shape[field].safeParse(value).success).toBe(size === limit);
  }
});
test("repo is the published SHA-256 key, with the same length and vocabulary", () => {
  for (const key of ["a".repeat(64), "a".repeat(65), "example/widget"]) {
    expect(InboxItem.shape.repo.safeParse(key).success).toBe(
      PublishRequest.shape.repo.safeParse({ key, name: "Synthetic" }).success,
    );
  }
  expect(InboxItem.shape.repo.safeParse(null).success).toBe(true);
});
test("files and docs have the publish file limit", () => {
  for (const size of [LIMITS.filesPerRevision, LIMITS.filesPerRevision + 1]) {
    const files = Array.from({ length: size }, (_, i) => ({ ...file, path: `file-${i}.ts`, order: i }));
    expect(RevisionView.shape.files.safeParse(files).success).toBe(size === LIMITS.filesPerRevision);
    expect(
      RevisionView.shape.docs.safeParse(files.map(({ path }) => ({ path, kind: "markdown", blocks: [] }))).success,
    ).toBe(size === LIMITS.filesPerRevision);
    expect(
      PublishRequest.safeParse({
        ...input,
        files: files.map((file) => ({ ...file, topic: undefined, oldBlob: null, newBlob: "b".repeat(64) })),
      }).success,
    ).toBe(size === LIMITS.filesPerRevision);
  }
});
test("file order is a zero-based index into the bounded publish file array", () => {
  expect(FileView.shape.order.safeParse(LIMITS.filesPerRevision - 1).success).toBe(true);
  expect(FileView.shape.order.safeParse(LIMITS.filesPerRevision).success).toBe(false);
});
test("topics accept the full publish limit, including Other changes", () => {
  for (const size of [LIMITS.topicsPerReview, LIMITS.topicsPerReview + 1]) {
    const topics = [
      ...Array.from({ length: size }, (_, i) => ({
        slug: `topic-${i}`,
        title: "Synthetic",
        summary: "",
        importance: 50,
      })),
      { ...OTHER_TOPIC, summary: "", importance: 100 },
    ];
    expect(PublishRequest.safeParse({ ...input, topics }).success).toBe(size === LIMITS.topicsPerReview);
    expect(RevisionView.shape.topics.safeParse(topics).success).toBe(size === LIMITS.topicsPerReview);
  }
});
test("section count allows seven fixed sections and three for every writeup topic", () => {
  const sections = ["overview", "tldr", "outOfScope", "whereToLook", "context", "decisions", "glossary"].map((key) => ({
    ...section,
    key,
  }));
  for (let i = 0; i < LIMITS.topicsPerReview; i++)
    for (const suffix of ["why", "example", "body"]) sections.push({ ...section, key: `t-topic-${i}-${suffix}` });
  expect(RenderedWriteup.parse({ sections })).toEqual({ sections });
  expect(RenderedWriteup.shape.sections.safeParse([...sections, section]).success).toBe(false);
});
test("section keys and generated labels allow the longest valid topic slug and title", () => {
  const key = `t-${"a".repeat(64)}-example`;
  const tooLong = `t-${"a".repeat(65)}-example`;
  for (const schema of [RenderedBlock.shape.section, RenderedWriteup.shape.sections.element.shape.key]) {
    expect(schema.safeParse(key).success).toBe(true);
    expect(schema.safeParse(tooLong).success).toBe(false);
  }
  expect(RenderedBlock.shape.section.safeParse("doc-12345678").success).toBe(true);
  const label = `${"x".repeat(LIMITS.titleChars)} — Example`;
  expect(RenderedWriteup.shape.sections.element.shape.label.safeParse(label).success).toBe(true);
  expect(RenderedWriteup.shape.sections.element.shape.label.safeParse(`${label}x`).success).toBe(false);
});
test("writeup and doc block arrays use the renderer's block count limit", () => {
  for (const count of [LIMITS.blocksPerRevision, LIMITS.blocksPerRevision + 1]) {
    const blocks = Array.from({ length: count }, () => block);
    expect(RenderedWriteup.shape.sections.element.shape.blocks.safeParse(blocks).success).toBe(
      count === LIMITS.blocksPerRevision,
    );
    const docs = [{ path: "plan.md", kind: "markdown", blocks }];
    expect(RevisionView.shape.docs.safeParse(docs).success).toBe(count === LIMITS.blocksPerRevision);
  }
});
test("fields with no write-side cap do not acquire a truncating read cap", () => {
  expect(InboxItem.shape.origin.shape.name.safeParse("x".repeat(LIMITS.pathChars + 1)).success).toBe(true);
  expect(FileView.shape.mediaType.safeParse("x".repeat(LIMITS.pathChars + 1)).success).toBe(true);
  expect(InboxItem.shape.movedTo.safeParse(`https://hub.example/${"x".repeat(LIMITS.pathChars + 1)}`).success).toBe(
    true,
  );
  expect(
    ReviewView.shape.revisions.safeParse(
      Array.from({ length: LIMITS.filesPerRevision + 1 }, (_, i) => ({
        seq: i + 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
    ).success,
  ).toBe(true);
  const thread = {
    id,
    target: { kind: "review" },
    state: "open",
    placement: { status: "unplaced", reason: "not-placed" },
    createdOn: 1,
    comments: [],
  };
  expect(
    RevisionView.shape.threads.safeParse(Array.from({ length: LIMITS.commentsPerHandoff + 1 }, () => thread)).success,
  ).toBe(true);
  expect(
    ThreadView.shape.comments.safeParse(
      Array.from({ length: LIMITS.commentsPerHandoff + 1 }, () => ({
        id,
        author: "agent",
        body: "An answer",
        outcome: "explained",
        sent: false,
        sentOn: null,
      })),
    ).success,
  ).toBe(true);
  expect(
    RevisionView.shape.changedBlocks.safeParse(
      Array.from({ length: LIMITS.blocksPerRevision + 1 }, (_, i) => ({
        blockId: `overview-${i.toString(16).padStart(8, "0")}`,
        revision: i + 1,
      })),
    ).success,
  ).toBe(true);
});
