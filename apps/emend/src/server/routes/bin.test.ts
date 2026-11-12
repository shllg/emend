import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AgentReviewList,
  BinView,
  InboxList,
  LIMITS,
  type ReviewEvent,
  ReviewView,
  RevisionView,
} from "@emend/contract";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as lifecycle from "../../db/repo/lifecycle.ts";
import { requireReview } from "../../db/repo/thread-access.ts";
import * as t from "../../db/schema.ts";
import { createToken, SESSION_MS } from "../auth/tokens.ts";
import { publishReview } from "../mailbox/lifecycle-support.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";
import * as pacing from "../pacing.ts";
import { bundle, importFixture } from "./import-test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});

const day = 86_400_000;
const post = (id: string, action: string, who: "reviewer" | "foreign" | "agent" = "reviewer") =>
  f.request(`/reviews/${id}/${action}`, "POST", undefined, who);
const bin = async () => BinView.parse(await (await f.request("/bin", "GET")).json());
const confirmation = async (who: "reviewer" | "foreign" = "reviewer") => {
  const view = BinView.parse(await (await f.request("/bin", "GET", undefined, who)).json());
  return { version: view.version };
};
const inboxIds = async () =>
  InboxList.parse(await (await f.request("/reviews", "GET")).json()).items.map((item) => item.id);
const row = (id: string) =>
  f.db.read((q) =>
    q
      .select()
      .from(t.reviews)
      .where(and(eq(t.reviews.ownerId, f.ownerId), eq(t.reviews.id, id)))
      .get(),
  );
const exists = async (id: string) => (await row(id)) !== undefined;

// A synthetic PNG header, served without decoding by the media route.
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
async function seedWriteupImage(reviewId: string) {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  await f.db.query(async (q) => {
    const revision = await q
      .select({ id: t.revisions.id })
      .from(t.revisions)
      .where(and(eq(t.revisions.ownerId, f.ownerId), eq(t.revisions.reviewId, reviewId)))
      .get();
    if (!revision) throw new Error("Missing revision");
    await q.insert(t.files).values({
      id: randomUUID(),
      ownerId: f.ownerId,
      revisionId: revision.id,
      path: "image.png",
      role: "asset",
      ord: 1,
      mediaType: "image/png",
      newBlob: hash,
    });
  });
  return hash;
}

