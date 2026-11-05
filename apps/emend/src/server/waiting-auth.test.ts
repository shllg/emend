import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deliveries, devices, reviews, revisions, sends, tokens } from "../db/schema.ts";
import { error, mailboxFixture } from "./mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
let emitted: string[];
let started: ReturnType<typeof Promise.withResolvers<void>>;
beforeEach(async () => {
  f = await mailboxFixture();
  emitted = [];
  started = Promise.withResolvers<void>();
  f.deps.events?.subscribe(f.ownerId, null, (event) => {
    emitted.push(event.type);
    if (event.type === "waiting" && event.reviewId === f.reviewId) started.resolve();
  });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await f.cleanup();
});
const invalidate = (kind: "agent" | "reviewer", field: "revokedAt" | "expiresAt") =>
  f.db.query((q) =>
    q
      .update(tokens)
      .set({ [field]: f.deps.now() })
      .where(and(eq(tokens.ownerId, f.ownerId), eq(tokens.kind, kind))),
  );
async function noClaims() {
  expect(emitted).not.toContain("claimed");
  expect(await f.db.read((q) => q.select().from(deliveries).where(eq(deliveries.ownerId, f.ownerId)))).toHaveLength(0);
  expect(
    (await f.db.read((q) => q.select().from(sends).where(eq(sends.ownerId, f.ownerId)))).every(
      (s) => s.deliveryId === null,
    ),
  ).toBe(true);
}

test.each(["revokedAt", "expiresAt"] as const)(
  "a waiting take whose token becomes %s claims nothing",
  async (field) => {
    const controller = new AbortController();
    const waiting = f.request(`/reviews/${f.reviewId}/take`, "POST", { waitSeconds: 10 }, "agent", controller.signal);
    try {
      await started.promise;
      expect(f.deps.events?.agentWaiting(f.ownerId, f.reviewId)).toBe(true);
      await invalidate("agent", field);
      await f.send({ revision: 1, kind: "go", instruction: "Do not expose this instruction" });
      await error(await waiting, 401, "unauthorized");
      await noClaims();
    } finally {
      controller.abort();
      await waiting;
    }
  },
);
test("the final credential check releases an unreturned claim", async () => {
  const controller = new AbortController();
  const waiting = f.request(`/reviews/${f.reviewId}/take`, "POST", { waitSeconds: 10 }, "agent", controller.signal);
  try {
    await started.promise;
    expect(f.deps.events?.agentWaiting(f.ownerId, f.reviewId)).toBe(true);
    const transaction = f.db.transaction;
    f.db.transaction = async (operation, options) => {
      const result = await transaction(operation, options);
      if (result && typeof result === "object" && "kind" in result && result.kind === "go")
        await invalidate("agent", "revokedAt");
      return result;
    };
    await f.send({ revision: 1, kind: "go", instruction: "Do not return this" });
    await error(await waiting, 401, "unauthorized");
    await noClaims();
  } finally {
    controller.abort();
    await waiting;
  }
});
test("a token revoked while the second take queues cannot start a claim", async () => {
  const controller = new AbortController();
  const queued = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const waiting = f.request(`/reviews/${f.reviewId}/take`, "POST", { waitSeconds: 10 }, "agent", controller.signal);
  let claims = 0;
  try {
    await started.promise;
    expect(f.deps.events?.agentWaiting(f.ownerId, f.reviewId)).toBe(true);
    const transaction = f.db.transaction;
    let calls = 0;
    f.db.transaction = async (operation, options) => {
      if (++calls === 2) {
        queued.resolve();
        await release.promise;
      }
      const result = await transaction(operation, options);
      if (result && typeof result === "object" && "kind" in result && result.kind === "go") claims++;
      return result;
    };
    await f.send({ revision: 1, kind: "go", instruction: "Queued" });
    await queued.promise;
    await invalidate("agent", "revokedAt");
    release.resolve();
    await error(await waiting, 401, "unauthorized");
    expect(claims).toBe(0);
    await noClaims();
  } finally {
    release.resolve();
    controller.abort();
    await waiting;
  }
});
test.each(
  (["revokedAt", "expiresAt", "device"] as const).flatMap((field) =>
    (["review", "owner"] as const).map((scope) => ({ field, scope })),
  ),
)("$scope SSE ends at the keepalive after session $field", async ({ field, scope }) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const response = await f.request(
    scope === "owner" ? "/events" : `/reviews/${f.reviewId}/events`,
    "GET",
    undefined,
    "reviewer",
    controller.signal,
  );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing body");
  try {
    await reader.read();
    if (field === "device")
      await f.db.query((q) =>
        q
          .update(devices)
          .set({ revokedAt: f.deps.now() })
          .where(and(eq(devices.ownerId, f.ownerId), eq(devices.kind, "browser"))),
      );
    else await invalidate("reviewer", field);
    f.advance(25000);
    await vi.advanceTimersByTimeAsync(25000);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  } finally {
    controller.abort();
    await reader.cancel();
  }
});
test("only 32 takes per owner may wait and abort releases their slots", async () => {
  const events = f.deps.events;
  if (!events) throw new Error("missing events");
  const full = Promise.withResolvers<void>();
  const beginWaiting = events.beginWaiting.bind(events);
  const begin = vi.spyOn(events, "beginWaiting").mockImplementation((...args) => {
    const end = beginWaiting(...args);
    if (begin.mock.calls.length === 32) full.resolve();
    return end;
  });
  const controller = new AbortController();
  const waiting = Array.from({ length: 32 }, () =>
    f.request(`/reviews/${f.reviewId}/take`, "POST", { waitSeconds: 25 }, "agent", controller.signal),
  );
  try {
    await full.promise;
    expect(begin).toHaveBeenCalledTimes(32);
    await error(
      await f.request(`/reviews/${f.reviewId}/take`, "POST", { waitSeconds: 0.01 }, "agent"),
      429,
      "rate_limited",
    );
    const id = randomUUID();
    await f.db.query(async (q) => {
      await q.insert(reviews).values({
        id,
        ownerId: f.otherOwnerId,
        originInstanceId: f.instanceId,
        reviewKey: "b".repeat(64),
        title: "Other synthetic review",
      });
      await q.insert(revisions).values({ ownerId: f.otherOwnerId, reviewId: id, seq: 1, contentKey: randomUUID() });
    });
    expect((await f.request(`/reviews/${id}/take`, "POST", { waitSeconds: 0.001 }, "stranger")).status).toBe(200);
  } finally {
    controller.abort();
    await Promise.all(waiting);
  }
  expect((await f.request(`/reviews/${f.reviewId}/take`, "POST", { waitSeconds: 0.001 }, "agent")).status).toBe(200);
  expect(
    await f.db.read((q) =>
      q
        .select()
        .from(deliveries)
        .where(and(eq(deliveries.ownerId, f.ownerId), isNull(deliveries.confirmedAt))),
    ),
  ).toHaveLength(0);
});
