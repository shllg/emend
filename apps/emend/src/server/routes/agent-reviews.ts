import { AgentReviewQuery } from "@emend/contract";
import type { Hono } from "hono";
import { listAgentReviews } from "../../db/repo/agent-reviews.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";

export function agentReviewRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/agent/reviews", async (c) => {
    // A repeated `head` is as malformed as a bad value: only one exact object id is a lookup.
    const heads = c.req.queries("head") ?? [];
    const query = AgentReviewQuery.safeParse(
      heads.length === 1 ? { head: heads[0] } : heads.length ? { head: "" } : {},
    );
    if (!query.success) throw new ApiError("invalid_request");
    return c.json(await listAgentReviews(deps.db, c.get("principal"), deps.config.baseUrl, query.data));
  });
}