const bearer = (secret: string, path: string, method: string) =>
  f.app.request(`http://127.0.0.1:3636/api/v1${path}`, {
    method,
    headers: { Host: "127.0.0.1:3636", Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
  });

test("the five bin routes are reviewer-only: agent, admin and bearer-sent reviewer tokens are refused", async () => {
  const { reviewId } = await publishReview(f);
  const admin = (await createToken(f.db, f.ownerId, "admin")).secret;
  const deviceId = randomUUID();
  await f.db.query((q) =>
    q.insert(t.devices).values({ id: deviceId, ownerId: f.ownerId, kind: "browser", name: "Synthetic" }),
  );
  const now = f.deps.now();
  const sessionAsBearer = (
    await createToken(f.db, f.ownerId, "reviewer", { deviceId, now, expiresAt: now + SESSION_MS })
  ).secret;
  const calls = [
    [`/reviews/${reviewId}/bin`, "POST"],
    [`/reviews/${reviewId}/restore`, "POST"],
    ["/bin", "GET"],
    ["/bin", "DELETE"],
    [`/bin/${reviewId}`, "DELETE"],
  ] as const;
  for (const [path, method] of calls) {
    await error(await f.request(path, method, undefined, "agent"), 403, "forbidden");
    expect((await bearer(admin, path, method)).status).toBe(403);
    expect((await bearer(sessionAsBearer, path, method)).status).toBe(401);
  }
  expect((await row(reviewId))?.binnedAt).toBeNull();
  expect((await bin()).total).toBe(0);
});

test("bin, list and restore a review without changing anything else", async () => {
  const { reviewId } = await publishReview(f, { title: "Binned review" });
  await f.request(`/reviews/${reviewId}/threads`, "POST", { revision: 1, target: { kind: "review" }, body: "Note" });
  const before = await row(reviewId);
  const seen: ReviewEvent[] = [];
  f.deps.events?.subscribe(f.ownerId, null, (event) => seen.push(event));
  f.advance(1000);
  expect((await post(reviewId, "bin")).status).toBe(204);
  expect(seen).toEqual([{ type: "bin", reviewId, revision: 1 }]);
  expect(await bin()).toEqual({
    items: [
      {
        id: reviewId,
        title: "Binned review",
        machine: "Synthetic instance",
        binnedAt: new Date(f.deps.now()).toISOString(),
      },
    ],
    total: 1,
    more: false,
    version: createHash("sha256").update(reviewId).digest("hex"),
  });
  expect(await inboxIds()).not.toContain(reviewId);
  expect({ ...(await row(reviewId)), binnedAt: null }).toEqual(before);
  // Nothing purges it as time passes.
  f.advance(25 * day);
  expect((await bin()).total).toBe(1);
  expect(await exists(reviewId)).toBe(true);
  expect((await post(reviewId, "restore")).status).toBe(204);
  expect(seen.at(-1)).toEqual({ type: "restore", reviewId, revision: 1 });
  expect(await row(reviewId)).toEqual(before);
  expect(await inboxIds()).toContain(reviewId);
  expect((await bin()).total).toBe(0);
  await error(await post(reviewId, "restore"), 409, "invalid_state");
});

test("restore returns the review to the same place in the same list with its records unchanged", async () => {
  const a = await publishReview(f, { key: "1", diff: true });
  f.advance(1000);
  const b = await publishReview(f, { key: "2", diff: true });
  f.advance(1000);
  const c = await publishReview(f, { key: "3", diff: true });
  const created = await f.request(`/reviews/${b.reviewId}/threads`, "POST", {
    revision: 1,
    target: { kind: "review" },
    body: "Keep me",
  });
  expect(created.status).toBe(201);
  const marked = await f.request(`/reviews/${b.reviewId}/viewed`, "PUT", {
    revision: 1,
    paths: ["src/a.ts"],
    viewed: true,
  });
  expect(marked.status).toBe(204);
  const revisionView = async () =>
    (await (await f.request(`/reviews/${b.reviewId}/revisions/1`, "GET")).json()) as unknown;
  const listBefore = (await inboxIds()).filter((id) => [a, b, c].some((r) => r.reviewId === id));
  const viewBefore = await revisionView();
  expect((await post(b.reviewId, "bin")).status).toBe(204);
  expect((await inboxIds()).filter((id) => [a, b, c].some((r) => r.reviewId === id))).toEqual(
    listBefore.filter((id) => id !== b.reviewId),
  );
  f.advance(day);
  expect((await post(b.reviewId, "restore")).status).toBe(204);
  expect((await inboxIds()).filter((id) => [a, b, c].some((r) => r.reviewId === id))).toEqual(listBefore);
  expect(await revisionView()).toEqual(viewBefore);
});

test("bin and restore are owner-scoped: a foreign or unknown review is 404 and never listed", async () => {
  const { reviewId } = await publishReview(f);
  await error(await post(reviewId, "bin", "foreign"), 404, "unknown_review");
  await error(await post(reviewId, "restore", "foreign"), 404, "unknown_review");
  await error(await post(randomUUID(), "bin"), 404, "unknown_review");
  await error(await post(randomUUID(), "restore"), 404, "unknown_review");
  expect((await post(reviewId, "bin")).status).toBe(204);
  const foreign = BinView.parse(await (await f.request("/bin", "GET", undefined, "foreign")).json());
  expect(foreign).toEqual({ items: [], total: 0, more: false, version: createHash("sha256").update("").digest("hex") });
  expect((await f.request("/bin", "DELETE", await confirmation("foreign"), "foreign")).status).toBe(204);
  expect(await exists(reviewId)).toBe(true);
});

test("a moved review cannot be binned", async () => {
  const { reviewId } = await publishReview(f);
  await f.db.query((q) =>
    q.update(t.reviews).set({ movedToUrl: "https://hub.example/r/x" }).where(eq(t.reviews.id, reviewId)),
  );
  await error(await post(reviewId, "bin"), 409, "review_moved");
});

test("a moved and binned review reads as moved but stays out of every list", async () => {
  const { reviewId } = await publishReview(f, { diff: true });
  const hash = await seedWriteupImage(reviewId);
  const movedTo = "https://hub.example/r/moved";
  expect((await post(reviewId, "bin")).status).toBe(204);
  await f.db.query((q) =>
    q
      .update(t.reviews)
      .set({ movedToUrl: movedTo })
      .where(and(eq(t.reviews.ownerId, f.ownerId), eq(t.reviews.id, reviewId))),
  );
  const response = await f.request(`/reviews/${reviewId}`, "GET");
  expect(response.status).toBe(200);
  expect(ReviewView.parse(await response.json())).toMatchObject({ id: reviewId, movedTo });
  expect(await f.db.read((q) => requireReview(f.ownerId, q, reviewId, undefined, false))).toMatchObject({
    movedToUrl: movedTo,
  });
  const revisionResponse = await f.request(`/reviews/${reviewId}/revisions/1`, "GET");
  expect(revisionResponse.status).toBe(200);
  const revision = RevisionView.parse(await revisionResponse.json());
  const file = revision.files.find((file) => file.path === "src/a.ts");
  if (!file) throw new Error("Missing diff");
  for (const [side, content] of [
    ["old", "const a = 1;\n"],
    ["new", "const a = 2;\n"],
  ]) {
    const response = await f.request(`/files/${file.id}/${side}`, "GET");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(content);
  }
  const image = await f.request(`/media/${hash}`, "GET");
  expect(image.status).toBe(200);
  expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
  for (const action of ["restore", "bin"]) await error(await post(reviewId, action), 409, "review_moved");
  expect(await inboxIds()).not.toContain(reviewId);
  const agent = AgentReviewList.parse(await (await f.request("/agent/reviews", "GET", undefined, "agent")).json());
  expect(agent.items.map((item) => item.id)).not.toContain(reviewId);
  expect(await bin()).toMatchObject({ items: [], total: 0, more: false });
  await error(await f.request(`/reviews/${reviewId}`, "GET", undefined, "foreign"), 404, "unknown_review");
  await error(await f.request(`/files/${file.id}/new`, "GET", undefined, "foreign"), 404, "not_found");
  await error(await f.request(`/media/${hash}`, "GET", undefined, "foreign"), 404, "not_found");
});

test("bin rows and version share one statement even when another connection swaps membership", async () => {
  const a = await publishReview(f, { key: "1" });
  const b = await publishReview(f, { key: "2" });
  expect((await post(a.reviewId, "bin")).status).toBe(204);
  const writer = new DatabaseSync(f.file);
  const swap = writer.prepare(
    "UPDATE reviews SET binned_at = CASE id WHEN ? THEN NULL ELSE ? END WHERE owner_id = ? AND id IN (?, ?)",
  );
  const prepare = DatabaseSync.prototype.prepare;
  const statements = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementationOnce(function (
    this: DatabaseSync,
    sql,
  ) {
    const statement = prepare.call(this, sql);
    const all = statement.all.bind(statement);
    vi.spyOn(statement, "all").mockImplementationOnce((...params) => {
      const rows = all(...params);
      // Commit after the page SELECT finishes, before listBin can issue another SELECT.
      swap.run(a.reviewId, f.deps.now(), f.ownerId, a.reviewId, b.reviewId);
      return rows;
    });
    return statement;
  });
  let shown: BinView;
  try {
    shown = await lifecycle.listBin(f.ownerId, f.db);
    expect(shown).toMatchObject({
      items: [{ id: a.reviewId }],
      total: 1,
      more: false,
      version: createHash("sha256").update(a.reviewId).digest("hex"),
    });
    expect(statements).toHaveBeenCalledTimes(1);
  } finally {
    statements.mockRestore();
    writer.close();
  }
  expect((await bin()).items.map((item) => item.id)).toEqual([b.reviewId]);
  await error(await f.request("/bin", "DELETE", { version: shown.version }), 409, "invalid_state");
  expect(await exists(a.reviewId)).toBe(true);
  expect(await exists(b.reviewId)).toBe(true);
});

test.each([false, true])("the bin pages timestamp ties even with its cursor deleted (%s)", async (deleteCursor) => {
  const stamp = 1_000_000;
  const items = Array.from({ length: LIMITS.binItems + 3 }, (_, i) => {
    const id = randomUUID();
    return {
      id,
      ownerId: f.ownerId,
      originInstanceId: f.instanceId,
      reviewKey: id.replaceAll("-", "").padEnd(64, "0"),
      title: `Review ${i}`,
      // Five share a time across the page boundary, followed by an older review.
      binnedAt: i < LIMITS.binItems - 3 ? stamp + 1000 + i : i === LIMITS.binItems + 2 ? stamp - 1 : stamp,
    };
  });
  await f.db.query((q) => q.insert(t.reviews).values(items));
  const expected = items.sort((a, b) => b.binnedAt - a.binnedAt || a.id.localeCompare(b.id));
  const view = await bin();
  expect(view.total).toBe(LIMITS.binItems + 3);
  expect(view.items).toHaveLength(LIMITS.binItems);
  expect(view.more).toBe(true);
  const ids = items.map((item) => item.id).sort();
  expect(view.version).toBe(createHash("sha256").update(ids.join("\n")).digest("hex"));
  const last = view.items.at(-1);
  if (!last) throw new Error("Missing cursor");
  const path = `/bin?${new URLSearchParams({ beforeAt: last.binnedAt, beforeId: last.id })}`;
  if (deleteCursor)
    await f.db.query((q) =>
      q.delete(t.reviews).where(and(eq(t.reviews.ownerId, f.ownerId), eq(t.reviews.id, last.id))),
    );
  const next = BinView.parse(await (await f.request(path, "GET")).json());
  expect(next).toMatchObject({ total: LIMITS.binItems + 3 - Number(deleteCursor), more: false });
  expect(next.items).toHaveLength(3);
  expect(next.items[0]?.binnedAt).toBe(last.binnedAt);
  expect([...view.items, ...next.items].map((item) => item.id)).toEqual(expected.map((item) => item.id));
  if (deleteCursor) expect(next.version).not.toBe(view.version);
  else {
    expect(next.version).toBe(view.version);
    await f.db.query((q) =>
      q.insert(t.revisions).values(
        ids.map((reviewId) => ({
          id: randomUUID(),
          ownerId: f.ownerId,
          reviewId,
          seq: 1,
          contentKey: randomUUID(),
        })),
      ),
    );
    const seen: ReviewEvent[] = [];
    f.deps.events?.subscribe(f.ownerId, null, (event) => seen.push(event));
    const cleanup = vi.spyOn(f.deps, "onBlobCleanup");
    const yieldToLoop = vi.spyOn(pacing, "yieldToLoop");
    expect((await f.request("/bin", "DELETE", { version: view.version })).status).toBe(204);
    await f.blobCleanup();
    expect((await bin()).total).toBe(0);
    expect(seen).toEqual(ids.map((reviewId) => ({ type: "delete", reviewId, revision: 1 })));
    const remaining = await f.db.read((q) => q.select().from(t.reviews).where(eq(t.reviews.ownerId, f.ownerId)));
    expect(remaining.map((item) => item.id)).toEqual([f.reviewId]);
    const tombstones = await f.db.read((q) =>
      q.select().from(t.reviewTombstones).where(eq(t.reviewTombstones.ownerId, f.ownerId)),
    );
    expect(tombstones.map((item) => item.reviewId).sort()).toEqual(ids);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(yieldToLoop.mock.calls.filter(([phase]) => phase === "lifecycle-bin-empty")).toHaveLength(ids.length);
  }
  expect(BinView.parse(await (await f.request(path, "GET", undefined, "foreign")).json())).toEqual({
    items: [],
    total: 0,
    more: false,
    version: createHash("sha256").update("").digest("hex"),
  });
});

test.each([
  "beforeAt=2026-11-04T10:00:00.000Z",
  "beforeId=11111111-1111-4111-8111-111111111111",
  "beforeAt=yesterday&beforeId=11111111-1111-4111-8111-111111111111",
  "beforeAt=2026-11-04T10:00:00.000Z&beforeId=invalid",
  "beforeAt=&beforeId=",
])("invalid bin cursor %s is refused", async (query) => {
  await error(await f.request(`/bin?${query}`, "GET"), 400, "invalid_request");
});

test("empty bin limits its JSON body before parsing", async () => {
  await error(await f.request("/bin", "DELETE", { version: "x".repeat(LIMITS.requestJsonBytes) }), 413, "too_large");
});

test("delete for good refuses a restored, missing, foreign or moved review", async () => {
  const { reviewId } = await publishReview(f);
  expect((await post(reviewId, "bin")).status).toBe(204);
  await error(await f.request(`/bin/${reviewId}`, "DELETE", undefined, "foreign"), 404, "unknown_review");
  await error(await f.request(`/bin/${randomUUID()}`, "DELETE"), 404, "unknown_review");
  expect((await post(reviewId, "restore")).status).toBe(204);
  const before = await row(reviewId);
  const seen: ReviewEvent[] = [];
  f.deps.events?.subscribe(f.ownerId, null, (event) => seen.push(event));
  await error(await f.request(`/bin/${reviewId}`, "DELETE"), 409, "invalid_state");
  expect(await row(reviewId)).toEqual(before);
  expect(seen).toEqual([]);
  expect(await f.db.read((q) => q.select().from(t.reviewTombstones))).toEqual([]);
  expect((await post(reviewId, "bin")).status).toBe(204);
  await f.db.query((q) =>
    q.update(t.reviews).set({ movedToUrl: "https://hub.example/r/x" }).where(eq(t.reviews.id, reviewId)),
  );
  await error(await f.request(`/bin/${reviewId}`, "DELETE"), 409, "review_moved");
  const moved = await row(reviewId);
  expect(await bin()).toEqual({
    items: [],
    total: 0,
    more: false,
    version: createHash("sha256").update("").digest("hex"),
  });
  expect((await f.request("/bin", "DELETE", await confirmation())).status).toBe(204);
  expect(await row(reviewId)).toEqual(moved);
});

test.each([
  undefined,
  null,
  {},
  { version: null },
  { version: 1 },
  { version: "" },
  { version: "a".repeat(63) },
  { version: "a".repeat(65) },
  { version: "A".repeat(64) },
  { version: "g".repeat(64) },
  { version: "a".repeat(64), extra: true },
  { version: "a".repeat(64), total: 1 },
  { upTo: "2026-11-04T10:00:00.000Z", total: 1 },
])("empty bin refuses an invalid body %j without deleting anything", async (body) => {
  const { reviewId } = await publishReview(f);
  expect((await post(reviewId, "bin")).status).toBe(204);
  await error(await f.request("/bin", "DELETE", body), 400, "invalid_request");
  expect(await exists(reviewId)).toBe(true);
});

test.each([false, true])("empty bin refuses a membership swap (clock stepped back: %s)", async (stepBack) => {
  const a = await publishReview(f, { key: "1" });
  const b = await publishReview(f, { key: "2" });
  expect((await post(a.reviewId, "bin")).status).toBe(204);
  f.advance(100);
  const shown = await bin();
  expect((await post(a.reviewId, "restore")).status).toBe(204);
  if (stepBack) f.advance(-50);
  expect((await post(b.reviewId, "bin")).status).toBe(204);
  const current = await bin();
  expect(current.total).toBe(shown.total);
  expect(current.version).not.toBe(shown.version);
  await error(await f.request("/bin", "DELETE", { version: shown.version }), 409, "invalid_state");
  expect(await exists(a.reviewId)).toBe(true);
  expect((await bin()).items.map((item) => item.id)).toEqual([b.reviewId]);
  expect(
    await f.db.read((q) => q.select().from(t.reviewTombstones).where(eq(t.reviewTombstones.ownerId, f.ownerId))),
  ).toEqual([]);
});

test.each(["bin", "restore", "move", "delete"])(
  "empty bin refuses a membership change after %s and deletes nothing",
  async (action) => {
    const first = await publishReview(f, { key: "1" });
    const changed = await publishReview(f, { key: "2" });
    expect((await post(first.reviewId, "bin")).status).toBe(204);
    if (action !== "bin") expect((await post(changed.reviewId, "bin")).status).toBe(204);
    const confirmed = await confirmation();
    if (action === "move") {
      await f.db.query((q) =>
        q
          .update(t.reviews)
          .set({ movedToUrl: "https://hub.example/r/x" })
          .where(and(eq(t.reviews.ownerId, f.ownerId), eq(t.reviews.id, changed.reviewId))),
      );
    } else if (action === "delete") {
      expect((await f.request(`/bin/${changed.reviewId}`, "DELETE")).status).toBe(204);
      await f.blobCleanup();
    } else expect((await post(changed.reviewId, action)).status).toBe(204);
    const before = await row(changed.reviewId);
    const tombstones = () =>
      f.db.read((q) => q.select().from(t.reviewTombstones).where(eq(t.reviewTombstones.ownerId, f.ownerId)));
    const beforeTombstones = await tombstones();
    const seen: ReviewEvent[] = [];
    f.deps.events?.subscribe(f.ownerId, null, (event) => seen.push(event));
    const response = await f.request("/bin", "DELETE", confirmed);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "invalid_state", message: "The bin changed. Check it and try again." },
    });
    expect(await exists(first.reviewId)).toBe(true);
    expect(await row(changed.reviewId)).toEqual(before);
    expect(seen).toEqual([]);
    expect(await tombstones()).toEqual(beforeTombstones);
  },
);

