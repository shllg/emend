import { randomInt, randomUUID } from "node:crypto";
import { type PairingPurpose, SessionRequest } from "@recense/contract";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { devices, pairings } from "../../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Principal } from "./principal.ts";
import { hashSecret, insertToken, newSecret, SESSION_MS } from "./tokens.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_MS = 600_000;
export async function createPairing(db: Db, principal: Principal, now: number, purpose: PairingPurpose = "device") {
  const secret = newSecret("emp_");
  const normalized = Array.from({ length: 8 }, () => CROCKFORD[randomInt(32)]).join("");
  const expiresAt = now + PAIRING_MS;
  await db.query((q) =>
    q.insert(pairings).values({
      ownerId: principal.ownerId,
      createdBy: principal.tokenId,
      purpose,
      secretHash: hashSecret(secret),
      codeHash: hashSecret(normalized),
      expiresAt,
    }),
  );
  return { secret, code: `${normalized.slice(0, 4)}-${normalized.slice(4)}`, expiresAt };
}
function browserName(userAgent?: string) {
  return (
    userAgent
      ?.slice(0, 512)
      .replace(/[^a-zA-Z0-9 ._()/;-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "Browser"
  );
}
export async function redeemPairing(db: Db, input: SessionRequest, now: number, userAgent?: string) {
  const parsed = SessionRequest.safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_request");
  const value = parsed.data;
  return db.transaction(async (q) => {
    // The one-time hash is a credential: the conditional update establishes its owner.
    const row = await q
      .update(pairings)
      .set({ usedAt: now })
      .where(
        and(
          value.secret !== undefined
            ? eq(pairings.secretHash, hashSecret(value.secret))
            : eq(pairings.codeHash, hashSecret(value.code)),
          isNull(pairings.usedAt),
          gt(pairings.expiresAt, now),
          eq(pairings.purpose, "device"),
          // Codes establish a principal too. A collision must never choose an owner.
          value.code === undefined
            ? undefined
            : sql`(SELECT count(*) FROM pairings WHERE code_hash = ${hashSecret(value.code)}
                AND used_at IS NULL AND expires_at > ${now} AND purpose = 'device') = 1`,
        ),
      )
      .returning()
      .get();
    if (!row) throw new ApiError("unauthorized");
    const deviceId = randomUUID();
    const name = browserName(userAgent);
    await q
      .insert(devices)
      .values({ id: deviceId, ownerId: row.ownerId, kind: "browser", name, createdAt: now, lastSeenAt: now });
    return insertToken(q, row.ownerId, "reviewer", { deviceId, now, expiresAt: now + SESSION_MS, name });
  });
}

export function codeLockout() {
  let failures: number[] = [];
  let lockedUntil = 0;
  return {
    check(now: number) {
      if (now < lockedUntil) throw new ApiError("rate_limited");
    },
    fail(now: number) {
      failures = failures.filter((at) => at > now - PAIRING_MS);
      failures.push(now);
      if (failures.length >= 5) {
        lockedUntil = now + PAIRING_MS;
        failures = [];
        throw new ApiError("rate_limited");
      }
    },
  };
}

// One queue and lockout per app, shared by browser and machine redemption.
export function pairingRedemptions(now: () => number) {
  const lock = codeLockout();
  let queue = Promise.resolve();
  return <T>(code: boolean, redeem: (at: number) => Promise<T>): Promise<T> => {
    const run = async () => {
      const at = now();
      if (code) lock.check(at);
      try {
        return await redeem(at);
      } catch (error) {
        if (code && error instanceof ApiError && error.code === "unauthorized") lock.fail(at);
        throw error;
      }
    };
    if (!code) return run();
    const pending = queue.then(run);
    queue = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
}
