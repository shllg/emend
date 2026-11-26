import { AgentReviewQuery } from "@recense/contract";
import type { Hono } from "hono";
import { listAgentReviews } from "../../db/repo/agent-reviews.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";

export function agentReviewRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/agent/reviews", async (c) => {
    const params = c.req.queries();
    const single = (name: keyof AgentReviewQuery) => {
      const values = params[name];
      if (values && values.length > 1) throw new ApiError("invalid_request");
      return values?.[0];
    };
    const query = AgentReviewQuery.safeParse({ head: single("head"), key: single("key"), diff: single("diff") });
    if (!query.success) throw new ApiError("invalid_request");
    return c.json(
      await listAgentReviews(deps.db, c.get("principal"), deps.config.baseUrl, query.data, {
        now: deps.now(),
        signal: c.req.raw.signal,
      }),
    );
  });
}
