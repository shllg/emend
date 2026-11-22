import { randomUUID } from "node:crypto";
import { ErrorBody, LIMITS, type PublishRequest, PublishResponse, ReviewView, RevisionView } from "@emend/contract";
import { and, count, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { reviews, revisions } from "../../db/schema.ts";
import { publishReview } from "../mailbox/lifecycle-support.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => f.cleanup());

const writeup = { overview: "Synthetic code change.", tldr: "Fewer retries.", decisions: null, topics: {} };
const input = (patch: Partial<PublishRequest> = {}): PublishRequest => ({
  reviewKey: "d".repeat(64),
  repo: null,
  branch: null,
  title: "Synthetic code review",
  base: null,
  head: null,
  topics: [],
  files: [],
  writeup,
  ...patch,
});
async function publish(patch: Partial<PublishRequest> = {}) {
  const response = await f.request("/publish", "POST", input(patch), "agent");
  expect(response.status).toBe(200);
  return PublishResponse.parse(await response.json());
}
async function view(id: string) {
  const response = await f.request(`/reviews/${id}`, "GET");
  expect(response.status).toBe(200);
  return ReviewView.parse(await response.json());
}
async function pair() {
  const intent = await publishReview(f, {
    title: "Synthetic intent",
    docs: { "intent.md": "# Limit retries\n\nStop after three attempts." },
  });
  const oldBlob = await f.deps.blobs.put(f.ownerId, Buffer.from("const attempts = 5;\n"), "text/plain");
  const newBlob = await f.deps.blobs.put(f.ownerId, Buffer.from("const attempts = 3;\n"), "text/plain");
  const code = await publish({
    intentReview: intent.reviewId,
    writeup: { ...writeup, deviations: "None." },
    base: "a".repeat(40),
    head: "b".repeat(40),
    files: [{ path: "retry.ts", role: "diff", status: "modified", oldPath: null, oldBlob, newBlob, flag: null }],
  });
  return { intent, code };
}
async function rowCounts() {
  return f.db.read(async (q) => ({
    reviews: await q.select({ n: count() }).from(reviews).where(eq(reviews.ownerId, f.ownerId)).get(),
    revisions: await q.select({ n: count() }).from(revisions).where(eq(revisions.ownerId, f.ownerId)).get(),
  }));
}

test("intent and code reviews link both ways, render deviations and show the current approval", async () => {
  const { intent, code } = await pair();
  const intentEntry = { id: intent.reviewId, role: "intent", title: "Synthetic intent", state: "open" };
  expect((await view(code.reviewId)).related).toEqual([intentEntry]);
  expect((await view(intent.reviewId)).related).toEqual([
    { id: code.reviewId, role: "code", title: "Synthetic code review", state: "open" },
  ]);
  const revision = RevisionView.parse(await (await f.request(`/reviews/${code.reviewId}/revisions/1`, "GET")).json());
  expect(revision.writeup.sections.find(({ key }) => key === "deviations")).toMatchObject({
    label: "Deviations from the approved intent",
    blocks: [{ text: "None." }],
  });
  expect((await f.request(`/reviews/${intent.reviewId}/sends`, "POST", { kind: "approve", revision: 1 })).status).toBe(
    201,
  );
  expect((await view(code.reviewId)).related).toEqual([{ ...intentEntry, state: "approved" }]);
  expect((await view(intent.reviewId)).revisions).toHaveLength(1);
});

test.each(["missing", "foreign", "other instance", "binned", "moved"])(
  "an unavailable intent (%s) refuses without creating a review or revision",
  async (kind) => {
    let intentReview: string = randomUUID();
    if (kind !== "missing") {
      const response = await f.request(
        "/publish",
        "POST",
        input({ reviewKey: "e".repeat(64) }),
        kind === "foreign" ? "stranger" : kind === "other instance" ? "otherAgent" : "agent",
      );
      expect(response.status).toBe(200);
      intentReview = PublishResponse.parse(await response.json()).reviewId;
      if (kind === "binned" || kind === "moved")
        await f.db.query((q) =>
          q
            .update(reviews)
            .set(
              kind === "binned" ? { binnedAt: f.deps.now() } : { movedToUrl: `https://hub.example/r/${intentReview}` },
            )
            .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, intentReview))),
        );
    }
    const before = await rowCounts();
    const response = await f.request(
      "/publish",
      "POST",
      input({ intentReview, writeup: { ...writeup, deviations: "None." } }),
      "agent",
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "unknown_intent_review", message: "The intent review was not found." },
    });
    expect(await rowCounts()).toEqual(before);
  },
);

