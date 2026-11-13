import { SettingsUpdate, SettingsView } from "@emend/contract";
import type { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";
import { readFileSetting, readKeySettings, readSettings, updateKeys, updateNumericSetting } from "../settings.ts";

export function settingsRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/settings", async (c) => {
    const { ownerId } = c.get("principal");
    const file = await readFileSetting(deps.configFile);
    const view = await deps.db.read(async (q) => ({
      ...(await readSettings(ownerId, q, file)),
      keys: await readKeySettings(ownerId, q, file),
    }));
    return c.json(SettingsView.parse({ ...view, serverTime: new Date(deps.now()).toISOString() }));
  });
  app.patch("/api/v1/settings", async (c) => {
    const { ownerId } = c.get("principal");
    const update = parseBody(c, SettingsUpdate);
    await deps.db.transaction(async (q) => {
      const now = deps.now();
      if (update.approvedActiveHours !== undefined)
        await updateNumericSetting(ownerId, q, "approvedActiveHours", update.approvedActiveHours, now);
      if (update.approvedActiveLimit !== undefined)
        await updateNumericSetting(ownerId, q, "approvedActiveLimit", update.approvedActiveLimit, now);
      if (update.keys !== undefined) await updateKeys(ownerId, q, update.keys, now);
    });
    const file = await readFileSetting(deps.configFile);
    const view = await deps.db.read(async (q) => ({
      ...(await readSettings(ownerId, q, file)),
      keys: await readKeySettings(ownerId, q, file),
    }));
    return c.json(SettingsView.parse({ ...view, serverTime: new Date(deps.now()).toISOString() }));
  });
}
