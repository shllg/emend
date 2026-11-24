import { randomUUID } from "node:crypto";
import { LIMITS, WaitResult } from "@recense/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { comments, sends } from "../../db/schema.ts";
import { takeDelivery } from "./take.ts";
import { error, mailboxFixture } from "./test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  await f.cleanup();
});
async function seed(threadId: string, count: number, body: string, author: "user" | "agent" = "user") {
  await f.db.transaction(async (q) => {
    for (let i = 0; i < count; i++)
      await q.insert(comments).values({
        ownerId: f.ownerId,
        reviewId: f.reviewId,
        threadId,
        author,
        body,
        createdAt: f.deps.now(),
        ...(author === "agent" ? { outcome: "held" as const } : {}),
      });
  });
}
test("250 comments of 20000 characters deliver once under the byte budget", async () => {
  const t = await f.thread("x".repeat(20000));
  await seed(t.threadId, 249, "x".repeat(20000));
  await f.send();
  const result = await takeDelivery(
    f.db,
    { ownerId: f.ownerId, tokenId: randomUUID(), kind: "agent", instanceId: f.instanceId, scopes: ["take"] },
    f.reviewId,
    f.deps.now(),
  );
  if (result?.kind !== "go") throw new Error("not go");
  // Fail before serializing the old implementation's >600 MB response.
  expect(result.comments.every((c) => c.history.length === 0)).toBe(true);
  expect(result.comments).toHaveLength(250);
  expect(Buffer.byteLength(JSON.stringify(WaitResult.parse(result)))).toBeLessThanOrEqual(LIMITS.handoffBytes);
  expect(await f.take()).toMatchObject({ kind: "pending" });
});
test("499 large agent replies trim oldest histories and flag each affected comment", async () => {
  const t = await f.thread("Previous user comment");
  await f.send();
  const first = await f.take();
  if (first.kind !== "go") throw new Error("not go");
  await f.request(`/deliveries/${first.deliveryId}/confirm`, "POST", undefined, "agent");
  await seed(t.threadId, 499, "r".repeat(20000), "agent");
  await seed(t.threadId, 60, "Later comment");
  await f.send();
  const response = await f.request(`/reviews/${f.reviewId}/take`, "POST", {}, "agent");
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LIMITS.handoffBytes);
  const result = WaitResult.parse(JSON.parse(text));
  if (result.kind !== "go") throw new Error("not go");
  expect(result.comments).toHaveLength(60);
  expect(result.comments.some((c) => c.historyTrimmed)).toBe(true);
  for (const c of result.comments) {
    expect(c.body).toBe("Later comment");
    if (c.history.length < 500) {
      expect(c.historyTrimmed).toBe(true);
      expect(c.history.every((h) => h.author === "agent")).toBe(true);
    } else expect(c.historyTrimmed).toBeUndefined();
  }
});
test("the byte cap leaves a whole later Send queued", async () => {
  for (const prefix of ["a", "b"]) {
    const t = await f.thread(prefix.repeat(20000));
    await seed(t.threadId, 449, prefix.repeat(20000));
    await f.send();
  }
  const first = await takeDelivery(
    f.db,
    { ownerId: f.ownerId, tokenId: randomUUID(), kind: "agent", instanceId: f.instanceId, scopes: ["take"] },
    f.reviewId,
    f.deps.now(),
  );
  if (first?.kind !== "go") throw new Error("not go");
  expect(first.comments).toHaveLength(450);
  expect(first.comments.every((c) => c.body.startsWith("a"))).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(LIMITS.handoffBytes);
  const second = await f.take();
  if (second.kind !== "go") throw new Error("not go");
  expect(second.comments).toHaveLength(450);
  expect(second.comments.every((c) => c.body.startsWith("b"))).toBe(true);
});
test.each(["x".repeat(20000), "界".repeat(20000), `${"\u0001".repeat(19999)}x`])(
  "Send refuses content over the JSON UTF-8 budget without binding it (%#)",
  async (body) => {
    const count = Math.floor(LIMITS.handoffBytes / Buffer.byteLength(JSON.stringify(body))) + 1;
    const t = await f.thread(body);
    await seed(t.threadId, count - 1, body);
    await error(await f.request(`/reviews/${f.reviewId}/sends`, "POST", { revision: 1, kind: "go" }), 413, "too_large");
    expect(await f.db.read((q) => q.select().from(sends).where(eq(sends.ownerId, f.ownerId)))).toHaveLength(0);
    expect(
      (
        await f.db.read((q) =>
          q.select({ sendId: comments.sendId }).from(comments).where(eq(comments.ownerId, f.ownerId)),
        )
      ).every((c) => c.sendId === null),
    ).toBe(true);
  },
);
