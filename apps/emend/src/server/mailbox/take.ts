import { randomUUID } from "node:crypto";
import {
  DEFAULT_MODE,
  type HandoffComment,
  LEASE_SECONDS,
  LIMITS,
  MODE_LABELS,
  type TakeAccept,
  type UnplacedReason,
  type WaitResult,
} from "@emend/contract";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db, Queries } from "../../db/client.ts";
import { snoozeInEffect } from "../../db/repo/snooze.ts";
import { commentOrder, newestRevision, requireReview } from "../../db/repo/thread-access.ts";
import { comments, deliveries, placements, reviews, revisions, sends, threads } from "../../db/schema.ts";
import type { Principal } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";
import { envelopeBytes, loadHistory, pendingCommentSizes, placementOrMissing, sendSizes } from "./payload.ts";

async function reopen(ownerId: string, q: Queries, reviewId: string, now: number, approvedRevisions: string[]) {
  if (!approvedRevisions.length) return;
  await q
    .update(reviews)
    .set({ state: "open", approvedRevision: null, approvedAt: null, updatedAt: now })
    .where(
      and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewId), inArray(reviews.approvedRevision, approvedRevisions)),
    );
}

async function claimSends(
  db: Db,
  principal: Principal,
  reviewId: string,
  now: number,
  authorize?: (q: Queries) => Promise<void>,
  maxBytes: number = LIMITS.handoffBytes,
): Promise<Exclude<WaitResult, { kind: "pending" }> | null> {
  const ownerId = principal.ownerId;
  const byteLimit = Math.min(maxBytes, LIMITS.handoffBytes);
  // An empty poll reads committed state without waiting behind a publishing writer.
  const available = await db.read(async (q) => {
    await requireReview(ownerId, q, reviewId, principal);
    return q
      .select({ id: sends.id })
      .from(sends)
      .leftJoin(deliveries, and(eq(deliveries.ownerId, ownerId), eq(deliveries.id, sends.deliveryId)))
      .where(
        and(
          eq(sends.ownerId, ownerId),
          eq(sends.reviewId, reviewId),
          isNull(sends.setAsideAt),
          or(isNull(sends.deliveryId), and(isNull(deliveries.confirmedAt), lt(deliveries.leaseUntil, now))),
        ),
      )
      .limit(1)
      .get();
  });
  if (!available) return null;
  return db.transaction(async (q) => {
    await authorize?.(q);
    await requireReview(ownerId, q, reviewId, principal);
    const newest = await newestRevision(ownerId, q, reviewId);
    const expired = and(
      eq(deliveries.ownerId, ownerId),
      eq(deliveries.reviewId, reviewId),
      isNull(deliveries.confirmedAt),
      lt(deliveries.leaseUntil, now),
    );
    // Release first, respecting the composite foreign key from Send to delivery.
    await q
      .update(sends)
      .set({ deliveryId: null, setAsideAt: null })
      .where(
        and(
          eq(sends.ownerId, ownerId),
          eq(sends.reviewId, reviewId),
          inArray(sends.deliveryId, q.select({ id: deliveries.id }).from(deliveries).where(expired)),
        ),
      );
    await q.delete(deliveries).where(expired);
    const unclaimed = and(
      eq(sends.ownerId, ownerId),
      eq(sends.reviewId, reviewId),
      isNull(sends.deliveryId),
      isNull(sends.setAsideAt),
    );
    const stale = await q
      .update(sends)
      .set({ setAsideAt: now })
      .where(and(unclaimed, eq(sends.kind, "approve"), ne(sends.revisionId, newest.id)))
      .returning({ revisionId: sends.revisionId });
    if (stale.length)
      await reopen(
        ownerId,
        q,
        reviewId,
        now,
        stale.map((s) => s.revisionId),
      );
    if (!(await q.select({ id: sends.id }).from(sends).where(unclaimed).limit(1).get())) return null;
    const deliveryId = randomUUID();
    await q
      .insert(deliveries)
      .values({ id: deliveryId, ownerId, reviewId, leaseUntil: now + LEASE_SECONDS * 1000, createdAt: now });
    // Select a FIFO prefix inside the guarded UPDATE itself. The running sums count
    // whole Sends, so a cap never strands part of a claimed Send or loses a comment.
    await q
      .update(sends)
      .set({ deliveryId })
      .where(
        and(
          unclaimed,
          sql`${sends.id} in (
      with pending_comments as materialized (${pendingCommentSizes(ownerId, reviewId, newest.id)}),
        send_sizes as materialized (${sendSizes()})
      select id from (
        select s.id, row_number() over (order by +s.rowid) as position,
          sum(coalesce(ss.comment_count, 0))
            over (order by +s.rowid rows unbounded preceding) as comment_count,
          sum(case when s.instruction is null then 0 else 1 end)
            over (order by +s.rowid rows unbounded preceding) as instruction_count,
          sum(coalesce(ss.bytes, 0) + case when s.instruction is null then 0
            else length(cast(json_quote(s.instruction) as blob)) + 1 end)
            over (order by +s.rowid rows unbounded preceding) as payload_bytes
        from sends s left join send_sizes ss on ss.send_id = s.id
        where s.owner_id = ${ownerId} and s.review_id = ${reviewId}
          and s.delivery_id is null and s.set_aside_at is null
      ) where position = 1 or (comment_count <= ${LIMITS.commentsPerHandoff}
        and instruction_count <= ${LIMITS.instructionsPerHandoff}
        and payload_bytes + ${envelopeBytes} <= ${byteLimit})
    )`,
        ),
      );
    const claimed = await q
      .select({ send: sends, seq: revisions.seq })
      .from(sends)
      .innerJoin(
        revisions,
        and(eq(revisions.ownerId, ownerId), eq(revisions.id, sends.revisionId), eq(revisions.reviewId, reviewId)),
      )
      .where(and(eq(sends.ownerId, ownerId), eq(sends.reviewId, reviewId), eq(sends.deliveryId, deliveryId)))
      .orderBy(sql`+sends.rowid`);
    if (!claimed.length) {
      await q.delete(deliveries).where(and(eq(deliveries.ownerId, ownerId), eq(deliveries.id, deliveryId)));
      return null;
    }
    const go = claimed.filter((row) => row.send.kind === "go");
    const latest = go.at(-1);
    if (!latest) {
      // Leading approvals and the first queued Go are indivisible. A smaller
      // budget must roll back this claim instead of hiding feedback behind approval.
      if (
        await q
          .select({ id: sends.id })
          .from(sends)
          .where(and(unclaimed, eq(sends.kind, "go")))
          .limit(1)
          .get()
      )
        throw new ApiError("too_large");
      return { kind: "approve", reviewId, deliveryId, revision: newest.seq };
    }
    const approvalSetAside = claimed.some((row) => row.send.kind === "approve");
    if (approvalSetAside) {
      await q
        .update(sends)
        .set({ setAsideAt: now })
        .where(
          and(
            eq(sends.ownerId, ownerId),
            eq(sends.reviewId, reviewId),
            eq(sends.deliveryId, deliveryId),
            eq(sends.kind, "approve"),
          ),
        );
      await reopen(
        ownerId,
        q,
        reviewId,
        now,
        claimed.filter((s) => s.send.kind === "approve").map((s) => s.send.revisionId),
      );
    }
    // Positional rows avoid decoding and mapping unused table columns for large Sends.
    const sentComments = await q.values<
      [string, string, string, number, string, "placed" | "unplaced" | null, string | null, UnplacedReason | null]
    >(sql`select ${comments.id}, ${comments.threadId}, ${comments.body}, ${commentOrder},
        ${threads.target}, ${placements.status}, ${placements.location}, ${placements.reason}
      from ${sends} cross join ${comments} indexed by comments_owner_review_send_idx
      join ${threads} on ${threads.ownerId} = ${ownerId} and ${threads.reviewId} = ${reviewId}
        and ${threads.id} = ${comments.threadId}
      left join ${placements} on ${placements.ownerId} = ${ownerId} and ${placements.reviewId} = ${reviewId}
        and ${placements.threadId} = ${comments.threadId} and ${placements.revisionId} = ${newest.id}
      where ${sends.ownerId} = ${ownerId} and ${sends.reviewId} = ${reviewId}
        and ${sends.id} = ${comments.sendId} and ${sends.deliveryId} = ${deliveryId}
        and ${comments.ownerId} = ${ownerId} and ${comments.reviewId} = ${reviewId} and ${comments.author} = 'user'
      order by +${commentOrder}`);
    const commentOrders = new Map<string, number>();
    const output: HandoffComment[] = [];
    const contexts = new Map<string, Pick<HandoffComment, "target" | "placement">>();
    let missingPlacement = false;
    for (const [id, threadId, body, order, target, status, location, reason] of sentComments) {
      let context = contexts.get(threadId);
      if (!context) {
        const placement = placementOrMissing(
          status === null ? null : { status, location: location === null ? null : JSON.parse(location), reason },
        );
        if (placement.status === "unplaced" && placement.reason === "not-placed") missingPlacement = true;
        context = { target: JSON.parse(target), placement };
        contexts.set(threadId, context);
      }
      commentOrders.set(id, order);
      output.push({ id, threadId, target: context.target, body, placement: context.placement, history: [] });
    }
    const mode = latest.send.mode ?? DEFAULT_MODE;
    if (missingPlacement) console.error("emend: missing placement during handoff");
    await authorize?.(q);
    return loadHistory(
      ownerId,
      q,
      reviewId,
      {
        kind: "go",
        reviewId,
        deliveryId,
        revision: newest.seq,
        sentOn: latest.seq,
        mode,
        modeLabel: MODE_LABELS[mode],
        instructions: go.flatMap(({ send }) => (send.instruction === null ? [] : [send.instruction])),
        approvalSetAside,
        comments: output,
      },
      commentOrders,
      byteLimit,
    );
  });
}

