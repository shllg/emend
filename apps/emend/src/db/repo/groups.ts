import { LIMITS } from "@emend/contract";
import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import { ApiError } from "../../server/http/errors.ts";
import type { Db, Queries } from "../client.ts";
import { reviewGroupMembers, reviewGroups, reviews } from "../schema.ts";
import { requireReview } from "./thread-access.ts";

async function requireGroup(ownerId: string, q: Queries, groupId: string) {
  const group = await q
    .select({ id: reviewGroups.id, name: reviewGroups.name })
    .from(reviewGroups)
    .where(and(eq(reviewGroups.ownerId, ownerId), eq(reviewGroups.id, groupId)))
    .get();
  if (!group) throw new ApiError("not_found");
  return group;
}
async function availableName(ownerId: string, q: Queries, name: string, groupId?: string) {
  const existing = await q
    .select({ id: reviewGroups.id })
    .from(reviewGroups)
    .where(
      and(
        eq(reviewGroups.ownerId, ownerId),
        eq(reviewGroups.name, name),
        groupId === undefined ? undefined : ne(reviewGroups.id, groupId),
      ),
    )
    .get();
  if (existing) throw new ApiError("invalid_state", "group_exists");
}
function nameConflict(error: unknown): never {
  // Drizzle wraps the SQLite constraint error in its cause.
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause.message.includes("UNIQUE constraint failed: review_groups.owner_id, review_groups.name"))
      throw new ApiError("invalid_state", "group_exists");
  }
  throw error;
}
export function createGroup(ownerId: string, db: Db, name: string, now: number) {
  return db
    .transaction(async (q) => {
      const total = await q
        .select({ count: count() })
        .from(reviewGroups)
        .where(eq(reviewGroups.ownerId, ownerId))
        .get();
      if ((total?.count ?? 0) >= LIMITS.groups) throw new ApiError("invalid_state", "group_limit");
      await availableName(ownerId, q, name);
      const group = { id: crypto.randomUUID(), name };
      await q.insert(reviewGroups).values({ ...group, ownerId, createdAt: now, updatedAt: now });
      return group;
    })
    .catch(nameConflict);
}
export function renameGroup(ownerId: string, db: Db, groupId: string, name: string, now: number) {
  return db
    .transaction(async (q) => {
      await requireGroup(ownerId, q, groupId);
      await availableName(ownerId, q, name, groupId);
      await q
        .update(reviewGroups)
        .set({ name, updatedAt: now })
        .where(and(eq(reviewGroups.ownerId, ownerId), eq(reviewGroups.id, groupId)));
      return { id: groupId, name };
    })
    .catch(nameConflict);
}
export function deleteGroup(ownerId: string, db: Db, groupId: string) {
  return db.transaction(async (q) => {
    await requireGroup(ownerId, q, groupId);
    await q
      .delete(reviewGroupMembers)
      .where(and(eq(reviewGroupMembers.ownerId, ownerId), eq(reviewGroupMembers.groupId, groupId)));
    await q.delete(reviewGroups).where(and(eq(reviewGroups.ownerId, ownerId), eq(reviewGroups.id, groupId)));
  });
}
export function setReviewGroup(ownerId: string, db: Db, reviewId: string, groupId: string | null, now: number) {
  return db.transaction(async (q) => {
    await requireReview(ownerId, q, reviewId);
    if (groupId === null) {
      await q
        .delete(reviewGroupMembers)
        .where(and(eq(reviewGroupMembers.ownerId, ownerId), eq(reviewGroupMembers.reviewId, reviewId)));
    } else {
      await requireGroup(ownerId, q, groupId);
      await q
        .insert(reviewGroupMembers)
        .values({ ownerId, reviewId, groupId, createdAt: now })
        .onConflictDoUpdate({
          target: [reviewGroupMembers.ownerId, reviewGroupMembers.reviewId],
          set: { groupId, createdAt: now },
          setWhere: and(eq(reviewGroupMembers.ownerId, ownerId), eq(reviewGroupMembers.reviewId, reviewId)),
        });
    }
  });
}
export function listGroups(ownerId: string, q: Queries) {
  return q
    .select({ id: reviewGroups.id, name: reviewGroups.name, members: count(reviews.id) })
    .from(reviewGroups)
    .leftJoin(
      reviewGroupMembers,
      and(eq(reviewGroupMembers.ownerId, ownerId), eq(reviewGroupMembers.groupId, reviewGroups.id)),
    )
    .leftJoin(
      reviews,
      and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewGroupMembers.reviewId), isNull(reviews.binnedAt)),
    )
    .where(eq(reviewGroups.ownerId, ownerId))
    .groupBy(reviewGroups.id, reviewGroups.name)
    .orderBy(asc(reviewGroups.name), asc(reviewGroups.id))
    .all();
}
