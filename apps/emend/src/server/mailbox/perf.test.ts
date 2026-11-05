import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { reviews, revisions } from "../../db/schema.ts";
import { takeDelivery } from "./take.ts";
import { expectIndexedTake, mailboxFixture, observeTake, seedComments } from "./test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});

async function take() {
  const result = await takeDelivery(
    f.db,
    { ownerId: f.ownerId, tokenId: randomUUID(), kind: "agent", instanceId: f.instanceId, scopes: ["take"] },
    f.reviewId,
    f.deps.now(),
  );
  if (result?.kind !== "go") throw new Error("not go");
  return { result };
}

async function sendComments(count: number) {
  const t = await f.thread("Feedback");
  await seedComments(f, t.threadId, count - 1);
  await f.send();
}

test("5,000 comments in one Send read only delivered rows plus constant overhead", async () => {
  await sendComments(500);
  const small = await observeTake(async () => (await take()).result);
  await sendComments(5000);
  const large = await observeTake(async () => (await take()).result);
  for (const measured of [small, large]) {
    expect(measured.rows).toBeGreaterThanOrEqual(measured.result.comments.length);
    expect(measured.rows).toBeLessThanOrEqual(measured.result.comments.length + 10);
    expectIndexedTake(measured.plans);
  }
  expect(small.result.comments).toHaveLength(500);
  expect(large.result.comments).toHaveLength(5000);
  expect(large.result.comments.every((c) => c.history.length === 0 && !c.historyTrimmed)).toBe(true);
}, 15000);

test("200,000 Sends in another review do not increase rows read by take", async () => {
  await f.thread();
  await f.send();
  const small = await observeTake(async () => (await take()).result);
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
  const large = await observeTake(async () => (await take()).result);
  expect(large.rows).toBe(small.rows);
  expectIndexedTake(small.plans);
  expectIndexedTake(large.plans);
  expect(large.result.comments).toHaveLength(1);
}, 15000);

test("one Send of 5,000 comments alternating between two threads fetches each row at most once", async () => {
  const first = await f.thread("Feedback");
  const second = await f.thread("Feedback");
  // Interleave rowids so each thread must fetch and discard delivered comments.
  await f.db.query((q) =>
    q.run(sql`with recursive numbers(n) as (select 1 union all select n + 1 from numbers where n < 4998)
      insert into comments (id, owner_id, review_id, thread_id, author, body, created_at, updated_at)
      select ${randomUUID().slice(0, 24)} || printf('%012x', n), ${f.ownerId}, ${f.reviewId},
        case when n % 2 = 1 then ${first.threadId} else ${second.threadId} end,
        'user', 'Feedback', ${f.deps.now()}, ${f.deps.now()} from numbers order by n`),
  );
  await f.send();
  const visited: number[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, query: string) {
    const statement = prepare.call(this, query);
    if (query.includes("with pending_comments as materialized")) {
      expect(query).not.toContain("history_entries");
      expect(query).not.toContain("comments_owner_review_thread_idx");
    }
    if (query.includes("from comments indexed by comments_owner_review_thread_idx")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...params) => {
        const rows = all(...params);
        visited.push(...rows.map((row) => Number(Object.values(row)[0])));
        return rows;
      });
    }
    return statement;
  });
  const { result } = await take();
  expect(result.comments).toHaveLength(5000);
  expect(result.comments.map((c) => c.threadId)).toEqual(
    Array.from({ length: 5000 }, (_, i) => (i % 2 === 0 ? first.threadId : second.threadId)),
  );
  expect(result.comments.every((c) => c.history.length === 0)).toBe(true);
  expect(visited.length).toBeGreaterThan(0);
  expect(new Set(visited).size).toBe(visited.length);
});

test("the FIFO claim and claimed-Send select search within the review", async () => {
  await f.thread();
  await f.send();
  const prepare = DatabaseSync.prototype.prepare;
  const plans = { claim: [] as string[], claimed: [] as string[] };
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, query: string) {
    const statement = prepare.call(this, query);
    const plan = (...params: Parameters<typeof statement.all>) =>
      prepare
        .call(this, `EXPLAIN QUERY PLAN ${query}`)
        .all(...params)
        .map((row) => String(row.detail));
    if (query.includes("with pending_comments as materialized")) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, "run").mockImplementation((...params) => {
        plans.claim.push(...plan(...params));
        return run(...params);
      });
    }
    if (query.includes('"sends"."mode"') && query.includes('"revisions"."seq"')) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...params) => {
        plans.claimed.push(...plan(...params));
        return all(...params);
      });
    }
    return statement;
  });
  await take();
  for (const plan of Object.values(plans)) {
    expect(plan.some((line) => line.includes("sends_owner_review_id_unique (owner_id=? AND review_id=?)"))).toBe(true);
    expect(plan.some((line) => line.includes("sends_owner_idx"))).toBe(false);
  }
});
