import { ServerStopping, ServerStopRequest } from "@recense/contract";
import type { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";

export function serverRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  let stopping = false;
  app.post("/api/v1/server/stop", (c) => {
    if (!deps.onStopRequest || !c.env?.onResponseSent) throw new ApiError("not_found");
    if (c.get("jsonBody") !== "") parseBody(c, ServerStopRequest);
    c.env.onResponseSent(() => {
      if (stopping) return;
      stopping = true;
      deps.onStopRequest?.();
    });
    return c.json(ServerStopping.parse({ stopping: true }), 202);
  });
}
