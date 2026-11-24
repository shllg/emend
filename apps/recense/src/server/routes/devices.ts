import { DeviceList } from "@recense/contract";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { devices, tokens } from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";

export function deviceRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/devices", async (c) => {
    const principal = c.get("principal");
    const items = await deps.db.read(async (q) => {
      const session =
        principal.kind === "reviewer"
          ? await q
              .select({ deviceId: tokens.deviceId })
              .from(tokens)
              .where(and(eq(tokens.ownerId, principal.ownerId), eq(tokens.id, principal.tokenId)))
              .get()
          : undefined;
      const rows = await q
        .select()
        .from(devices)
        .where(and(eq(devices.ownerId, principal.ownerId), isNull(devices.revokedAt)))
        .orderBy(desc(devices.createdAt), desc(devices.id));
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        createdAt: new Date(row.createdAt).toISOString(),
        lastSeenAt: row.lastSeenAt === null ? null : new Date(row.lastSeenAt).toISOString(),
        current: row.id === session?.deviceId,
      }));
    });
    return c.json(DeviceList.parse({ items }));
  });
  app.delete("/api/v1/devices/:id", async (c) => {
    const { ownerId } = c.get("principal");
    const id = c.req.param("id");
    const now = deps.now();
    const revoked = await deps.db.transaction(async (q) => {
      const device = await q
        .update(devices)
        .set({ revokedAt: now })
        .where(and(eq(devices.ownerId, ownerId), eq(devices.id, id), isNull(devices.revokedAt)))
        .returning({ id: devices.id })
        .get();
      if (!device) throw new ApiError("not_found");
      return q
        .update(tokens)
        .set({ revokedAt: now })
        .where(and(eq(tokens.ownerId, ownerId), eq(tokens.deviceId, id), isNull(tokens.revokedAt)))
        .returning({ id: tokens.id });
    });
    for (const token of revoked) deps.events?.closeSession(ownerId, token.id);
    return c.body(null, 204);
  });
}