test.each([0, -1000])("an unchanged bin can be emptied with the clock offset by %i ms", async (offset) => {
  const first = await publishReview(f, { key: "1" });
  const second = await publishReview(f, { key: "2" });
  for (const id of [first.reviewId, second.reviewId]) expect((await post(id, "bin")).status).toBe(204);
  const before = await bin();
  f.advance(offset);
  const shown = await bin();
  expect(shown.version).toBe(before.version);
  expect(shown.total).toBe(2);
  for (const item of shown.items) expect(Date.parse(item.binnedAt)).toBeGreaterThanOrEqual(f.deps.now());
  expect((await f.request("/bin", "DELETE", { version: shown.version })).status).toBe(204);
  expect(await exists(first.reviewId)).toBe(false);
  expect(await exists(second.reviewId)).toBe(false);
});

test("empty bin leaves a review binned after the version check", async () => {
  const first = await publishReview(f, { key: "1" });
  const later = await publishReview(f, { key: "2" });
  expect((await post(first.reviewId, "bin")).status).toBe(204);
  const confirmed = await confirmation();
  const deleteReview = lifecycle.deleteReview;
  vi.spyOn(lifecycle, "deleteReview").mockImplementationOnce(async (...args) => {
    f.advance(-1000);
    expect((await post(later.reviewId, "bin")).status).toBe(204);
    return deleteReview(...args);
  });
  expect((await f.request("/bin", "DELETE", confirmed)).status).toBe(204);
  expect(await exists(first.reviewId)).toBe(false);
  expect((await bin()).items.map((item) => item.id)).toEqual([later.reviewId]);
});

