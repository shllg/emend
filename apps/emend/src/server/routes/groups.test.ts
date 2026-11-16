import { randomUUID } from "node:crypto";
import { AgentReviewList, InboxGroup, InboxList, LIMITS, type ReviewEvent, ReviewView } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { listGroups } from "../../db/repo/groups.ts";
import * as t from "../../db/schema.ts";
import { createToken, SESSION_MS } from "../auth/tokens.ts";
import { publishReview } from "../mailbox/lifecycle-support.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  await f.blobCleanup();
  await f.cleanup();
});
const inbox = async (who: "reviewer" | "foreign" = "reviewer") =>
  InboxList.parse(await (await f.request("/reviews", "GET", undefined, who)).json());
const create = async (name = "Project A", who: "reviewer" | "foreign" = "reviewer") => {
  const response = await f.request("/groups", "POST", { name }, who);
  expect(response.status).toBe(201);
  return InboxGroup.parse(await response.json());
};
const move = (reviewId: string, groupId: string | null, who: "reviewer" | "foreign" = "reviewer") =>
  f.request(`/reviews/${reviewId}/group`, "PUT", { groupId }, who);
const view = async (id: string) => ReviewView.parse(await (await f.request(`/reviews/${id}`, "GET")).json());
const members = () =>
  f.db.read((q) => q.select().from(t.reviewGroupMembers).where(eq(t.reviewGroupMembers.ownerId, f.ownerId)).all());
const post = (id: string, action: string, body?: unknown) => f.request(`/reviews/${id}/${action}`, "POST", body);
async function seed(state: "open" | "approved" | "settled", extra: Partial<typeof t.reviews.$inferInsert> = {}) {
  const id = randomUUID();
  await f.db.transaction(async (q) => {
    await q.insert(t.reviews).values({
      id,
      ownerId: f.ownerId,
      originInstanceId: f.instanceId,
      title: "Synthetic group item",
      reviewKey: id.replaceAll("-", "").repeat(2),
      state,
      updatedAt: f.deps.now(),
      ...extra,
    });
    await q
      .insert(t.revisions)
      .values({ id: randomUUID(), ownerId: f.ownerId, reviewId: id, seq: 1, contentKey: randomUUID() });
  });
  return id;
}

test("create, list by name, rename (including itself), delete and report duplicates", async () => {
  const b = await create(" Zeta ");
  const a = await create("Alpha");
  expect((await inbox()).groups).toEqual([
    { ...a, members: 0 },
    { ...b, name: "Zeta", members: 0 },
  ]);
  for (const response of [
    await f.request("/groups", "POST", { name: " Alpha " }),
    await f.request(`/groups/${b.id}`, "PATCH", { name: "Alpha" }),
  ]) {
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "invalid_state", message: "A group with this name exists." },
    });
  }
  f.advance(1000);
  for (const name of ["Zeta", "Beta"]) {
    const response = await f.request(`/groups/${b.id}`, "PATCH", { name });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: b.id, name });
  }
  const stored = await f.db.read((q) =>
    q
      .select()
      .from(t.reviewGroups)
      .where(and(eq(t.reviewGroups.ownerId, f.ownerId), eq(t.reviewGroups.id, b.id)))
      .get(),
  );
  expect(stored?.updatedAt).toBe(f.deps.now());
  expect((await f.request(`/groups/${a.id}`, "DELETE")).status).toBe(204);
  expect((await inbox()).groups).toEqual([{ id: b.id, name: "Beta", members: 0 }]);
  await error(await f.request(`/groups/${a.id}`, "DELETE"), 404, "not_found");
});

test("only 50 groups per owner; a different owner still has room", async () => {
  await f.db.query((q) =>
    q
      .insert(t.reviewGroups)
      .values(
        Array.from({ length: LIMITS.groups }, (_, i) => ({ id: randomUUID(), ownerId: f.ownerId, name: `Group ${i}` })),
      ),
  );
  const response = await f.request("/groups", "POST", { name: "Too many" });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: { code: "invalid_state", message: "You have the most groups allowed. Delete one first." },
  });
  expect((await inbox()).groups).toHaveLength(50);
  await create("Other owner's group", "foreign");
});

