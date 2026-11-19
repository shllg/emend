import { randomUUID } from "node:crypto";
import { AgentReviewList, InboxGroup, InboxList, LIMITS, type ReviewEvent, ReviewView } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as t from "../../db/schema.ts";
import { createToken, SESSION_MS } from "../auth/tokens.ts";
import { publishReview } from "../mailbox/lifecycle-support.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.blobCleanup();
  await f.cleanup();
});
const pin = (reviewId: string, pinned = true, who: "reviewer" | "foreign" = "reviewer") =>
  f.request(`/reviews/${reviewId}/pin`, "PUT", { pinned }, who);
const inbox = async (who: "reviewer" | "foreign" = "reviewer") =>
  InboxList.parse(await (await f.request("/reviews", "GET", undefined, who)).json());
const view = async (id: string) => ReviewView.parse(await (await f.request(`/reviews/${id}`, "GET")).json());
const pins = () => f.db.read((q) => q.select().from(t.reviewPins).where(eq(t.reviewPins.ownerId, f.ownerId)).all());
const post = (id: string, action: string, body?: unknown) => f.request(`/reviews/${id}/${action}`, "POST", body);
const createGroup = async () => {
  const response = await f.request("/groups", "POST", { name: "Synthetic group" });
  expect(response.status).toBe(201);
  return InboxGroup.parse(await response.json());
};
const move = (id: string, groupId: string | null) => f.request(`/reviews/${id}/group`, "PUT", { groupId });
const markMoved = (id: string) =>
  f.db.query((q) =>
    q
      .update(t.reviews)
      .set({ movedToUrl: "https://example.com/r/synthetic" })
      .where(and(eq(t.reviews.ownerId, f.ownerId), eq(t.reviews.id, id))),
  );
async function seedMany(count: number, extra: (i: number) => Partial<typeof t.reviews.$inferInsert> = () => ({})) {
  const rows = Array.from({ length: count }, (_, i) => {
    const id = randomUUID();
    return {
      id,
      ownerId: f.ownerId,
      originInstanceId: f.instanceId,
      title: "Synthetic pin item",
      reviewKey: id.replaceAll("-", "").repeat(2),
      updatedAt: f.deps.now(),
      ...extra(i),
    };
  });
  await f.db.transaction(async (q) => {
    for (let start = 0; start < rows.length; start += 100) {
      const batch = rows.slice(start, start + 100);
      await q.insert(t.reviews).values(batch);
      await q
        .insert(t.revisions)
        .values(batch.map((row) => ({ ownerId: row.ownerId, reviewId: row.id, seq: 1, contentKey: randomUUID() })));
    }
  });
  return rows.map((row) => row.id);
}
async function seed(extra: Partial<typeof t.reviews.$inferInsert> = {}) {
  const [id] = await seedMany(1, () => extra);
  if (!id) throw new Error("Missing seeded review");
  return id;
}

test("pin and unpin reviews and pubs without changing their records; repeated writes keep the first pin time", async () => {
  const pub = await publishReview(f, { key: "b", writeup: { overview: "", tldr: "", decisions: null, topics: {} } });
  const review = await publishReview(f);
  expect((await view(pub.reviewId)).kind).toBe("publish");
  expect((await view(review.reviewId)).kind).toBe("review");
  for (const { reviewId } of [pub, review]) {
    const before = await view(reviewId);
    expect(before.pinnedAt).toBeNull();
    f.advance(1000);
    const pinnedAt = new Date(f.deps.now()).toISOString();
    expect((await pin(reviewId)).status).toBe(204);
    expect(await view(reviewId)).toEqual({ ...before, pinnedAt });
    f.advance(1000);
    expect((await pin(reviewId)).status).toBe(204);
    expect(await view(reviewId)).toEqual({ ...before, pinnedAt });
    expect((await inbox()).items.find((item) => item.id === reviewId)?.pinnedAt).toBe(pinnedAt);
    for (let i = 0; i < 2; i++) {
      expect((await pin(reviewId, false)).status).toBe(204);
      expect(await view(reviewId)).toEqual(before);
    }
  }
  expect(await pins()).toEqual([]);
});

test("pinning and repinning keep Active's activity order regardless of pin time", async () => {
  await seed({ state: "settled" });
  const first = await seed({ updatedAt: f.deps.now() - 1000 });
  const tie = await seed({ updatedAt: f.deps.now() - 1000 });
  const newest = await seed({ updatedAt: f.deps.now() - 2000 });
  const before = (await inbox()).items.map((item) => item.id);
  for (const id of [first, tie].sort().reverse()) expect((await pin(id)).status).toBe(204);
  f.advance(1000);
  expect((await pin(newest)).status).toBe(204);
  f.advance(1000);
  expect((await pin(first)).status).toBe(204);
  expect((await inbox()).items.map((item) => item.id)).toEqual(before);
  expect((await pin(first, false)).status).toBe(204);
  expect((await pin(first)).status).toBe(204);
  expect((await inbox()).items.map((item) => item.id)).toEqual(before);
});

