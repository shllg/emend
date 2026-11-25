import { diffImageType } from "@recense/contract";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { diffImages, files, reviews, revisions } from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";

export const DIFF_IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export function fileRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  for (const side of ["old", "new"] as const) {
    app.get(`/api/v1/files/:fileId/${side}/image`, async (c) => {
      const ownerId = c.get("principal").ownerId;
      const id = c.req.param("fileId");
      const file = await deps.db.read((q) =>
        q
          .select({
            blob: diffImages.blob,
            path: files.path,
            oldPath: files.oldPath,
            binnedAt: reviews.binnedAt,
            movedToUrl: reviews.movedToUrl,
          })
          .from(files)
          .innerJoin(revisions, and(eq(revisions.ownerId, ownerId), eq(revisions.id, files.revisionId)))
          .innerJoin(reviews, and(eq(reviews.ownerId, ownerId), eq(reviews.id, revisions.reviewId)))
          .innerJoin(
            diffImages,
            and(eq(diffImages.ownerId, ownerId), eq(diffImages.fileId, files.id), eq(diffImages.side, side)),
          )
          .where(and(eq(files.ownerId, ownerId), eq(files.id, id), eq(files.role, "diff"), isNotNull(diffImages.blob)))
          .get(),
      );
      if (!file?.blob) throw new ApiError("not_found");
      if (file.binnedAt !== null && file.movedToUrl === null) throw new ApiError("review_in_bin");
      const type = diffImageType(side === "old" ? (file.oldPath ?? file.path) : file.path);
      if (!type) throw new ApiError("not_found");
      const destination = c.req.header("Sec-Fetch-Dest");
      if (type === "image/svg+xml" && destination !== undefined && destination !== "image")
        throw new ApiError("not_found");
      const read = await deps.blobs.open(ownerId, file.blob, c.req.raw.signal);
      if (!read) throw new ApiError("not_found");
      let body: ReadableStream<Uint8Array> | null = null;
      if (c.req.method === "HEAD") await read.close();
      else {
        try {
          body = read.stream();
        } catch (error) {
          await read.close();
          throw error;
        }
      }
      c.header("Content-Type", type);
      c.header("Content-Length", String(read.size));
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
      c.header("Cache-Control", "no-store");
      c.header("Content-Disposition", type === "image/svg+xml" ? "attachment" : "inline");
      c.header("Content-Security-Policy", DIFF_IMAGE_CSP);
      return body === null ? c.body(null) : c.body(body);
    });
    app.get(`/api/v1/files/:fileId/${side}`, async (c) => {
      const ownerId = c.get("principal").ownerId;
      const bytes = await deps.db.read(async (q) => {
        const file = await q
          .select({
            hash: side === "old" ? files.oldBlob : files.newBlob,
            binnedAt: reviews.binnedAt,
            movedToUrl: reviews.movedToUrl,
          })
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
        if (file && file.binnedAt !== null && file.movedToUrl === null) throw new ApiError("review_in_bin");
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
