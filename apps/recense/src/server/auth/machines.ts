import { randomUUID } from "node:crypto";
import type { MachineRegistration } from "@recense/contract";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db, Queries } from "../../db/client.ts";
import { devices, instances, owners, pairings, tokens } from "../../db/schema.ts";
import type { Instance } from "../../state/instance.ts";
import { ApiError } from "../http/errors.ts";
import type { Principal } from "./principal.ts";
import { hashSecret, insertToken, principalIsLive } from "./tokens.ts";

export async function registerMachine(db: Db, input: MachineRegistration, self: Instance, now: number) {
  return db.transaction(async (q) => {
    // A pairing hash establishes the owner, just as session redemption does.
    const matches = await q
      .select()
      .from(pairings)
      .where(
        and(
          input.secret !== undefined
            ? eq(pairings.secretHash, hashSecret(input.secret))
            : eq(pairings.codeHash, hashSecret(input.code)),
          eq(pairings.purpose, "machine"),
          isNull(pairings.usedAt),
          gt(pairings.expiresAt, now),
        ),
      )
      .limit(2);
    const pairing = matches[0];
    if (!pairing || matches.length !== 1) throw new ApiError("unauthorized");
    const existing = await q.select().from(instances).where(eq(instances.id, input.instance.id)).get();
    if (input.instance.id === self.id || existing?.isSelf || existing?.wasSelf) throw new ApiError("wrong_origin");
    // Instances are global identities. Never hand an origin to a second live device,
    // even if that credential belongs to a different owner. Return no foreign data.
    const live = await q
      .select({
        yes: sql<number>`exists(select 1 from ${devices} where ${devices.instanceId} = ${input.instance.id} and ${devices.kind} = 'machine' and ${devices.revokedAt} is null)`,
      })
      .from(owners)
      .where(eq(owners.id, pairing.ownerId))
      .get();
    if (live?.yes) throw new ApiError("instance_attached");
    await q
      .update(pairings)
      .set({ usedAt: now })
      .where(and(eq(pairings.ownerId, pairing.ownerId), eq(pairings.id, pairing.id), isNull(pairings.usedAt)));
    if (existing)
      await q
        .update(instances)
        .set({ name: input.instance.name, attachedAt: now })
        .where(eq(instances.id, existing.id));
    else await q.insert(instances).values({ ...input.instance, attachedAt: now });
    const deviceId = randomUUID();
    await q.insert(devices).values({
      id: deviceId,
      ownerId: pairing.ownerId,
      kind: "machine",
      name: input.instance.name,
      instanceId: input.instance.id,
      createdAt: now,
      lastSeenAt: now,
    });
    return insertToken(q, pairing.ownerId, "agent", {
      deviceId,
      instanceId: input.instance.id,
      name: input.instance.name,
      now,
    });
  });
}

export async function machineDevice(ownerId: string, q: Queries, principal: Principal, now: number) {
  if (!(await principalIsLive(q, principal, now))) throw new ApiError("unauthorized");
  const row = await q
    .select({ id: devices.id })
    .from(tokens)
    .innerJoin(
      devices,
      and(
        eq(devices.ownerId, ownerId),
        eq(devices.id, tokens.deviceId),
        eq(devices.kind, "machine"),
        principal.instanceId === null ? undefined : eq(devices.instanceId, principal.instanceId),
        isNull(devices.revokedAt),
      ),
    )
    .where(and(eq(tokens.ownerId, ownerId), eq(tokens.id, principal.tokenId), eq(tokens.kind, "agent")))
    .get();
  if (!row || principal.instanceId === null) throw new ApiError("not_found");
  return row.id;
}

export function detachMachine(db: Db, principal: Principal, now: number) {
  const { ownerId } = principal;
  return db.transaction(async (q) => {
    const id = await machineDevice(ownerId, q, principal, now);
    await q
      .update(devices)
      .set({ revokedAt: now })
      .where(and(eq(devices.ownerId, ownerId), eq(devices.id, id)));
    await q
      .update(tokens)
      .set({ revokedAt: now })
      .where(and(eq(tokens.ownerId, ownerId), eq(tokens.deviceId, id), isNull(tokens.revokedAt)));
  });
}
