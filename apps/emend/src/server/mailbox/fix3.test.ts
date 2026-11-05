import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_MODE, LIMITS, MODE_LABELS, type WaitResult } from "@emend/contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { reviews, revisions } from "../../db/schema.ts";
import { jsonBytes } from "./payload.ts";
import { takeDelivery } from "./take.ts";
import { error, expectIndexedTake, mailboxFixture, observeTake, seedComments } from "./test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
type Go = Extract<WaitResult, { kind: "go" }>;
const replyBody = (n: number, length = 7) => `${"r".repeat(length - 6)}${String(n).padStart(6, "0")}`;
const agentEntry = (body: string) => ({ author: "agent" as const, body, outcome: "held" as const });
async function seed(threadId: string, count: number, offset = 0, length = 7, reviewId = f.reviewId) {
  await seedComments(f, threadId, count, {
    author: "agent",
    body: "r".repeat(length - 6),
    digits: 6,
    offset,
    reviewId,
  });
}

async function take() {
  const result = await takeDelivery(
    f.db,
    {
      ownerId: f.ownerId,
      tokenId: randomUUID(),
      kind: "agent",
      instanceId: f.instanceId,
      scopes: ["take"],
    },
    f.reviewId,
    f.deps.now(),
  );
  if (result?.kind !== "go") throw new Error("not go");
  return { result };
}
async function confirm(result: Go) {
  expect((await f.request(`/deliveries/${result.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
}
async function sentThread(body = "Earlier user comment") {
  const t = await f.thread(body);
  await f.send();
  await confirm((await take()).result);
  return t;
}
function template(comments: Go["comments"]): Go {
  return {
    kind: "go",
    reviewId: f.reviewId,
    deliveryId: randomUUID(),
    revision: 1,
    sentOn: 1,
    mode: DEFAULT_MODE,
    modeLabel: MODE_LABELS[DEFAULT_MODE],
    instructions: [],
    approvalSetAside: false,
    comments,
  };
}
function comment(
  id: string,
  threadId: string,
  history: Go["comments"][number]["history"],
  body = "Feedback",
): Go["comments"][number] {
  return {
    id,
    threadId,
    target: { kind: "review" },
    placement: { status: "placed", location: { kind: "review" } },
    body,
    history,
  };
}

// Seeding 200,000 indexed replies is required to compare bounded history reads at both scales.
test("200,000 replies read the same bounded history as 2,000 replies, keeping the newest 500", async () => {
  const t = await sentThread();
  await seed(t.threadId, 2000);
  await f.comment(t.threadId, "Small history feedback");
  await f.send();
  const small = await observeTake(async () => (await take()).result);
  await confirm(small.result);
  await seed(t.threadId, 198000, 2000);
  await f.comment(t.threadId, "Large history feedback");
  await f.send();
  const large = await observeTake(async () => (await take()).result);
  expect(large.rows).toBe(small.rows);
  expectIndexedTake(small.plans);
  expectIndexedTake(large.plans);
  const delivered = large.result.comments[0];
  expect(delivered?.history.map((h) => h.body)).toEqual(Array.from({ length: 500 }, (_, i) => replyBody(199501 + i)));
  expect(delivered?.historyTrimmed).toBe(true);
}, 15000);

// Seeding 200,000 indexed replies in the other review is the isolation workload.
test("200,000 replies in another review of the owner do not increase rows read by take", async () => {
  const t = await sentThread();
  await f.comment(t.threadId, "Baseline feedback");
  await f.send();
  const small = await observeTake(async () => (await take()).result);
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
  await seed(otherThread.threadId, 200000, 0, 7, otherReview);
  const target = await sentThread();
  await f.comment(target.threadId, "This review's feedback");
  await f.send();
  const large = await observeTake(async () => (await take()).result);
  expect(large.rows).toBe(small.rows);
  expectIndexedTake(small.plans);
  expectIndexedTake(large.plans);
  expect(large.result.comments).toHaveLength(1);
  expect(large.result.comments[0]?.body).toBe("This review's feedback");
}, 15000);

test("each capped comment gets its own newest window, including recent sent user comments", async () => {
  const t = await sentThread();
  await seed(t.threadId, 600);
  await f.comment(t.threadId, "Recent sent user comment");
  await f.send();
  await confirm((await take()).result);
  await seed(t.threadId, 20, 600);
  await f.comment(t.threadId, "First new comment");
  await seed(t.threadId, 20, 620);
  await f.comment(t.threadId, "Second new comment");
  await f.send();
  const { result } = await take();
  for (const [index, c] of result.comments.entries()) {
    const end = 620 + 20 * index;
    const expected = Array.from({ length: 499 }, (_, i) => replyBody(end - 498 + i));
    expected.splice(600 - (end - 498) + 1, 0, "Recent sent user comment");
    expect(c.history.map((h) => h.body)).toEqual(expected);
    expect(c.historyTrimmed).toBe(true);
  }
});

test.each([0, 499])(
  "a comment keeping all %i replies plus its earlier user comment has no historyTrimmed field",
  async (count) => {
    const t = await sentThread();
    if (count) await seed(t.threadId, count);
    await f.comment(t.threadId, "New feedback");
    await f.send();
    const { result } = await take();
    expect(result.comments[0]?.history).toHaveLength(count + 1);
    expect(result.comments[0]).not.toHaveProperty("historyTrimmed");
  },
);

test("a tight fit drops exactly the oldest shared entry and flags only its carriers", async () => {
  const empty = { author: "user" as const, body: "" };
  const emptyHistory = [empty, ...Array.from({ length: 419 }, () => agentEntry(""))];
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const;
  const skeleton = template([
    comment(ids[0], ids[1], emptyHistory),
    comment(ids[2], ids[1], [...emptyHistory, agentEntry("")]),
    comment(ids[4], ids[5], [], "Untouched"),
  ]);
  const length = Math.floor((LIMITS.handoffBytes - jsonBytes(skeleton)) / 841);
  const t = await sentThread("u".repeat(length));
  await seed(t.threadId, 419, 0, length);
  const a = await f.comment(t.threadId, "Feedback");
  await seed(t.threadId, 1, 419, length);
  const b = await f.comment(t.threadId, "Feedback");
  const untouched = await f.thread("Untouched");
  const history = [
    { author: "user" as const, body: "u".repeat(length) },
    ...Array.from({ length: 419 }, (_, i) => agentEntry(replyBody(i + 1, length))),
  ];
  const untrimmed = template([
    comment(a.commentId, t.threadId, history),
    comment(b.commentId, t.threadId, [...history, agentEntry(replyBody(420, length))]),
    comment(untouched.commentId, untouched.threadId, [], "Untouched"),
  ]);
  const padding = LIMITS.handoffBytes + 1 - jsonBytes(untrimmed);
  expect(padding).toBeGreaterThan(0);
  expect(padding).toBeLessThan(1000);
  const second = untrimmed.comments[1];
  if (!second) throw new Error("Missing second comment");
  second.body += "b".repeat(padding);
  expect((await f.request(`/comments/${b.commentId}`, "PATCH", { body: second.body })).status).toBe(204);
  await f.send();
  const { result } = await take();
  expect(result.comments.map((c) => c.history.length)).toEqual([419, 420, 0]);
  expect(result.comments[0]?.history).toEqual(history.slice(1));
  expect(result.comments[1]?.history).toEqual([...history.slice(1), agentEntry(replyBody(420, length))]);
  expect(result.comments[0]?.historyTrimmed).toBe(true);
  expect(result.comments[1]?.historyTrimmed).toBe(true);
  expect(result.comments[2]).not.toHaveProperty("historyTrimmed");
  const expectedBytes =
    LIMITS.handoffBytes + 1 - 2 * (jsonBytes(history[0]) + 1) + 2 * Buffer.byteLength(',"historyTrimmed":true');
  expect(jsonBytes(result)).toBe(expectedBytes);
  expect(expectedBytes).toBeLessThanOrEqual(LIMITS.handoffBytes);
});

test("mixed history prefixes trim globally with exact byte accounting", async () => {
  const length = 20000;
  const t = await sentThread("u".repeat(length));
  const ids: string[] = [];
  let offset = 0;
  for (const count of [200, 180, 80]) {
    await seed(t.threadId, count, offset, length);
    offset += count;
    ids.push((await f.comment(t.threadId, "Feedback")).commentId);
  }
  const history = [
    { author: "user" as const, body: "u".repeat(length) },
    ...Array.from({ length: 460 }, (_, i) => agentEntry(replyBody(i + 1, length))),
  ];
  const lengths = [201, 381, 461] as const;
  const untrimmed = template(ids.map((id, i) => comment(id, t.threadId, history.slice(0, lengths[i]))));
  const fullBytes = jsonBytes(untrimmed);
  const flagBytes = 3 * Buffer.byteLength(',"historyTrimmed":true');
  const firstDrop = 3 * (jsonBytes(history[0]) + 1);
  const laterDrop = 3 * (jsonBytes(history[1]) + 1);
  const dropped = 1 + Math.ceil((fullBytes + flagBytes - firstDrop - LIMITS.handoffBytes) / laterDrop);
  expect(dropped).toBeGreaterThan(1);
  expect(dropped).toBeLessThan(lengths[0]);
  await f.send();
  const { result } = await take();
  for (const [i, c] of result.comments.entries()) {
    expect(c.history).toEqual(history.slice(dropped, lengths[i]));
    expect(c.historyTrimmed).toBe(true);
  }
  const expectedBytes = fullBytes + flagBytes - firstDrop - (dropped - 1) * laterDrop;
  expect(jsonBytes(result)).toBe(expectedBytes);
  expect(expectedBytes).toBeLessThanOrEqual(LIMITS.handoffBytes);
  expect(expectedBytes + laterDrop).toBeGreaterThan(LIMITS.handoffBytes);
});

test.each(["\ud800", "\udfff"])("rejects malformed body and instruction with 400 (%#)", async (text) => {
  await error(
    await f.request(`/reviews/${f.reviewId}/threads`, "POST", { revision: 1, target: { kind: "review" }, body: text }),
    400,
    "invalid_request",
  );
  await error(
    await f.request(`/reviews/${f.reviewId}/sends`, "POST", { revision: 1, kind: "go", instruction: text }),
    400,
    "invalid_request",
  );
});

test("a valid surrogate pair survives comment and instruction storage", async () => {
  const body = "Body \ud83d\ude80";
  const instruction = "Instruction \ud83d\ude80";
  await f.thread(body);
  await f.send({ revision: 1, kind: "go", instruction });
  expect((await take()).result).toMatchObject({ comments: [{ body }], instructions: [instruction] });
});

test("the claim and sent-comments plans probe comments by owner, review and Send", async () => {
  await f.thread();
  await f.send();
  const prepare = DatabaseSync.prototype.prepare;
  const plans = { claim: [] as string[], sentComments: [] as string[] };
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
    if (query.includes('"comments"."body"') && query.includes('"placements"."location"')) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...params) => {
        plans.sentComments.push(...plan(...params));
        return all(...params);
      });
    }
    return statement;
  });
  await take();
  expect(plans.claim).toContain(
    "SEARCH c USING INDEX comments_owner_review_send_idx (owner_id=? AND review_id=? AND send_id=?)",
  );
  expect(plans.sentComments).toContain(
    "SEARCH comments USING INDEX comments_owner_review_send_idx (owner_id=? AND review_id=? AND send_id=?)",
  );
  expect(plans.sentComments.some((line) => line.includes("comments_owner_idx"))).toBe(false);
});
