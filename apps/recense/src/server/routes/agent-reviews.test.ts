import { createHash, randomUUID } from "node:crypto";
import { AgentReviewList, LIMITS, PublishResponse } from "@recense/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Db } from "../../db/client.ts";
import { listAgentReviews } from "../../db/repo/agent-reviews.ts";
import {
  agentWaiters,
  blobs,
  comments,
  deliveries,
  files,
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
import { observePacing } from "../pacing-test-support.ts";

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

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const oldHash = "a".repeat(64);
const newHash = "b".repeat(64);
const emptyDiff = { files: 0, digest: digest("") };
type FixtureFile = Pick<
  typeof files.$inferInsert,
  "path" | "oldPath" | "role" | "status" | "oldBlob" | "newBlob" | "flag"
>;

async function seedFiles(revisionId: string, rows: FixtureFile[]) {
  const ownerId = f.ownerId;
  await f.db.query(async (q) => {
    const hashes = new Set(rows.flatMap((row) => [row.oldBlob, row.newBlob]));
    for (const sha256 of hashes) {
      if (sha256)
        await q.insert(blobs).values({ ownerId, sha256, size: 1, mediaType: "text/plain" }).onConflictDoNothing();
    }
    await q
      .insert(files)
      .values(rows.map((row, ord) => ({ ...row, ownerId, revisionId, ord, mediaType: "text/plain" })));
  });
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
    turn: null,
    answerWaiting: false,
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
    "answerWaiting",
    "approved",
    "branch",
    "id",
    "newest",
    "state",
    "title",
    "turn",
    "updatedAt",
    "url",
  ]);
  expect(Object.keys(item.newest).sort()).toEqual(["diff", "head", "revision"]);
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
  expect(items.find((item) => item.id === snoozed)).toMatchObject({ turn: null, answerWaiting: false });
  expect(items.find((item) => item.id === settled)).toMatchObject({ turn: null, answerWaiting: false });
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
async function items(query = "", who: "agent" | "stranger" | "otherAgent" = "agent") {
  const response = await f.request(`/agent/reviews${query}`, "GET", undefined, who);
  expect(response.status).toBe(200);
  return AgentReviewList.parse(await response.json()).items;
}

test("a revision containing only a doc reports the empty diff", async () => {
  await seedFiles(f.revisionId, [{ path: "plan.md", role: "doc", newBlob: newHash }]);
  await approve(f.reviewId, 1);
  const [item] = await items();
  expect(item?.newest?.diff).toEqual(emptyDiff);
  expect(item?.approved?.diff).toEqual(emptyDiff);
});

test("a revision deleted between the list and file queries has an unreported diff", async () => {
  let deleted = false;
  const db: Db = {
    ...f.db,
    read: async (query) => {
      const result = await f.db.read(query);
      if (!deleted) {
        await f.db.query((q) => q.delete(revisions).where(eq(revisions.id, f.revisionId)));
        deleted = true;
      }
      return result;
    },
  };
  const list = await listAgentReviews(
    db,
    {
      ownerId: f.ownerId,
      instanceId: f.instanceId,
      kind: "agent",
      tokenId: "",
      scopes: ["publish"],
    },
    f.deps.config.baseUrl,
  );
  expect(list.items[0]?.newest).toEqual({ revision: 1, head: null, diff: null });
});

test("the digest hashes one sorted line for each side shown in the revision's diff", async () => {
  await seedFiles(f.revisionId, [
    { role: "diff", status: "renamed", oldPath: "before", path: "renamed", oldBlob: oldHash, newBlob: newHash },
    { role: "diff", status: "mode-changed", path: "mode", oldBlob: oldHash, newBlob: oldHash },
    { role: "diff", status: "deleted", path: "deleted", oldBlob: oldHash },
    { role: "diff", status: "modified", path: "edit", oldBlob: oldHash, newBlob: newHash },
    { role: "diff", status: "added", path: "added", newBlob: newHash },
    { role: "diff", status: "modified", path: "binary", flag: "binary" },
    { role: "diff", status: null, path: "partial", newBlob: newHash },
    { role: "diff", status: "modified", path: "large", oldBlob: oldHash, flag: "oversized" },
    { role: "doc", path: "plan.md", newBlob: newHash },
  ]);
  const expected =
    `added\tnew\t${newHash}\nbefore\told\t${oldHash}\nbinary\tnew\tbinary\nbinary\told\tbinary\n` +
    `deleted\told\t${oldHash}\nedit\tnew\t${newHash}\nedit\told\t${oldHash}\n` +
    `large\tnew\toversized\nlarge\told\t${oldHash}\nmode\tnew\t${oldHash}\nmode\told\t${oldHash}\n` +
    `partial\tnew\t${newHash}\nrenamed\tnew\t${newHash}\n`;
  expect((await items())[0]?.newest?.diff).toEqual({ files: 8, digest: digest(expected) });
});

