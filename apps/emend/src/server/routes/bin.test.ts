import { randomUUID } from "node:crypto";
import { BinView, InboxList, LIMITS, type ReviewEvent } from "@emend/contract";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
const cutoff = () => ({ upTo: new Date(f.deps.now()).toISOString() });
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
  expect(foreign).toEqual({ items: [], total: 0, more: false });
  expect((await f.request("/bin", "DELETE", cutoff(), "foreign")).status).toBe(204);
  expect(await exists(reviewId)).toBe(true);
});

test("a moved review cannot be binned", async () => {
  const { reviewId } = await publishReview(f);
  await f.db.query((q) =>
    q.update(t.reviews).set({ movedToUrl: "https://hub.example/r/x" }).where(eq(t.reviews.id, reviewId)),
  );
  await error(await post(reviewId, "bin"), 409, "review_moved");
});

test("the bin pages newest first, including timestamp ties across the page boundary", async () => {
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
  const last = view.items.at(-1);
  if (!last) throw new Error("Missing cursor");
  const path = `/bin?${new URLSearchParams({ beforeAt: last.binnedAt, beforeId: last.id })}`;
  const next = BinView.parse(await (await f.request(path, "GET")).json());
  expect(next).toMatchObject({ total: LIMITS.binItems + 3, more: false });
  expect(next.items).toHaveLength(3);
  expect(next.items[0]?.binnedAt).toBe(last.binnedAt);
  expect([...view.items, ...next.items].map((item) => item.id)).toEqual(expected.map((item) => item.id));
  expect(BinView.parse(await (await f.request(path, "GET", undefined, "foreign")).json())).toEqual({
    items: [],
    total: 0,
    more: false,
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
  await error(await f.request("/bin", "DELETE", { upTo: "x".repeat(LIMITS.requestJsonBytes) }), 413, "too_large");
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
  expect(await bin()).toEqual({ items: [], total: 0, more: false });
  expect((await f.request("/bin", "DELETE", cutoff())).status).toBe(204);
  expect(await row(reviewId)).toEqual(moved);
});

test.each([undefined, null, {}, { upTo: "yesterday" }, { upTo: "2026-11-04T10:00:00.000Z", extra: true }])(
  "empty bin refuses an invalid body %j without deleting anything",
  async (body) => {
    const { reviewId } = await publishReview(f);
    expect((await post(reviewId, "bin")).status).toBe(204);
    await error(await f.request("/bin", "DELETE", body), 400, "invalid_request");
    expect(await exists(reviewId)).toBe(true);
  },
);

test("empty bin leaves reviews binned after the confirmed cutoff", async () => {
  const first = await publishReview(f, { key: "1" });
  const later = await publishReview(f, { key: "2" });
  expect((await post(first.reviewId, "bin")).status).toBe(204);
  const confirmed = cutoff();
  f.advance(1);
  expect((await post(later.reviewId, "bin")).status).toBe(204);
  expect((await f.request("/bin", "DELETE", confirmed)).status).toBe(204);
  expect(await exists(first.reviewId)).toBe(false);
  expect((await bin()).items.map((item) => item.id)).toEqual([later.reviewId]);
});

test.each(["restore", "rebin"])("empty bin rechecks a review changed by %s after selection", async (action) => {
  const a = await publishReview(f, { key: "1" });
  const b = await publishReview(f, { key: "2" });
  for (const id of [a.reviewId, b.reviewId]) expect((await post(id, "bin")).status).toBe(204);
  const [first, second] = [a.reviewId, b.reviewId].sort();
  if (!first || !second) throw new Error("Missing reviews");
  const confirmed = cutoff();
  const yieldToLoop = pacing.yieldToLoop;
  let changed = false;
  vi.spyOn(pacing, "yieldToLoop").mockImplementation(async (phase) => {
    if (phase === "lifecycle-bin-empty" && !changed) {
      changed = true;
      expect((await post(second, "restore")).status).toBe(204);
      if (action === "rebin") {
        f.advance(1);
        expect((await post(second, "bin")).status).toBe(204);
      }
    }
    await yieldToLoop(phase);
  });
  expect((await f.request("/bin", "DELETE", confirmed)).status).toBe(204);
  expect(changed).toBe(true);
  expect(await exists(first)).toBe(false);
  expect(await exists(second)).toBe(true);
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
  expect((await f.request("/bin", "DELETE", cutoff())).status).toBe(204);
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
  expect((await f.request("/bin", "DELETE", cutoff())).status).toBe(204);
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
