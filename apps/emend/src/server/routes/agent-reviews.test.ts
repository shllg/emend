import { randomUUID } from "node:crypto";
import { AgentReviewList, LIMITS, PublishResponse } from "@emend/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { listAgentReviews } from "../../db/repo/agent-reviews.ts";
import {
  agentWaiters,
  comments,
  deliveries,
  instances,
  repos,
  reviews,
  revisions,
  sends,
  threads,
  tokens,
} from "../../db/schema.ts";
import { createToken, hashSecret } from "../auth/tokens.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  await f.cleanup();
});
async function insert(ownerId: string, originInstanceId: string, title: string, updatedAt: number, state = "open") {
  const id = randomUUID();
  await f.db.query((q) =>
    q.insert(reviews).values({
      id,
      ownerId,
      originInstanceId,
      reviewKey: randomUUID().replaceAll("-", "").repeat(2),
      title,
      state: state as "open",
      createdAt: updatedAt,
      updatedAt,
    }),
  );
  return id;
}
function list(token: string) {
  return f.app.request("http://127.0.0.1:3636/api/v1/agent/reviews", {
    headers: { Host: "127.0.0.1:3636", Authorization: `Bearer ${token}` },
  });
}
async function machine() {
  const id = randomUUID();
  await f.db.query((q) => q.insert(instances).values({ id, name: "Second synthetic machine" }));
  return { id, token: (await createToken(f.db, f.ownerId, "agent", { instanceId: id })).secret };
}

test("an agent token lists its own instance's reviews newest first, with a review URL", async () => {
  const other = await machine();
  const older = await insert(f.ownerId, f.instanceId, "Older review", 1_000);
  const newer = await insert(f.ownerId, f.instanceId, "Newer review", f.deps.now() + 3_000, "approved");
  await insert(f.ownerId, other.id, "Foreign instance review", f.deps.now() + 9_000);
  await insert(f.otherOwnerId, f.instanceId, "Foreign owner review", f.deps.now() + 9_000);
  const response = await f.request("/agent/reviews", "GET", undefined, "agent");
  expect(response.status).toBe(200);
  const items = AgentReviewList.parse(await response.json()).items;
  expect(items.map((item) => item.id)).toEqual([newer, f.reviewId, older]);
  expect(items[0]).toEqual({
    id: newer,
    title: "Newer review",
    branch: null,
    state: "approved",
    newest: null,
    approved: null,
    updatedAt: new Date(f.deps.now() + 3_000).toISOString(),
    url: `http://127.0.0.1:3636/r/${newer}`,
  });
});

test("another instance's token and another owner's token see only their own rows", async () => {
  const other = await machine();
  await insert(f.ownerId, other.id, "Other instance review", 5_000);
  await insert(f.otherOwnerId, f.instanceId, "Other owner review", 6_000);
  const own = AgentReviewList.parse(await (await list(other.token)).json());
  expect(own.items.map((item) => item.title)).toEqual(["Other instance review"]);
  const stranger = AgentReviewList.parse(
    await (await f.request("/agent/reviews", "GET", undefined, "stranger")).json(),
  );
  expect(stranger.items.map((item) => item.title)).toEqual(["Other owner review"]);
});

test("the list never carries comment bodies or any other field", async () => {
  await f.thread("SECRET-COMMENT-BODY");
  const text = await (await f.request("/agent/reviews", "GET", undefined, "agent")).text();
  expect(text).not.toContain("SECRET-COMMENT-BODY");
  const [item] = JSON.parse(text).items;
  expect(Object.keys(item).sort()).toEqual([
    "approved",
    "branch",
    "id",
    "newest",
    "state",
    "title",
    "updatedAt",
    "url",
  ]);
});

test("the list is capped at the agent review limit", async () => {
  await f.db.query((q) =>
    q.insert(reviews).values(
      Array.from({ length: LIMITS.agentReviews + 5 }, (_, i) => ({
        id: randomUUID(),
        ownerId: f.ownerId,
        originInstanceId: f.instanceId,
        reviewKey: randomUUID().replaceAll("-", "").repeat(2),
        title: `Review ${i}`,
        createdAt: 10_000 + i,
        updatedAt: 10_000 + i,
      })),
    ),
  );
  const items = AgentReviewList.parse(
    await (await f.request("/agent/reviews", "GET", undefined, "agent")).json(),
  ).items;
  expect(items).toHaveLength(LIMITS.agentReviews);
});