test.each([false, true])("a review cannot name itself through its key or id (explicit id: %s)", async (explicit) => {
  const code = await publish();
  const before = await rowCounts();
  const response = await f.request(
    "/publish",
    "POST",
    input({
      ...(explicit ? { reviewId: code.reviewId } : {}),
      intentReview: code.reviewId,
      writeup: { ...writeup, deviations: "None." },
    }),
    "agent",
  );
  expect(response.status).toBe(400);
  const body = ErrorBody.parse(await response.json());
  expect(body.error.code).toBe("invalid_request");
  if (!explicit) expect(body.error.message).toBe("a review cannot be its own intent review");
  expect(await rowCounts()).toEqual(before);
});

test("a later publish without the pair clears both links without revising the intent", async () => {
  const { intent, code } = await pair();
  expect((await publish({ reviewId: code.reviewId })).revision).toBe(2);
  expect((await view(code.reviewId)).related).toEqual([]);
  expect((await view(intent.reviewId)).related).toEqual([]);
  expect((await view(intent.reviewId)).revisions).toHaveLength(1);
  const stored = await f.db.read((q) =>
    q
      .select({ id: reviews.intentReviewId })
      .from(reviews)
      .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, code.reviewId)))
      .get(),
  );
  expect(stored?.id).toBeNull();
});

test.each(["intent", "code"] as const)("a binned or moved %s review drops out of related reviews", async (role) => {
  const { intent, code } = await pair();
  const hidden = role === "intent" ? intent.reviewId : code.reviewId;
  const visible = role === "intent" ? code.reviewId : intent.reviewId;
  for (const patch of [
    { binnedAt: f.deps.now(), movedToUrl: null },
    { binnedAt: null, movedToUrl: `https://hub.example/r/${hidden}` },
  ]) {
    await f.db.query((q) =>
      q
        .update(reviews)
        .set(patch)
        .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, hidden))),
    );
    expect((await view(visible)).related).toEqual([]);
  }
});

test("related code reviews are capped, newest first with id ties, and owner scoped", async () => {
  const intent = await publishReview(f);
  const entries = Array.from({ length: LIMITS.relatedReviews + 2 }, (_, i) => ({
    id: randomUUID(),
    ownerId: f.ownerId,
    originInstanceId: f.instanceId,
    reviewKey: String(i).padStart(64, "0"),
    title: `Synthetic code ${i}`,
    intentReviewId: intent.reviewId,
    updatedAt: 100 + Math.floor(i / 2),
  }));
  await f.db.query(async (q) => {
    await q.insert(reviews).values(entries);
    await q.insert(reviews).values({
      ...entries[0],
      id: randomUUID(),
      ownerId: f.otherOwnerId,
      originInstanceId: f.instanceId,
      reviewKey: "f".repeat(64),
      title: "Foreign code",
      intentReviewId: intent.reviewId,
      updatedAt: 999,
    });
  });
  expect((await view(intent.reviewId)).related).toEqual(
    entries
      .toSorted((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, 8)
      .map(({ id, title }) => ({ id, role: "code", title, state: "open" })),
  );
});

test("an unresolved or foreign stored intent id is omitted", async () => {
  const code = await publish();
  const foreignId = randomUUID();
  await f.db.query((q) =>
    q.insert(reviews).values({
      id: foreignId,
      ownerId: f.otherOwnerId,
      originInstanceId: f.instanceId,
      reviewKey: "f".repeat(64),
      title: "Foreign intent",
    }),
  );
  for (const intentReviewId of [randomUUID(), foreignId]) {
    await f.db.query((q) =>
      q
        .update(reviews)
        .set({ intentReviewId })
        .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, code.reviewId))),
    );
    expect((await view(code.reviewId)).related).toEqual([]);
  }
});
