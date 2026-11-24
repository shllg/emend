import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SCOPES_BY_KIND, type TokenKind } from "@recense/contract";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Db, Queries } from "../../db/client.ts";
import { devices, tokens } from "../../db/schema.ts";
import type { Principal } from "./principal.ts";

export const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");
export const newSecret = (prefix: "em_" | "ems_" | "emp_") => prefix + randomBytes(32).toString("base64url");
export const BEARER_SHAPE = /^em_[A-Za-z0-9_-]{43}$/;
export const SESSION_SHAPE = /^ems_[A-Za-z0-9_-]{43}$/;
export const SESSION_MS = 30 * 86_400_000;
export interface TokenOptions {
  instanceId?: string;
  deviceId?: string;
  expiresAt?: number;
  now?: number;
  name?: string;
}
export async function insertToken(q: Queries, ownerId: string, kind: TokenKind, opts: TokenOptions) {
  const id = randomUUID();
  const secret = newSecret(kind === "reviewer" ? "ems_" : "em_");
  const now = opts.now ?? Date.now();
  await q.insert(tokens).values({
    id,
    ownerId,
    kind,
    name: opts.name ?? kind,
    instanceId: opts.instanceId,
    deviceId: opts.deviceId,
    expiresAt: opts.expiresAt,
    createdAt: now,
    lastUsedAt: now,
    secretHash: hashSecret(secret),
  });
  return { id, secret };
}
export function createToken(db: Db, ownerId: string, kind: TokenKind, opts: TokenOptions = {}) {
  return db.query((q) => insertToken(q, ownerId, kind, opts));
}
export function principalFromToken(row: typeof tokens.$inferSelect): Principal {
  return {
    ownerId: row.ownerId,
    tokenId: row.id,
    kind: row.kind,
    instanceId: row.instanceId,
    scopes: [...SCOPES_BY_KIND[row.kind]],
  };
}
export async function liveToken(q: Queries, secret: string, now: number) {
  // This hash lookup establishes the principal; all subsequent owned queries use its owner.
  const row = await q
    .select()
    .from(tokens)
    .where(
      and(
        eq(tokens.secretHash, hashSecret(secret)),
        isNull(tokens.revokedAt),
        or(isNull(tokens.expiresAt), gt(tokens.expiresAt, now)),
      ),
    )
    .get();
  if (!row) return null;
  if (row.deviceId) {
    const device = await q
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.ownerId, row.ownerId), eq(devices.id, row.deviceId), isNull(devices.revokedAt)))
      .get();
    if (!device) return null;
  }
  return row;
}
export async function verifyBearer(db: Db, header: string | undefined, now: number): Promise<Principal | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const secret = header.slice(7);
  if (!BEARER_SHAPE.test(secret)) return null;
  return db.read(async (q) => {
    const row = await liveToken(q, secret, now);
    return row && row.kind !== "reviewer" ? principalFromToken(row) : null;
  });
}

// Revalidate an already authenticated request without retaining its credential or
// renewing it. Call through Db.read while waiting, or the current claim transaction.
export async function principalIsLive(q: Queries, principal: Principal, now: number): Promise<boolean> {
  const row = await q
    .select({ deviceId: tokens.deviceId, expiresAt: tokens.expiresAt })
    .from(tokens)
    .where(
      and(
        eq(tokens.ownerId, principal.ownerId),
        eq(tokens.id, principal.tokenId),
        eq(tokens.kind, principal.kind),
        principal.instanceId === null ? isNull(tokens.instanceId) : eq(tokens.instanceId, principal.instanceId),
        isNull(tokens.revokedAt),
        or(isNull(tokens.expiresAt), gt(tokens.expiresAt, now)),
      ),
    )
    .get();
  if (!row || (principal.kind === "reviewer" && (!row.deviceId || row.expiresAt === null))) return false;
  if (!row.deviceId) return true;
  return Boolean(
    await q
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.ownerId, principal.ownerId), eq(devices.id, row.deviceId), isNull(devices.revokedAt)))
      .get(),
  );
}

// The caller supplies its transaction so rotation can join the rest of startup repair.
export async function rotateLocalToken(
  q: Queries,
  ownerId: string,
  kind: "admin" | "agent",
  instanceId: string,
  now: number,
) {
  await q
    .update(tokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(tokens.ownerId, ownerId),
        eq(tokens.kind, kind),
        eq(tokens.instanceId, instanceId),
        isNull(tokens.revokedAt),
      ),
    );
  return insertToken(q, ownerId, kind, { instanceId, now });
}