type Closing = { reason: "retired" | "snoozed"; until: number | null };

/** Why a review ends the wait of its agent, if it does: retired, or snoozed and still asleep. */
function closing(
  review: { state: string; snoozedAt: number | null; snoozedUntil: number | null },
  now: number,
): Closing | null {
  if (review.state === "settled") return { reason: "retired", until: null };
  if (review.state === "open" && snoozeInEffect(review, now)) return { reason: "snoozed", until: review.snoozedUntil };
  return null;
}

/**
 * Deliver any pending Send first. With none, a retired or snoozed review answers `closed` to a client
 * that announced it, and `review_closed` to one that did not.
 */
export async function takeDelivery(
  db: Db,
  principal: Principal,
  reviewId: string,
  now: number,
  authorize?: (q: Queries) => Promise<void>,
  maxBytes: number = LIMITS.handoffBytes,
  accepts: readonly TakeAccept[] = [],
): Promise<Exclude<WaitResult, { kind: "pending" }> | null> {
  const claimed = await claimSends(db, principal, reviewId, now, authorize, maxBytes);
  if (claimed) return claimed;
  const review = await db.read((q) => requireReview(principal.ownerId, q, reviewId, principal));
  if (!closing(review, now)) return null;
  if (!accepts.includes("closed")) throw new ApiError("review_closed");
  return closeDelivery(db, principal, reviewId, now, authorize);
}

