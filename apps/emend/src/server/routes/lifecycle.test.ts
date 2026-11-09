import { randomUUID } from "node:crypto";
import { APPROVED_ACTIVE_HOURS, InboxList, LIMITS, MAX_SNOOZE_DAYS, ReviewView } from "@emend/contract";
import { and, eq, sql } from "drizzle-orm";
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
  await f.cleanup();
});

const day = 86_400_000;
const approvedWindow = APPROVED_ACTIVE_HOURS * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const row = (id: string) =>
  f.db.read((q) =>
    q
      .select()
      .from(t.reviews)
      .where(and(eq(t.reviews.ownerId, f.ownerId), eq(t.reviews.id, id)))
      .get(),
  );
const post = (id: string, action: string, body?: unknown, who: "reviewer" | "foreign" | "agent" = "reviewer") =>
  f.request(`/reviews/${id}/${action}`, "POST", body, who);
// The fixture seeds one review of its own; leave it out so each test sees only what it publishes.
const inbox = async () => {
  const list = InboxList.parse(await (await f.request("/reviews", "GET")).json());
  expect(list.serverTime).toBe(iso(f.deps.now()));
  return list.items.filter((item) => item.id !== f.reviewId);
};
async function userThread(id: string, body = "Please explain.") {
  const response = await f.request(`/reviews/${id}/threads`, "POST", { revision: 1, target: { kind: "review" }, body });
  expect(response.status).toBe(201);
  return (await response.json()) as { threadId: string; commentId: string };
}

const stamp = (id: string, updatedAt: number) =>
  f.db.query((q) =>
    q
      .update(t.reviews)
      .set({ updatedAt })
      .where(and(eq(t.reviews.ownerId, f.ownerId), eq(t.reviews.id, id))),
  );
async function approve(id: string) {
  expect((await post(id, "sends", { kind: "approve", revision: 1 })).status).toBe(201);
}
async function expectBoth(id: string, fields: Partial<ReviewView>) {
  expect((await inbox()).find((item) => item.id === id)).toMatchObject(fields);
  const response = await f.request(`/reviews/${id}`, "GET");
  expect(response.status).toBe(200);
  expect(ReviewView.parse(await response.json())).toMatchObject(fields);
}

const routes = [
  ["snooze", { untilRevision: true }],
  ["unsnooze", undefined],
  ["retire", {}],
  ["reopen", undefined],
  ["delete", undefined],
] as const;
const call = (id: string, action: string, body: unknown, who: "reviewer" | "foreign" | "agent" = "reviewer") =>
  action === "delete" ? f.request(`/reviews/${id}`, "DELETE", undefined, who) : post(id, action, body, who);

