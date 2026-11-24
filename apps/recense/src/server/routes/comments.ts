import { EditCommentRequest, ReplyCreated, ReplyRequest } from "@recense/contract";
import type { Hono } from "hono";
import { replyToComment } from "../../db/repo/replies.ts";
import { deleteComment, editComment } from "../../db/repo/threads.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";

export function commentRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.patch("/api/v1/comments/:id", async (c) => {
    const result = await editComment(
      c.get("principal").ownerId,
      deps.db,
      c.req.param("id"),
      parseBody(c, EditCommentRequest).body,
      deps.now(),
    );
    deps.events?.emit(c.get("principal").ownerId, { type: "thread", ...result });
    return c.body(null, 204);
  });
  app.delete("/api/v1/comments/:id", async (c) => {
    const result = await deleteComment(c.get("principal").ownerId, deps.db, c.req.param("id"));
    deps.events?.emit(c.get("principal").ownerId, { type: "thread", ...result });
    return c.body(null, 204);
  });
  app.post("/api/v1/comments/:id/reply", async (c) => {
    const principal = c.get("principal");
    const result = await replyToComment(deps.db, principal, c.req.param("id"), parseBody(c, ReplyRequest), deps.now());
    deps.events?.emit(c.get("principal").ownerId, { type: "thread", ...result });
    return c.json(ReplyCreated.parse(result), 201);
  });
}
