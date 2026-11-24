import { InboxItem, ReviewPinPlaceRequest, ReviewPinRequest } from "@recense/contract";
import type { Hono } from "hono";
import { placeReviewPin, setReviewPin } from "../../db/repo/pins.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";

/** Reviewer-only writes; events observe committed pins. */
export function pinRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.put("/api/v1/reviews/:id/pin", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const reviewId = c.req.param("id");
    if (!InboxItem.shape.id.safeParse(reviewId).success) throw new ApiError("not_found");
    const { pinned } = parseBody(c, ReviewPinRequest);
    await setReviewPin(ownerId, deps.db, reviewId, pinned, deps.now());
    deps.events?.emit(ownerId, { type: "pins", reviewId });
    return c.body(null, 204);
  });
  app.put("/api/v1/reviews/:id/pin/place", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const reviewId = c.req.param("id");
    if (!InboxItem.shape.id.safeParse(reviewId).success) throw new ApiError("not_found");
    const place = parseBody(c, ReviewPinPlaceRequest);
    await placeReviewPin(ownerId, deps.db, reviewId, place);
    deps.events?.emit(ownerId, { type: "pins", reviewId });
    return c.body(null, 204);
  });
}