test("invalid names and unknown fields are 400; malformed and missing path ids are 404", async () => {
  const group = await create();
  for (const body of [
    {},
    { name: "" },
    { name: "   " },
    { name: "x".repeat(81) },
    { name: "a\nb" },
    { name: "a\u0085b" },
    { name: "a\u2028b" },
    { name: "a\u2029b" },
    { name: "A", extra: true },
  ]) {
    await error(await f.request("/groups", "POST", body), 400, "invalid_request");
    await error(await f.request(`/groups/${group.id}`, "PATCH", body), 400, "invalid_request");
  }
  for (const body of [{}, { groupId: "bad" }, { groupId: group.id, extra: true }])
    await error(await f.request(`/reviews/${f.reviewId}/group`, "PUT", body), 400, "invalid_request");
  for (const id of ["bad", randomUUID()]) {
    await error(await f.request(`/groups/${id}`, "PATCH", { name: "A" }), 404, "not_found");
    await error(await f.request(`/groups/${id}`, "DELETE"), 404, "not_found");
    await error(await move(id, group.id), 404, id === "bad" ? "not_found" : "unknown_review");
  }
});

test("move pubs and reviews between groups and out without changing their records", async () => {
  const a = await create();
  const b = await create("Project B");
  const pub = await publishReview(f, { key: "b", writeup: { overview: "", tldr: "", decisions: null, topics: {} } });
  const review = await publishReview(f, { key: "c" });
  expect((await view(pub.reviewId)).kind).toBe("publish");
  expect((await view(review.reviewId)).kind).toBe("review");
  for (const { reviewId } of [pub, review]) {
    const before = await view(reviewId);
    f.advance(1000);
    for (const groupId of [a.id, a.id, b.id, null, null]) {
      expect((await move(reviewId, groupId)).status).toBe(204);
      expect(await view(reviewId)).toEqual({ ...before, groupId });
    }
    await error(await move(reviewId, randomUUID()), 404, "not_found");
    expect((await view(reviewId)).groupId).toBeNull();
  }
  expect(await members()).toEqual([]);
});

test("owner isolation covers groups, reviews, members and inbox metadata", async () => {
  const own = await create();
  const foreign = await create("Other group", "foreign");
  expect((await move(f.reviewId, own.id)).status).toBe(204);
  await error(await f.request(`/groups/${foreign.id}`, "PATCH", { name: "Changed" }), 404, "not_found");
  await error(await f.request(`/groups/${foreign.id}`, "DELETE"), 404, "not_found");
  await error(await move(f.reviewId, foreign.id), 404, "not_found");
  await error(await move(f.reviewId, foreign.id, "foreign"), 404, "unknown_review");
  expect((await inbox()).groups).toEqual([{ ...own, members: 1 }]);
  expect((await inbox("foreign")).groups).toEqual([{ ...foreign, members: 0 }]);
  expect((await view(f.reviewId)).groupId).toBe(own.id);
});

test("group counts include each owner's non-binned members and zero-member groups only", async () => {
  const a = await create("Alpha");
  const b = await create("Beta");
  const empty = await create("Empty");
  const foreign = await create("Alpha", "foreign");
  const binned = await seed("open");
  for (const reviewId of [f.reviewId, await seed("settled"), binned])
    expect((await move(reviewId, a.id)).status).toBe(204);
  expect((await move(await seed("approved", { approvedAt: f.deps.now() }), b.id)).status).toBe(204);
  expect((await post(binned, "bin")).status).toBe(204);
  await f.db.transaction(async (q) => {
    const reviewId = randomUUID();
    await q.insert(t.reviews).values({
      id: reviewId,
      ownerId: f.otherOwnerId,
      originInstanceId: f.instanceId,
      title: "Synthetic foreign member",
      reviewKey: reviewId.replaceAll("-", "").repeat(2),
    });
    await q.insert(t.reviewGroupMembers).values({ ownerId: f.otherOwnerId, reviewId, groupId: foreign.id });
  });
  expect((await inbox()).groups).toEqual([
    { ...a, members: 2 },
    { ...b, members: 1 },
    { ...empty, members: 0 },
  ]);
  expect((await inbox("foreign")).groups).toEqual([{ ...foreign, members: 1 }]);
  expect((await post(binned, "restore")).status).toBe(204);
  expect((await inbox()).groups.find((group) => group.id === a.id)?.members).toBe(3);
});

