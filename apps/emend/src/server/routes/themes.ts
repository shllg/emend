import { ThemeList } from "@emend/contract";
import type { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { listThemesForRequest } from "../theme-reads.ts";

export function themeRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/themes", async (c) => c.json(ThemeList.parse(await listThemesForRequest(deps.themesDir))));
}