test("a rename and the same deletion and addition have equal digests", async () => {
  await seedFiles(f.revisionId, [
    { role: "diff", path: "b", oldPath: "a", status: "renamed", oldBlob: oldHash, newBlob: newHash },
  ]);
  const renamed = (await items())[0]?.newest?.diff;
  expect(renamed?.files).toBe(1);
  await seedFiles(await f.revision(2), [
    { role: "diff", path: "b", status: "added", newBlob: newHash },
    { role: "diff", path: "a", status: "deleted", oldBlob: oldHash },
  ]);
  expect((await items())[0]?.newest?.diff).toEqual({ files: 2, digest: renamed?.digest });
});

test.each(["go", "approve"] as const)("an answer waits from %s through any unconfirmed lease", async (kind) => {
  const waiting = async () => (await items())[0]?.answerWaiting;
  expect(await waiting()).toBe(false);
  await f.send(kind === "go" ? { revision: 1, kind, instruction: "Synthetic feedback" } : { revision: 1, kind });
  expect(await waiting()).toBe(true);
  expect(await f.take()).toMatchObject({ kind });
  expect(await waiting()).toBe(true);
  f.advance(121_000);
  expect(await waiting()).toBe(true);
  const retry = await f.take();
  if (retry.kind !== kind) throw new Error("missing redelivery");
  expect((await f.request(`/deliveries/${retry.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
  expect(await waiting()).toBe(false);
});

test("the turn follows a live Send on the newest revision and clears on approval", async () => {
  const first = await publishAs("agent", "d", shaA);
  const current = async () => (await items()).find((row) => row.id === first.reviewId);
  expect(await current()).toMatchObject({ state: "open", turn: "reviewer" });
  const sent = await f.request(`/reviews/${first.reviewId}/sends`, "POST", {
    revision: 1,
    kind: "go",
    instruction: "Synthetic feedback",
  });
  expect(sent.status).toBe(201);
  expect(await current()).toMatchObject({ state: "open", turn: "agent" });
  await publishAs("agent", "d", shaB);
  expect(await current()).toMatchObject({ newest: { revision: 2 }, turn: "reviewer" });
  await approve(first.reviewId, 2);
  expect(await current()).toMatchObject({ state: "approved", turn: null });
});

test("a Send that was set aside does not pass the turn to the agent", async () => {
  await f.send({ revision: 1, kind: "go", instruction: "Synthetic feedback" });
  expect((await items()).find((row) => row.id === f.reviewId)).toMatchObject({ turn: "agent", answerWaiting: true });
  await f.db.query((q) => q.update(sends).set({ setAsideAt: f.deps.now() }).where(eq(sends.reviewId, f.reviewId)));
  expect((await items()).find((row) => row.id === f.reviewId)).toMatchObject({
    turn: "reviewer",
    answerWaiting: false,
  });
});

test("a retired review has no turn even with a Send on its newest revision", async () => {
  await f.send({ revision: 1, kind: "go", instruction: "Synthetic feedback" });
  await f.db.query((q) => q.update(reviews).set({ state: "settled" }).where(eq(reviews.id, f.reviewId)));
  expect((await items()).find((row) => row.id === f.reviewId)).toMatchObject({ state: "settled", turn: null });
});

test("the key lookup keeps only the exact key within the owner and origin instance", async () => {
  // The fixture review already has key "a" and belongs to the first agent.
  await seedFiles(f.revisionId, [{ role: "diff", path: "own", status: "added", newBlob: newHash }]);
  await approve(f.reviewId, 1);
  await publishAs("agent", "e", shaA);
  const second = await publishAs("otherAgent", "a", shaA);
  const foreign = await publishAs("stranger", "a", shaA);
  const query = `?key=${"a".repeat(64)}`;
  const ownDiff = { files: 1, digest: digest(`own\tnew\t${newHash}\n`) };
  expect(await items(query)).toMatchObject([
    { id: f.reviewId, answerWaiting: true, newest: { diff: ownDiff }, approved: { diff: ownDiff } },
  ]);
  expect(await items(query, "otherAgent")).toMatchObject([
    { id: second.reviewId, answerWaiting: false, newest: { diff: emptyDiff }, approved: null },
  ]);
  expect(await items(query, "stranger")).toMatchObject([
    { id: foreign.reviewId, answerWaiting: false, newest: { diff: emptyDiff }, approved: null },
  ]);
  expect(await items(`?key=${"f".repeat(64)}`)).toEqual([]);
});

test("a malformed or repeated key is a 400", async () => {
  for (const query of [
    "?key=",
    `?key=${"a".repeat(63)}`,
    `?key=${"A".repeat(64)}`,
    `?key=${"a".repeat(64)}&key=${"a".repeat(64)}`,
  ])
    await error(await f.request(`/agent/reviews${query}`, "GET", undefined, "agent"), 400, "invalid_request");
});

test("key and head filters must both match", async () => {
  const own = await publishAs("agent", "d", shaA);
  await publishAs("agent", "e", shaB);
  const query = `?key=${"d".repeat(64)}`;
  expect((await items(`${query}&head=${shaA}`)).map((row) => row.id)).toEqual([own.reviewId]);
  expect(await items(`${query}&head=${shaB}`)).toEqual([]);
  expect(await items(`?key=${"f".repeat(64)}&head=${shaA}`)).toEqual([]);
});

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

test("an approval of an older revision keeps its own head and diff while a newer one exists", async () => {
  await f.db.query((q) => q.update(revisions).set({ head: shaA }).where(eq(revisions.id, f.revisionId)));
  await seedFiles(f.revisionId, [{ role: "diff", path: "old", status: "deleted", oldBlob: oldHash }]);
  await approve(f.reviewId, 1);
  // An import can retain the approval pointer when a newer revision exists.
  const nextId = await f.revision(2);
  await f.db.query((q) => q.update(revisions).set({ head: shaB }).where(eq(revisions.id, nextId)));
  await seedFiles(nextId, [{ role: "diff", path: "new", status: "added", newBlob: newHash }]);
  for (const head of [shaA, shaB]) {
    expect(await items(`?head=${head}`)).toMatchObject([
      {
        approved: { revision: 1, head: shaA, diff: { files: 1, digest: digest(`old\told\t${oldHash}\n`) } },
        newest: { revision: 2, head: shaB, diff: { files: 1, digest: digest(`new\tnew\t${newHash}\n`) } },
        // The approval is unclaimed and its revision is not the newest, so take would set it aside.
        answerWaiting: false,
      },
    ]);
  }
});

test("a delivery that holds an approval of an older revision still counts as a waiting answer", async () => {
  await approve(f.reviewId, 1);
  await f.revision(2);
  const claimed = await f.db.read((q) => q.select().from(sends).where(eq(sends.reviewId, f.reviewId)).get());
  expect(claimed?.deliveryId).toBeNull();
  const deliveryId = randomUUID();
  await f.db.query(async (q) => {
    await q.insert(deliveries).values({
      id: deliveryId,
      ownerId: f.ownerId,
      reviewId: f.reviewId,
      leaseUntil: f.deps.now() + 120_000,
    });
    await q.update(sends).set({ deliveryId }).where(eq(sends.reviewId, f.reviewId));
  });
  expect((await items())[0]?.answerWaiting).toBe(true);
  await f.db.query((q) => q.update(deliveries).set({ confirmedAt: f.deps.now() }).where(eq(deliveries.id, deliveryId)));
  expect((await items())[0]?.answerWaiting).toBe(false);
});

test("a revision of more than 1000 diff rows yields between chunks of at most 500 rows", async () => {
  const total = 1200;
  for (let start = 0; start < total; start += 200) {
    await f.db.query((q) =>
      q.insert(files).values(
        Array.from({ length: 200 }, (_, i) => ({
          ownerId: f.ownerId,
          revisionId: f.revisionId,
          path: `file-${String(start + i).padStart(4, "0")}.bin`,
          role: "diff" as const,
          status: "added" as const,
          flag: "binary" as const,
          ord: start + i,
          mediaType: "application/octet-stream",
        })),
      ),
    );
  }
  const log = observePacing(f.deps);
  try {
    const [item] = await items();
    const lines = Array.from({ length: total }, (_, i) => `file-${String(i).padStart(4, "0")}.bin\tnew\tbinary\n`);
    expect(item?.newest?.diff).toEqual({ files: total, digest: digest(lines.join("")) });
    // Each added row makes one line, so the row loop and the hash loop yield at 500 and 1000 each.
    const phases = log.events.filter((event) => event.kind === "yield" && event.phase === "agent-review-diff");
    expect(phases).toHaveLength(4);
  } finally {
    log.restore();
  }
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

test("the head and key filters apply before the row limit", async () => {
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
  expect((await items(`?key=${"d".repeat(64)}`)).map((row) => row.id)).toEqual([target.reviewId]);
});

test("listing with head and key filters changes no row and takes or confirms no delivery", async () => {
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
  for (const query of ["", `?head=${shaA}`, `?head=${shaB}`, `?head=${shaC}`, `?key=${"d".repeat(64)}`, ""])
    await items(query);
  expect(await snapshot()).toEqual(before);
  expect(before.deliveries.every((row) => row.confirmedAt === null)).toBe(true);
});