test.each(routes)(
  "%s is reviewer-only: agents and bearer reviewer tokens are refused, foreign reviews are 404",
  async (action, body) => {
    const { reviewId } = await publishReview(f);
    await error(await call(reviewId, action, body, "agent"), 403, "forbidden");
    // A reviewer credential is accepted only from the cookie, never as a bearer.
    const deviceId = randomUUID();
    await f.db.query((q) =>
      q.insert(t.devices).values({ id: deviceId, ownerId: f.ownerId, kind: "browser", name: "Synthetic" }),
    );
    const now = f.deps.now();
    const bearer = (await createToken(f.db, f.ownerId, "reviewer", { deviceId, now, expiresAt: now + SESSION_MS }))
      .secret;
    const response = await f.app.request(
      `http://127.0.0.1:3636/api/v1/reviews/${reviewId}${action === "delete" ? "" : `/${action}`}`,
      {
        method: action === "delete" ? "DELETE" : "POST",
        headers: { Host: "127.0.0.1:3636", Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    expect(response.status).toBe(401);
    await error(await call(reviewId, action, body, "foreign"), 404, "unknown_review");
    await error(await call(randomUUID(), action, body), 404, "unknown_review");
    expect((await row(reviewId))?.state).toBe("open");
  },
);

test("snooze, unsnooze and the inbox fields", async () => {
  const { reviewId } = await publishReview(f);
  const until = iso(f.deps.now() + 3 * 3_600_000);
  expect((await post(reviewId, "snooze", { until })).status).toBe(204);
  expect(await inbox()).toMatchObject([{ id: reviewId, list: "snoozed", snoozed: true, snoozedUntil: until }]);
  expect((await post(reviewId, "unsnooze")).status).toBe(204);
  expect(await inbox()).toMatchObject([{ list: "active", snoozed: false, snoozedUntil: null }]);
  expect((await post(reviewId, "unsnooze")).status).toBe(204);
  expect((await post(reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  expect(await inbox()).toMatchObject([{ list: "snoozed", snoozed: true, snoozedUntil: null }]);
  expect((await post(reviewId, "snooze", { until })).status).toBe(204);
  expect((await inbox())[0]).toMatchObject({ snoozedUntil: until });
  const view = await (await f.request(`/reviews/${reviewId}`, "GET")).json();
  expect(view).toMatchObject({ list: "snoozed", snoozed: true, snoozedUntil: until, releasedAt: null });
});

test("snooze refuses a past or distant time, a bad body and a review that is not open", async () => {
  const { reviewId } = await publishReview(f);
  const now = f.deps.now();
  await error(await post(reviewId, "snooze", { until: iso(now - 1000) }), 400, "invalid_request");
  await error(
    await post(reviewId, "snooze", { until: iso(now + (MAX_SNOOZE_DAYS + 1) * day) }),
    400,
    "invalid_request",
  );
  await error(await post(reviewId, "snooze", {}), 400, "invalid_request");
  expect((await post(reviewId, "snooze", { until: iso(now + MAX_SNOOZE_DAYS * day - 1000) })).status).toBe(204);
  await f.db.query((q) => q.update(t.reviews).set({ state: "approved" }).where(eq(t.reviews.id, reviewId)));
  await error(await post(reviewId, "snooze", { untilRevision: true }), 409, "invalid_state");
  await f.db.query((q) => q.update(t.reviews).set({ state: "settled" }).where(eq(t.reviews.id, reviewId)));
  await error(await post(reviewId, "snooze", { untilRevision: true }), 409, "invalid_state");
});

test("a snooze ends at its time and on a new revision", async () => {
  const { reviewId } = await publishReview(f);
  const until = iso(f.deps.now() + 3_600_000);
  expect((await post(reviewId, "snooze", { until })).status).toBe(204);
  f.advance(3_600_000 - 1);
  expect((await inbox())[0]).toMatchObject({ list: "snoozed", snoozed: true });
  f.advance(2);
  expect((await inbox())[0]).toMatchObject({ list: "active", snoozed: false, snoozedUntil: null });
  expect((await post(reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  f.advance(day);
  expect((await inbox())[0]).toMatchObject({ list: "snoozed", snoozed: true });
  await publishReview(f);
  expect((await inbox())[0]).toMatchObject({ list: "active", snoozed: false, newestRevision: 2 });
  expect((await row(reviewId))?.snoozedAt).toBeNull();
});

test("approval stays Active for exactly 12 hours in the inbox and single-review view", async () => {
  const windowMs = 12 * 3_600_000;
  const { reviewId } = await publishReview(f);
  await approve(reviewId);
  const approvedAt = f.deps.now();
  const active = {
    state: "approved",
    list: "active",
    snoozed: false,
    activeUntil: iso(approvedAt + windowMs),
  } as const;
  expect(await row(reviewId)).toMatchObject({ approvedAt });
  await expectBoth(reviewId, active);
  f.advance(windowMs - 1);
  await expectBoth(reviewId, active);
  f.advance(1);
  await expectBoth(reviewId, { state: "approved", list: "done", snoozed: false, activeUntil: null });
});

test("later activity does not extend the approval window", async () => {
  const { reviewId } = await publishReview(f);
  await approve(reviewId);
  const approvedAt = f.deps.now();
  f.advance(3_600_000);
  await stamp(reviewId, f.deps.now());
  await expectBoth(reviewId, { list: "active", activeUntil: iso(approvedAt + approvedWindow) });
  f.advance(approvedWindow - 3_600_000);
  await expectBoth(reviewId, { list: "done", activeUntil: null });
  expect(await row(reviewId)).toMatchObject({ approvedAt, updatedAt: approvedAt + 3_600_000 });
});

test("comments, Sends and agent replies keep the original approval time", async () => {
  const { reviewId } = await publishReview(f);
  await approve(reviewId);
  const approvedAt = f.deps.now();
  const unchanged = async () => {
    expect((await row(reviewId))?.approvedAt).toBe(approvedAt);
    await expectBoth(reviewId, { state: "approved", list: "active", activeUntil: iso(approvedAt + approvedWindow) });
  };
  f.advance(3_600_000);
  const thread = await userThread(reviewId);
  await unchanged();
  // An agent can reply only to a sent comment, so send it before replying.
  f.advance(3_600_000);
  expect((await post(reviewId, "sends", { kind: "go", revision: 1 })).status).toBe(201);
  await unchanged();
  f.advance(3_600_000);
  expect(
    (
      await f.request(
        `/comments/${thread.commentId}/reply`,
        "POST",
        { outcome: "held", body: "Please discuss this." },
        "agent",
      )
    ).status,
  ).toBe(201);
  await unchanged();
  f.advance(approvedWindow - 3 * 3_600_000);
  await expectBoth(reviewId, { state: "approved", list: "done", activeUntil: null });
  expect((await row(reviewId))?.approvedAt).toBe(approvedAt);
});

test("a new revision clears the approval time and reopens the review", async () => {
  const { reviewId } = await publishReview(f);
  await approve(reviewId);
  expect((await row(reviewId))?.approvedAt).toBe(f.deps.now());
  await publishReview(f);
  await expectBoth(reviewId, { state: "open", list: "active", activeUntil: null, newestRevision: 2 });
  expect(await row(reviewId)).toMatchObject({ approvedRevision: null, approvedAt: null });
});

test("an approval with no recorded approval time stays in Done", async () => {
  const { reviewId } = await publishReview(f);
  await approve(reviewId);
  await f.db.query((q) =>
    q
      .update(t.reviews)
      .set({ approvedAt: null })
      .where(and(eq(t.reviews.ownerId, f.ownerId), eq(t.reviews.id, reviewId))),
  );
  await expectBoth(reviewId, { state: "approved", list: "done", snoozed: false, activeUntil: null });
});

test("retire refuses unsent comments unless they are discarded, and does not mark a release", async () => {
  const { reviewId } = await publishReview(f);
  const first = await userThread(reviewId);
  await userThread(reviewId, "Second");
  await error(await post(reviewId, "retire", {}), 409, "unsent_comments");
  await error(await post(reviewId, "retire", { discardUnsent: false }), 409, "unsent_comments");
  expect((await row(reviewId))?.state).toBe("open");
  expect((await post(reviewId, "retire", { discardUnsent: true })).status).toBe(204);
  const after = await row(reviewId);
  expect(after).toMatchObject({ state: "settled", approvedRevision: null, releasedAt: null, releasedReason: null });
  const counts = await f.db.read(async (q) => ({
    comments: (
      await q.select({ n: sql<number>`count(*)` }).from(t.comments).where(eq(t.comments.reviewId, reviewId)).get()
    )?.n,
    threads: (
      await q.select({ n: sql<number>`count(*)` }).from(t.threads).where(eq(t.threads.reviewId, reviewId)).get()
    )?.n,
  }));
  expect(counts).toEqual({ comments: 0, threads: 0 });
  expect(first.threadId).toBeTruthy();
  await expectBoth(reviewId, { list: "done", state: "settled", releasedAt: null, activeUntil: null });
});

test("retire keeps sent comments, accepts no empty body variants but a missing one, and needs an open review", async () => {
  const { reviewId } = await publishReview(f);
  await userThread(reviewId);
  expect((await f.request(`/reviews/${reviewId}/sends`, "POST", { kind: "go", revision: 1 })).status).toBe(201);
  const missing = await f.request(`/reviews/${reviewId}/retire`, "POST");
  expect(missing.status).toBe(204);
  await error(await post(reviewId, "retire", {}), 409, "invalid_state");
  await error(await post(reviewId, "retire", { discardUnsent: 1 }), 400, "invalid_request");
  const sent = await f.db.read((q) =>
    q.select({ n: sql<number>`count(*)` }).from(t.comments).where(eq(t.comments.reviewId, reviewId)).get(),
  );
  expect(sent?.n).toBe(1);
  await f.db.query((q) => q.update(t.reviews).set({ state: "approved" }).where(eq(t.reviews.id, reviewId)));
  await error(await post(reviewId, "retire", {}), 409, "invalid_state");
});

test("reopen needs a retired review, and a Send on a retired review is refused", async () => {
  const { reviewId } = await publishReview(f);
  await error(await post(reviewId, "reopen"), 409, "invalid_state");
  expect((await post(reviewId, "retire", {})).status).toBe(204);
  await error(
    await f.request(`/reviews/${reviewId}/sends`, "POST", { kind: "approve", revision: 1 }),
    409,
    "invalid_state",
  );
  await error(
    await f.request(`/reviews/${reviewId}/sends`, "POST", { kind: "go", revision: 1, instruction: "Hi" }),
    409,
    "invalid_state",
  );
  expect((await post(reviewId, "reopen")).status).toBe(204);
  expect((await row(reviewId))?.state).toBe("open");
  expect((await f.request(`/reviews/${reviewId}/sends`, "POST", { kind: "approve", revision: 1 })).status).toBe(201);
  await error(await post(reviewId, "reopen"), 409, "invalid_state");
});

test("a publish reopens a retired review and keeps the release record", async () => {
  const { reviewId } = await publishReview(f);
  expect((await post(reviewId, "retire", {})).status).toBe(204);
  await f.db.query((q) =>
    q.update(t.reviews).set({ releasedAt: 42, releasedReason: "retired" }).where(eq(t.reviews.id, reviewId)),
  );
  await publishReview(f);
  expect(await row(reviewId)).toMatchObject({ state: "open", releasedAt: 42, releasedReason: "retired" });
});

test("a Send does not end a snooze", async () => {
  const { reviewId } = await publishReview(f);
  await userThread(reviewId);
  expect((await post(reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  expect((await f.request(`/reviews/${reviewId}/sends`, "POST", { kind: "go", revision: 1 })).status).toBe(201);
  expect((await inbox())[0]).toMatchObject({ list: "snoozed", snoozed: true, pendingSend: true });
});

test("the inbox orders Active (waiting first), Snoozed (soonest first, revision last) and Done, capped per list", async () => {
  const a = await publishReview(f, { key: "1", title: "A" });
  const b = await publishReview(f, { key: "2", title: "B" });
  const c = await publishReview(f, { key: "3", title: "C" });
  const d = await publishReview(f, { key: "4", title: "D" });
  const e = await publishReview(f, { key: "5", title: "E" });
  const g = await publishReview(f, { key: "6", title: "G" });
  const h = await publishReview(f, { key: "7", title: "H" });
  const now = f.deps.now();
  // Active by update: b newest, then a. Snoozed: c at +2h, d at +1h, e until revision.
  await stamp(a.reviewId, now - 3000);
  await stamp(b.reviewId, now - 1000);
  await stamp(h.reviewId, now - 2000);
  await stamp(g.reviewId, now - 500);
  // H is older than B, but an agent waits on it, so it comes first.
  await f.db.query((q) =>
    q.insert(t.agentWaiters).values({ ownerId: f.ownerId, reviewId: h.reviewId, expiresAt: now + 30_000 }),
  );
  expect((await post(c.reviewId, "snooze", { until: iso(now + 2 * 3_600_000) })).status).toBe(204);
  expect((await post(d.reviewId, "snooze", { until: iso(now + 3_600_000) })).status).toBe(204);
  expect((await post(e.reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  expect((await post(g.reviewId, "retire", {})).status).toBe(204);
  await stamp(g.reviewId, now - 500);
  await f.db.query((q) => q.update(t.reviews).set({ state: "approved" }).where(eq(t.reviews.id, a.reviewId)));
  await stamp(a.reviewId, now - 4000);
  const items = await inbox();
  expect(items.map((item) => [item.title, item.list])).toEqual([
    ["H", "active"],
    ["B", "active"],
    ["D", "snoozed"],
    ["C", "snoozed"],
    ["E", "snoozed"],
    ["G", "done"],
    ["A", "done"],
  ]);
});

test("recent approvals sort by update among open rows, ignoring stale snoozes and keeping waiting agents first", async () => {
  const a = await publishReview(f, { key: "1", title: "Older open" });
  const b = await publishReview(f, { key: "2", title: "Newer open" });
  const c = await publishReview(f, { key: "3", title: "Approved with a snooze" });
  const d = await publishReview(f, { key: "4", title: "Approved and waiting" });
  const now = f.deps.now();
  const until = now + day;
  expect((await post(c.reviewId, "snooze", { until: iso(until) })).status).toBe(204);
  await approve(c.reviewId);
  await approve(d.reviewId);
  await stamp(a.reviewId, now - 3000);
  await stamp(b.reviewId, now - 1000);
  await stamp(c.reviewId, now - 2000);
  await stamp(d.reviewId, now - 4000);
  await f.db.query((q) =>
    q.insert(t.agentWaiters).values({ ownerId: f.ownerId, reviewId: d.reviewId, expiresAt: now + 30_000 }),
  );
  expect((await inbox()).map((item) => [item.title, item.list])).toEqual([
    ["Approved and waiting", "active"],
    ["Newer open", "active"],
    ["Approved with a snooze", "active"],
    ["Older open", "active"],
  ]);
  await expectBoth(c.reviewId, { snoozed: false, snoozedUntil: null, activeUntil: iso(now + approvedWindow) });
  expect(await row(c.reviewId)).toMatchObject({ snoozedUntil: until });
});

test("an unsnoozed review sorts as updated at the unsnooze, and a passed timed snooze sorts by its wake time", async () => {
  const a = await publishReview(f, { key: "1", title: "A" });
  const b = await publishReview(f, { key: "2", title: "B" });
  const c = await publishReview(f, { key: "3", title: "C" });
  const start = f.deps.now();
  await stamp(a.reviewId, start - 5000);
  await stamp(b.reviewId, start - 3000);
  await stamp(c.reviewId, start - 4000);
  expect((await post(c.reviewId, "snooze", { until: iso(start + 60_000) })).status).toBe(204);
  expect((await post(a.reviewId, "snooze", { untilRevision: true })).status).toBe(204);
  f.advance(120_000);
  expect((await post(a.reviewId, "unsnooze")).status).toBe(204);
  expect(await row(a.reviewId)).toMatchObject({ updatedAt: start + 120_000, snoozedAt: null, snoozedUntil: null });
  // A is newest (just unsnoozed), C came back at its wake time, B was last touched before both.
  expect((await inbox()).map((item) => [item.title, item.list])).toEqual([
    ["A", "active"],
    ["C", "active"],
    ["B", "active"],
  ]);
});

async function seedReviews(rows: (typeof t.reviews.$inferInsert & { id: string })[]) {
  await f.db.transaction(async (q) => {
    await q.insert(t.reviews).values(rows);
    await q.insert(t.revisions).values(
      rows.map((review) => ({
        id: randomUUID(),
        ownerId: f.ownerId,
        reviewId: review.id,
        seq: 1,
        contentKey: randomUUID(),
        createdAt: 1,
      })),
    );
  });
}

test("approvals fill the remaining Active places and interleave with open reviews by activity", async () => {
  const now = f.deps.now();
  const make = (state: "open" | "approved", updatedAt: number) => ({
    id: randomUUID(),
    ownerId: f.ownerId,
    originInstanceId: f.instanceId,
    reviewKey: randomUUID().replaceAll("-", "").repeat(2),
    title: "Synthetic capped review",
    state,
    approvedAt: state === "approved" ? now : null,
    createdAt: 1,
    updatedAt,
    snoozedAt: null as number | null,
    snoozedUntil: null as number | null,
  });
  // A passed snooze controls the first open row's position; a future snooze on an approval does not.
  const open = [
    { ...make("open", now - 10_000), snoozedAt: now - 20_000, snoozedUntil: now - 1500 },
    make("open", now - 500),
    make("open", now - 2000),
  ];
  const approvals = Array.from({ length: LIMITS.inboxItems }, (_, i) => ({
    ...make("approved", now - i * 1000),
    ...(i === 2 ? { snoozedAt: now - 10_000, snoozedUntil: now + day } : {}),
  }));
  await seedReviews([...open, ...approvals]);
  const list = InboxList.parse(await (await f.request("/reviews", "GET")).json());
  const active = list.items.filter((item) => item.list === "active");
  expect(active).toHaveLength(LIMITS.inboxItems);
  // The fixture's own review takes one open place too.
  const kept = [...open, ...approvals.slice(0, LIMITS.inboxItems - open.length - 1)];
  const activity = (review: (typeof open)[number]) =>
    review.state === "open" ? Math.max(review.updatedAt, review.snoozedUntil ?? 0) : review.updatedAt;
  kept.sort((a, b) => activity(b) - activity(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  expect(active.filter((item) => item.id !== f.reviewId).map((item) => item.id)).toEqual(kept.map((item) => item.id));
  expect(
    active
      .filter((item) => item.id !== f.reviewId)
      .slice(0, 4)
      .map((item) => item.state),
  ).toEqual(["approved", "open", "approved", "open"]);
  const keptApprovals = active.filter((item) => item.state === "approved");
  expect(keptApprovals).toHaveLength(LIMITS.inboxItems - open.length - 1);
  for (const item of keptApprovals) expect(item.activeUntil).toBe(iso(now + approvedWindow));
  const overflow = approvals.slice(keptApprovals.length);
  expect(list.items.filter((item) => item.list === "done").map((item) => item.id)).toEqual(
    overflow.map((item) => item.id),
  );
  for (const item of list.items.filter((item) => item.list === "done")) expect(item.activeUntil).toBeNull();
  expect(list.items.map((item) => item.id).sort()).toEqual(
    [f.reviewId, ...open.map((item) => item.id), ...approvals.map((item) => item.id)].sort(),
  );
  // The single-review view uses the time rule alone, independent of list capacity.
  const firstOverflow = overflow[0];
  if (!firstOverflow) throw new Error("missing overflow approval");
  const single = ReviewView.parse(await (await f.request(`/reviews/${firstOverflow.id}`, "GET")).json());
  expect(single).toMatchObject({ state: "approved", list: "active", activeUntil: iso(now + approvedWindow) });
});

test.each([0, 5])("the per-list cap keeps overflow approvals in Done with %s extra open reviews", async (extra) => {
  const rows = (state: "open" | "approved", count: number, snoozed: boolean, approvedAt: number | null = null) =>
    Array.from({ length: count }, (_, i) => ({
      id: randomUUID(),
      ownerId: f.ownerId,
      originInstanceId: f.instanceId,
      reviewKey: randomUUID().replaceAll("-", "").repeat(2),
      title: `${state}-${snoozed}-${i}`,
      state,
      approvedAt,
      snoozedAt: snoozed ? 1 : null,
      createdAt: 1,
      updatedAt: (approvedAt ?? 1) + i,
    }));
  const recent = rows("approved", 3, false, f.deps.now());
  const older = rows("approved", 3, false, f.deps.now() - approvedWindow);
  const all = [...rows("open", LIMITS.inboxItems - 1 + extra, false), ...recent, ...older, ...rows("open", 2, true)];
  await seedReviews(all);
  // Unfiltered: the fixture's own review is one of the Active rows.
  const items = InboxList.parse(await (await f.request("/reviews", "GET")).json()).items;
  const by = (list: string) => items.filter((item) => item.list === list).length;
  expect([by("active"), by("snoozed"), by("done")]).toEqual([LIMITS.inboxItems, 2, 6]);
  expect(items.filter((item) => item.list === "active").every((item) => item.state === "open")).toBe(true);
  expect(
    items
      .filter((item) => item.list === "done")
      .map((item) => item.id)
      .sort(),
  ).toEqual([...recent, ...older].map((item) => item.id).sort());
  for (const item of items.filter((item) => item.list === "done")) expect(item.activeUntil).toBeNull();
  if (extra === 0)
    expect(items.map((item) => item.id).sort()).toEqual([f.reviewId, ...all.map((item) => item.id)].sort());
  f.advance(approvedWindow);
  const later = InboxList.parse(await (await f.request("/reviews", "GET")).json()).items;
  expect(later.filter((item) => item.list === "active")).toHaveLength(LIMITS.inboxItems);
  expect(later.filter((item) => item.list === "active").every((item) => item.state === "open")).toBe(true);
  expect(later.filter((item) => item.list === "done")).toHaveLength(6);
});

test("delete removes every row of the review and only the blobs no other review uses", async () => {
  const shared = "# Shared doc";
  const first = await publishReview(f, { key: "1", docs: { "shared.md": shared, "own.md": "# Only in the first" } });
  const second = await publishReview(f, { key: "2", docs: { "shared.md": shared } });
  const thread = await userThread(first.reviewId);
  const sent = await f.request(`/reviews/${first.reviewId}/sends`, "POST", { kind: "go", revision: 1 });
  expect([sent.status, await sent.text()]).toEqual([201, expect.any(String)]);
  const candidates = async (reviewId: string) =>
    f.db.read(async (q) => {
      const docs = await q.select().from(t.files).where(eq(t.files.ownerId, f.ownerId));
      const owned = await q.select({ id: t.revisions.id }).from(t.revisions).where(eq(t.revisions.reviewId, reviewId));
      const ids = new Set(owned.map((r) => r.id));
      return docs
        .filter((file) => ids.has(file.revisionId))
        .flatMap((file) => [file.newBlob, file.renderedBlob])
        .filter((h): h is string => !!h);
    });
  const firstBlobs = new Set(await candidates(first.reviewId));
  const secondBlobs = new Set(await candidates(second.reviewId));
  const onlyFirst = [...firstBlobs].filter((hash) => !secondBlobs.has(hash));
  const both = [...firstBlobs].filter((hash) => secondBlobs.has(hash));
  expect(onlyFirst.length).toBeGreaterThan(0);
  expect(both.length).toBeGreaterThan(0);
  const response = await f.request(`/reviews/${first.reviewId}`, "DELETE");
  expect(response.status).toBe(204);
  await f.blobCleanup();
  const gone = await f.db.read(async (q) => {
    const id = first.reviewId;
    const rows = await q.values<[number]>(
      sql`select (select count(*) from reviews where id = ${id}),
        (select count(*) from revisions where review_id = ${id}),
        (select count(*) from threads where review_id = ${id}),
        (select count(*) from comments where review_id = ${id}),
        (select count(*) from sends where review_id = ${id}),
        (select count(*) from deliveries where review_id = ${id}),
        (select count(*) from placements where review_id = ${id}),
        (select count(*) from viewed_files where review_id = ${id}),
        (select count(*) from agent_waiters where review_id = ${id})`,
    );
    return rows[0];
  });
  expect(gone).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const orphans = await f.db.read(async (q) => {
    const rows = await q.values<[number]>(
      sql`select (select count(*) from files where owner_id = ${f.ownerId} and revision_id not in (select id from revisions))
        + (select count(*) from writeups where owner_id = ${f.ownerId} and revision_id not in (select id from revisions))
        + (select count(*) from topics where owner_id = ${f.ownerId} and revision_id not in (select id from revisions))
        + (select count(*) from changed_blocks where owner_id = ${f.ownerId} and revision_id not in (select id from revisions))`,
    );
    return rows[0]?.[0];
  });
  expect(orphans).toBe(0);
  for (const hash of onlyFirst) expect(await f.deps.blobs.has(f.ownerId, hash)).toBe(false);
  for (const hash of both) expect(await f.deps.blobs.get(f.ownerId, hash)).not.toBeNull();
  // The tombstone records the id and the time only.
  const tombstone = await f.db.read((q) =>
    q.values(sql`select owner_id, review_id, deleted_at from review_tombstones where review_id = ${first.reviewId}`),
  );
  expect(tombstone).toEqual([[f.ownerId, first.reviewId, f.deps.now()]]);
  expect(thread.threadId).toBeTruthy();
  await error(await f.request(`/reviews/${first.reviewId}`, "GET"), 404, "unknown_review");
  expect((await f.request(`/reviews/${second.reviewId}`, "GET")).status).toBe(200);
  // A publish with the first key creates a new review.
  const again = await publishReview(f, { key: "1" });
  expect(again.reviewId).not.toBe(first.reviewId);
  expect(again.revision).toBe(1);
});

test("delete removes a repo row only when no remaining review uses it", async () => {
  const a = await publishReview(f, { key: "1", title: "A" });
  const b = await publishReview(f, { key: "2", title: "B" });
  const c = await publishReview(f, { key: "3", title: "C" });
  const shared = randomUUID();
  const own = randomUUID();
  const theirs = randomUUID();
  await f.db.transaction(async (q) => {
    await q.insert(t.repos).values([
      { id: shared, ownerId: f.ownerId, key: "shared", name: "shared" },
      { id: own, ownerId: f.ownerId, key: "own", name: "own" },
      { id: theirs, ownerId: f.otherOwnerId, key: "shared", name: "shared" },
    ]);
    await q.update(t.reviews).set({ repoId: shared }).where(eq(t.reviews.id, a.reviewId));
    await q.update(t.reviews).set({ repoId: shared }).where(eq(t.reviews.id, b.reviewId));
    await q.update(t.reviews).set({ repoId: own }).where(eq(t.reviews.id, c.reviewId));
  });
  const repoIds = async () =>
    (await f.db.read((q) => q.select({ id: t.repos.id }).from(t.repos))).map((r) => r.id).sort();
  expect((await f.request(`/reviews/${a.reviewId}`, "DELETE")).status).toBe(204);
  expect(await repoIds()).toEqual([shared, own, theirs].sort());
  expect((await f.request(`/reviews/${b.reviewId}`, "DELETE")).status).toBe(204);
  expect(await repoIds()).toEqual([own, theirs].sort());
  expect((await f.request(`/reviews/${c.reviewId}`, "DELETE")).status).toBe(204);
  // Another owner's repo with the same key is never touched.
  expect(await repoIds()).toEqual([theirs]);
  await f.blobCleanup();
});

test("delete keeps another owner's blob with the same hash", async () => {
  const doc = "# Same bytes";
  const mine = await publishReview(f, { key: "1", docs: { "doc.md": doc } });
  const theirHash = await f.deps.blobs.put(f.otherOwnerId, Buffer.from(doc), "text/markdown");
  const used = await f.db.read((q) =>
    q.select({ hash: t.files.newBlob }).from(t.files).where(eq(t.files.ownerId, f.ownerId)),
  );
  expect(used.some((r) => r.hash === theirHash)).toBe(true);
  expect((await f.request(`/reviews/${mine.reviewId}`, "DELETE")).status).toBe(204);
  await f.blobCleanup();
  expect(await f.deps.blobs.has(f.otherOwnerId, theirHash)).toBe(true);
  expect(await f.deps.blobs.has(f.ownerId, theirHash)).toBe(false);
});

test("a publish that reuses a blob while its old review is deleted fails cleanly, then succeeds on retry", async () => {
  const doc = "# Reused doc";
  const first = await publishReview(f, { key: "1", docs: { "doc.md": doc } });
  const hash = (
    await f.db.read((q) => q.select({ hash: t.files.newBlob }).from(t.files).where(eq(t.files.ownerId, f.ownerId)))
  )[0]?.hash;
  if (!hash) throw new Error("missing blob");
  // The new publish stages the same bytes (the blob row exists), then the delete removes the row.
  const restage = await f.deps.blobs.put(f.ownerId, Buffer.from(doc), "text/markdown");
  expect(restage).toBe(hash);
  expect((await f.request(`/reviews/${first.reviewId}`, "DELETE")).status).toBe(204);
  await f.blobCleanup();
  expect(await f.deps.blobs.has(f.ownerId, hash)).toBe(false);
  const stale = await f.request(
    "/publish",
    "POST",
    {
      reviewKey: "b".repeat(64),
      repo: null,
      branch: null,
      title: "Reuses the blob",
      base: null,
      head: null,
      topics: [],
      writeup: { overview: "Synthetic", tldr: "", decisions: null, topics: {} },
      files: [{ path: "doc.md", role: "doc", oldPath: null, oldBlob: null, newBlob: hash, flag: null }],
    },
    "agent",
  );
  // Never a dangling reference: a client error, not a stored row pointing at a removed blob.
  expect([400, 409]).toContain(stale.status);
  const dangling = await f.db.read((q) =>
    q.values(sql`select count(*) from files where new_blob = ${hash} and owner_id = ${f.ownerId}`),
  );
  expect(dangling).toEqual([[0]]);
  const retried = await publishReview(f, { key: "2", docs: { "doc.md": doc } });
  expect(retried.revision).toBe(1);
  expect(await f.deps.blobs.get(f.ownerId, hash)).not.toBeNull();
});

test("a publish whose rendered blobs vanish between render and commit retries and stores them again", async () => {
  const doc = "# Shared doc";
  const first = await publishReview(f, { key: "1", docs: { "doc.md": doc } });
  const hash = await f.deps.blobs.put(f.ownerId, Buffer.from(doc), "text/markdown");
  const body = {
    reviewKey: "2".repeat(64),
    repo: null,
    branch: null,
    title: "Shares every blob",
    base: null,
    head: null,
    topics: [],
    writeup: { overview: "Synthetic", tldr: "", decisions: null, topics: {} },
    files: [{ path: "doc.md", role: "doc", oldPath: null, oldBlob: null, newBlob: hash, flag: null }],
  };
  const put = f.deps.blobs.put.bind(f.deps.blobs);
  let deleted = false;
  vi.spyOn(f.deps.blobs, "put").mockImplementation(async (...args) => {
    const sha = await put(...args);
    if (!deleted && args[2] === "application/json") {
      deleted = true;
      // The render has put its blobs (the first review's rows). Now the first review goes, rows and all.
      expect((await f.request(`/reviews/${first.reviewId}`, "DELETE")).status).toBe(204);
      await f.blobCleanup();
      await put(f.ownerId, Buffer.from(doc), "text/markdown");
    }
    return sha;
  });
  const response = await f.request("/publish", "POST", body, "agent");
  expect(deleted).toBe(true);
  expect(response.status).toBe(200);
  const missing = await f.db.read((q) =>
    q.values<[number]>(
      sql`select
        (select count(*) from writeups where owner_id = ${f.ownerId}
          and (source_blob not in (select sha256 from blobs where owner_id = ${f.ownerId})
            or rendered_blob not in (select sha256 from blobs where owner_id = ${f.ownerId})))
        + (select count(*) from files where owner_id = ${f.ownerId} and rendered_blob is not null
          and rendered_blob not in (select sha256 from blobs where owner_id = ${f.ownerId}))`,
    ),
  );
  expect(missing).toEqual([[0]]);
});

test("a delete answers 204 even when the blob cleanup fails, and logs without content", async () => {
  const doc = "# Cleanup fails";
  const { reviewId } = await publishReview(f, { key: "1", docs: { "doc.md": doc } });
  vi.spyOn(f.deps.blobs, "exclusive").mockRejectedValue(new Error("disk is gone: secret-path"));
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect((await f.request(`/reviews/${reviewId}`, "DELETE")).status).toBe(204);
    await f.blobCleanup();
    expect(log).toHaveBeenCalledWith("emend: blob cleanup after a review delete failed");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-path");
  } finally {
    log.mockRestore();
  }
  await error(await f.request(`/reviews/${reviewId}`, "GET"), 404, "unknown_review");
});
