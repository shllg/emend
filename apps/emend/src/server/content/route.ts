import { FilePath } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { docAssets, files, revisions } from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";
import { HTML_DOC_CSP } from "../http/headers.ts";
import { injectBridge } from "./inject.ts";

export function contentRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/content/:docKey/*", async (c) => {
    // Parse the raw path once: encoded slashes must not create new path segments.
    const match = /^\/content\/([A-Za-z0-9_-]{43})([0-9a-f]{32})\/(.+)$/.exec(c.req.path);
    if (!match?.[1] || !match[2] || !match[3]) throw new ApiError("not_found");
    const contentKey = match[1];
    const compactId = match[2];
    const docId = `${compactId.slice(0, 8)}-${compactId.slice(8, 12)}-${compactId.slice(12, 16)}-${compactId.slice(16, 20)}-${compactId.slice(20)}`;
    let path: string;
    try {
      const segments = match[3].split("/").map(decodeURIComponent);
      if (segments.some((segment) => segment.includes("/"))) throw new Error("Encoded separator");
      path = FilePath.parse(segments.join("/"));
    } catch {
      throw new ApiError("not_found");
    }
    const result = await deps.db.read(async (q) => {
      // The key is the capability; its revision supplies owner_id. No cookie or Authorization is read.
      const revision = await q.select().from(revisions).where(eq(revisions.contentKey, contentKey)).get();
      if (!revision) throw new ApiError("not_found");
      const owned = and(eq(files.ownerId, revision.ownerId), eq(files.revisionId, revision.id));
      const doc = await q
        .select()
        .from(files)
        .where(and(owned, eq(files.id, docId), eq(files.role, "doc"), eq(files.mediaType, "text/html")))
        .get();
      if (!doc) throw new ApiError("not_found");
      const isDoc = path === doc.path;
      const asset = isDoc
        ? undefined
        : await q
            .select({ file: files })
            .from(files)
            .innerJoin(
              docAssets,
              and(
                eq(docAssets.ownerId, revision.ownerId),
                eq(docAssets.revisionId, revision.id),
                eq(docAssets.docId, docId),
                eq(docAssets.assetId, files.id),
              ),
            )
            .where(and(owned, eq(files.path, path), eq(files.role, "asset")))
            .get();
      const file = isDoc ? doc : asset?.file;
      if (!file?.newBlob) throw new ApiError("not_found");
      if (isDoc) {
        const bytes = await deps.blobs.get(revision.ownerId, file.newBlob, q);
        if (!bytes) throw new ApiError("not_found");
        return { bytes, mediaType: file.mediaType, isDoc: true as const };
      }
      return { ownerId: revision.ownerId, sha: file.newBlob, mediaType: file.mediaType, isDoc: false as const };
    });
    const type = result.mediaType;
    const contentType = /^(?:text\/|application\/json$|image\/svg\+xml$)/.test(type) ? `${type}; charset=utf-8` : type;
    if (result.isDoc) {
      const html = injectBridge(new TextDecoder().decode(result.bytes));
      c.header("Content-Type", contentType);
      c.header("Content-Security-Policy", HTML_DOC_CSP);
      return c.body(html);
    }
    const read = await deps.blobs.open(result.ownerId, result.sha, c.req.raw.signal);
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
    c.header("Content-Type", contentType);
    c.header("Cross-Origin-Resource-Policy", "cross-origin");
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Content-Length", String(read.size));
    return body === null ? c.body(null) : c.body(body);
  });
}