test("agent/admin bearers and a reviewer token as bearer are refused before path, body or review lookup", async () => {
  const admin = (await createToken(f.db, f.ownerId, "admin")).secret;
  const deviceId = randomUUID();
  await f.db.query((q) =>
    q.insert(t.devices).values({ id: deviceId, ownerId: f.ownerId, kind: "browser", name: "Synthetic" }),
  );
  const reviewer = (
    await createToken(f.db, f.ownerId, "reviewer", {
      deviceId,
      now: f.deps.now(),
      expiresAt: f.deps.now() + SESSION_MS,
    })
  ).secret;
  const transaction = vi.spyOn(f.db, "transaction");
  for (const id of ["bad", randomUUID(), f.reviewId]) {
    const path = `/reviews/${id}/pin`;
    await error(await f.request(path, "PUT", undefined, "agent"), 403, "forbidden");
    for (const [secret, status, code] of [
      [admin, 403, "forbidden"],
      [reviewer, 401, "unauthorized"],
    ] as const) {
      await error(
        await f.app.request(`http://127.0.0.1:3636/api/v1${path}`, {
          method: "PUT",
          headers: { Host: "127.0.0.1:3636", Authorization: `Bearer ${secret}` },
        }),
        status,
        code,
      );
    }
  }
  expect(transaction).not.toHaveBeenCalled();
  expect(await pins()).toEqual([]);
});

test("missing and foreign reviews are unknown_review; malformed UUIDs and invalid bodies are refused", async () => {
  for (const pinned of [true, false]) {
    await error(await pin(f.reviewId, pinned, "foreign"), 404, "unknown_review");
    await error(await pin(randomUUID(), pinned), 404, "unknown_review");
    await error(await pin("bad", pinned), 404, "not_found");
  }
  for (const body of [{}, { pinned: "true" }, { pinned: 1 }, { pinned: null }, { pinned: true, extra: true }])
    await error(await f.request(`/reviews/${f.reviewId}/pin`, "PUT", body), 400, "invalid_request");
  expect((await pin(f.reviewId)).status).toBe(204);
  expect((await inbox("foreign")).items).toEqual([]);
  expect((await inbox()).items[0]?.pinnedAt).not.toBeNull();
});

test("only 50 pins per owner including binned pins; idempotent writes still work and other owners have room", async () => {
  expect((await pin(f.reviewId)).status).toBe(204);
  const ids = await seedMany(LIMITS.pins - 1);
  await f.db.query((q) =>
    q.insert(t.reviewPins).values(ids.map((reviewId) => ({ ownerId: f.ownerId, reviewId, createdAt: f.deps.now() }))),
  );
  const before = await pins();
  const existing = ids[0];
  if (!existing) throw new Error("Missing pin");
  f.advance(1000);
  expect((await pin(existing)).status).toBe(204);
  expect(await pins()).toEqual(before);
  expect((await post(f.reviewId, "bin")).status).toBe(204);
  expect((await inbox()).items.filter((item) => item.pinnedAt !== null)).toHaveLength(LIMITS.pins - 1);
  const next = await seed();
  const response = await pin(next);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: { code: "invalid_state", message: "You have the most pins allowed. Unpin one first." },
  });
  expect((await pin(next, false)).status).toBe(204);
  expect(await pins()).toEqual(before);
  const foreign = await seed({ ownerId: f.otherOwnerId });
  expect((await pin(foreign, true, "foreign")).status).toBe(204);
  expect((await inbox("foreign")).items).toMatchObject([{ id: foreign, pinnedAt: expect.any(String) }]);
  await error(await pin(foreign, false), 404, "unknown_review");
  expect((await pin(existing, false)).status).toBe(204);
  expect((await pin(next)).status).toBe(204);
  expect(await pins()).toHaveLength(LIMITS.pins);
});

