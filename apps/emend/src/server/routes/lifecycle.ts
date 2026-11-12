import { BinQuery, EmptyBinRequest, RetireRequest, SnoozeRequest } from "@emend/contract";
import type { Hono } from "hono";
import { removeUnreferencedBlob } from "../../db/repo/blob-removal.ts";
import {
  binReview,
  binSnapshot,
  deleteReview,
  listBin,
  reopenReview,
  restoreReview,
  retireReview,
  snoozeReview,
  unsnoozeReview,
} from "../../db/repo/lifecycle.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
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
  for (const [path, onlyBinned] of [
    ["/api/v1/reviews/:id", false],
    ["/api/v1/bin/:id", true],
  ] as const) {
    app.delete(path, async (c) => {
      const ownerId = owner(c);
      const reviewId = c.req.param("id");
      const deleted = await deleteReview(ownerId, deps.db, reviewId, deps.now(), onlyBinned);
      if (!deleted) throw new ApiError(onlyBinned ? "invalid_state" : "unknown_review");
      const { revision, candidates } = deleted;
      deps.events?.emit(ownerId, { type: "delete", reviewId, revision });
      // The rows are committed, so the delete is done. Freeing blobs follows the response and never
      // fails it: a blob that stays is only disk, and an error is logged without its content.
      const cleanup = cleanBlobs(deps, ownerId, candidates);
      deps.onBlobCleanup?.(cleanup);
      return c.body(null, 204);
    });
  }
  app.post("/api/v1/reviews/:id/bin", async (c) => {
    const ownerId = owner(c);
    const reviewId = c.req.param("id");
    const revision = await binReview(ownerId, deps.db, reviewId, deps.now());
    deps.events?.emit(ownerId, { type: "bin", reviewId, revision });
    return c.body(null, 204);
  });
  app.post("/api/v1/reviews/:id/restore", async (c) => {
    const ownerId = owner(c);
    const reviewId = c.req.param("id");
    const revision = await restoreReview(ownerId, deps.db, reviewId);
    deps.events?.emit(ownerId, { type: "restore", reviewId, revision });
    return c.body(null, 204);
  });
  app.get("/api/v1/bin", async (c) => {
    const query = BinQuery.safeParse(c.req.query());
    if (!query.success) throw new ApiError("invalid_request");
    return c.json(await listBin(owner(c), deps.db, query.data));
  });
  app.delete("/api/v1/bin", async (c) => {
    const ownerId = owner(c);
    const request = parseBody(c, EmptyBinRequest);
    const { ids, version } = await deps.db.read((q) => binSnapshot(ownerId, q));
    if (version !== request.version) throw new ApiError("invalid_state", "bin_changed");
    const candidates: string[] = [];
    // Each review goes in its own transaction, and only while it is still in the bin. A review
    // restored or deleted meanwhile is left alone. The loop yields so a large bin does not block.
    try {
      for (const reviewId of ids) {
        try {
          const deleted = await deleteReview(ownerId, deps.db, reviewId, deps.now(), true);
          if (deleted) {
            candidates.push(...deleted.candidates);
            deps.events?.emit(ownerId, { type: "delete", reviewId, revision: deleted.revision });
          }
        } catch (error) {
          if (!(error instanceof ApiError) || !["unknown_review", "review_moved"].includes(error.code)) throw error;
        }
        await yieldToLoop("lifecycle-bin-empty");
      }
    } finally {
      const cleanup = cleanBlobs(deps, ownerId, [...new Set(candidates)]);
      deps.onBlobCleanup?.(cleanup);
    }
    return c.body(null, 204);
  });
}