test("membership insert and reassignment store the server clock in created_at", async () => {
  const a = await create("Alpha");
  const b = await create("Beta");
  const now = Date.parse("2026-11-15T12:00:00.000Z");
  f.deps.now = () => now;
  expect((await move(f.reviewId, a.id)).status).toBe(204);
  expect(await members()).toEqual([{ ownerId: f.ownerId, reviewId: f.reviewId, groupId: a.id, createdAt: now }]);
  f.deps.now = () => now + 1000;
  expect((await move(f.reviewId, b.id)).status).toBe(204);
  expect(await members()).toEqual([{ ownerId: f.ownerId, reviewId: f.reviewId, groupId: b.id, createdAt: now + 1000 }]);
});

test("all group writes reject agent/admin bearers and a reviewer token sent as a bearer before lookup", async () => {
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
  for (const [path, method] of [
    ["/groups", "POST"],
    ["/groups/bad", "PATCH"],
    ["/groups/bad", "DELETE"],
    ["/reviews/bad/group", "PUT"],
  ] as const) {
    await error(await f.request(path, method, undefined, "agent"), 403, "forbidden");
    for (const [secret, status] of [
      [admin, 403],
      [reviewer, 401],
    ] as const) {
      const response = await f.app.request(`http://127.0.0.1:3636/api/v1${path}`, {
        method,
        headers: { Host: "127.0.0.1:3636", Authorization: `Bearer ${secret}` },
      });
      expect(response.status).toBe(status);
    }
  }
  expect((await inbox()).groups).toEqual([]);
});

test("membership wins over all states, keeps state fields, and occupies its block between Snoozed and Done", async () => {
  const group = await create();
  const snoozed = await seed("open", { snoozedAt: f.deps.now(), snoozedUntil: null });
  const done = await seed("settled");
  const grouped: string[] = [];
  for (const state of ["open", "snoozed", "approved", "settled"] as const) {
    f.advance(1000);
    const id = await seed(
      state === "snoozed" ? "open" : state,
      state === "snoozed"
        ? { snoozedAt: f.deps.now(), snoozedUntil: null }
        : state === "approved"
          ? { approvedAt: f.deps.now() }
          : {},
    );
    grouped.push(id);
    expect((await move(id, group.id)).status).toBe(204);
  }
  const [open, asleep, approved, retired] = grouped;
  const items = (await inbox()).items;
  expect(items.map((item) => item.id)).toEqual([f.reviewId, snoozed, ...[...grouped].reverse(), done]);
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  for (const id of grouped) expect(items.find((item) => item.id === id)?.groupId).toBe(group.id);
  expect(items.find((item) => item.id === asleep)).toMatchObject({ list: "snoozed", snoozed: true });
  expect(items.find((item) => item.id === approved)).toMatchObject({
    state: "approved",
    list: "active",
    activeUntil: expect.any(String),
  });
  expect(items.find((item) => item.id === retired)).toMatchObject({ state: "settled", list: "done" });
  expect((await f.request(`/groups/${group.id}`, "DELETE")).status).toBe(204);
  const returned = (await inbox()).items;
  for (const [id, list] of [
    [open, "active"],
    [asleep, "snoozed"],
    [approved, "active"],
    [retired, "done"],
  ])
    expect(returned.find((item) => item.id === id)).toMatchObject({ groupId: null, list });
});