test("bin hides a pin and refuses changes, restore keeps its time, and delete for good removes it", async () => {
  const pinnedAt = new Date(f.deps.now()).toISOString();
  expect((await pin(f.reviewId)).status).toBe(204);
  const before = await pins();
  expect((await post(f.reviewId, "bin")).status).toBe(204);
  for (const pinned of [true, false]) await error(await pin(f.reviewId, pinned), 409, "review_in_bin");
  expect((await inbox()).items).toEqual([]);
  expect(await pins()).toEqual(before);
  f.advance(1000);
  expect((await post(f.reviewId, "restore")).status).toBe(204);
  expect((await inbox()).items).toMatchObject([{ id: f.reviewId, pinnedAt }]);
  expect((await view(f.reviewId)).pinnedAt).toBe(pinnedAt);
  expect((await post(f.reviewId, "bin")).status).toBe(204);
  expect((await f.request(`/bin/${f.reviewId}`, "DELETE")).status).toBe(204);
  expect(await pins()).toEqual([]);
});

test("moved reviews show as unpinned and refuse pin and unpin without changing the pin row", async () => {
  expect((await pin(f.reviewId)).status).toBe(204);
  const before = await pins();
  await markMoved(f.reviewId);
  for (const pinned of [true, false]) await error(await pin(f.reviewId, pinned), 409, "review_moved");
  expect(await pins()).toEqual(before);
  expect((await inbox()).items).toMatchObject([{ id: f.reviewId, pinnedAt: null }]);
  expect(await view(f.reviewId)).toMatchObject({ id: f.reviewId, pinnedAt: null });
});

test("a moved pin keeps its row but leaves room for a new pin among 49 other pins", async () => {
  expect((await pin(f.reviewId)).status).toBe(204);
  const ids = await seedMany(LIMITS.pins - 1);
  await f.db.query((q) =>
    q.insert(t.reviewPins).values(ids.map((reviewId) => ({ ownerId: f.ownerId, reviewId, createdAt: f.deps.now() }))),
  );
  const next = await seed();
  await error(await pin(next), 409, "invalid_state");
  await markMoved(f.reviewId);
  const before = await pins();
  expect((await pin(next)).status).toBe(204);
  expect(await pins()).toHaveLength(LIMITS.pins + 1);
  expect(await pins()).toEqual(expect.arrayContaining(before));
  expect((await inbox()).items.filter((item) => item.pinnedAt !== null)).toHaveLength(LIMITS.pins);
  await error(await pin(await seed()), 409, "invalid_state");
});

test("a pinned open review takes an Active place and stays in the sorted Active part at the cap", async () => {
  expect((await pin(f.reviewId)).status).toBe(204);
  const ids = await seedMany(LIMITS.inboxItems, (i) => ({ updatedAt: f.deps.now() - i - 1 }));
  const done = await seed({ state: "settled" });
  const { items } = await inbox();
  expect(items).toHaveLength(LIMITS.inboxItems + 1);
  expect(items.slice(0, LIMITS.inboxItems).map((item) => item.id)).toEqual([f.reviewId, ...ids.slice(0, -1)]);
  expect(items.at(-1)?.id).toBe(done);
  expect(items[0]).toMatchObject({ id: f.reviewId, list: "active", groupId: null, pinnedAt: expect.any(String) });
  expect(items.filter((item) => item.id === f.reviewId)).toHaveLength(1);
});

test("pinned approvals take approval-cap places and stay in Done when the approval or Active cap is full", async () => {
  const pinned = await seed({ state: "approved", approvedAt: f.deps.now() });
  expect((await pin(pinned)).status).toBe(204);
  const approvals = await seedMany(6, (i) => ({ state: "approved", approvedAt: f.deps.now() - i - 1 }));
  const { items } = await inbox();
  expect(items.filter((item) => item.state === "approved" && item.list === "active").map((item) => item.id)).toEqual(
    [pinned, ...approvals.slice(0, 4)].sort(),
  );
  const overflow = approvals[5];
  if (!overflow) throw new Error("Missing approval");
  expect(items.find((item) => item.id === overflow)).toMatchObject({ list: "done", activeUntil: null });
  expect((await pin(overflow)).status).toBe(204);
  expect((await inbox()).items.find((item) => item.id === overflow)).toMatchObject({
    list: "done",
    activeUntil: null,
    pinnedAt: expect.any(String),
  });
  const activeUntil = new Date(f.deps.now() + 12 * 3_600_000).toISOString();
  expect(items.find((item) => item.id === pinned)).toMatchObject({ list: "active", activeUntil });
  expect(items.filter((item) => item.id === pinned)).toHaveLength(1);
  expect((await f.request("/settings", "PATCH", { approvedActiveLimit: 0 })).status).toBe(200);
  const atZero = await inbox();
  for (const id of [pinned, ...approvals])
    expect(atZero.items.find((item) => item.id === id)).toMatchObject({ list: "done", activeUntil: null });
  expect(await view(pinned)).toMatchObject({ list: "active", activeUntil });
  expect((await f.request("/settings", "PATCH", { approvedActiveLimit: 5 })).status).toBe(200);
  await seedMany(LIMITS.inboxItems);
  expect((await inbox()).items.find((item) => item.id === pinned)).toMatchObject({ list: "done", activeUntil: null });
  f.advance(12 * 3_600_000);
  expect((await inbox()).items.find((item) => item.id === pinned)).toMatchObject({ list: "done", activeUntil: null });
});

