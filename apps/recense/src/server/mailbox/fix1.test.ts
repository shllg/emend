import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { comments, reviews, sends, threads } from "../../db/schema.ts";
import { error, mailboxFixture } from "./test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
const threadState = (id: string) =>
  f.db.read((q) =>
    q
      .select()
      .from(threads)
      .where(and(eq(threads.ownerId, f.ownerId), eq(threads.id, id)))
      .get(),
  );

test("a clock step never puts an unsent draft into history", async () => {
  const t = await f.thread("Sent text");
  await f.send();
  f.advance(-1000);
  await f.comment(t.threadId, "Unsent draft after clock step");
  const result = await f.take();
  expect(result).toMatchObject({ kind: "go", comments: [{ body: "Sent text", history: [] }] });
  expect(JSON.stringify(result)).not.toContain("Unsent draft");
});
test("history uses insertion order, excludes all delivered comments, and includes earlier sent text", async () => {
  const t = await f.thread("Earlier sent text");
  await f.send();
  const first = await f.take();
  if (first.kind !== "go") throw new Error("not go");
  await f.request(`/deliveries/${first.deliveryId}/confirm`, "POST", undefined, "agent");
  for (const body of ["First reply", "Second reply"]) {
    f.advance(-1000);
    expect((await f.request(`/comments/${t.commentId}/reply`, "POST", { outcome: "held", body }, "agent")).status).toBe(
      201,
    );
  }
  await f.comment(t.threadId, "First delivered now");
  await f.send();
  f.advance(-1000);
  await f.comment(t.threadId, "Second delivered now");
  await f.send();
  const result = await f.take();
  if (result.kind !== "go") throw new Error("not go");
  expect(result.comments.map((c) => c.body)).toEqual(["First delivered now", "Second delivered now"]);
  for (const c of result.comments)
    expect(c.history.map((h) => h.body)).toEqual(["Earlier sent text", "First reply", "Second reply"]);
});
test("missing placements deliver not-placed and log once without ids or text", async () => {
  const t = await f.thread("Synthetic comment");
  await f.comment(t.threadId, "Another synthetic comment");
  await f.revision(2);
  await f.send({ revision: 2, kind: "go" });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await f.take();
  if (result.kind !== "go") throw new Error("not go");
  for (const c of result.comments)
    expect(c).toMatchObject({ target: { kind: "review" }, placement: { status: "unplaced", reason: "not-placed" } });
  expect(log).toHaveBeenCalledExactlyOnceWith("recense: missing placement during handoff");
});
test("agent replies must target sent user comments", async () => {
  const t = await f.thread();
  await error(
    await f.request(`/comments/${t.commentId}/reply`, "POST", { outcome: "held", body: "Not allowed" }, "agent"),
    404,
    "not_found",
  );
  await f.send();
  const response = await f.request(
    `/comments/${t.commentId}/reply`,
    "POST",
    { outcome: "held", body: "Allowed" },
    "agent",
  );
  expect(response.status).toBe(201);
  const reply = (await response.json()) as { commentId: string };
  await error(
    await f.request(`/comments/${reply.commentId}/reply`, "POST", { outcome: "held", body: "Not allowed" }, "agent"),
    404,
    "not_found",
  );
  expect(await f.db.read((q) => q.select().from(comments).where(eq(comments.ownerId, f.ownerId)))).toHaveLength(2);
});
test("replying on a reviewer-resolved thread stores the reply without reopening it", async () => {
  const t = await f.thread();
  await f.send();
  expect((await f.request(`/threads/${t.threadId}/resolve`)).status).toBe(204);
  expect(
    (await f.request(`/comments/${t.commentId}/reply`, "POST", { outcome: "fixed", body: "Reply" }, "agent")).status,
  ).toBe(201);
  expect(await threadState(t.threadId)).toMatchObject({ state: "resolved" });
  expect(await f.db.read((q) => q.select().from(comments).where(eq(comments.ownerId, f.ownerId)))).toHaveLength(2);
});
test("setting aside an older approval preserves the newer review approval", async () => {
  await f.send({ revision: 1, kind: "approve" });
  const newest = await f.revision(2);
  await f.send({ revision: 2, kind: "approve" });
  expect(await f.take()).toMatchObject({ kind: "approve", revision: 2 });
  expect(await f.review()).toMatchObject({ state: "approved", approvedRevision: newest });
});
test("expired mixed deliveries re-evaluate their set-aside approval", async () => {
  await f.thread();
  await f.send();
  await f.send({ revision: 1, kind: "approve" });
  const first = await f.take();
  expect(first).toMatchObject({ kind: "go", approvalSetAside: true });
  f.advance(121000);
  expect(await f.take()).toMatchObject({ kind: "go", approvalSetAside: true });
});
test("take defaults a missing or empty body, but other routes still require JSON", async () => {
  const original = f.app.request.bind(f.app);
  for (const body of [undefined, ""]) {
    f.app.request = ((input, init, env, executionCtx) =>
      original(
        input,
        {
          ...init,
          body,
          headers: Object.fromEntries(Object.entries(init?.headers ?? {}).filter(([key]) => key !== "Content-Type")),
        },
        env,
        executionCtx,
      )) as typeof f.app.request;
    expect((await f.request(`/reviews/${f.reviewId}/take`, "POST", undefined, "agent")).status).toBe(200);
    await error(await f.request(`/reviews/${f.reviewId}/threads`), 400, "invalid_request");
  }
  for (const body of ["not-json", " ", "null", "[]"]) {
    f.app.request = ((input, init, env, executionCtx) =>
      original(input, { ...init, body }, env, executionCtx)) as typeof f.app.request;
    await error(await f.request(`/reviews/${f.reviewId}/take`, "POST", undefined, "agent"), 400, "invalid_request");
  }
});
test("confirm remains available on a moved review while take refuses it", async () => {
  await f.thread();
  await f.send();
  const delivery = await f.take();
  if (delivery.kind !== "go") throw new Error("not go");
  await f.db.query((q) =>
    q
      .update(reviews)
      .set({ movedToUrl: "https://example.test/r/moved" })
      .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, f.reviewId))),
  );
  expect((await f.request(`/deliveries/${delivery.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
  f.advance(121000);
  await error(await f.request(`/reviews/${f.reviewId}/take`, "POST", {}, "agent"), 409, "review_moved");
  await f.db.query((q) =>
    q
      .update(reviews)
      .set({ movedToUrl: null })
      .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, f.reviewId))),
  );
  expect(await f.take()).toMatchObject({ kind: "pending" });
  expect((await f.db.read((q) => q.select().from(sends).where(eq(sends.ownerId, f.ownerId))))[0]?.deliveryId).toBe(
    delivery.deliveryId,
  );
});
test.each(["sent", "answered", "resolved"] as const)("a user comment opens a %s thread", async (state) => {
  const t = await f.thread();
  await f.send();
  await f.db.query((q) =>
    q
      .update(threads)
      .set({ state })
      .where(and(eq(threads.ownerId, f.ownerId), eq(threads.id, t.threadId))),
  );
  await f.comment(t.threadId, "New unsent comment");
  expect(await threadState(t.threadId)).toMatchObject({ state: "open" });
});