test("grouped approvals take no approval-cap places and follow the window even at a zero cap", async () => {
  const group = await create();
  const grouped = await seed("approved", { approvedAt: f.deps.now() });
  await move(grouped, group.id);
  const approvals = [];
  for (let i = 0; i < 6; i++) approvals.push(await seed("approved", { approvedAt: f.deps.now() - 1000 - i }));
  const items = (await inbox()).items;
  expect(
    items
      .filter((item) => item.groupId === null && item.state === "approved" && item.list === "active")
      .map((item) => item.id),
  ).toEqual(approvals.slice(0, 5).sort());
  expect(items.find((item) => item.id === grouped)).toMatchObject({
    list: "active",
    activeUntil: expect.any(String),
    groupId: group.id,
  });
  expect((await f.request("/settings", "PATCH", { approvedActiveLimit: 0 })).status).toBe(200);
  expect((await inbox()).items.find((item) => item.id === grouped)?.list).toBe("active");
  f.advance(13 * 3_600_000);
  expect((await inbox()).items.find((item) => item.id === grouped)).toMatchObject({
    list: "done",
    activeUntil: null,
    groupId: group.id,
  });
});

test("group activity uses elapsed wakes only, newest first with id ascending on ties", async () => {
  const group = await create();
  const now = f.deps.now();
  const elapsed = await seed("open", { updatedAt: now - 5000, snoozedAt: now - 5000, snoozedUntil: now - 1000 });
  const future = await seed("open", { updatedAt: now - 5000, snoozedAt: now - 5000, snoozedUntil: now + 100000 });
  const retired = await seed("settled", { updatedAt: now - 2000, snoozedUntil: now + 100000 });
  const tie = await seed("open", { updatedAt: now - 2000 });
  for (const id of [elapsed, future, retired, tie]) await move(id, group.id);
  expect((await inbox()).items.filter((item) => item.groupId).map((item) => item.id)).toEqual([
    elapsed,
    ...[retired, tie].sort(),
    future,
  ]);
});

test("new revisions, waiting, snooze, retire, reopen and approval keep membership; agents see no groups", async () => {
  const group = await create();
  const { reviewId } = await publishReview(f);
  await move(reviewId, group.id);
  for (const [action, body] of [
    ["snooze", { untilRevision: true }],
    ["retire", {}],
    ["reopen", undefined],
    ["sends", { kind: "approve", revision: 1 }],
  ] as const) {
    expect((await post(reviewId, action, body)).status).toBe(action === "sends" ? 201 : 204);
    expect((await view(reviewId)).groupId).toBe(group.id);
  }
  await publishReview(f);
  const stop = f.deps.events?.beginWaiting(f.ownerId, reviewId, 2);
  expect((await inbox()).items.find((item) => item.id === reviewId)).toMatchObject({
    groupId: group.id,
    newestRevision: 2,
    agentWaiting: true,
    state: "open",
  });
  stop?.();
  const response = await (await f.request("/agent/reviews", "GET", undefined, "agent")).json();
  expect(AgentReviewList.safeParse(response).success).toBe(true);
  expect(JSON.stringify(response)).not.toMatch(/groupId|groups/);
});

test("bin preserves membership, refuses moves, restores to the group, and hard delete removes its member row", async () => {
  const group = await create();
  await move(f.reviewId, group.id);
  expect((await post(f.reviewId, "bin")).status).toBe(204);
  await error(await move(f.reviewId, null), 409, "review_in_bin");
  expect((await inbox()).items).toEqual([]);
  expect((await inbox()).groups).toEqual([{ ...group, members: 0 }]);
  expect(await members()).toHaveLength(1);
  expect((await post(f.reviewId, "restore")).status).toBe(204);
  expect((await view(f.reviewId)).groupId).toBe(group.id);
  expect((await f.request(`/reviews/${f.reviewId}`, "DELETE")).status).toBe(204);
  expect(await members()).toEqual([]);
});

test("deleting a group removes binned memberships too, and moved reviews refuse membership writes", async () => {
  const group = await create();
  await move(f.reviewId, group.id);
  await post(f.reviewId, "bin");
  expect((await f.request(`/groups/${group.id}`, "DELETE")).status).toBe(204);
  expect(await members()).toEqual([]);
  await post(f.reviewId, "restore");
  expect((await view(f.reviewId)).groupId).toBeNull();
  await f.db.query((q) =>
    q
      .update(t.reviews)
      .set({ movedToUrl: "https://example.com/r/synthetic" })
      .where(and(eq(t.reviews.ownerId, f.ownerId), eq(t.reviews.id, f.reviewId))),
  );
  await error(await move(f.reviewId, null), 409, "review_moved");
});