test("a pinned open review beyond the Active cap appears once in Active before the other blocks", async () => {
  const ids = await seedMany(LIMITS.inboxItems, (i) => ({ updatedAt: f.deps.now() - i - 1 }));
  const pinned = ids.at(-1);
  if (!pinned) throw new Error("Missing review");
  expect((await pin(pinned)).status).toBe(204);
  const done = await seed({ state: "settled" });
  const { items } = await inbox();
  expect(items.map((item) => item.id)).toEqual([f.reviewId, ...ids, done]);
  expect(items.filter((item) => item.id === pinned)).toHaveLength(1);
  expect(items.find((item) => item.id === pinned)).toMatchObject({ list: "active", pinnedAt: expect.any(String) });
  await markMoved(pinned);
  expect((await inbox()).items.map((item) => item.id)).toEqual([f.reviewId, ...ids.slice(0, -1), done]);
});

test.each(["snoozed", "grouped", "done"] as const)(
  "pinned %s overflow follows capped rows in block order and excludes moved reviews",
  async (block) => {
    const group = block === "grouped" ? await createGroup() : null;
    const ids = await seedMany(LIMITS.inboxItems + 2, (i) => ({
      state: block === "done" ? "settled" : "open",
      updatedAt: f.deps.now() - i,
      snoozedAt: block === "snoozed" ? f.deps.now() : null,
      snoozedUntil: block === "snoozed" ? f.deps.now() + (i + 1) * 1000 : null,
    }));
    if (group)
      await f.db.query((q) =>
        q
          .insert(t.reviewGroupMembers)
          .values(ids.map((reviewId) => ({ ownerId: f.ownerId, reviewId, groupId: group.id }))),
      );
    const overflow = ids.slice(LIMITS.inboxItems);
    for (const id of overflow.toReversed()) {
      expect((await pin(id)).status).toBe(204);
      f.advance(1);
    }
    const { items } = await inbox();
    expect(items.map((item) => item.id)).toEqual([f.reviewId, ...ids]);
    for (const id of overflow) {
      expect(items.filter((item) => item.id === id)).toHaveLength(1);
      expect(items.find((item) => item.id === id)).toMatchObject({
        pinnedAt: expect.any(String),
        groupId: group?.id ?? null,
        list: block === "grouped" ? "active" : block,
      });
    }
    const moved = overflow[0];
    if (!moved) throw new Error("Missing review");
    await markMoved(moved);
    expect((await inbox()).items.map((item) => item.id)).toEqual([f.reviewId, ...ids.filter((id) => id !== moved)]);
  },
);

test("pinned Snoozed, grouped and Done items keep their normal block position and appear once", async () => {
  const group = await createGroup();
  const snoozed = await seed({ snoozedAt: f.deps.now(), snoozedUntil: f.deps.now() + 1000 });
  const snoozedLast = await seed({ snoozedAt: f.deps.now() });
  const grouped = await seed();
  const groupedLast = await seed({ updatedAt: f.deps.now() - 1 });
  for (const id of [grouped, groupedLast]) expect((await move(id, group.id)).status).toBe(204);
  const done = await seed({ state: "settled" });
  const doneLast = await seed({ state: "approved", approvedAt: null, updatedAt: f.deps.now() - 1 });
  const active = await seed({ updatedAt: f.deps.now() - 1 });
  for (const id of [active, done, grouped, snoozed]) expect((await pin(id)).status).toBe(204);
  const { items } = await inbox();
  expect(items.map((item) => item.id)).toEqual([
    f.reviewId,
    active,
    snoozed,
    snoozedLast,
    grouped,
    groupedLast,
    done,
    doneLast,
  ]);
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
});

