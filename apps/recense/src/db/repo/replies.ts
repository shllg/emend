import { randomUUID } from "node:crypto";
import type { ReplyRequest } from "@recense/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Principal } from "../../server/auth/principal.ts";
import { ApiError } from "../../server/http/errors.ts";
import type { Db } from "../client.ts";
import { comments, threads } from "../schema.ts";
import { eventInfo, requireComment } from "./thread-access.ts";

export function replyToComment(db: Db, principal: Principal, commentId: string, request: ReplyRequest, now: number) {
  const ownerId = principal.ownerId;
  return db.transaction(
    async (q) => {
      const comment = await requireComment(ownerId, q, commentId, principal);
      if (comment.author !== "user" || comment.sendId === null) throw new ApiError("not_found");
      const id = randomUUID();
      await q.insert(comments).values({
        id,
        ownerId,
        reviewId: comment.reviewId,
        threadId: comment.threadId,
        author: "agent",
        body: request.body,
        outcome: request.outcome,
        createdAt: now,
        updatedAt: now,
      });
      const updated = await q
        .update(threads)
        .set({
          state: sql`case when ${threads.state} = 'resolved' then 'resolved' else 'answered' end`,
          updatedAt: now,
        })
        .where(and(eq(threads.ownerId, ownerId), eq(threads.id, comment.threadId)))
        .returning({ state: threads.state })
        .get();
      if (!updated) throw new ApiError("not_found");
      return {
        ...(await eventInfo(ownerId, q, comment.reviewId, comment.threadId)),
        commentId: id,
        state: updated.state,
      };
    },
    { offThread: true },
  );
}
