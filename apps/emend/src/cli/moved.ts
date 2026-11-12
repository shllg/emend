import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { openDb } from "../db/client.ts";
import { comments, owners, reviews } from "../db/schema.ts";
import { escapeReference } from "./escape.ts";
import { CliApiError, CliError } from "./http.ts";
import { readRegular } from "./publish/read.ts";

/** Enrich only a local review_moved refusal; the API does not disclose its destination. */
export async function movedError(
  stateDir: string,
  error: unknown,
  reference: { reviewId?: string; commentId?: string; keyFor?: (instanceId: string) => string },
  publish = false,
): Promise<never> {
  if (!(error instanceof CliApiError) || error.code !== "review_moved") throw error;
  const db = openDb(join(stateDir, "emend.db"));
  let destination: string | null | undefined;
  try {
    destination = await db.read(async (q) => {
      // Local bootstrap has exactly one owner; never use an id from command input as an owner.
      const owner = await q.select({ id: owners.id }).from(owners).get();
      if (!owner) return;
      let reviewId = reference.reviewId;
      if (reference.commentId) {
        const comment = await q
          .select({ reviewId: comments.reviewId })
          .from(comments)
          .where(and(eq(comments.ownerId, owner.id), eq(comments.id, reference.commentId)))
          .get();
        if (!comment) return;
        reviewId = comment.reviewId;
      }
      let predicate = reviewId ? eq(reviews.id, reviewId) : undefined;
      if (!predicate && reference.keyFor) {
        const instance = JSON.parse(
          (await readRegular(join(stateDir, "instance.json"), LIMITS.publicJsonBytes)).toString(),
        );
        if (typeof instance.id !== "string") return;
        predicate = and(
          eq(reviews.originInstanceId, instance.id),
          eq(reviews.reviewKey, reference.keyFor(instance.id)),
        );
      }
      if (!predicate) return;
      return (
        await q
          .select({ movedToUrl: reviews.movedToUrl })
          .from(reviews)
          .where(and(eq(reviews.ownerId, owner.id), predicate))
          .get()
      )?.movedToUrl;
    });
  } finally {
    await db.close();
  }
  if (destination) {
    const origin = new URL(destination).origin;
    let attached = false;
    try {
      await lstat(join(stateDir, "attach.json"));
      attached = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (attached) throw new CliError(`This review moved to ${origin}. Run the command again.`);
    throw new CliError(
      `This review moved to ${origin}. Attach again${publish ? ", or pass --key for a new review" : ""}.`,
    );
  }
  throw error;
}

/**
 * Turn an unknown-review answer into the line the skills stop on. With a hub address, a local copy
 * that moved to that hub says the review was deleted there. Any other error is rethrown unchanged.
 */
export async function deletedError(
  stateDir: string,
  error: unknown,
  reviewId: string,
  hubUrl?: string,
): Promise<never> {
  if (!(error instanceof CliApiError) || error.code !== "unknown_review") throw error;
  let onHub = false;
  const path = join(stateDir, "emend.db");
  if (
    hubUrl !== undefined &&
    (await lstat(path).then(
      (s) => s.isFile(),
      () => false,
    ))
  ) {
    const db = openDb(path);
    try {
      onHub = await db.read(async (q) => {
        // Local bootstrap has exactly one owner; never use an id from command input as an owner.
        const owner = await q.select({ id: owners.id }).from(owners).get();
        if (!owner) return false;
        const row = await q
          .select({ movedToUrl: reviews.movedToUrl })
          .from(reviews)
          .where(and(eq(reviews.ownerId, owner.id), eq(reviews.id, reviewId)))
          .get();
        return row?.movedToUrl === `${hubUrl}/r/${reviewId}`;
      });
    } catch {
      onHub = false;
    } finally {
      await db.close();
    }
  }
  throw new CliError(`review ${reviewId} was deleted ${onHub ? "on the hub" : "or never existed"}`);
}

/**
 * Turn a review_in_bin answer into the line the skills stop on. A publish names the way out: restore
 * the review, or publish as a new one. A reply knows only its comment, so it looks the review up in
 * the local state and falls back to naming the comment. Any other error is rethrown unchanged.
 */
export async function binnedError(
  stateDir: string,
  error: unknown,
  reference: { reviewId?: string; commentId?: string; publish?: boolean; shortcut?: boolean },
): Promise<never> {
  if (!(error instanceof CliApiError) || error.code !== "review_in_bin") throw error;
  if (reference.publish) {
    if (reference.reviewId === undefined)
      throw new CliError(
        `the review this publish would update is in the bin. Restore it in Settings, or pass ${reference.shortcut ? "--new" : "a new --key"} for a new review.`,
      );
    throw new CliError(
      `review ${escapeReference(reference.reviewId)} is in the bin. Restore it in Settings, or publish without --review and with a new --key for a new review.`,
    );
  }
  let reviewId = reference.reviewId;
  if (reviewId === undefined && reference.commentId !== undefined) {
    const commentId = reference.commentId;
    const path = join(stateDir, "emend.db");
    if (
      await lstat(path).then(
        (s) => s.isFile(),
        () => false,
      )
    ) {
      const db = openDb(path);
      try {
        reviewId = await db.read(async (q) => {
          // Local bootstrap has exactly one owner; never use an id from command input as an owner.
          const owner = await q.select({ id: owners.id }).from(owners).get();
          if (!owner) return undefined;
          return (
            await q
              .select({ reviewId: comments.reviewId })
              .from(comments)
              .where(and(eq(comments.ownerId, owner.id), eq(comments.id, commentId)))
              .get()
          )?.reviewId;
        });
      } catch {
        reviewId = undefined;
      } finally {
        await db.close();
      }
    }
    if (reviewId === undefined) throw new CliError(`the review of comment ${escapeReference(commentId)} is in the bin`);
  }
  throw new CliError(`review ${escapeReference(reviewId ?? "")} is in the bin`);
}

/** Refuse an attached publish before any request can create a competing hub review. */
export async function refuseUncopiedReview(
  stateDir: string,
  reference: { reviewId?: string; keyFor: (instanceId: string) => string },
  hubUrl: string,
) {
  const path = join(stateDir, "emend.db");
  try {
    if (!(await lstat(path)).isFile()) throw new CliError("Could not read the local emend database.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let instanceId: string;
  try {
    const instance = JSON.parse(
      (await readRegular(join(stateDir, "instance.json"), LIMITS.publicJsonBytes)).toString(),
    );
    if (
      !instance ||
      typeof instance.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instance.id) ||
      typeof instance.name !== "string"
    )
      throw new Error("Invalid instance");
    instanceId = instance.id;
  } catch {
    throw new CliError("could not read this machine's identity. Nothing was changed.");
  }
  const db = openDb(path);
  try {
    const local = await db.read(async (q) => {
      const owner = await q.select({ id: owners.id }).from(owners).get();
      if (!owner) return;
      return q
        .select({ id: reviews.id, movedToUrl: reviews.movedToUrl })
        .from(reviews)
        .where(
          and(
            eq(reviews.ownerId, owner.id),
            eq(reviews.originInstanceId, instanceId),
            reference.reviewId
              ? eq(reviews.id, reference.reviewId)
              : eq(reviews.reviewKey, reference.keyFor(instanceId)),
          ),
        )
        .get();
    });
    if (local && !local.movedToUrl)
      throw new CliError(`review ${local.id} is still on this machine. Run emend attach again to copy it.`);
    if (local && local.movedToUrl === `${hubUrl}/r/${local.id}`) return local.id;
  } finally {
    await db.close();
  }
}
