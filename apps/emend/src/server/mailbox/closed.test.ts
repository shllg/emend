import { randomUUID } from "node:crypto";
import { WaitResult } from "@emend/contract";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deliveries, reviews } from "../../db/schema.ts";
import { ReviewEvents } from "../events.ts";
import { publishReview, takeAs, takeClosed } from "./lifecycle-support.ts";
import { error, mailboxFixture, nextWaiting } from "./test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});

const act = (id: string, action: string, body?: unknown) => f.request(`/reviews/${id}/${action}`, "POST", body);
const deliveryRows = () => f.db.read((q) => q.select().from(deliveries).where(eq(deliveries.ownerId, f.ownerId)));
const row = (id: string) =>
  f.db.read((q) =>
    q
      .select()
      .from(reviews)
      .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, id)))
      .get(),
  );
const iso = (ms: number) => new Date(ms).toISOString();

test("a take on a retired review gets closed with a send-less delivery; the confirm sets the release record", async () => {
  const { reviewId } = await publishReview(f);
  expect((await act(reviewId, "retire", {})).status).toBe(204);
  expect(await row(reviewId)).toMatchObject({ releasedAt: null });
  const result = await takeClosed(f, reviewId);
  expect(result).toEqual({
    kind: "closed",
    reviewId,
    deliveryId: expect.any(String),
    revision: 1,
    reason: "retired",
    until: null,
  });
  // Taking is not releasing: the release record waits for the confirm.
  expect(await row(reviewId)).toMatchObject({ releasedAt: null, releasedReason: null });
  expect(await deliveryRows()).toHaveLength(1);
  f.advance(1000);
  // The delivery has no Send, and confirms like any other, with the usual event.
  const events = new ReviewEvents(f.deps.now);
  f.deps.events = events;
  const emitted = vi.spyOn(events, "emit");
  const confirm = await f.request(
    `/deliveries/${(result as { deliveryId: string }).deliveryId}/confirm`,
    "POST",
    undefined,
    "agent",
  );
  expect(confirm.status).toBe(204);
  expect((await deliveryRows())[0]?.confirmedAt).not.toBeNull();
  expect(await row(reviewId)).toMatchObject({ releasedAt: f.deps.now(), releasedReason: "retired" });
  expect(emitted).toHaveBeenCalledWith(f.ownerId, {
    type: "confirmed",
    reviewId,
    revision: 1,
    deliveryId: expect.any(String),
  });
});

