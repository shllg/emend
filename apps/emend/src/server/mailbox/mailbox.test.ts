import { randomUUID } from "node:crypto";
import { LIMITS } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { comments, deliveries, placements, reviews, sends, threads } from "../../db/schema.ts";
import { takeDelivery } from "./take.ts";
import { error, mailboxFixture, seedComments } from "./test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  await f.cleanup();
});
const go = (instruction?: string, mode = "fix-clear", revision = 1) => ({ kind: "go", revision, mode, instruction });
async function rows() {
  return f.db.read(async (q) => ({
    comments: await q.select().from(comments).where(eq(comments.ownerId, f.ownerId)),
    threads: await q.select().from(threads).where(eq(threads.ownerId, f.ownerId)),
    sends: await q.select().from(sends).where(eq(sends.ownerId, f.ownerId)),
    deliveries: await q.select().from(deliveries).where(eq(deliveries.ownerId, f.ownerId)),
    placements: await q.select().from(placements).where(eq(placements.ownerId, f.ownerId)),
  }));
}

test("nothing to take returns pending without creating a delivery", async () => {
  expect(
    await takeDelivery(
      f.db,
      { ownerId: f.ownerId, tokenId: randomUUID(), kind: "agent", instanceId: f.instanceId, scopes: ["take"] },
      f.reviewId,
      f.deps.now(),
    ),
  ).toBeNull();
  expect(await f.take()).toEqual({ kind: "pending", reviewId: f.reviewId, waitedSeconds: 0 });
  expect((await rows()).deliveries).toHaveLength(0);
});
test("two Sends merge instructions in creation order and use the newest go mode and sentOn", async () => {
  const first = await f.thread("First");
  await f.send(go("First instruction", "explain"));
  await f.comment(first.threadId, "Second");
  const secondRevision = await f.revision(2);
  // A real publish places threads; seed its equivalent for this mailbox-only test.
  const old = (await rows()).placements[0];
  if (!old) throw new Error("missing placement");
  await f.db.query((q) => q.insert(placements).values({ ...old, revisionId: secondRevision }));
  await f.send(go("Second instruction", "fix-all", 2));
  const result = await f.take();
  expect(result).toMatchObject({
    kind: "go",
    revision: 2,
    sentOn: 2,
    mode: "fix-all",
    modeLabel: "Fix everything",
    instructions: ["First instruction", "Second instruction"],
    comments: [{ body: "First" }, { body: "Second" }],
  });
  expect((await rows()).deliveries).toHaveLength(1);
});
test("comments saved after Send wait for the next Send and history excludes later unsent text", async () => {
  const thread = await f.thread("First");
  await f.send();
  const second = await f.comment(thread.threadId, "Later unsent");
  const firstTake = await f.take();
  expect(firstTake).toMatchObject({ kind: "go", comments: [{ id: thread.commentId, body: "First", history: [] }] });
  expect(JSON.stringify(firstTake)).not.toContain("Later unsent");
  await f.send();
  expect(await f.take()).toMatchObject({
    kind: "go",
    comments: [{ id: second.commentId, history: [{ author: "user", body: "First" }] }],
  });
  expect(await f.take()).toMatchObject({ kind: "pending" });
});
test("offers the same comments under a new delivery id after 121 seconds; late confirms fail", async () => {
  const thread = await f.thread();
  await f.send();
  const first = await f.take();
  if (first.kind !== "go") throw new Error("not go");
  f.advance(121000);
  await error(await f.request(`/deliveries/${first.deliveryId}/confirm`, "POST", undefined, "agent"), 404, "not_found");
  const next = await f.take();
  expect(next).toMatchObject({ kind: "go", comments: [{ id: thread.commentId }] });
  if (next.kind !== "go") throw new Error("not go");
  expect(next.deliveryId).not.toBe(first.deliveryId);
  expect((await rows()).deliveries).toHaveLength(1);
});
test("a confirmed delivery is never offered again; the lease endpoint is inclusive", async () => {
  await f.thread();
  await f.send();
  const result = await f.take();
  if (result.kind !== "go") throw new Error("not go");
  f.advance(120000);
  expect((await f.request(`/deliveries/${result.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
  await error(
    await f.request(`/deliveries/${result.deliveryId}/confirm`, "POST", undefined, "agent"),
    404,
    "not_found",
  );
  f.advance(121000);
  expect(await f.take()).toMatchObject({ kind: "pending" });
});
test("two concurrent takes deliver each comment exactly once", async () => {
  const t = await f.thread();
  await f.send();
  const results = await Promise.all([f.take(), f.take()]);
  expect(results.flatMap((r) => (r.kind === "go" ? r.comments.map((c) => c.id) : []))).toEqual([t.commentId]);
  expect(results.filter((r) => r.kind === "pending")).toHaveLength(1);
});
test("go plus approve sets approval aside and reopens the review", async () => {
  await f.thread();
  await f.send();
  await f.send({ revision: 1, kind: "approve" });
  expect(await f.review()).toMatchObject({ state: "approved", approvedRevision: f.revisionId });
  expect(await f.take()).toMatchObject({ kind: "go", approvalSetAside: true });
  expect(await f.review()).toMatchObject({ state: "open", approvedRevision: null });
  expect((await rows()).sends.find((s) => s.kind === "approve")?.setAsideAt).toBeTypeOf("number");
});
test("an approval for an older revision is set aside without a delivery", async () => {
  await f.revision(2);
  await f.send({ revision: 2, kind: "approve" });
  await f.revision(3);
  expect(await f.take()).toMatchObject({ kind: "pending" });
  expect(await f.review()).toMatchObject({ state: "open", approvedRevision: null });
  expect((await rows()).deliveries).toHaveLength(0);
  expect((await rows()).sends[0]?.setAsideAt).toBeTypeOf("number");
});
test("an approval alone is delivered and can be confirmed", async () => {
  await f.send({ revision: 1, kind: "approve" });
  const result = await f.take();
  expect(result).toMatchObject({ kind: "approve", revision: 1 });
  if (result.kind !== "approve") throw new Error("not approve");
  expect((await f.request(`/deliveries/${result.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
});
test("stale Send binds nothing; empty go and approve with unsent comments are refused", async () => {
  await error(await f.request(`/reviews/${f.reviewId}/sends`, "POST", go()), 400, "empty_send");
  await error(await f.request(`/reviews/${f.reviewId}/sends`, "POST", go("  ")), 400, "empty_send");
  await f.thread();
  await error(
    await f.request(`/reviews/${f.reviewId}/sends`, "POST", { revision: 1, kind: "approve" }),
    409,
    "unsent_comments",
  );
  await f.revision(2);
  await f.revision(3);
  await error(
    await f.request(`/reviews/${f.reviewId}/sends`, "POST", go("stale", "fix-all", 2)),
    409,
    "stale_revision",
  );
  expect((await rows()).sends).toHaveLength(0);
  expect((await rows()).comments[0]?.sendId).toBeNull();
});
test("comments are editable before Send and frozen afterwards; deleting the last deletes placements", async () => {
  const t = await f.thread();
  expect((await f.request(`/comments/${t.commentId}`, "PATCH", { body: "Edited" })).status).toBe(204);
  expect((await rows()).comments[0]?.body).toBe("Edited");
  await f.send();
  for (const method of ["PATCH", "DELETE"])
    await error(
      await f.request(`/comments/${t.commentId}`, method, method === "PATCH" ? { body: "Again" } : undefined),
      409,
      "comment_frozen",
    );
  const removable = await f.thread("Remove");
  expect((await f.request(`/comments/${removable.commentId}`, "DELETE")).status).toBe(204);
  expect((await rows()).threads.map((r) => r.id)).toEqual([t.threadId]);
  expect((await rows()).placements.map((r) => r.threadId)).toEqual([t.threadId]);
});
test.each(["fixed", "explained", "held", "declined"])(
  "reply outcome %s answers without resolving or Sending; reviewer followup reopens",
  async (outcome) => {
    const t = await f.thread();
    await f.send();
    const response = await f.request(`/comments/${t.commentId}/reply`, "POST", { outcome, body: "Response" }, "agent");
    expect(response.status).toBe(201);
    const reply = (await response.json()) as { commentId: string };
    expect((await rows()).threads[0]?.state).toBe("answered");
    expect((await rows()).sends).toHaveLength(1);
    expect((await rows()).deliveries).toHaveLength(0);
    for (const method of ["PATCH", "DELETE"])
      await error(await f.request(`/comments/${reply.commentId}`, method, { body: "Replace" }), 404, "not_found");
    await error(
      await f.request(`/comments/${t.commentId}/reply`, "POST", { outcome: "resolved", body: "No" }, "agent"),
      400,
      "invalid_request",
    );
    await f.comment(t.threadId, "Followup");
    expect((await rows()).threads[0]?.state).toBe("open");
    await f.send();
    const result = await f.take();
    if (result.kind !== "go") throw new Error("not go");
    expect(result.comments.at(-1)?.history).toEqual([{ author: "agent", body: "Response", outcome }]);
  },
);
test("reviewer resolve and reopen work while agents cannot create reviewer actions", async () => {
  const t = await f.thread();
  for (const [action, state] of [
    ["resolve", "resolved"],
    ["reopen", "open"],
  ]) {
    expect((await f.request(`/threads/${t.threadId}/${action}`)).status).toBe(204);
    expect((await rows()).threads[0]?.state).toBe(state);
    await error(await f.request(`/threads/${t.threadId}/${action}`, "POST", undefined, "agent"), 403, "forbidden");
  }
  for (const [path, body] of [
    [`/reviews/${f.reviewId}/threads`, { revision: 1, target: { kind: "review" }, body: "Fake" }],
    [`/threads/${t.threadId}/comments`, { body: "Fake" }],
    [`/reviews/${f.reviewId}/sends`, go("Fake")],
  ] as const)
    await error(await f.request(path, "POST", body, "agent"), 403, "forbidden");
});
test("foreign and missing review, thread, comment and delivery ids return 404 on every endpoint", async () => {
  const t = await f.thread();
  await f.send();
  const delivery = await f.take();
  if (delivery.kind !== "go") throw new Error("not go");
  for (const missing of [false, true]) {
    const review = missing ? randomUUID() : f.reviewId;
    const thread = missing ? randomUUID() : t.threadId;
    const comment = missing ? randomUUID() : t.commentId;
    const lease = missing ? randomUUID() : delivery.deliveryId;
    for (const [path, method, body, code] of [
      [`/reviews/${review}/threads`, "POST", { revision: 1, target: { kind: "review" }, body: "No" }, "unknown_review"],
      [`/reviews/${review}/sends`, "POST", go("No"), "unknown_review"],
      [`/reviews/${review}/events`, "GET", undefined, "unknown_review"],
      [`/threads/${thread}/comments`, "POST", { body: "No" }, "not_found"],
      [`/threads/${thread}/resolve`, "POST", undefined, "not_found"],
      [`/threads/${thread}/reopen`, "POST", undefined, "not_found"],
      [`/comments/${comment}`, "PATCH", { body: "No" }, "not_found"],
      [`/comments/${comment}`, "DELETE", undefined, "not_found"],
    ] as const)
      await error(await f.request(path, method, body, "foreign"), 404, code);
    for (const who of ["stranger", "otherAgent"] as const) {
      await error(await f.request(`/reviews/${review}/take`, "POST", {}, who), 404, "unknown_review");
      await error(
        await f.request(`/comments/${comment}/reply`, "POST", { outcome: "held", body: "No" }, who),
        404,
        "not_found",
      );
      await error(await f.request(`/deliveries/${lease}/confirm`, "POST", undefined, who), 404, "not_found");
    }
  }
});
test("moved reviews refuse new feedback mutations", async () => {
  const t = await f.thread();
  await f.send();
  const delivery = await f.take();
  if (delivery.kind !== "go") throw new Error("not go");
  await f.db.query((q) =>
    q
      .update(reviews)
      .set({ movedToUrl: "https://example.test/r/moved" })
      .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, f.reviewId))),
  );
  for (const [path, method, body, who] of [
    [`/reviews/${f.reviewId}/threads`, "POST", { revision: 1, target: { kind: "review" }, body: "No" }, "reviewer"],
    [`/reviews/${f.reviewId}/sends`, "POST", go("No"), "reviewer"],
    [`/reviews/${f.reviewId}/take`, "POST", {}, "agent"],
    [`/threads/${t.threadId}/comments`, "POST", { body: "No" }, "reviewer"],
    [`/threads/${t.threadId}/resolve`, "POST", undefined, "reviewer"],
    [`/threads/${t.threadId}/reopen`, "POST", undefined, "reviewer"],
    [`/comments/${t.commentId}`, "PATCH", { body: "No" }, "reviewer"],
    [`/comments/${t.commentId}`, "DELETE", undefined, "reviewer"],
    [`/comments/${t.commentId}/reply`, "POST", { body: "No", outcome: "held" }, "agent"],
  ] as const)
    await error(await f.request(path, method, body, who), 409, "review_moved");
});
test("instruction cap leaves whole Sends for the next take", async () => {
  for (let i = 0; i <= LIMITS.instructionsPerHandoff; i++) await f.send(go(`Instruction ${i}`));
  const first = await f.take();
  if (first.kind !== "go") throw new Error("not go");
  expect(first.instructions).toHaveLength(LIMITS.instructionsPerHandoff);
  expect(await f.take()).toMatchObject({ kind: "go", instructions: [`Instruction ${LIMITS.instructionsPerHandoff}`] });
});
test("comment cap leaves a whole Send queued and history is the newest suffix, oldest first", async () => {
  const t = await f.thread("First");
  await seedComments(f, t.threadId, LIMITS.commentsPerHandoff - 2, { body: "Comment ", digits: 0 });
  await f.send();
  await f.comment(t.threadId, "Next send");
  await f.comment(t.threadId, "Also next send");
  await f.send();
  const first = await f.take();
  if (first.kind !== "go") throw new Error("not go");
  expect(first.comments).toHaveLength(LIMITS.commentsPerHandoff - 1);
  expect(first.comments.at(-1)?.history).toHaveLength(0);
  const next = await f.take();
  expect(next).toMatchObject({ kind: "go", comments: [{ body: "Next send" }, { body: "Also next send" }] });
  if (next.kind !== "go") throw new Error("not go");
  expect(next.comments[0]?.history).toHaveLength(LIMITS.historyPerComment);
  expect(next.comments[0]?.history[0]?.body).toBe(
    `Comment ${LIMITS.commentsPerHandoff - LIMITS.historyPerComment - 1}`,
  );
  expect(next.comments[0]?.history.at(-1)?.body).toBe(`Comment ${LIMITS.commentsPerHandoff - 2}`);
  expect(next.comments.every((c) => c.historyTrimmed)).toBe(true);
});
test("a single oversized Send is refused without binding any comments", async () => {
  const t = await f.thread();
  await seedComments(f, t.threadId, LIMITS.commentsPerHandoff, { body: "Synthetic" });
  await error(await f.request(`/reviews/${f.reviewId}/sends`, "POST", go()), 413, "too_large");
  expect((await rows()).comments.every((c) => c.sendId === null)).toBe(true);
  expect((await rows()).sends).toHaveLength(0);
});