test("a revoked agent token gets 401", async () => {
  const other = await machine();
  expect((await list(other.token)).status).toBe(200);
  await f.db.query((q) =>
    q
      .update(tokens)
      .set({ revokedAt: f.deps.now() })
      .where(eq(tokens.secretHash, hashSecret(other.token))),
  );
  await error(await list(other.token), 401, "unauthorized");
});

test("rows with the same updatedAt come back in ascending id order", async () => {
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await insert(f.ownerId, f.instanceId, `Tie ${i}`, f.deps.now() + 50_000));
  const items = AgentReviewList.parse(
    await (await f.request("/agent/reviews", "GET", undefined, "agent")).json(),
  ).items;
  expect(items.slice(0, 4).map((item) => item.id)).toEqual([...ids].sort());
});

test("a principal without an instance gets an empty list (the database forbids such an agent token)", async () => {
  const principal = { ownerId: f.ownerId, tokenId: "", kind: "agent" as const, instanceId: null, scopes: [] };
  expect(await listAgentReviews(f.db, principal, "http://127.0.0.1:3636")).toEqual({ items: [] });
});

test("snoozed and settled reviews are listed with their stored state", async () => {
  const snoozed = await insert(f.ownerId, f.instanceId, "Snoozed review", f.deps.now() + 1_000);
  await f.db.query((q) =>
    q.update(reviews).set({ snoozedAt: f.deps.now(), snoozedUntil: null }).where(eq(reviews.id, snoozed)),
  );
  const settled = await insert(f.ownerId, f.instanceId, "Retired review", f.deps.now() + 2_000, "settled");
  const items = AgentReviewList.parse(
    await (await f.request("/agent/reviews", "GET", undefined, "agent")).json(),
  ).items;
  expect(items.find((item) => item.id === snoozed)?.state).toBe("open");
  expect(items.find((item) => item.id === settled)?.state).toBe("settled");
});

test("a reviewer session and a missing credential are refused", async () => {
  await error(await f.request("/agent/reviews", "GET", undefined, "reviewer"), 403, "forbidden");
  const anonymous = await f.app.request("http://127.0.0.1:3636/api/v1/agent/reviews", {
    headers: { Host: "127.0.0.1:3636" },
  });
  expect(anonymous.status).toBe(401);
});

const shaA = "a1".repeat(20);
const shaB = "b2".repeat(20);
const shaC = "c3".repeat(32);

async function publishAs(
  token: "agent" | "otherAgent" | "stranger",
  key: string,
  head: string | null,
  branch = "feature",
) {
  const response = await f.request(
    "/publish",
    "POST",
    {
      reviewKey: key.repeat(64),
      repo: null,
      branch,
      title: `Review ${key}`,
      // base and head travel together.
      base: head === null ? null : "0".repeat(40),
      head,
      topics: [],
      writeup: { overview: "Synthetic", tldr: "", decisions: null, topics: {} },
      files: [],
    },
    token,
  );
  expect(response.status).toBe(200);
  return PublishResponse.parse(await response.json());
}
async function approve(reviewId: string, revision: number) {
  const response = await f.request(`/reviews/${reviewId}/sends`, "POST", { revision, kind: "approve" });
  expect(response.status).toBe(201);
}
async function items(query = "", who: "agent" | "stranger" = "agent") {
  const response = await f.request(`/agent/reviews${query}`, "GET", undefined, who);
  expect(response.status).toBe(200);
  return AgentReviewList.parse(await response.json()).items;
}

test("an approved review names its approved commit, equal to the newest revision", async () => {
  const { reviewId } = await publishAs("agent", "d", shaA);
  await approve(reviewId, 1);
  const item = (await items()).find((row) => row.id === reviewId);
  expect(item).toMatchObject({
    branch: "feature",
    state: "approved",
    newest: { revision: 1, head: shaA },
    approved: { revision: 1, head: shaA },
  });
  expect((await items(`?head=${shaA}`)).map((row) => row.id)).toEqual([reviewId]);
});

test("a new revision clears the approval and moves the head lookup to the new commit", async () => {
  const first = await publishAs("agent", "d", shaA);
  await approve(first.reviewId, 1);
  const second = await publishAs("agent", "d", shaB);
  expect(second).toMatchObject({ reviewId: first.reviewId, revision: 2 });
  const item = (await items()).find((row) => row.id === first.reviewId);
  expect(item).toMatchObject({ state: "open", newest: { revision: 2, head: shaB }, approved: null });
  expect(await items(`?head=${shaA}`)).toEqual([]);
  const found = await items(`?head=${shaB}`);
  expect(found.map((row) => row.id)).toEqual([first.reviewId]);
  expect(found[0]?.approved).toBeNull();
});

