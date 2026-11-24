import { AddCommentRequest, CreateThreadRequest } from "@recense/contract";
import type { Hono } from "hono";
import { addComment, createThread, reopenThread, resolveThread } from "../../db/repo/threads.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";

export function threadRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.post("/api/v1/reviews/:id/threads", async (c) => {
    const result = await createThread(
      c.get("principal").ownerId,
      deps.db,
      c.req.param("id"),
      parseBody(c, CreateThreadRequest),
      { blobs: deps.blobs, executor: deps.publishExecutor, signal: c.req.raw.signal },
      deps.now,
    );
    deps.events?.emit(c.get("principal").ownerId, { type: "thread", ...result });
    return c.json({ threadId: result.threadId, commentId: result.commentId }, 201);
  });
  app.post("/api/v1/threads/:id/comments", async (c) => {
    const result = await addComment(
      c.get("principal").ownerId,
      deps.db,
      c.req.param("id"),
      parseBody(c, AddCommentRequest).body,
      deps.now(),
    );
    deps.events?.emit(c.get("principal").ownerId, { type: "thread", ...result });
    return c.json({ commentId: result.commentId }, 201);
  });
  for (const [path, action] of [
    ["resolve", resolveThread],
    ["reopen", reopenThread],
  ] as const) {
    app.post(`/api/v1/threads/:id/${path}`, async (c) => {
      const result = await action(c.get("principal").ownerId, deps.db, c.req.param("id"), deps.now());
      deps.events?.emit(c.get("principal").ownerId, { type: "thread", ...result });
      return c.body(null, 204);
    });
  }
}
