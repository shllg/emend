import { AgentReviewList, type AgentReviewQuery, LIMITS } from "@emend/contract";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Principal } from "../../server/auth/principal.ts";
import type { Db } from "../client.ts";
import { reviews, revisions } from "../schema.ts";

/**
 * The agent's own list: the owner's reviews that began on the token's instance, newest first.
 * It selects no comment, writeup or doc column, and a token without an instance sees nothing.
 * Each row names the newest revision and the approved one (revision number and head), so an agent
 * can tell which commit an approval covers. With `query.head`, only reviews whose approved or newest
 * revision has exactly that head remain, before the row limit applies. It reads and writes nothing else.
 */
export async function listAgentReviews(
  db: Db,
  principal: Principal,
  baseUrl: string,
  query: AgentReviewQuery = {},
): Promise<AgentReviewList> {
  if (principal.instanceId === null) return { items: [] };
  const instanceId = principal.instanceId;
  const newest = alias(revisions, "newest");
  const approved = alias(revisions, "approved");
  const rows = await db.read((q) =>
    q
      .select({
        id: reviews.id,
        title: reviews.title,
        branch: reviews.branch,
        state: reviews.state,
        updatedAt: reviews.updatedAt,
        newestSeq: newest.seq,
        newestHead: newest.head,
        approvedSeq: approved.seq,
        approvedHead: approved.head,
      })
      .from(reviews)
      .leftJoin(
        newest,
        and(
          eq(newest.ownerId, reviews.ownerId),
          eq(newest.reviewId, reviews.id),
          eq(
            newest.seq,
            sql`(select max(r.seq) from ${revisions} r where r.owner_id = ${reviews.ownerId} and r.review_id = ${reviews.id})`,
          ),
        ),
      )
      .leftJoin(
        approved,
        and(
          eq(approved.ownerId, reviews.ownerId),
          eq(approved.reviewId, reviews.id),
          eq(approved.id, reviews.approvedRevision),
        ),
      )
      .where(
        and(
          eq(reviews.ownerId, principal.ownerId),
          eq(reviews.originInstanceId, instanceId),
          isNull(reviews.binnedAt),
          query.head === undefined ? undefined : or(eq(approved.head, query.head), eq(newest.head, query.head)),
        ),
      )
      .orderBy(desc(reviews.updatedAt), asc(reviews.id))
      .limit(LIMITS.agentReviews)
      .all(),
  );
  return AgentReviewList.parse({
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      branch: row.branch,
      state: row.state,
      newest: row.newestSeq === null ? null : { revision: row.newestSeq, head: row.newestHead },
      approved: row.approvedSeq === null ? null : { revision: row.approvedSeq, head: row.approvedHead },
      updatedAt: new Date(row.updatedAt).toISOString(),
      url: `${baseUrl}/r/${row.id}`,
    })),
  });
}
