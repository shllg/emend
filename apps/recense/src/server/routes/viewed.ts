import { ViewedRequest } from "@recense/contract";
import type { Hono } from "hono";
import { setViewed } from "../../db/repo/viewed.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";

export function viewedRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.put("/api/v1/reviews/:id/viewed", async (c) => {
    await setViewed(c.get("principal").ownerId, deps.db, c.req.param("id"), parseBody(c, ViewedRequest), deps.now());
    deps.events?.emit(c.get("principal").ownerId, { type: "viewed", reviewId: c.req.param("id") });
    return c.body(null, 204);
  });
}
