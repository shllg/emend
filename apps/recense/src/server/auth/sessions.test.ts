import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { devices, tokens } from "../../db/schema.ts";
import { testDb } from "../../db/test-support.ts";
import { revokeSession, verifySession } from "./sessions.ts";
import { createToken, principalFromToken, SESSION_MS } from "./tokens.ts";

test("verifySession can verify without renewing and leave a due renewal for a later request", async () => {
  const f = await testDb();
  try {
    const now = Date.now();
    const deviceId = randomUUID();
    await f.db.query((q) =>
      q.insert(devices).values({ id: deviceId, ownerId: f.ownerId, kind: "browser", name: "Synthetic" }),
    );
    const token = await createToken(f.db, f.ownerId, "reviewer", { deviceId, now, expiresAt: now + SESSION_MS });
    const read = () =>
      f.db.read((q) =>
        q
          .select()
          .from(tokens)
          .where(and(eq(tokens.ownerId, f.ownerId), eq(tokens.id, token.id)))
          .get(),
      );
    const later = now + 86_400_000;
    expect(await verifySession(f.db, token.secret, later, false)).toMatchObject({
      principal: { tokenId: token.id, ownerId: f.ownerId },
      renew: false,
    });
    expect((await read())?.expiresAt).toBe(now + SESSION_MS);
    expect(await verifySession(f.db, token.secret, later)).toMatchObject({
      principal: { tokenId: token.id, ownerId: f.ownerId },
      renew: true,
    });
    expect((await read())?.expiresAt).toBe(later + SESSION_MS);
  } finally {
    await f.cleanup();
  }
});

test.each(["admin", "agent"] as const)(
  "revokeSession leaves a %s principal untouched and returns no ids",
  async (kind) => {
    const f = await testDb();
    try {
      const deviceId = randomUUID();
      await f.db.query((q) =>
        q.insert(devices).values({ id: deviceId, ownerId: f.ownerId, kind: "browser", name: "Synthetic" }),
      );
      const token = await createToken(f.db, f.ownerId, kind, { deviceId, instanceId: f.instanceId });
      const read = () =>
        f.db.read((q) =>
          q
            .select()
            .from(tokens)
            .where(and(eq(tokens.ownerId, f.ownerId), eq(tokens.id, token.id)))
            .get(),
        );
      const before = await read();
      if (!before) throw new Error("missing token");
      expect(await revokeSession(f.db, principalFromToken(before), Date.now())).toEqual([]);
      expect(await read()).toEqual(before);
      expect(
        await f.db.read((q) =>
          q
            .select()
            .from(devices)
            .where(and(eq(devices.ownerId, f.ownerId), eq(devices.id, deviceId)))
            .get(),
        ),
      ).toMatchObject({ revokedAt: null });
    } finally {
      await f.cleanup();
    }
  },
);

test("logout returns only the caller and live reviewer siblings, preserving other kinds, owners and prior revocations", async () => {
  const f = await testDb();
  try {
    const now = Date.now();
    const deviceId = randomUUID();
    await f.db.query((q) =>
      q.insert(devices).values({ id: deviceId, ownerId: f.ownerId, kind: "browser", name: "Synthetic" }),
    );
    const options = { deviceId, expiresAt: now + SESSION_MS };
    const caller = await createToken(f.db, f.ownerId, "reviewer", options);
    const sibling = await createToken(f.db, f.ownerId, "reviewer", options);
    const revoked = await createToken(f.db, f.ownerId, "reviewer", options);
    const expired = await createToken(f.db, f.ownerId, "reviewer", { ...options, expiresAt: now });
    const agent = await createToken(f.db, f.ownerId, "agent", { ...options, instanceId: f.instanceId });
    const foreign = await createToken(f.db, f.otherOwnerId, "reviewer", { expiresAt: options.expiresAt });
    await f.db.query((q) =>
      q
        .update(tokens)
        .set({ revokedAt: now - 1 })
        .where(and(eq(tokens.ownerId, f.ownerId), eq(tokens.id, revoked.id))),
    );
    const read = (ownerId: string, id: string) =>
      f.db.read((q) =>
        q
          .select()
          .from(tokens)
          .where(and(eq(tokens.ownerId, ownerId), eq(tokens.id, id)))
          .get(),
      );
    const principal = await read(f.ownerId, caller.id);
    if (!principal) throw new Error("missing caller");
    expect(await revokeSession(f.db, principalFromToken(principal), now)).toEqual([
      { id: caller.id },
      { id: sibling.id },
    ]);
    for (const token of [caller, sibling]) expect(await read(f.ownerId, token.id)).toMatchObject({ revokedAt: now });
    expect(await read(f.ownerId, revoked.id)).toMatchObject({ revokedAt: now - 1 });
    for (const token of [expired, agent]) expect(await read(f.ownerId, token.id)).toMatchObject({ revokedAt: null });
    expect(await read(f.otherOwnerId, foreign.id)).toMatchObject({ revokedAt: null });
    expect(await revokeSession(f.db, principalFromToken(principal), now + 1)).toEqual([]);
    expect(await read(f.ownerId, caller.id)).toMatchObject({ revokedAt: now });
  } finally {
    await f.cleanup();
  }
});
