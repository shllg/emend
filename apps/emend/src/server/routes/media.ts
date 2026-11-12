import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { files, reviews, revisions } from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";

const MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];

/** Serves writeup images by content hash, to the owner only, with a locked-down response. */
export function mediaRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/media/:sha256", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const hash = c.req.param("sha256");
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ApiError("not_found");
    const type = await deps.db.read(async (q) => {
      const file = await q
        .select({ mediaType: files.mediaType })
        .from(files)
        .innerJoin(revisions, and(eq(revisions.ownerId, ownerId), eq(revisions.id, files.revisionId)))
        .innerJoin(reviews, and(eq(reviews.ownerId, ownerId), eq(reviews.id, revisions.reviewId)))
        .where(
          and(
            eq(files.ownerId, ownerId),
            // An image used only by a binned review is not served; the bytes stay for a restore.
            isNull(reviews.binnedAt),
            eq(files.role, "asset"),
            eq(files.newBlob, hash),
            // Only writeup media: an HTML doc's own assets load from its content path.
            isNull(files.parentDocId),
            inArray(files.mediaType, MEDIA_TYPES),
          ),
        )
        // The same bytes can sit under two image types; pick one type deterministically.
        .orderBy(files.mediaType)
        .limit(1)
        .get();
      if (!file) throw new ApiError("not_found");
      return file.mediaType;
    });
    const read = await deps.blobs.open(ownerId, hash, c.req.raw.signal);
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
    // The app-wide middleware set its defaults earlier; these replace them for this route only.
    c.header("Content-Type", type);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", "sandbox; default-src 'none'");
    c.header("Content-Disposition", "inline");
    c.header("Content-Length", String(read.size));
    return body === null ? c.body(null) : c.body(body);
  });
}