async function closeDelivery(
  db: Db,
  principal: Principal,
  reviewId: string,
  now: number,
  authorize?: (q: Queries) => Promise<void>,
): Promise<Exclude<WaitResult, { kind: "pending" }> | null> {
  const ownerId = principal.ownerId;
  return db.transaction(async (q) => {
    await authorize?.(q);
    const review = await requireReview(ownerId, q, reviewId, principal);
    const why = closing(review, now);
    if (!why) return null;
    // A Send that arrived after the claim attempt is delivered first: leave it to the next claim of the wait.
    const waiting = await q
      .select({ id: sends.id })
      .from(sends)
      .leftJoin(deliveries, and(eq(deliveries.ownerId, ownerId), eq(deliveries.id, sends.deliveryId)))
      .where(
        and(
          eq(sends.ownerId, ownerId),
          eq(sends.reviewId, reviewId),
          isNull(sends.setAsideAt),
          or(isNull(sends.deliveryId), and(isNull(deliveries.confirmedAt), lt(deliveries.leaseUntil, now))),
        ),
      )
      .limit(1)
      .get();
    if (waiting) return null;
    const newest = await newestRevision(ownerId, q, reviewId);
    const sendless = sql`not exists (select 1 from sends where sends.owner_id = ${ownerId} and sends.delivery_id = deliveries.id)`;
    // Confirmed closed deliveries pile up with every wake; keep only the newest one.
    const newestConfirmed = await q
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.ownerId, ownerId),
          eq(deliveries.reviewId, reviewId),
          isNotNull(deliveries.confirmedAt),
          sendless,
        ),
      )
      .orderBy(desc(sql`${deliveries}.rowid`))
      .limit(1)
      .get();
    if (newestConfirmed)
      await q
        .delete(deliveries)
        .where(
          and(
            eq(deliveries.ownerId, ownerId),
            eq(deliveries.reviewId, reviewId),
            isNotNull(deliveries.confirmedAt),
            ne(deliveries.id, newestConfirmed.id),
            sendless,
          ),
        );
    // A dead closed delivery has no Send to release; drop it before reusing a live one.
    await q
      .delete(deliveries)
      .where(
        and(
          eq(deliveries.ownerId, ownerId),
          eq(deliveries.reviewId, reviewId),
          isNull(deliveries.confirmedAt),
          lt(deliveries.leaseUntil, now),
          sendless,
        ),
      );
    const live = await q
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.ownerId, ownerId),
          eq(deliveries.reviewId, reviewId),
          isNull(deliveries.confirmedAt),
          gte(deliveries.leaseUntil, now),
          sendless,
        ),
      )
      .orderBy(desc(sql`${deliveries}.rowid`))
      .limit(1)
      .get();
    const deliveryId = live?.id ?? randomUUID();
    if (!live)
      await q
        .insert(deliveries)
        .values({ id: deliveryId, ownerId, reviewId, leaseUntil: now + LEASE_SECONDS * 1000, createdAt: now });
    return {
      kind: "closed",
      reviewId,
      deliveryId,
      revision: newest.seq,
      reason: why.reason,
      until: why.until === null ? null : new Date(why.until).toISOString(),
    };
  });
}

