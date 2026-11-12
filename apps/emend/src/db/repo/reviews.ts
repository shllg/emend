import { and, desc, eq, isNull, max } from "drizzle-orm";
import type { Db } from "../client.ts";
import { repos, reviews, revisions } from "../schema.ts";

export type NewReview = Pick<
  typeof reviews.$inferInsert,
  "originInstanceId" | "reviewKey" | "repoId" | "branch" | "title"
>;
export type NewRevision = Pick<typeof revisions.$inferInsert, "base" | "head" | "contentKey">;
export class DuplicateReviewKeyError extends Error {}

export function findReviewByKey(ownerId: string, db: Db, originInstanceId: string, reviewKey: string) {
  return db.query(
    async (q) =>
      (await q
        .select()
        .from(reviews)
        .where(
          and(
            eq(reviews.ownerId, ownerId),
            eq(reviews.originInstanceId, originInstanceId),
            eq(reviews.reviewKey, reviewKey),
          ),
        )
        .get()) ?? null,
  );
}

export function createReview(ownerId: string, db: Db, input: NewReview) {
  return db.transaction(async (q) => {
    if (
      input.repoId &&
      !(await q
        .select({ id: repos.id })
        .from(repos)
        .where(and(eq(repos.ownerId, ownerId), eq(repos.id, input.repoId)))
        .get())
    )
      return null;
    const [review] = await q
      .insert(reviews)
      .values({
        ownerId,
        originInstanceId: input.originInstanceId,
        reviewKey: input.reviewKey,
        repoId: input.repoId,
        branch: input.branch,
        title: input.title,
      })
      .onConflictDoNothing({ target: [reviews.ownerId, reviews.originInstanceId, reviews.reviewKey] })
      .returning();
    if (!review) throw new DuplicateReviewKeyError();
    return review;
  });
}

export function addRevision(ownerId: string, db: Db, reviewId: string, input: NewRevision) {
  return db.transaction(async (q) => {
    const ownedReview = and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewId));
    if (!(await q.select({ id: reviews.id }).from(reviews).where(ownedReview).get())) return null;
    const latest = await q
      .select({ seq: max(revisions.seq) })
      .from(revisions)
      .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId)))
      .get();
    const now = Date.now();
    const [revision] = await q
      .insert(revisions)
      .values({
        ownerId,
        reviewId,
        seq: (latest?.seq ?? 0) + 1,
        base: input.base,
        head: input.head,
        contentKey: input.contentKey,
        createdAt: now,
      })
      .returning();
    await q.update(reviews).set({ updatedAt: now }).where(ownedReview);
    return revision ?? null;
  });
}

export function getReview(ownerId: string, db: Db, reviewId: string) {
  return db.query(
    async (q) =>
      (await q
        .select()
        .from(reviews)
        .where(and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewId)))
        .get()) ?? null,
  );
}

export function listReviews(ownerId: string, db: Db) {
  return db.query((q) =>
    q
      .select()
      .from(reviews)
      .where(and(eq(reviews.ownerId, ownerId), isNull(reviews.binnedAt)))
      .orderBy(desc(reviews.updatedAt), reviews.id)
      .all(),
  );
}

export function getRevision(ownerId: string, db: Db, reviewId: string, seq: number) {
  return db.query(
    async (q) =>
      (await q
        .select()
        .from(revisions)
        .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), eq(revisions.seq, seq)))
        .get()) ?? null,
  );
}
