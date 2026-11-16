import { GroupRequest, InboxGroup, ReviewGroupRequest } from "@emend/contract";
import type { Hono } from "hono";
import { createGroup, deleteGroup, renameGroup, setReviewGroup } from "../../db/repo/groups.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";

function id(value: string) {
  if (!InboxGroup.shape.id.safeParse(value).success) throw new ApiError("not_found");
  return value;
}
/** Reviewer-only writes; events observe committed membership and names. */
export function groupRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.post("/api/v1/groups", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const { name } = parseBody(c, GroupRequest);
    const group = await createGroup(ownerId, deps.db, name, deps.now());
    deps.events?.emit(ownerId, { type: "groups" });
    return c.json(InboxGroup.parse(group), 201);
  });
  app.patch("/api/v1/groups/:id", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const groupId = id(c.req.param("id"));
    const { name } = parseBody(c, GroupRequest);
    const group = await renameGroup(ownerId, deps.db, groupId, name, deps.now());
    deps.events?.emit(ownerId, { type: "groups" });
    return c.json(InboxGroup.parse(group));
  });
  app.delete("/api/v1/groups/:id", async (c) => {
    const ownerId = c.get("principal").ownerId;
    await deleteGroup(ownerId, deps.db, id(c.req.param("id")));
    deps.events?.emit(ownerId, { type: "groups" });
    return c.body(null, 204);
  });
  app.put("/api/v1/reviews/:id/group", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const reviewId = id(c.req.param("id"));
    const { groupId } = parseBody(c, ReviewGroupRequest);
    await setReviewGroup(ownerId, deps.db, reviewId, groupId, deps.now());
    deps.events?.emit(ownerId, { type: "groups", reviewId });
    return c.body(null, 204);
  });
}
