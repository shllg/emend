import { AgentReviewList, LIMITS } from "@emend/contract";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Principal } from "../../server/auth/principal.ts";
import type { Db } from "../client.ts";
import { reviews } from "../schema.ts";

/**
 * The agent's own list: the owner's reviews that began on the token's instance, newest first.
 * It selects no comment, writeup or doc column, and a token without an instance sees nothing.
 */
export async function listAgentReviews(db: Db, principal: Principal, baseUrl: string): Promise<AgentReviewList> {
  if (principal.instanceId === null) return { items: [] };
  const instanceId = principal.instanceId;
  const rows = await db.read((q) =>
    q
      .select({ id: reviews.id, title: reviews.title, state: reviews.state, updatedAt: reviews.updatedAt })
      .from(reviews)
      .where(
        and(eq(reviews.ownerId, principal.ownerId), eq(reviews.originInstanceId, instanceId), isNull(reviews.binnedAt)),
      )
      .orderBy(desc(reviews.updatedAt), asc(reviews.id))
      .limit(LIMITS.agentReviews)
      .all(),
  );
  return AgentReviewList.parse({
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      state: row.state,
      updatedAt: new Date(row.updatedAt).toISOString(),
      url: `${baseUrl}/r/${row.id}`,
    })),
  });
}
