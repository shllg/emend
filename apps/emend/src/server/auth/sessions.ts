import { and, eq, exists, gt, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Db } from "../../db/client.ts";
import { devices, tokens } from "../../db/schema.ts";
import type { Principal } from "./principal.ts";
import { liveToken, principalFromToken, SESSION_MS, SESSION_SHAPE } from "./tokens.ts";

export const SESSION_COOKIE = "emend_session";
export function secureSessionRequest(c: Context, secureHost?: string): boolean {
  return secureHost !== undefined && c.req.header("Host")?.toLowerCase() === secureHost;
}
export function writeSessionCookie(c: Context, secret: string, secure: boolean, clear = false) {
  setCookie(c, SESSION_COOKIE, secret, {
    httpOnly: true,
    sameSite: "Strict",
    secure,
    path: "/",
    maxAge: clear ? 0 : SESSION_MS / 1000,
  });
}
export function sessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}
export async function verifySession(db: Db, secret: string | undefined, now: number, allowRenewal = true) {
  if (!secret || !SESSION_SHAPE.test(secret)) return null;
  return db.query(async (q) => {
    const row = await liveToken(q, secret, now);
    if (row?.kind !== "reviewer" || !row.deviceId || row.expiresAt === null) return null;
    const due = allowRenewal && now - (row.expiresAt - SESSION_MS) >= 86_400_000;
    let renew = false;
    if (due) {
      const updated = await q
        .update(tokens)
        .set({ expiresAt: now + SESSION_MS, lastUsedAt: now })
        .where(
          and(
            eq(tokens.ownerId, row.ownerId),
            eq(tokens.id, row.id),
            eq(tokens.expiresAt, row.expiresAt),
            isNull(tokens.revokedAt),
            gt(tokens.expiresAt, now),
            exists(
              q
                .select({ id: devices.id })
                .from(devices)
                .where(and(eq(devices.ownerId, row.ownerId), eq(devices.id, row.deviceId), isNull(devices.revokedAt))),
            ),
          ),
        )
        .returning({ id: tokens.id })
        .get();
      renew = Boolean(updated);
      if (!updated && !(await liveToken(q, secret, now))) return null;
    }
    return { principal: principalFromToken(row), renew };
  });
}
export function revokeSession(db: Db, principal: Principal, now: number) {
  return db.transaction(async (q) => {
    const row = await q
      .update(tokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(tokens.ownerId, principal.ownerId),
          eq(tokens.id, principal.tokenId),
          eq(tokens.kind, "reviewer"),
          isNull(tokens.revokedAt),
        ),
      )
      .returning({ deviceId: tokens.deviceId })
      .get();
    if (!row) return [];
    const closed = [{ id: principal.tokenId }];
    if (!row.deviceId) return closed;
    await q
      .update(devices)
      .set({ revokedAt: now })
      .where(and(eq(devices.ownerId, principal.ownerId), eq(devices.id, row.deviceId)));
    // Logout revokes the browser device too, so close every session bound to it.
    const siblings = await q
      .update(tokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(tokens.ownerId, principal.ownerId),
          eq(tokens.deviceId, row.deviceId),
          eq(tokens.kind, "reviewer"),
          isNull(tokens.revokedAt),
          gt(tokens.expiresAt, now),
        ),
      )
      .returning({ id: tokens.id });
    return [...closed, ...siblings];
  });
}
