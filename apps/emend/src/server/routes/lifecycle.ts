import { RetireRequest, SnoozeRequest } from "@emend/contract";
import type { Hono } from "hono";
import { removeUnreferencedBlob } from "../../db/repo/blob-removal.ts";
import { deleteReview, reopenReview, retireReview, snoozeReview, unsnoozeReview } from "../../db/repo/lifecycle.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";
import { yieldToLoop } from "../pacing.ts";

export const CLEANUP_BATCH = 16;

/**
 * Free the blobs nothing of this owner uses any more, a batch at a time with a yield between
 * batches. Each blob goes under its sha's lock, so a put of the same content is whole before or
 * after the removal. Resolves always; failures are logged.
 */
async function cleanBlobs(deps: AppDeps, ownerId: string, candidates: readonly string[]): Promise<void> {
  try {
    for (let i = 0; i < candidates.length; i += CLEANUP_BATCH) {
      for (const hash of candidates.slice(i, i + CLEANUP_BATCH))
        await deps.blobs.exclusive(hash, async () => {
          const { removed } = await removeUnreferencedBlob(deps.db, ownerId, hash);
          if (removed) await deps.blobs.unlinkIfUnheld(hash);
        });
      await yieldToLoop("lifecycle-blob-cleanup");
    }
  } catch {
    console.error("emend: blob cleanup after a review delete failed");
  }
}

/** Reviewer-only (scope `send`) review lifecycle. Each emits its event after the commit. */
export function lifecycleRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  const owner = (c: { get(key: "principal"): { ownerId: string } }) => c.get("principal").ownerId;
  app.post("/api/v1/reviews/:id/snooze", async (c) => {
    const ownerId = owner(c);
    const reviewId = c.req.param("id");
    const revision = await snoozeReview(ownerId, deps.db, reviewId, parseBody(c, SnoozeRequest), deps.now());
    deps.events?.emit(ownerId, { type: "snooze", reviewId, revision });
    return c.body(null, 204);
  });
  app.post("/api/v1/reviews/:id/unsnooze", async (c) => {
    const ownerId = owner(c);
    const reviewId = c.req.param("id");
    const revision = await unsnoozeReview(ownerId, deps.db, reviewId, deps.now());
    deps.events?.emit(ownerId, { type: "unsnooze", reviewId, revision });
    return c.body(null, 204);
  });
  app.post("/api/v1/reviews/:id/retire", async (c) => {
    const ownerId = owner(c);
    const reviewId = c.req.param("id");
    // A missing or zero-length body means {}.
    const request = c.get("jsonBody") === "" ? RetireRequest.parse({}) : parseBody(c, RetireRequest);
    const revision = await retireReview(ownerId, deps.db, reviewId, request, deps.now());
    deps.events?.emit(ownerId, { type: "retire", reviewId, revision });
    return c.body(null, 204);
  });
  app.post("/api/v1/reviews/:id/reopen", async (c) => {
    const ownerId = owner(c);
    const reviewId = c.req.param("id");
    const revision = await reopenReview(ownerId, deps.db, reviewId, deps.now());
    deps.events?.emit(ownerId, { type: "reopen", reviewId, revision });
    return c.body(null, 204);
  });
  app.delete("/api/v1/reviews/:id", async (c) => {
    const ownerId = owner(c);
    const reviewId = c.req.param("id");
    const { revision, candidates } = await deleteReview(ownerId, deps.db, reviewId, deps.now());
    deps.events?.emit(ownerId, { type: "delete", reviewId, revision });
    // The rows are committed, so the delete is done. Freeing blobs follows the response and never
    // fails it: a blob that stays is only disk, and an error is logged without its content.
    const cleanup = cleanBlobs(deps, ownerId, candidates);
    deps.onBlobCleanup?.(cleanup);
    return c.body(null, 204);
  });
}
