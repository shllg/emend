import { and, eq, exists, gt, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Db } from "../../db/client.ts";
import { devices, tokens } from "../../db/schema.ts";
import type { Principal } from "./principal.ts";
import { liveToken, principalFromToken, SESSION_MS, SESSION_SHAPE } from "./tokens.ts";

export const SESSION_COOKIE = "recense_session";
/** The cookie name before the rename. A browser that still carries it stays signed in until it moves over. */
export const LEGACY_SESSION_COOKIE = "emend_session";
export function secureSessionRequest(c: Context, secureHost?: string): boolean {
  return secureHost !== undefined && c.req.header("Host")?.toLowerCase() === secureHost;
}
const cookieAttributes = (secure: boolean, maxAge: number) =>
  ({ httpOnly: true, sameSite: "Strict", secure, path: "/", maxAge }) as const;
export function writeSessionCookie(c: Context, secret: string, secure: boolean, clear = false) {
  setCookie(c, SESSION_COOKIE, secret, cookieAttributes(secure, clear ? 0 : SESSION_MS / 1000));
}
/** Expires the cookie of the old name with the attributes it was set with. */
export function expireLegacySessionCookie(c: Context, secure: boolean) {
  setCookie(c, LEGACY_SESSION_COOKIE, "", cookieAttributes(secure, 0));
}
/** The session secret and whether it came in under the old cookie name; the new name wins when both are there. */
export function readSessionCookie(c: Context): { secret: string; legacy: boolean } | undefined {
  const current = getCookie(c, SESSION_COOKIE);
  if (current !== undefined) return { secret: current, legacy: false };
  const legacy = getCookie(c, LEGACY_SESSION_COOKIE);
  return legacy === undefined ? undefined : { secret: legacy, legacy: true };
}
export function sessionCookie(c: Context): string | undefined {
  return readSessionCookie(c)?.secret;
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