test("an approval of an older revision keeps its own head while a newer one exists", async () => {
  const first = await publishAs("agent", "d", shaA);
  await approve(first.reviewId, 1);
  await publishAs("agent", "d", shaB);
  await approve(first.reviewId, 2);
  const [item] = await items(`?head=${shaB}`);
  expect(item).toMatchObject({ approved: { revision: 2, head: shaB }, newest: { revision: 2, head: shaB } });
  expect(await items(`?head=${shaA}`)).toEqual([]);
});

test("worktree and null heads come out unchanged", async () => {
  const worktree = await publishAs("agent", "e", "worktree");
  const none = await publishAs("agent", "f", null);
  await approve(worktree.reviewId, 1);
  const all = await items();
  expect(all.find((row) => row.id === worktree.reviewId)).toMatchObject({
    newest: { revision: 1, head: "worktree" },
    approved: { revision: 1, head: "worktree" },
  });
  expect(all.find((row) => row.id === none.reviewId)).toMatchObject({
    newest: { revision: 1, head: null },
    approved: null,
  });
});

test("a malformed head is a 400 and a reviewer session still a 403", async () => {
  for (const query of [
    "?head=",
    "?head=abc",
    "?head=worktree",
    `?head=${shaA.toUpperCase()}`,
    `?head=${shaA}0`,
    `?head=${shaA}&head=${shaB}`,
  ])
    await error(await f.request(`/agent/reviews${query}`, "GET", undefined, "agent"), 400, "invalid_request");
  await error(await f.request(`/agent/reviews?head=${shaA}`, "GET", undefined, "reviewer"), 403, "forbidden");
  expect((await items(`?head=${shaC}`)).length).toBe(0);
});

test("the head lookup keeps owner and origin-instance isolation", async () => {
  const own = await publishAs("agent", "d", shaA);
  await publishAs("otherAgent", "d", shaA);
  await publishAs("stranger", "d", shaA);
  expect((await items(`?head=${shaA}`)).map((row) => row.id)).toEqual([own.reviewId]);
  const other = await items(`?head=${shaA}`, "stranger");
  expect(other).toHaveLength(1);
  expect(other[0]?.id).not.toBe(own.reviewId);
});

test("the head filter applies before the row limit", async () => {
  const target = await publishAs("agent", "d", shaA);
  await f.db.query((q) =>
    q.insert(reviews).values(
      Array.from({ length: LIMITS.agentReviews + 5 }, (_, i) => ({
        id: randomUUID(),
        ownerId: f.ownerId,
        originInstanceId: f.instanceId,
        reviewKey: randomUUID().replaceAll("-", "").repeat(2),
        title: `Newer ${i}`,
        createdAt: f.deps.now() + 100_000 + i,
        updatedAt: f.deps.now() + 100_000 + i,
      })),
    ),
  );
  expect((await items(`?head=${shaA}`)).map((row) => row.id)).toEqual([target.reviewId]);
});

test("listing, with and without a head, changes no row and takes or confirms no delivery", async () => {
  const first = await publishAs("agent", "d", shaA);
  await publishAs("agent", "9", shaB);
  await f.thread("Synthetic feedback");
  await f.send();
  await approve(first.reviewId, 1);
  const snapshot = () =>
    f.db.read(async (q) => ({
      reviews: await q.select().from(reviews).all(),
      revisions: await q.select().from(revisions).all(),
      deliveries: await q.select().from(deliveries).all(),
      sends: await q.select().from(sends).all(),
      comments: await q.select().from(comments).all(),
      threads: await q.select().from(threads).all(),
      agentWaiters: await q.select().from(agentWaiters).all(),
      // A bearer request writes nothing to tokens (only a reviewer session renewal does), so no column is excluded.
      tokens: await q.select().from(tokens).all(),
      instances: await q.select().from(instances).all(),
      repos: await q.select().from(repos).all(),
    }));
  const before = await snapshot();
  for (const query of ["", `?head=${shaA}`, `?head=${shaB}`, `?head=${shaC}`, ""]) await items(query);
  expect(await snapshot()).toEqual(before);
  expect(before.deliveries.every((row) => row.confirmedAt === null)).toBe(true);
});
