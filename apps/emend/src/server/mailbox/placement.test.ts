import { randomUUID } from "node:crypto";
import type { Target } from "@emend/contract";
import { type PlaceContext, placeThread } from "@emend/core";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { files, placements, revisions, topics, writeups } from "../../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { ingest } from "../publish/ingest.ts";
import { topicQuote, topicQuoteHistory } from "../publish/topic-test-support.ts";
import { executeWork } from "../publish/work.ts";
import { computePlacements } from "./placement.ts";
import { error, mailboxFixture } from "./test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  await f.cleanup();
});
const line = (start = 1): Target => ({
  kind: "lines",
  path: "a.ts",
  side: "new",
  start,
  end: start,
  lines: ["needle"],
  before: [],
  after: [],
});

test("topic quote creation replays core placements and loads only its topic text", async () => {
  for (const [index, { title, summary }] of topicQuoteHistory.entries()) {
    const revisionId = index ? await f.revision(index + 1) : f.revisionId;
    await f.db.query((q) =>
      q.insert(topics).values([
        { ownerId: f.ownerId, revisionId, slug: topicQuote.slug, title, summary, importance: 10 },
        { ownerId: f.ownerId, revisionId, slug: "unrelated", title, summary, importance: 20 },
      ]),
    );
  }
  let index = 0;
  const ctx: PlaceContext = {
    writeup: [],
    docs: new Map(),
    files: new Map(),
    renamedFrom: new Map(),
    topics: new Set([topicQuote.slug]),
    last: null,
    topicAnchor: { part: topicQuote.part, text: "remove the cache entirely." },
  };
  f.deps.publishExecutor = async (work) => {
    if (work.kind !== "place") throw new Error("Expected placement work");
    const snapshot = topicQuoteHistory[index++];
    if (!snapshot) throw new Error("Unexpected snapshot");
    // Unrelated topics must not reach the worker, even when their text matches.
    expect(work.topics).toEqual(new Set([topicQuote.slug]));
    expect(work.topicText).toEqual(new Map([[topicQuote.slug, { title: snapshot.title, summary: snapshot.summary }]]));
    expect(work.threads[0]?.topicAnchor).toEqual(ctx.topicAnchor);
    ctx.topicText = work.topicText;
    const expected = placeThread(topicQuote, ctx);
    expect(expected).toEqual(snapshot.placement);
    const result = await executeWork(work);
    if (result.kind !== "place") throw new Error("Expected placement result");
    expect(result.placements[0]?.placement).toEqual(expected);
    if (expected.status === "placed" && expected.location.kind === "topic" && expected.location.part) {
      ctx.last = { location: expected.location };
      ctx.topicAnchor = { part: expected.location.part, text: snapshot[expected.location.part] };
    }
    return result;
  };
  const created = await f.thread("Explain the cache", topicQuote);
  expect(index).toBe(topicQuoteHistory.length);
  const rows = await f.db.read((q) =>
    q
      .select({ status: placements.status, location: placements.location, reason: placements.reason })
      .from(placements)
      .innerJoin(revisions, and(eq(revisions.ownerId, f.ownerId), eq(revisions.id, placements.revisionId)))
      .where(and(eq(placements.ownerId, f.ownerId), eq(placements.threadId, created.threadId)))
      .orderBy(revisions.seq),
  );
  expect(rows).toEqual(
    topicQuoteHistory.map(({ placement }) => ({
      status: placement.status,
      location: placement.status === "placed" ? placement.location : null,
      reason: placement.status === "unplaced" ? placement.reason : null,
    })),
  );
});

