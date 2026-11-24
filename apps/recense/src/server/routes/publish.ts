import { PublishRequest } from "@recense/contract";
import type { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import { ingest } from "../publish/ingest.ts";

export function publishRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.post("/api/v1/publish", async (c) => {
    const principal = c.get("principal");
    if (!principal.instanceId) throw new ApiError("forbidden");
    const request = parseBody(c, PublishRequest);
    const result = await ingest(principal.ownerId, principal.instanceId, request, {
      db: deps.db,
      blobs: deps.blobs,
      baseUrl: deps.config.baseUrl,
      executor: deps.publishExecutor,
      signal: c.req.raw.signal,
    });
    deps.events?.emit(c.get("principal").ownerId, {
      type: "publish",
      reviewId: result.reviewId,
      revision: result.revision,
    });
    return c.json(result);
  });
}
