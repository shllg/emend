import { ThemeFontFileName, ThemeList, ThemeName } from "@emend/contract";
import type { Hono } from "hono";
import { readThemeFont } from "../../state/theme-fonts.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";
import { listThemesForRequest, readThemeForRequest } from "../theme-reads.ts";

export function themeRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/themes", async (c) => c.json(ThemeList.parse(await listThemesForRequest(deps.themesDir))));
  app.get("/api/v1/themes/:name/fonts/:file", async (c) => {
    const name = ThemeName.safeParse(c.req.param("name"));
    const file = ThemeFontFileName.safeParse(c.req.param("file"));
    if (!name.success || !file.success) throw new ApiError("not_found");
    const theme = await readThemeForRequest(deps.themesDir, name.data);
    if (!theme?.valid || !theme.fonts.files?.some((entry) => entry.file === file.data)) throw new ApiError("not_found");
    const result = await readThemeFont(deps.themesDir, file.data);
    if (typeof result === "string") throw new ApiError("not_found");
    c.header("Content-Type", result.type);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("Content-Security-Policy", "sandbox; default-src 'none'");
    c.header("Content-Length", String(result.bytes.length));
    return c.req.method === "HEAD" ? c.body(null) : c.body(new Uint8Array(result.bytes));
  });
}
