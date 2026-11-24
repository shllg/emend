import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import type { Principal } from "../../server/auth/principal.ts";
import type { Db } from "../client.ts";
import { agentWaiters } from "../schema.ts";
import { requireReview } from "./thread-access.ts";

export function beginWait(ownerId: string, db: Db, principal: Principal, reviewId: string, now: number) {
  return db.transaction(
    async (q) => {
      await requireReview(ownerId, q, reviewId, principal);
      await q.delete(agentWaiters).where(and(eq(agentWaiters.ownerId, ownerId), lte(agentWaiters.expiresAt, now)));
      const id = randomUUID();
      await q.insert(agentWaiters).values({ id, ownerId, reviewId, expiresAt: now + 30000 });
      return id;
    },
    { offThread: true },
  );
}

export function renewWait(ownerId: string, db: Db, id: string, now: number) {
  return db.transaction(
    async (q) => {
      await q
        .update(agentWaiters)
        .set({ expiresAt: now + 30000 })
        .where(and(eq(agentWaiters.ownerId, ownerId), eq(agentWaiters.id, id)));
    },
    { offThread: true },
  );
}

export function endWait(ownerId: string, db: Db, id: string) {
  return db.transaction(
    async (q) => {
      await q.delete(agentWaiters).where(and(eq(agentWaiters.ownerId, ownerId), eq(agentWaiters.id, id)));
    },
    { offThread: true },
  );
}
