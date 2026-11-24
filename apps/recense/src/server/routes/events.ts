import type { Context, Hono } from "hono";
import { requireReview } from "../../db/repo/thread-access.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { principalIsLive } from "../auth/tokens.ts";

export function eventRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  function stream(c: Context<AppEnv>, reviewId: string | null) {
    const principal = c.get("principal");
    // HEAD inherits GET's scope but must not allocate an unread live stream.
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-store");
    if (c.req.method === "HEAD") return c.body(null);
    if (!deps.events) throw new Error("Missing event emitter");
    return c.body(
      deps.events.stream(principal.ownerId, reviewId, principal.tokenId, c.req.raw.signal, () =>
        deps.db.read((q) => principalIsLive(q, principal, deps.now())),
      ),
    );
  }
  app.get("/api/v1/events", (c) => stream(c, null));
  app.get("/api/v1/reviews/:id/events", async (c) => {
    const principal = c.get("principal");
    const reviewId = c.req.param("id");
    await deps.db.read((q) => requireReview(principal.ownerId, q, reviewId, principal, false));
    return stream(c, reviewId);
  });
}