test("topic quotes store ranges, reject the wrong original part and survive publication and hand-off", async () => {
  const topic = { slug: "garden", title: "Plant a seed.", summary: "Fresh soil.", importance: 10 };
  await f.db.query((q) => q.insert(topics).values({ ownerId: f.ownerId, revisionId: f.revisionId, ...topic }));
  // Only the first creation uses the production placement worker to exercise structured clone.
  f.deps.publishExecutor = undefined;
  const target = {
    kind: "topic",
    slug: topic.slug,
    part: "title",
    quote: "seed",
    prefix: "Plant a ",
    suffix: ".",
  } as const;
  const created = await f.thread("Explain the seed", target);
  f.deps.publishExecutor = executeWork;
  const placement = (revisionId: string) =>
    f.db.read((q) =>
      q
        .select()
        .from(placements)
        .where(
          and(
            eq(placements.ownerId, f.ownerId),
            eq(placements.threadId, created.threadId),
            eq(placements.revisionId, revisionId),
          ),
        )
        .get(),
    );
  expect(await placement(f.revisionId)).toMatchObject({
    status: "placed",
    location: { kind: "topic", slug: topic.slug, part: "title", start: 8, end: 12 },
  });
  for (const invalid of [
    { ...target, part: "summary" },
    { ...target, quote: "missing" },
  ]) {
    await error(
      await f.request(`/reviews/${f.reviewId}/threads`, "POST", { revision: 1, target: invalid, body: "No" }),
      400,
      "invalid_target",
    );
  }
  await error(
    await f.request(`/reviews/${f.reviewId}/threads`, "POST", { revision: 1, target, body: "No" }, "agent"),
    403,
    "forbidden",
  );
  const publish = (title: string, summary: string) =>
    ingest(
      f.ownerId,
      f.instanceId,
      {
        reviewKey: "a".repeat(64),
        repo: null,
        branch: null,
        title: "Synthetic review",
        base: null,
        head: null,
        topics: [{ ...topic, title, summary }],
        files: [],
        writeup: { overview: "Garden", tldr: "", decisions: null, topics: {} },
      },
      { db: f.db, blobs: f.deps.blobs, baseUrl: "http://127.0.0.1:3636", executor: executeWork },
    );
  const moved = await publish("Plant flowers", "Plant a seed.");
  expect(moved).toMatchObject({ revision: 2, placed: 1, unplaced: 0 });
  await f.send({ revision: 2, kind: "go" });
  expect(await f.take()).toMatchObject({
    kind: "go",
    comments: [
      {
        target,
        placement: {
          status: "placed",
          location: { kind: "topic", slug: topic.slug, part: "summary", start: 8, end: 12 },
        },
      },
    ],
  });
  const removed = await publish("Plant flowers", "Fresh soil.");
  expect(removed).toMatchObject({ revision: 3, placed: 0, unplaced: 1 });
  const newest = await f.db.read((q) =>
    q
      .select()
      .from(revisions)
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.reviewId, f.reviewId), eq(revisions.seq, 3)))
      .get(),
  );
  if (!newest) throw new Error("Missing revision");
  expect(await placement(newest.id)).toMatchObject({ status: "unplaced", reason: "block-gone", location: null });
});
test("topic quotes reject incomplete snapshot text with a plain error", async () => {
  const revision = await f.db.read((q) =>
    q
      .select()
      .from(revisions)
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.id, f.revisionId)))
      .get(),
  );
  if (!revision) throw new Error("Missing revision");
  for (const topic of [
    { slug: "garden" },
    { slug: "garden", title: "Plant a seed." },
    { slug: "garden", summary: "Fresh soil." },
  ]) {
    const placement = computePlacements(
      f.ownerId,
      randomUUID(),
      { kind: "topic", slug: topic.slug, part: "title", quote: "seed", prefix: "Plant a ", suffix: "." },
      [{ revision, files: [], topics: [topic], writeup: undefined }],
      { blobs: f.deps.blobs, executor: executeWork },
    );
    await expect(placement).rejects.toThrow("Missing topic placement text");
    await expect(placement).rejects.not.toBeInstanceOf(ApiError);
  }
});
async function file(revisionId: string, path: string, text: string, oldPath: string | null = null) {
  const blob = await f.deps.blobs.put(f.ownerId, Buffer.from(text), "text/plain");
  await f.db.query((q) =>
    q.insert(files).values({
      ownerId: f.ownerId,
      revisionId,
      path,
      oldPath,
      role: "diff",
      ord: 0,
      mediaType: "text/plain",
      newBlob: blob,
    }),
  );
}
test("places a thread made on an older revision on every newer revision, including unplaced renames", async () => {
  await file(f.revisionId, "a.ts", "needle\n");
  await file(await f.revision(2), "a.ts", "absent\n");
  await file(await f.revision(3), "b.ts", "absent\n", "a.ts");
  await file(await f.revision(4), "b.ts", "extra\nneedle\n", "a.ts");
  const t = await f.thread("Note", line());
  const rows = await f.db.read((q) =>
    q
      .select()
      .from(placements)
      .innerJoin(revisions, and(eq(revisions.ownerId, f.ownerId), eq(revisions.id, placements.revisionId)))
      .where(and(eq(placements.ownerId, f.ownerId), eq(placements.threadId, t.threadId)))
      .orderBy(revisions.seq),
  );
  expect(rows.map((r) => r.placements.status)).toEqual(["placed", "unplaced", "unplaced", "placed"]);
  expect(rows.map((r) => r.placements.carried)).toEqual([
    { path: "a.ts", side: "new" },
    { path: "a.ts", side: "new" },
    { path: "b.ts", side: "new" },
    { path: "b.ts", side: "new" },
  ]);
  expect(rows[3]?.placements.location).toEqual({ kind: "lines", path: "b.ts", side: "new", start: 2, end: 2 });
  await f.send({ revision: 4, kind: "go" });
  expect(await f.take()).toMatchObject({
    kind: "go",
    comments: [{ placement: { status: "placed", location: { path: "b.ts", start: 2 } } }],
  });
});
test("unplaced comments are delivered rather than dropped", async () => {
  await file(f.revisionId, "a.ts", "needle\n");
  await f.revision(2);
  await f.thread("Note", line());
  await f.send({ revision: 2, kind: "go" });
  expect(await f.take()).toMatchObject({
    kind: "go",
    comments: [{ placement: { status: "unplaced", reason: "file-gone" } }],
  });
});
test("invalid original targets are rejected even if the quote exists elsewhere", async () => {
  await file(f.revisionId, "a.ts", "other\nneedle\n");
  const blocks = [{ id: "overview-11111111", text: "needle", html: "<p>needle</p>", kind: "paragraph" }];
  const rendered = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(JSON.stringify({ sections: [{ blocks }] })),
    "application/json",
  );
  await f.db.query((q) =>
    q
      .insert(writeups)
      .values({ ownerId: f.ownerId, revisionId: f.revisionId, sourceBlob: rendered, renderedBlob: rendered }),
  );
  for (const target of [
    line(),
    { kind: "file", path: "missing.ts" },
    { kind: "topic", slug: "missing" },
    { kind: "writeup-span", blockId: "overview-22222222", quote: "needle", prefix: "", suffix: "" },
  ])
    await error(
      await f.request(`/reviews/${f.reviewId}/threads`, "POST", { revision: 1, target, body: "No" }),
      400,
      "invalid_target",
    );
  expect(await f.db.read((q) => q.select().from(placements).where(eq(placements.ownerId, f.ownerId)))).toHaveLength(0);
});
test("file, topic and span targets place on their own revision without topic text", async () => {
  await file(f.revisionId, "a.ts", "needle\n");
  await f.db.query((q) =>
    q.insert(topics).values({
      ownerId: f.ownerId,
      revisionId: f.revisionId,
      slug: "topic",
      title: "Topic",
      importance: 50,
      summary: "Summary",
    }),
  );
  const rendered = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(
      JSON.stringify({ sections: [{ blocks: [{ id: "overview-11111111", text: "needle", html: "<p>needle</p>" }] }] }),
    ),
    "application/json",
  );
  await f.db.query((q) =>
    q
      .insert(writeups)
      .values({ ownerId: f.ownerId, revisionId: f.revisionId, sourceBlob: rendered, renderedBlob: rendered }),
  );
  f.deps.publishExecutor = async (work) => {
    if (work.kind === "place") {
      expect(work.topics).toEqual(new Set(["topic"]));
      expect(work).not.toHaveProperty("topicText");
    }
    return executeWork(work);
  };
  for (const target of [
    { kind: "file", path: "a.ts" },
    { kind: "topic", slug: "topic" },
    { kind: "writeup-span", blockId: "overview-11111111", quote: "needle", prefix: "", suffix: "" },
  ] satisfies Target[])
    await f.thread("Note", target);
});
test("creation retries a revision race outside the database and stops after three conflicts", async () => {
  let calls = 0;
  f.deps.publishExecutor = async (work) => {
    expect(work.kind).toBe("place");
    if (++calls === 1) await f.revision(2);
    return executeWork(work);
  };
  await f.thread();
  expect(calls).toBe(3);
  expect(await f.db.read((q) => q.select().from(placements).where(eq(placements.ownerId, f.ownerId)))).toHaveLength(2);
  let seq = 2;
  const seen = new Set<string>();
  f.deps.publishExecutor = async (work) => {
    if (work.kind === "place" && !seen.has(work.threads[0]?.id ?? "")) {
      seen.add(work.threads[0]?.id ?? "");
      await f.revision(++seq);
    }
    return executeWork(work);
  };
  await error(
    await f.request(`/reviews/${f.reviewId}/threads`, "POST", {
      revision: 1,
      target: { kind: "review" },
      body: "Conflict",
    }),
    409,
    "publish_conflict",
  );
  expect(seen.size).toBe(3);
});
test("missing revision is invalid_target and the production placement worker is used", async () => {
  await error(
    await f.request(`/reviews/${f.reviewId}/threads`, "POST", { revision: 99, target: { kind: "review" }, body: "No" }),
    400,
    "invalid_target",
  );
  f.deps.publishExecutor = undefined;
  expect((await f.thread()).threadId).not.toBe(randomUUID());
});