export function confirmDelivery(db: Db, principal: Principal, deliveryId: string, now: number) {
  const ownerId = principal.ownerId;
  return db.transaction(async (q) => {
    const delivery = await q
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.ownerId, ownerId), eq(deliveries.id, deliveryId)))
      .get();
    if (!delivery) return false;
    const review = await requireReview(ownerId, q, delivery.reviewId, principal, false, true, true);
    const confirmed = await q
      .update(deliveries)
      .set({ confirmedAt: now })
      .where(
        and(
          eq(deliveries.ownerId, ownerId),
          eq(deliveries.id, deliveryId),
          isNull(deliveries.confirmedAt),
          gte(deliveries.leaseUntil, now),
        ),
      )
      .returning({ id: deliveries.id })
      .get();
    if (!confirmed) return false;
    // A delivery with no Send is a closed answer. Its confirm is the proof of the agent that it stopped,
    // and the point where the review counts as released.
    const carriesSend = await q
      .select({ id: sends.id })
      .from(sends)
      .where(and(eq(sends.ownerId, ownerId), eq(sends.deliveryId, deliveryId)))
      .limit(1)
      .get();
    const why = carriesSend ? null : closing(review, now);
    if (why)
      await q
        .update(reviews)
        .set({ releasedAt: now, releasedReason: why.reason })
        .where(and(eq(reviews.ownerId, ownerId), eq(reviews.id, delivery.reviewId)));
    const revision = await newestRevision(ownerId, q, delivery.reviewId);
    return { reviewId: delivery.reviewId, revision: revision.seq, deliveryId };
  });
}

export function releaseUnreturnedDelivery(db: Db, principal: Principal, deliveryId: string) {
  const ownerId = principal.ownerId;
  return db.transaction(async (q) => {
    const owned = and(eq(deliveries.ownerId, ownerId), eq(deliveries.id, deliveryId), isNull(deliveries.confirmedAt));
    const delivery = await q.select().from(deliveries).where(owned).get();
    if (!delivery) return;
    await requireReview(ownerId, q, delivery.reviewId, principal, false, true, true);
    await q
      .update(sends)
      .set({ deliveryId: null, setAsideAt: null })
      .where(and(eq(sends.ownerId, ownerId), eq(sends.reviewId, delivery.reviewId), eq(sends.deliveryId, deliveryId)));
    await q.delete(deliveries).where(owned);
  });
}