test("group events run after commit, with reviewId only for moves, and reach owner-wide SSE", async () => {
  const seen: ReviewEvent[] = [];
  const snapshots: Promise<unknown>[] = [];
  const stop = f.deps.events?.subscribe(f.ownerId, null, (event) => {
    seen.push(event);
    snapshots.push(
      f.db.read(async (q) => ({
        groups: await listGroups(f.ownerId, q),
        members: await q.select().from(t.reviewGroupMembers).where(eq(t.reviewGroupMembers.ownerId, f.ownerId)).all(),
      })),
    );
  });
  const stream = await f.request("/events", "GET");
  const reader = stream.body?.getReader();
  if (!reader) throw new Error("Missing stream");
  try {
    await reader.read();
    const group = await create();
    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame).toBe("event: groups\ndata: {}\n\n");
    await f.request(`/groups/${group.id}`, "PATCH", { name: "Renamed" });
    await move(f.reviewId, group.id);
    await f.request(`/groups/${group.id}`, "DELETE");
    expect(seen).toEqual([
      { type: "groups" },
      { type: "groups" },
      { type: "groups", reviewId: f.reviewId },
      { type: "groups" },
    ]);
    expect(await Promise.all(snapshots)).toMatchObject([
      { groups: [group], members: [] },
      { groups: [{ id: group.id, name: "Renamed" }], members: [] },
      { groups: [{ id: group.id, name: "Renamed" }], members: [{ reviewId: f.reviewId, groupId: group.id }] },
      { groups: [], members: [] },
    ]);
  } finally {
    stop?.();
    await reader.cancel();
  }
});

test("all four inbox blocks have independent 200-row limits, and groups cannot consume Active places", async () => {
  const group = await create();
  const blocks = ["active", "snoozed", "group", "done"] as const;
  const rows = blocks.flatMap((block) =>
    Array.from({ length: LIMITS.inboxItems + 1 }, (_, i) => {
      const id = randomUUID();
      return {
        block,
        id,
        review: {
          id,
          ownerId: f.ownerId,
          originInstanceId: f.instanceId,
          reviewKey: id.replaceAll("-", "").repeat(2),
          title: `Synthetic ${block} ${i}`,
          state: block === "done" ? ("settled" as const) : ("open" as const),
          snoozedAt: block === "snoozed" ? f.deps.now() : null,
          updatedAt: f.deps.now() + i,
        },
      };
    }),
  );
  await f.db.transaction(async (q) => {
    for (let start = 0; start < rows.length; start += 100) {
      const batch = rows.slice(start, start + 100);
      await q.insert(t.reviews).values(batch.map((row) => row.review));
      await q.insert(t.revisions).values(
        batch.map((row) => ({
          id: randomUUID(),
          ownerId: f.ownerId,
          reviewId: row.id,
          seq: 1,
          contentKey: randomUUID(),
        })),
      );
    }
    await q
      .insert(t.reviewGroupMembers)
      .values(
        rows
          .filter((row) => row.block === "group")
          .map((row) => ({ ownerId: f.ownerId, reviewId: row.id, groupId: group.id })),
      );
  });
  const listed = await inbox();
  expect(listed.groups).toEqual([{ ...group, members: LIMITS.inboxItems + 1 }]);
  const result = listed.items;
  expect(result).toHaveLength(800);
  expect(new Set(result.map((row) => row.id)).size).toBe(800);
  for (const [index, block] of blocks.entries())
    expect(
      result
        .slice(index * 200, (index + 1) * 200)
        .every((row) => (block === "group" ? row.groupId === group.id : row.groupId === null && row.list === block)),
    ).toBe(true);
  const expectedGroups = rows
    .filter((row) => row.block === "group")
    .sort((a, b) => b.review.updatedAt - a.review.updatedAt)
    .slice(0, 200)
    .map((row) => row.id);
  expect(result.filter((row) => row.groupId).map((row) => row.id)).toEqual(expectedGroups);
});

test("capabilities advertise review groups", async () => {
  expect(await (await f.request("/capabilities", "GET")).json()).toMatchObject({
    features: expect.arrayContaining(["review-bin", "review-groups"]),
  });
});