test("empty bin leaves a review restored after the version check before its own delete", async () => {
  const a = await publishReview(f, { key: "1" });
  const b = await publishReview(f, { key: "2" });
  for (const id of [a.reviewId, b.reviewId]) expect((await post(id, "bin")).status).toBe(204);
  const [first, second] = [a.reviewId, b.reviewId].sort();
  if (!first || !second) throw new Error("Missing reviews");
  const confirmed = await confirmation();
  const yieldToLoop = pacing.yieldToLoop;
  let restored = false;
  vi.spyOn(pacing, "yieldToLoop").mockImplementation(async (phase) => {
    if (phase === "lifecycle-bin-empty" && !restored) {
      restored = true;
      expect((await post(second, "restore")).status).toBe(204);
    }
    await yieldToLoop(phase);
  });
  expect((await f.request("/bin", "DELETE", confirmed)).status).toBe(204);
  expect(restored).toBe(true);
  expect(await exists(first)).toBe(false);
  expect((await row(second))?.binnedAt).toBeNull();
});

test("a binned review acts as deleted for agents and reviewers", async () => {
  const { reviewId } = await publishReview(f, { diff: true });
  const created = (await (
    await f.request(`/reviews/${reviewId}/threads`, "POST", { revision: 1, target: { kind: "review" }, body: "Note" })
  ).json()) as { threadId: string; commentId: string };
  const fileId = (
    await f.db.read((q) => q.select({ id: t.files.id }).from(t.files).where(eq(t.files.path, "src/a.ts")).get())
  )?.id;
  expect((await post(reviewId, "bin")).status).toBe(204);
  const refused = async (response: Response) => error(response, 409, "review_in_bin");
  await refused(await post(reviewId, "take", "agent"));
  await refused(await f.request(`/reviews/${reviewId}/take`, "POST", { waitSeconds: 0, accepts: ["closed"] }, "agent"));
  await refused(await f.request(`/reviews/${reviewId}`, "GET"));
  await refused(await f.request(`/reviews/${reviewId}/revisions/1`, "GET"));
  await refused(await f.request(`/reviews/${reviewId}/events`, "GET"));
  await refused(await f.request(`/files/${fileId}/new`, "GET"));
  await refused(
    await f.request(`/reviews/${reviewId}/threads`, "POST", { revision: 1, target: { kind: "review" }, body: "x" }),
  );
  await refused(await f.request(`/threads/${created.threadId}/comments`, "POST", { body: "x" }));
  await refused(await f.request(`/comments/${created.commentId}`, "PATCH", { body: "x" }));
  await refused(await f.request(`/threads/${created.threadId}/resolve`, "POST"));
  await refused(await f.request(`/reviews/${reviewId}/sends`, "POST", { kind: "go", revision: 1 }));
  await refused(
    await f.request(`/reviews/${reviewId}/viewed`, "PUT", { revision: 1, paths: ["src/a.ts"], viewed: true }),
  );
  await refused(
    await f.request(`/comments/${created.commentId}/reply`, "POST", { outcome: "fixed", body: "x" }, "agent"),
  );
  for (const action of ["snooze", "unsnooze", "retire", "reopen", "bin"])
    await refused(
      await f.request(`/reviews/${reviewId}/${action}`, "POST", action === "snooze" ? { untilRevision: true } : {}),
    );
  // The agent list leaves it out too.
  const list = (await (await f.request("/agent/reviews", "GET", undefined, "agent")).json()) as { items: unknown[] };
  expect(list.items.map((item) => (item as { id: string }).id)).not.toContain(reviewId);
});

