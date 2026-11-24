import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { repos } from "../schema.ts";
import { testDb } from "../test-support.ts";
import {
  addRevision,
  createReview,
  DuplicateReviewKeyError,
  findReviewByKey,
  getReview,
  getRevision,
  listReviews,
} from "./reviews.ts";

test("review lookups and revision writes are scoped to the owner", async () => {
  const ctx = await testDb();
  try {
    const input = { originInstanceId: ctx.instanceId, reviewKey: "synthetic", title: "Synthetic review" };
    const review = await createReview(ctx.ownerId, ctx.db, input);
    if (!review) throw new Error("missing review");
    expect(await findReviewByKey(ctx.ownerId, ctx.db, ctx.instanceId, input.reviewKey)).toEqual(review);
    expect(await getReview(ctx.ownerId, ctx.db, review.id)).toEqual(review);
    expect(await listReviews(ctx.ownerId, ctx.db)).toEqual([review]);
    const revision = await addRevision(ctx.ownerId, ctx.db, review.id, { contentKey: randomUUID() });
    if (!revision) throw new Error("missing revision");
    expect(await getRevision(ctx.ownerId, ctx.db, review.id, revision.seq)).toEqual(revision);
    for (const id of [review.id, randomUUID()]) {
      expect(await getReview(ctx.otherOwnerId, ctx.db, id)).toBeNull();
      expect(await addRevision(ctx.otherOwnerId, ctx.db, id, { contentKey: randomUUID() })).toBeNull();
    }
    expect(await getRevision(ctx.otherOwnerId, ctx.db, review.id, revision.seq)).toBeNull();
    expect(await getRevision(ctx.ownerId, ctx.db, randomUUID(), revision.seq)).toBeNull();
    expect(await getRevision(ctx.ownerId, ctx.db, review.id, revision.seq + 1)).toBeNull();
    expect(await findReviewByKey(ctx.otherOwnerId, ctx.db, ctx.instanceId, input.reviewKey)).toBeNull();
    expect(await listReviews(ctx.otherOwnerId, ctx.db)).toEqual([]);
    expect(await createReview(ctx.otherOwnerId, ctx.db, input)).toMatchObject({ ownerId: ctx.otherOwnerId });
  } finally {
    await ctx.cleanup();
  }
});

test("three revisions retain their data and receive consecutive sequences", async () => {
  const ctx = await testDb();
  try {
    const review = await createReview(ctx.ownerId, ctx.db, {
      originInstanceId: ctx.instanceId,
      reviewKey: "sequential",
      title: "Synthetic",
    });
    if (!review) throw new Error("missing review");
    const revisions = [];
    for (let i = 1; i <= 3; i++)
      revisions.push(
        await addRevision(ctx.ownerId, ctx.db, review.id, { contentKey: randomUUID(), head: `synthetic-${i}` }),
      );
    expect(revisions.map((revision) => revision?.seq)).toEqual([1, 2, 3]);
    for (const revision of revisions) {
      if (!revision) throw new Error("missing revision");
      expect(await getRevision(ctx.ownerId, ctx.db, review.id, revision.seq)).toEqual(revision);
    }
  } finally {
    await ctx.cleanup();
  }
});

test("two simultaneous addRevision calls on one handle get sequences 1 and 2", async () => {
  const ctx = await testDb();
  try {
    const review = await createReview(ctx.ownerId, ctx.db, {
      originInstanceId: ctx.instanceId,
      reviewKey: "concurrent",
      title: "Synthetic",
    });
    if (!review) throw new Error("missing review");
    const revisions = await Promise.all(
      [1, 2].map(() => addRevision(ctx.ownerId, ctx.db, review.id, { contentKey: randomUUID() })),
    );
    expect(revisions.map((revision) => revision?.seq)).toEqual([1, 2]);
  } finally {
    await ctx.cleanup();
  }
});

test("createReview treats a foreign or missing repository as missing", async () => {
  const ctx = await testDb();
  const repoId = randomUUID();
  try {
    await ctx.db.query(async (q) => {
      await q.insert(repos).values({ id: repoId, ownerId: ctx.ownerId, key: "synthetic", name: "Synthetic" });
    });
    for (const id of [repoId, randomUUID()]) {
      expect(
        await createReview(ctx.otherOwnerId, ctx.db, {
          originInstanceId: ctx.instanceId,
          reviewKey: "foreign-repo",
          title: "Synthetic",
          repoId: id,
        }),
      ).toBeNull();
    }
    expect(await listReviews(ctx.otherOwnerId, ctx.db)).toEqual([]);
  } finally {
    await ctx.cleanup();
  }
});

test("a duplicate review key raises a typed error and leaves the winner intact", async () => {
  const ctx = await testDb();
  try {
    const input = { originInstanceId: ctx.instanceId, reviewKey: "synthetic-duplicate", title: "Synthetic" };
    const winner = await createReview(ctx.ownerId, ctx.db, input);
    await expect(createReview(ctx.ownerId, ctx.db, input)).rejects.toBeInstanceOf(DuplicateReviewKeyError);
    expect(await findReviewByKey(ctx.ownerId, ctx.db, ctx.instanceId, input.reviewKey)).toEqual(winner);
  } finally {
    await ctx.cleanup();
  }
});
