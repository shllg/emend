import { randomUUID } from "node:crypto";
import { AgentReviewList, LIMITS } from "@emend/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { listAgentReviews } from "../../db/repo/agent-reviews.ts";
import { instances, reviews, tokens } from "../../db/schema.ts";
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
    state: "approved",
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
  expect(Object.keys(item).sort()).toEqual(["id", "state", "title", "updatedAt", "url"]);
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
