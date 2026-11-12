import { and, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { files, reviews, revisions } from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";

export function fileRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  for (const side of ["old", "new"] as const) {
    app.get(`/api/v1/files/:fileId/${side}`, async (c) => {
      const ownerId = c.get("principal").ownerId;
      const bytes = await deps.db.read(async (q) => {
        const file = await q
          .select({ hash: side === "old" ? files.oldBlob : files.newBlob, binnedAt: reviews.binnedAt })
          .from(files)
          .innerJoin(revisions, and(eq(revisions.ownerId, ownerId), eq(revisions.id, files.revisionId)))
          .innerJoin(reviews, and(eq(reviews.ownerId, ownerId), eq(reviews.id, revisions.reviewId)))
          .where(
            and(
              eq(files.ownerId, ownerId),
              eq(files.id, c.req.param("fileId")),
              eq(files.role, "diff"),
              isNull(files.flag),
            ),
          )
          .get();
        if (file && file.binnedAt !== null) throw new ApiError("review_in_bin");
        if (!file?.hash) throw new ApiError("not_found");
        const bytes = await deps.blobs.get(ownerId, file.hash, q);
        if (!bytes) throw new ApiError("not_found");
        return bytes;
      });
      c.header("Content-Type", "text/plain; charset=utf-8");
      c.header("Cache-Control", "no-store");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
      return c.body(new Uint8Array(bytes));
    });
  }
}
