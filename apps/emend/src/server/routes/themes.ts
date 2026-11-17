import { ThemeList } from "@emend/contract";
import type { Hono } from "hono";
import { listThemes } from "../../state/themes.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";

export function themeRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/themes", async (c) => c.json(ThemeList.parse(await listThemes(deps.themesDir))));
}
