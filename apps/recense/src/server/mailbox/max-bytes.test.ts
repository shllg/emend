import { LIMITS, WaitResult } from "@recense/contract";
import { and, eq, sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { comments, deliveries, sends } from "../../db/schema.ts";
import { error, mailboxFixture } from "./test-support.ts";

test.each([65535, LIMITS.handoffBytes + 1, 65536.5, "65536", null])(
  "take refuses invalid maxBytes %j",
  async (maxBytes) => {
    const f = await mailboxFixture();
    onTestFinished(() => f.cleanup());
    await error(await f.request(`/reviews/${f.reviewId}/take`, "POST", { maxBytes }, "agent"), 400, "invalid_request");
  },
);

test("a smaller take window leaves whole later Sends queued", async () => {
  const f = await mailboxFixture();
  onTestFinished(() => f.cleanup());
  for (const prefix of ["a", "b", "c", "d"]) {
    await f.thread(prefix.repeat(20000));
    await f.send();
  }
  const response = await f.request(`/reviews/${f.reviewId}/take`, "POST", { maxBytes: 65536 }, "agent");
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);
  const result = WaitResult.parse(JSON.parse(text));
  if (result.kind !== "go") throw new Error("not go");
  expect(result.comments.map((comment) => comment.body[0])).toEqual(["a", "b", "c"]);
  const next = await f.take();
  if (next.kind !== "go") throw new Error("not go");
  expect(next.comments.map((comment) => comment.body[0])).toEqual(["d"]);
});

test("an oversized first Send returns 413 and rolls back every claim", async () => {
  const f = await mailboxFixture();
  onTestFinished(() => f.cleanup());
  const thread = await f.thread('"'.repeat(20000));
  await f.comment(thread.threadId, '"'.repeat(20000));
  const sent = await f.send();
  await error(await f.request(`/reviews/${f.reviewId}/take`, "POST", { maxBytes: 65536 }, "agent"), 413, "too_large");
  expect(
    await f.db.read((q) =>
      q
        .select({ deliveryId: sends.deliveryId })
        .from(sends)
        .where(and(eq(sends.ownerId, f.ownerId), eq(sends.id, sent.sendId)))
        .get(),
    ),
  ).toEqual({ deliveryId: null });
  expect(await f.db.read((q) => q.select().from(deliveries).where(eq(deliveries.ownerId, f.ownerId)))).toEqual([]);
  const result = await f.take();
  if (result.kind !== "go") throw new Error("not go");
  expect(result.comments).toHaveLength(2);
});

test("leading approval and an oversized Go stay queued together until a full-budget take", async () => {
  const f = await mailboxFixture();
  onTestFinished(() => f.cleanup());
  await f.send({ revision: 1, kind: "approve" });
  for (const body of ["a", "b", "c", "d"]) await f.thread(body.repeat(20000));
  await f.send();
  await error(await f.request(`/reviews/${f.reviewId}/take`, "POST", { maxBytes: 65536 }, "agent"), 413, "too_large");
  expect(
    await f.db.read((q) =>
      q
        .select({ kind: sends.kind, deliveryId: sends.deliveryId, setAsideAt: sends.setAsideAt })
        .from(sends)
        .where(and(eq(sends.ownerId, f.ownerId), eq(sends.reviewId, f.reviewId)))
        .orderBy(sql`+sends.rowid`),
    ),
  ).toEqual([
    { kind: "approve", deliveryId: null, setAsideAt: null },
    { kind: "go", deliveryId: null, setAsideAt: null },
  ]);
  expect(await f.db.read((q) => q.select().from(deliveries).where(eq(deliveries.ownerId, f.ownerId)))).toEqual([]);
  expect(await f.review()).toMatchObject({ state: "approved", approvedRevision: f.revisionId });
  const result = await f.take();
  expect(result).toMatchObject({ kind: "go", approvalSetAside: true });
  if (result.kind !== "go") throw new Error("not go");
  expect(result.comments.map((comment) => comment.body[0])).toEqual(["a", "b", "c", "d"]);
  expect(await f.review()).toMatchObject({ state: "open", approvedRevision: null });
});

test("an approval with no queued Go is delivered under the smaller budget", async () => {
  const f = await mailboxFixture();
  onTestFinished(() => f.cleanup());
  await f.send({ revision: 1, kind: "approve" });
  const response = await f.request(`/reviews/${f.reviewId}/take`, "POST", { maxBytes: 65536 }, "agent");
  expect(response.status).toBe(200);
  const result = WaitResult.parse(await response.json());
  expect(result).toMatchObject({ kind: "approve", revision: 1 });
  if (result.kind !== "approve") throw new Error("not approve");
  expect((await f.request(`/deliveries/${result.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
  expect(await f.review()).toMatchObject({ state: "approved", approvedRevision: f.revisionId });
});

test("a window containing Go still sets approval aside and leaves an oversized later Go queued", async () => {
  const f = await mailboxFixture();
  onTestFinished(() => f.cleanup());
  const first = await f.thread("First Go");
  await f.send();
  await f.send({ revision: 1, kind: "approve" });
  for (const body of ["a", "b", "c", "d"]) await f.thread(body.repeat(20000));
  const last = await f.send();
  const response = await f.request(`/reviews/${f.reviewId}/take`, "POST", { maxBytes: 65536 }, "agent");
  expect(response.status).toBe(200);
  const result = WaitResult.parse(await response.json());
  expect(result).toMatchObject({ kind: "go", approvalSetAside: true, comments: [{ id: first.commentId }] });
  if (result.kind !== "go") throw new Error("not go");
  expect(result.comments).toHaveLength(1);
  expect(await f.review()).toMatchObject({ state: "open", approvedRevision: null });
  expect(
    await f.db.read((q) =>
      q
        .select({ deliveryId: sends.deliveryId, setAsideAt: sends.setAsideAt })
        .from(sends)
        .where(and(eq(sends.ownerId, f.ownerId), eq(sends.id, last.sendId)))
        .get(),
    ),
  ).toEqual({ deliveryId: null, setAsideAt: null });
  const next = await f.take();
  expect(next).toMatchObject({ kind: "go", approvalSetAside: false });
  if (next.kind !== "go") throw new Error("not go");
  expect(next.comments.map((comment) => comment.body[0])).toEqual(["a", "b", "c", "d"]);
});

test("history is trimmed to the take budget, retaining the newest entries", async () => {
  const f = await mailboxFixture();
  onTestFinished(() => f.cleanup());
  const thread = await f.thread("Previous comment");
  await f.send();
  const previous = await f.take();
  if (previous.kind !== "go") throw new Error("not go");
  await f.request(`/deliveries/${previous.deliveryId}/confirm`, "POST", undefined, "agent");
  await f.db.transaction(async (q) => {
    for (const body of ["a", "b", "c", "d"])
      await q.insert(comments).values({
        ownerId: f.ownerId,
        reviewId: f.reviewId,
        threadId: thread.threadId,
        author: "agent",
        outcome: "held",
        body: body.repeat(20000),
        createdAt: f.deps.now(),
      });
  });
  await f.comment(thread.threadId, "Follow-up");
  await f.send();
  const response = await f.request(`/reviews/${f.reviewId}/take`, "POST", { maxBytes: 65536 }, "agent");
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);
  const result = WaitResult.parse(JSON.parse(text));
  if (result.kind !== "go") throw new Error("not go");
  expect(result.comments[0]).toMatchObject({ body: "Follow-up", historyTrimmed: true });
  expect(result.comments[0]?.history.map((entry) => entry.body[0])).toEqual(["b", "c", "d"]);
});