test("writeup media is hidden only while every review using it is binned", async () => {
  const hash = await seedWriteupImage(f.reviewId);
  const served = async () => {
    const response = await f.request(`/media/${hash}`, "GET");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  };
  await served();
  expect((await post(f.reviewId, "bin")).status).toBe(204);
  await error(await f.request(`/media/${hash}`, "GET"), 404, "not_found");
  const shared = await publishReview(f);
  expect(await seedWriteupImage(shared.reviewId)).toBe(hash);
  await served();
  expect((await post(shared.reviewId, "bin")).status).toBe(204);
  await error(await f.request(`/media/${hash}`, "GET"), 404, "not_found");
  expect((await post(f.reviewId, "restore")).status).toBe(204);
  await served();
});

test("a waiting take ends at once when the review is binned", async () => {
  const { reviewId } = await publishReview(f);
  const controller = new AbortController();
  const waiting = f.request(`/reviews/${reviewId}/take`, "POST", { waitSeconds: 25 }, "agent", controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect((await post(reviewId, "bin")).status).toBe(204);
  const response = await Promise.race([
    waiting,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("take still waiting")), 3000)),
  ]);
  await error(response, 409, "review_in_bin");
  controller.abort();
});

test("a delivery claimed before the bin can still be confirmed", async () => {
  const { reviewId } = await publishReview(f);
  expect(
    (await f.request(`/reviews/${reviewId}/sends`, "POST", { kind: "go", revision: 1, instruction: "Go" })).status,
  ).toBe(201);
  const taken = (await (await f.request(`/reviews/${reviewId}/take`, "POST", { waitSeconds: 0 }, "agent")).json()) as {
    deliveryId: string;
  };
  expect((await post(reviewId, "bin")).status).toBe(204);
  expect((await f.request(`/deliveries/${taken.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
});

test("a publish to a binned review by id or by key is refused and writes nothing", async () => {
  const first = await publishReview(f, { key: "5" });
  expect((await post(first.reviewId, "bin")).status).toBe(204);
  const counts = () =>
    f.db.read((q) =>
      q.values(
        sql`select (select count(*) from reviews), (select count(*) from revisions), (select count(*) from files), (select count(*) from blobs)`,
      ),
    );
  const before = await counts();
  const body = (extra: object) => ({
    reviewKey: "5".repeat(64),
    repo: null,
    branch: null,
    title: "Again",
    base: null,
    head: null,
    topics: [],
    writeup: { overview: "Again", tldr: "", decisions: null, topics: {} },
    files: [],
    ...extra,
  });
  await error(await f.request("/publish", "POST", body({}), "agent"), 409, "review_in_bin");
  await error(await f.request("/publish", "POST", body({ reviewId: first.reviewId }), "agent"), 409, "review_in_bin");
  expect(await counts()).toEqual(before);
  expect((await post(first.reviewId, "restore")).status).toBe(204);
  expect((await f.request("/publish", "POST", body({}), "agent")).status).toBe(200);
});

test.each(["reviews", "bin"])("deleting a binned review through /%s writes the tombstone", async (route) => {
  const { reviewId } = await publishReview(f);
  expect((await post(reviewId, "bin")).status).toBe(204);
  const seen: ReviewEvent[] = [];
  f.deps.events?.subscribe(f.ownerId, null, (event) => seen.push(event));
  expect((await f.request(`/${route}/${reviewId}`, "DELETE")).status).toBe(204);
  expect(seen).toEqual([{ type: "delete", reviewId, revision: 1 }]);
  await f.blobCleanup();
  expect(await exists(reviewId)).toBe(false);
  expect(
    await f.db.read((q) => q.values(sql`select review_id from review_tombstones where review_id = ${reviewId}`)),
  ).toEqual([[reviewId]]);
  expect((await bin()).total).toBe(0);
});

test("empty bin deletes only binned reviews and leaves a restored one", async () => {
  const kept = await publishReview(f, { key: "1" });
  const restored = await publishReview(f, { key: "2" });
  const one = await publishReview(f, { key: "3", docs: { "a.md": "# Only here" } });
  const two = await publishReview(f, { key: "4" });
  for (const id of [restored.reviewId, one.reviewId, two.reviewId]) expect((await post(id, "bin")).status).toBe(204);
  expect((await post(restored.reviewId, "restore")).status).toBe(204);
  const seen: ReviewEvent[] = [];
  f.deps.events?.subscribe(f.ownerId, null, (event) => seen.push(event));
  expect((await f.request("/bin", "DELETE", await confirmation())).status).toBe(204);
  await f.blobCleanup();
  expect(await exists(kept.reviewId)).toBe(true);
  expect(await exists(restored.reviewId)).toBe(true);
  expect(await exists(one.reviewId)).toBe(false);
  expect(await exists(two.reviewId)).toBe(false);
  expect(seen.map((event) => event.type)).toEqual(["delete", "delete"]);
  const tombstones = await f.db.read((q) => q.values(sql`select review_id from review_tombstones`));
  expect(tombstones.map(([id]) => id).sort()).toEqual([one.reviewId, two.reviewId].sort());
  expect((await bin()).total).toBe(0);
  // An empty bin is fine.
  expect((await f.request("/bin", "DELETE", await confirmation())).status).toBe(204);
});

test("empty bin cleans committed deletes when a later delete throws a non-ApiError", async () => {
  const contents = ["# First unique document", "# Second unique document"];
  const published = [];
  for (const [index, content] of contents.entries()) {
    const { reviewId } = await publishReview(f, { key: String(index + 1), docs: { "unique.md": content } });
    expect((await post(reviewId, "bin")).status).toBe(204);
    published.push({ reviewId, hash: createHash("sha256").update(content).digest("hex"), content });
  }
  published.sort((a, b) => a.reviewId.localeCompare(b.reviewId));
  const [deleted, kept] = published;
  if (!deleted || !kept) throw new Error("Missing reviews");
  const path = (hash: string) => join(f.dir, "state", "blobs", hash.slice(0, 2), hash);
  expect(await readFile(path(deleted.hash), "utf8")).toBe(deleted.content);
  const cleanup = vi.spyOn(f.deps, "onBlobCleanup");
  const deleteReview = lifecycle.deleteReview;
  vi.spyOn(lifecycle, "deleteReview")
    .mockImplementationOnce(deleteReview)
    .mockRejectedValueOnce(Object.assign(new Error("Synthetic writer contention"), { code: "SQLITE_BUSY" }));
  await error(await f.request("/bin", "DELETE", await confirmation()), 500, "internal");
  await f.blobCleanup();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(await exists(deleted.reviewId)).toBe(false);
  expect(await exists(kept.reviewId)).toBe(true);
  expect(await f.deps.blobs.has(f.ownerId, deleted.hash)).toBe(false);
  await expect(readFile(path(deleted.hash))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path(kept.hash), "utf8")).toBe(kept.content);
});

test("an import with binnedAt lands in the hub's bin and a repeated attach does not restore it", async () => {
  const g = await importFixture();
  try {
    const input = await bundle(g);
    const binnedAt = new Date(g.deps.now() - 500).toISOString();
    const response = await g.importRequest("/import", { ...input, review: { ...input.review, binnedAt } });
    expect(response.status).toBe(201);
    const list = BinView.parse(await (await g.request("/bin", "GET")).json());
    expect(list.items).toMatchObject([{ id: input.review.id, binnedAt, machine: "Synthetic laptop" }]);
    expect(InboxList.parse(await (await g.request("/reviews", "GET")).json()).items.map((i) => i.id)).not.toContain(
      input.review.id,
    );
    const again = await g.importRequest("/import", { ...input, review: { ...input.review, binnedAt: null } });
    expect(again.status).toBe(200);
    expect((await again.json()) as unknown).toMatchObject({ skipped: true });
    expect((await g.request("/bin", "GET")).status).toBe(200);
    expect(BinView.parse(await (await g.request("/bin", "GET")).json()).total).toBe(1);
  } finally {
    await g.cleanup();
  }
});

test.each([-1, 0, 1])("empty bin refuses an older binned review imported %i ms after the listing", async (delay) => {
  const g = await importFixture();
  try {
    const local = await publishReview(g, { key: "1" });
    expect((await g.request(`/reviews/${local.reviewId}/bin`, "POST")).status).toBe(204);
    const shown = BinView.parse(await (await g.request("/bin", "GET")).json());
    const input = await bundle(g);
    const binnedAt = new Date(g.deps.now() - 1000).toISOString();
    g.advance(delay);
    expect((await g.importRequest("/import", { ...input, review: { ...input.review, binnedAt } })).status).toBe(201);
    await error(await g.request("/bin", "DELETE", { version: shown.version }), 409, "invalid_state");
    const remaining = BinView.parse(await (await g.request("/bin", "GET")).json());
    expect(remaining.items.map((item) => item.id).sort()).toEqual([local.reviewId, input.review.id].sort());
    expect(remaining.version).not.toBe(shown.version);
    expect(
      await g.db.read((q) => q.select().from(t.reviewTombstones).where(eq(t.reviewTombstones.ownerId, g.ownerId))),
    ).toEqual([]);
    // A new confirmation includes the imported review too.
    expect((await g.request("/bin", "DELETE", { version: remaining.version })).status).toBe(204);
    expect(BinView.parse(await (await g.request("/bin", "GET")).json()).total).toBe(0);
    await g.blobCleanup();
  } finally {
    await g.cleanup();
  }
});

test("empty bin refuses an import stamped before the listing but committed after it", async () => {
  const g = await importFixture();
  const inserted = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  let importing: Promise<Response> | undefined;
  try {
    const local = await publishReview(g, { key: "1" });
    expect((await g.request(`/reviews/${local.reviewId}/bin`, "POST")).status).toBe(204);
    const input = await bundle(g);
    const binnedAt = new Date(g.deps.now() - 1000).toISOString();
    const transaction = g.db.transaction.bind(g.db);
    vi.spyOn(g.db, "transaction").mockImplementationOnce((fn, options) =>
      transaction(async (q) => {
        const result = await fn(q);
        inserted.resolve();
        await commit.promise;
        return result;
      }, options),
    );
    importing = Promise.resolve(g.importRequest("/import", { ...input, review: { ...input.review, binnedAt } }));
    await Promise.race([
      inserted.promise,
      importing.then(() => {
        throw new Error("Import did not pause");
      }),
    ]);
    g.advance(1000);
    // Read through the listing repo: HTTP session bookkeeping would wait on the paused writer.
    const shown = await lifecycle.listBin(g.ownerId, g.db);
    expect(shown.items.map((item) => item.id)).toEqual([local.reviewId]);
    commit.resolve();
    expect((await importing).status).toBe(201);
    await error(await g.request("/bin", "DELETE", { version: shown.version }), 409, "invalid_state");
    const remaining = BinView.parse(await (await g.request("/bin", "GET")).json());
    expect(remaining.items.map((item) => item.id).sort()).toEqual([local.reviewId, input.review.id].sort());
    expect(
      await g.db.read((q) => q.select().from(t.reviewTombstones).where(eq(t.reviewTombstones.ownerId, g.ownerId))),
    ).toEqual([]);
  } finally {
    commit.resolve();
    await importing;
    await g.cleanup();
  }
});

test("an imported binnedAt is clamped to the hub clock", async () => {
  const g = await importFixture();
  try {
    const input = await bundle(g);
    const future = new Date(g.deps.now() + 5 * day).toISOString();
    const response = await g.importRequest("/import", { ...input, review: { ...input.review, binnedAt: future } });
    expect(response.status).toBe(201);
    const list = BinView.parse(await (await g.request("/bin", "GET")).json());
    expect(Date.parse(list.items[0]?.binnedAt ?? "")).toBeLessThanOrEqual(g.deps.now());
  } finally {
    await g.cleanup();
  }
});
