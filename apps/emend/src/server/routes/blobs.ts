import { LIMITS, Sha256 } from "@emend/contract";
import type { Hono } from "hono";
import { BlobMismatchError, BlobTooLargeError } from "../../store/blobs.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";

export function blobRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  // Hono dispatches HEAD through GET handlers; the scope table still refuses actual GETs.
  app.get("/api/v1/blobs/:sha256", async (c) => {
    const sha = Sha256.safeParse(c.req.param("sha256"));
    if (!sha.success) throw new ApiError("invalid_request");
    // A row without its file (or at another size) is missing: the client uploads it again.
    if (!(await deps.blobs.hasWhole(c.get("principal").ownerId, sha.data))) throw new ApiError("not_found");
    return c.body(null, 204);
  });
  app.put("/api/v1/blobs/:sha256", async (c) => {
    const sha = Sha256.safeParse(c.req.param("sha256"));
    const length = c.req.header("Content-Length");
    if (
      !sha.success ||
      length === undefined ||
      !/^(?:0|[1-9]\d*)$/.test(length) ||
      !Number.isSafeInteger(Number(length))
    )
      throw new ApiError("invalid_request");
    async function* chunks() {
      const reader = c.req.raw.body?.getReader();
      if (!reader) return;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          yield chunk.value;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    try {
      await deps.blobs.putStream(c.get("principal").ownerId, chunks(), sha.data, Number(length), LIMITS.assetBytes);
    } catch (error) {
      if (error instanceof BlobMismatchError) throw new ApiError("blob_mismatch");
      if (error instanceof BlobTooLargeError) throw new ApiError("too_large");
      throw error;
    }
    return c.body(null, 204);
  });
}
