import { SettingsUpdate, SettingsView } from "@emend/contract";
import type { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";
import { readSettings, updateApprovedActiveHours } from "../settings.ts";

export function settingsRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/settings", async (c) => {
    const { ownerId } = c.get("principal");
    const view = await deps.db.read((q) => readSettings(ownerId, q, deps.configFile));
    return c.json(SettingsView.parse(view));
  });
  app.patch("/api/v1/settings", async (c) => {
    const { ownerId } = c.get("principal");
    const update = parseBody(c, SettingsUpdate);
    const view = await deps.db.transaction(async (q) => {
      await updateApprovedActiveHours(ownerId, q, update.approvedActiveHours, deps.now());
      return readSettings(ownerId, q, deps.configFile);
    });
    return c.json(SettingsView.parse(view));
  });
}