test("confirming a closed delivery of a snoozed review records the snooze release; a confirm after the review woke records none", async () => {
  const { reviewId } = await publishReview(f);
  const confirm = (deliveryId: string) => f.request(`/deliveries/${deliveryId}/confirm`, "POST", undefined, "agent");
  expect((await act(reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  const snoozed = (await takeClosed(f, reviewId)) as { deliveryId: string };
  expect(await row(reviewId)).toMatchObject({ releasedAt: null });
  expect((await confirm(snoozed.deliveryId)).status).toBe(204);
  expect(await row(reviewId)).toMatchObject({ releasedAt: f.deps.now(), releasedReason: "snoozed" });
  // The review is awake again before the next closed delivery is confirmed.
  expect((await act(reviewId, "unsnooze")).status).toBe(204);
  expect((await act(reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  const next = (await takeClosed(f, reviewId)) as { deliveryId: string };
  expect((await act(reviewId, "unsnooze")).status).toBe(204);
  f.advance(1000);
  expect((await confirm(next.deliveryId)).status).toBe(204);
  expect(await row(reviewId)).toMatchObject({ releasedAt: f.deps.now() - 1000, releasedReason: "snoozed" });
});

test("a Send that lands between the claim and the closed answer is claimed by the wait, not closed over", async () => {
  const { reviewId } = await publishReview(f);
  const created = await f.request(`/reviews/${reviewId}/threads`, "POST", {
    revision: 1,
    target: { kind: "review" },
    body: "Late question.",
  });
  expect(created.status).toBe(201);
  expect((await act(reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  // Fire the Send right after takeDelivery has read the (snoozed) review, before closeDelivery runs.
  const realRead = f.db.read.bind(f.db);
  let fired = false;
  vi.spyOn(f.db, "read").mockImplementation(async (fn) => {
    const result = await realRead(fn);
    if (!fired && result && typeof result === "object" && "snoozedAt" in result) {
      fired = true;
      const sent = await f.request(`/reviews/${reviewId}/sends`, "POST", { kind: "go", revision: 1 });
      expect(sent.status).toBe(201);
    }
    return result;
  });
  const first = await takeClosed(f, reviewId);
  expect(fired).toBe(true);
  expect(first.kind).toBe("pending");
  expect(await deliveryRows()).toHaveLength(0);
  expect(await takeClosed(f, reviewId)).toMatchObject({ kind: "go", comments: [{ body: "Late question." }] });
});

test("closed deliveries keep at most one confirmed send-less row per review", async () => {
  const { reviewId } = await publishReview(f);
  expect((await act(reviewId, "retire", {})).status).toBe(204);
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const taken = (await takeClosed(f, reviewId)) as { deliveryId: string };
    expect((await f.request(`/deliveries/${taken.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
    ids.push(taken.deliveryId);
    expect(new Set(ids).size).toBe(i + 1);
  }
  // Each take clears older confirmed rows but the newest, then adds an unconfirmed one: after the
  // loop the newest two are confirmed, and one more take leaves a single confirmed row.
  const confirmedIds = async () =>
    (await deliveryRows())
      .filter((d) => d.confirmedAt !== null)
      .map((d) => d.id)
      .sort();
  expect(await confirmedIds()).toEqual(ids.slice(-2).sort());
  await takeClosed(f, reviewId);
  expect(await confirmedIds()).toEqual(ids.slice(-1));
});

test("a take on a snoozed review gets closed with the wake time, or null until the next revision", async () => {
  const { reviewId } = await publishReview(f);
  const until = iso(f.deps.now() + 3_600_000);
  expect((await act(reviewId, "snooze", { until })).status).toBe(204);
  expect(await takeClosed(f, reviewId)).toMatchObject({ kind: "closed", reason: "snoozed", until });
  expect((await act(reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  expect(await takeClosed(f, reviewId)).toMatchObject({ kind: "closed", reason: "snoozed", until: null });
});

test("a wait started on a still-snoozed review returns at once; after the wake time it waits", async () => {
  const { reviewId } = await publishReview(f);
  const until = iso(f.deps.now() + 5000);
  expect((await act(reviewId, "snooze", { until })).status).toBe(204);
  const events = f.deps.events;
  if (!events) throw new Error("Missing review events");
  const beginWaiting = vi.spyOn(events, "beginWaiting");
  expect(await takeClosed(f, reviewId, 25)).toMatchObject({ kind: "closed", reason: "snoozed" });
  expect(beginWaiting).not.toHaveBeenCalled();
  expect(events.agentWaiting(f.ownerId, reviewId)).toBe(false);
  f.advance(6000);
  expect(await takeClosed(f, reviewId, 0)).toMatchObject({ kind: "pending" });
});

test("a waiting take is ended once by a retire, with closed", async () => {
  const events = new ReviewEvents(f.deps.now);
  f.deps.events = events;
  const { reviewId } = await publishReview(f);
  const registered = nextWaiting(f.deps.events, f.ownerId, reviewId);
  const waiting = takeClosed(f, reviewId, 25);
  await registered;
  expect(f.deps.events?.agentWaiting(f.ownerId, reviewId)).toBe(true);
  expect(events.agentWaiting(f.ownerId, reviewId)).toBe(true);
  expect((await act(reviewId, "retire", {})).status).toBe(204);
  expect(await waiting).toMatchObject({ kind: "closed", reason: "retired" });
  expect((await row(reviewId))?.releasedReason).toBeNull();
  expect(await deliveryRows()).toHaveLength(1);
});

test("a waiting take is ended by a snooze with closed", async () => {
  f.deps.events = new ReviewEvents(f.deps.now);
  const { reviewId } = await publishReview(f);
  const registered = nextWaiting(f.deps.events, f.ownerId, reviewId);
  const waiting = takeClosed(f, reviewId, 25);
  await registered;
  expect(f.deps.events?.agentWaiting(f.ownerId, reviewId)).toBe(true);
  expect((await act(reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  expect(await waiting).toMatchObject({ kind: "closed", reason: "snoozed", until: null });
});

test("a waiting take on a deleted review gets 404", async () => {
  f.deps.events = new ReviewEvents(f.deps.now);
  const { reviewId } = await publishReview(f);
  const registered = nextWaiting(f.deps.events, f.ownerId, reviewId);
  const waiting = takeAs(f, reviewId, ["closed"], 25);
  await registered;
  expect(f.deps.events?.agentWaiting(f.ownerId, reviewId)).toBe(true);
  expect((await f.request(`/reviews/${reviewId}`, "DELETE")).status).toBe(204);
  await error(await waiting, 404, "unknown_review");
  await error(await takeAs(f, reviewId, ["closed"]), 404, "unknown_review");
  await error(await takeAs(f, reviewId, undefined), 404, "unknown_review");
});

test("a pending Send is delivered before closed, on a snoozed review", async () => {
  const { reviewId } = await publishReview(f);
  const created = await f.request(`/reviews/${reviewId}/threads`, "POST", {
    revision: 1,
    target: { kind: "review" },
    body: "Explain.",
  });
  expect(created.status).toBe(201);
  expect((await f.request(`/reviews/${reviewId}/sends`, "POST", { kind: "go", revision: 1 })).status).toBe(201);
  expect((await act(reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  expect(await takeClosed(f, reviewId)).toMatchObject({ kind: "go", comments: [{ body: "Explain." }] });
  expect(await row(reviewId)).toMatchObject({ releasedAt: null });
  expect(await takeClosed(f, reviewId)).toMatchObject({ kind: "closed", reason: "snoozed" });
});

test("a client that does not announce closed gets review_closed and no release record", async () => {
  const { reviewId } = await publishReview(f);
  expect((await act(reviewId, "retire", {})).status).toBe(204);
  for (const accepts of [undefined, []]) {
    await error(await takeAs(f, reviewId, accepts), 409, "review_closed");
    await error(await takeAs(f, reviewId, accepts, 25), 409, "review_closed");
  }
  expect(await row(reviewId)).toMatchObject({ releasedAt: null, releasedReason: null });
  expect(await deliveryRows()).toHaveLength(0);
  expect((await act(reviewId, "reopen")).status).toBe(204);
  expect(await (await takeAs(f, reviewId, undefined)).json()).toMatchObject({ kind: "pending" });
});

test("repeated takes reuse one unconfirmed closed delivery, and a new one follows its confirm or expiry", async () => {
  const { reviewId } = await publishReview(f);
  expect((await act(reviewId, "retire", {})).status).toBe(204);
  const first = (await takeClosed(f, reviewId)) as { deliveryId: string };
  const second = (await takeClosed(f, reviewId)) as { deliveryId: string };
  expect(second.deliveryId).toBe(first.deliveryId);
  expect(await deliveryRows()).toHaveLength(1);
  expect((await f.request(`/deliveries/${first.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
  const third = (await takeClosed(f, reviewId)) as { deliveryId: string };
  expect(third.deliveryId).not.toBe(first.deliveryId);
  f.advance(121_000);
  const fourth = (await takeClosed(f, reviewId)) as { deliveryId: string };
  expect(fourth.deliveryId).not.toBe(third.deliveryId);
  // The expired unconfirmed delivery is cleaned up; the confirmed one stays.
  expect((await deliveryRows()).map((d) => d.id).sort()).toEqual([first.deliveryId, fourth.deliveryId].sort());
});

test("a send-less delivery breaks no reader: claim events, inbox, lease expiry, export and a later Send", async () => {
  const { reviewId } = await publishReview(f);
  expect((await act(reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  await takeClosed(f, reviewId);
  const items = (await (await f.request("/reviews", "GET")).json()) as { items: { pendingSend: boolean }[] };
  expect(items.items[0]?.pendingSend).toBe(false);
  const orphans = await f.db.read((q) =>
    q.values<[number]>(
      sql`select count(*) from deliveries d where d.owner_id = ${f.ownerId} and not exists (select 1 from sends s where s.delivery_id = d.id)`,
    ),
  );
  expect(orphans).toEqual([[1]]);
  // Past its lease, takes still work, and the next closed take clears the dead delivery.
  f.advance(121_000);
  expect((await act(reviewId, "unsnooze")).status).toBe(204);
  expect(await takeClosed(f, reviewId)).toMatchObject({ kind: "pending" });
  expect((await act(reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  const again = (await takeClosed(f, reviewId)) as { deliveryId: string };
  expect((await deliveryRows()).map((d) => d.id)).toEqual([again.deliveryId]);
});

test("owner isolation: a foreign owner cannot take or confirm a closed delivery", async () => {
  const { reviewId } = await publishReview(f);
  expect((await act(reviewId, "retire", {})).status).toBe(204);
  const result = (await takeClosed(f, reviewId)) as { deliveryId: string };
  await error(
    await f.request(`/reviews/${reviewId}/take`, "POST", { accepts: ["closed"] }, "stranger"),
    404,
    "unknown_review",
  );
  await error(
    await f.request(`/deliveries/${result.deliveryId}/confirm`, "POST", undefined, "stranger"),
    404,
    "not_found",
  );
  expect(WaitResult.safeParse(result).success).toBe(true);
  expect(randomUUID()).not.toBe(reviewId);
});