test("pins preserve review state, snooze and approval; a zero approval window keeps pins in Done", async () => {
  const group = await createGroup();
  const ids = [
    await seed({ snoozedAt: f.deps.now(), snoozedUntil: f.deps.now() + 1000 }),
    await seed({ state: "approved", approvedAt: f.deps.now() }),
    await seed({ state: "approved", approvedAt: null }),
    await seed({ state: "settled" }),
  ];
  for (const id of ids) {
    expect((await move(id, group.id)).status).toBe(204);
    const before = await view(id);
    const stored = () =>
      f.db.read((q) =>
        q
          .select()
          .from(t.reviews)
          .where(and(eq(t.reviews.ownerId, f.ownerId), eq(t.reviews.id, id)))
          .get(),
      );
    const record = await stored();
    expect((await pin(id)).status).toBe(204);
    expect(await view(id)).toEqual({ ...before, pinnedAt: new Date(f.deps.now()).toISOString() });
    expect(await stored()).toEqual(record);
  }
  expect((await f.request("/settings", "PATCH", { approvedActiveHours: 0 })).status).toBe(200);
  for (const id of ids.slice(1)) {
    expect((await move(id, null)).status).toBe(204);
    expect((await inbox()).items.find((item) => item.id === id)).toMatchObject({ list: "done", activeUntil: null });
  }
});

test("new revisions, snooze, retire, reopen, approval and group changes keep the pin; agents see no pins", async () => {
  const { reviewId } = await publishReview(f);
  expect((await pin(reviewId)).status).toBe(204);
  const pinnedAt = (await view(reviewId)).pinnedAt;
  for (const [action, body] of [
    ["snooze", { untilRevision: true }],
    ["retire", {}],
    ["reopen", undefined],
    ["sends", { kind: "approve", revision: 1 }],
  ] as const) {
    expect((await post(reviewId, action, body)).status).toBe(action === "sends" ? 201 : 204);
    expect((await view(reviewId)).pinnedAt).toBe(pinnedAt);
  }
  await publishReview(f);
  expect(await view(reviewId)).toMatchObject({ pinnedAt, newestRevision: 2, state: "open" });
  const group = await createGroup();
  for (const groupId of [group.id, null, group.id]) {
    expect((await move(reviewId, groupId)).status).toBe(204);
    expect(await view(reviewId)).toMatchObject({ pinnedAt, groupId });
  }
  expect((await f.request(`/groups/${group.id}`, "DELETE")).status).toBe(204);
  expect(await view(reviewId)).toMatchObject({ pinnedAt, groupId: null });
  const response = await (await f.request("/agent/reviews", "GET", undefined, "agent")).json();
  expect(AgentReviewList.safeParse(response).success).toBe(true);
  expect(JSON.stringify(response)).not.toMatch(/pinnedAt|pins/);
  expect((await f.request(`/reviews/${reviewId}`, "DELETE")).status).toBe(204);
  expect(await pins()).toEqual([]);
});

test("pins events name the review after commit, reach both streams, and never fire for refused requests", async () => {
  const seen: ReviewEvent[] = [];
  const snapshots: Promise<unknown>[] = [];
  const stop = f.deps.events?.subscribe(f.ownerId, null, (event) => {
    if (event.type !== "pins") return;
    seen.push(event);
    snapshots.push(pins());
  });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    for (const path of ["/events", `/reviews/${f.reviewId}/events`]) {
      const response = await f.request(path, "GET");
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing stream");
      readers.push(reader);
      await reader.read();
    }
    const at = f.deps.now();
    for (const pinned of [true, false]) {
      expect((await pin(f.reviewId, pinned)).status).toBe(204);
      for (const reader of readers)
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(
          `event: pins\ndata: ${JSON.stringify({ reviewId: f.reviewId })}\n\n`,
        );
    }
    await error(await f.request(`/reviews/${f.reviewId}/pin`, "PUT", { pinned: true }, "agent"), 403, "forbidden");
    await error(await pin(f.reviewId, true, "foreign"), 404, "unknown_review");
    await error(
      await f.request(`/reviews/${f.reviewId}/pin`, "PUT", { pinned: true, extra: 1 }),
      400,
      "invalid_request",
    );
    await error(await pin(randomUUID()), 404, "unknown_review");
    expect((await post(f.reviewId, "bin")).status).toBe(204);
    await error(await pin(f.reviewId), 409, "review_in_bin");
    expect(seen).toEqual([
      { type: "pins", reviewId: f.reviewId },
      { type: "pins", reviewId: f.reviewId },
    ]);
    expect(await Promise.all(snapshots)).toEqual([[{ ownerId: f.ownerId, reviewId: f.reviewId, createdAt: at }], []]);
  } finally {
    stop?.();
    await Promise.all(readers.map((reader) => reader.cancel()));
  }
});

test("capabilities advertise review pins", async () => {
  expect(await (await f.request("/capabilities", "GET")).json()).toMatchObject({
    features: expect.arrayContaining(["review-pins"]),
  });
});
