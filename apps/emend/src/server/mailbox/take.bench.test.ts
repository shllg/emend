import { randomUUID } from "node:crypto";
import type { WaitResult } from "@emend/contract";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { reviews, revisions } from "../../db/schema.ts";
import { emitBench } from "../bench-support.ts";
import { takeDelivery } from "./take.ts";
import { mailboxFixture, seedComments } from "./test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});

type Go = Extract<WaitResult, { kind: "go" }>;

async function take() {
  const start = performance.now();
  const result = await takeDelivery(
    f.db,
    { ownerId: f.ownerId, tokenId: randomUUID(), kind: "agent", instanceId: f.instanceId, scopes: ["take"] },
    f.reviewId,
    f.deps.now(),
  );
  const elapsedMs = performance.now() - start;
  if (result?.kind !== "go") throw new Error("not go");
  return { result, elapsedMs };
}

async function confirm(result: Go) {
  expect((await f.request(`/deliveries/${result.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
}

async function sentThread() {
  const t = await f.thread("Earlier user comment");
  await f.send();
  await confirm((await take()).result);
  return t;
}

async function sendComments(count: number) {
  const t = await f.thread("Feedback");
  await seedComments(f, t.threadId, count - 1);
  await f.send();
}

async function seedReplies(threadId: string, count: number, offset = 0, reviewId = f.reviewId) {
  await seedComments(f, threadId, count, { author: "agent", body: "r", digits: 6, offset, reviewId });
}

test("500 versus 5000 comments in one Send", async () => {
  await sendComments(500);
  const small = await take();
  await confirm(small.result);
  await sendComments(5000);
  const large = await take();
  emitBench({ bench: "take-comments", smallMs: small.elapsedMs, largeMs: large.elapsedMs });
  expect(small.result.comments).toHaveLength(500);
  expect(large.result.comments).toHaveLength(5000);
  expect(large.result.comments.every((c) => c.history.length === 0 && !c.historyTrimmed)).toBe(true);
});

test("take with and without 200000 Sends in another review", async () => {
  await f.thread();
  await f.send();
  const small = await take();
  await confirm(small.result);
  const reviewId = randomUUID();
  const revisionId = randomUUID();
  await f.db.query(async (q) => {
    await q.insert(reviews).values({
      id: reviewId,
      ownerId: f.ownerId,
      originInstanceId: f.instanceId,
      reviewKey: "b".repeat(64),
      title: "Other synthetic review",
    });
    await q
      .insert(revisions)
      .values({ id: revisionId, ownerId: f.ownerId, reviewId, seq: 1, contentKey: randomUUID() });
    await q.run(sql`with recursive numbers(n) as (select 1 union all select n + 1 from numbers where n < 200000)
      insert into sends (id, owner_id, review_id, revision_id, kind, instruction, created_at)
      select ${randomUUID().slice(0, 24)} || printf('%012x', n), ${f.ownerId}, ${reviewId}, ${revisionId},
        'go', 'Feedback', ${f.deps.now()} from numbers`);
  });
  await f.thread();
  await f.send();
  const large = await take();
  emitBench({ bench: "take-other-review-sends", smallMs: small.elapsedMs, largeMs: large.elapsedMs });
  expect(large.result.comments).toHaveLength(1);
});

test("2000 versus 200000 replies, retaining the newest 500", async () => {
  const t = await sentThread();
  await seedReplies(t.threadId, 2000);
  await f.comment(t.threadId, "Small history feedback");
  await f.send();
  const small = await take();
  await confirm(small.result);
  await seedReplies(t.threadId, 198000, 2000);
  await f.comment(t.threadId, "Large history feedback");
  await f.send();
  const large = await take();
  emitBench({ bench: "take-history", smallMs: small.elapsedMs, largeMs: large.elapsedMs });
  const delivered = large.result.comments[0];
  expect(delivered?.history.map((h) => h.body)).toEqual(
    Array.from({ length: 500 }, (_, i) => `r${String(199501 + i).padStart(6, "0")}`),
  );
  expect(delivered?.historyTrimmed).toBe(true);
});

test("take with and without 200000 replies in another review of the same owner", async () => {
  const t = await sentThread();
  await f.comment(t.threadId, "Baseline feedback");
  await f.send();
  const small = await take();
  await confirm(small.result);
  const otherReview = randomUUID();
  await f.db.query(async (q) => {
    await q.insert(reviews).values({
      id: otherReview,
      ownerId: f.ownerId,
      originInstanceId: f.instanceId,
      reviewKey: "b".repeat(64),
      title: "Other synthetic review",
    });
    await q
      .insert(revisions)
      .values({ id: randomUUID(), ownerId: f.ownerId, reviewId: otherReview, seq: 1, contentKey: randomUUID() });
  });
  const response = await f.request(`/reviews/${otherReview}/threads`, "POST", {
    revision: 1,
    target: { kind: "review" },
    body: "Other review comment",
  });
  expect(response.status).toBe(201);
  const otherThread = (await response.json()) as { threadId: string };
  expect((await f.request(`/reviews/${otherReview}/sends`, "POST", { revision: 1, kind: "go" })).status).toBe(201);
  await seedReplies(otherThread.threadId, 200000, 0, otherReview);
  const target = await sentThread();
  await f.comment(target.threadId, "This review's feedback");
  await f.send();
  const large = await take();
  emitBench({ bench: "take-other-review-replies", smallMs: small.elapsedMs, largeMs: large.elapsedMs });
  expect(large.result.comments).toHaveLength(1);
  expect(large.result.comments[0]?.body).toBe("This review's feedback");
});
