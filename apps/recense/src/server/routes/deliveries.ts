import { TakeRequest } from "@recense/contract";
import type { Hono } from "hono";
import type { Queries } from "../../db/client.ts";
import { newestRevision, requireReview } from "../../db/repo/thread-access.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { principalIsLive } from "../auth/tokens.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import { confirmDelivery, releaseUnreturnedDelivery, takeDelivery } from "../mailbox/take.ts";

export function deliveryRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.post("/api/v1/reviews/:id/take", async (c) => {
    const { waitSeconds, maxBytes, accepts } =
      c.get("jsonBody") === "" ? TakeRequest.parse({}) : parseBody(c, TakeRequest);
    const principal = c.get("principal");
    const reviewId = c.req.param("id");
    const start = deps.now();
    const authorize = async (q: Queries) => {
      if (!(await principalIsLive(q, principal, deps.now()))) throw new ApiError("unauthorized");
    };
    const revision = await deps.db.read(async (q) => {
      await requireReview(principal.ownerId, q, reviewId, principal);
      return newestRevision(principal.ownerId, q, reviewId);
    });
    // Subscribe before the initial take so a Send between its empty read and wait
    // cannot be missed. Only mark waiting if that take actually finds no delivery.
    const wait =
      waitSeconds > 0
        ? deps.events?.waitForSend(principal.ownerId, reviewId, waitSeconds, c.req.raw.signal)
        : undefined;
    let endWaiting: (() => void) | undefined;
    try {
      let result = await takeDelivery(
        deps.db,
        principal,
        reviewId,
        deps.now(),
        wait ? authorize : undefined,
        maxBytes,
        accepts,
      );
      if (!result && wait && !c.req.raw.signal.aborted) {
        endWaiting = deps.events?.beginWaiting(principal.ownerId, reviewId, revision.seq);
        await wait.promise;
        await deps.db.read(authorize);
        if (!c.req.raw.signal.aborted)
          result = await takeDelivery(deps.db, principal, reviewId, deps.now(), authorize, maxBytes, accepts);
      }
      if (wait) {
        try {
          await deps.db.read(authorize);
        } catch (error) {
          if (result) await releaseUnreturnedDelivery(deps.db, principal, result.deliveryId);
          throw error;
        }
      }
      if (result) {
        endWaiting?.();
        deps.events?.endGrace(principal.ownerId, reviewId);
        deps.events?.emit(principal.ownerId, { type: "claimed", reviewId, revision: result.revision });
      }
      return c.json(result ?? { kind: "pending", reviewId, waitedSeconds: Math.max(0, (deps.now() - start) / 1000) });
    } finally {
      wait?.cancel();
      endWaiting?.();
    }
  });
  app.post("/api/v1/deliveries/:id/confirm", async (c) => {
    const principal = c.get("principal");
    const result = await confirmDelivery(deps.db, principal, c.req.param("id"), deps.now());
    if (!result) throw new ApiError("not_found");
    deps.events?.emit(principal.ownerId, { type: "confirmed", ...result });
    return c.body(null, 204);
  });
}
