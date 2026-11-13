import { LIMITS, RenderedBlock, RenderedWriteup, SourceContent, TopicMeta } from "@emend/contract";
import { buildDocDownload, buildHtmlDocDownload, buildWriteupDownload, type ResolveResult } from "@emend/core";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Queries } from "../../db/client.ts";
import { docAssets, files, repos, reviews, revisions, topics, writeups } from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";
import { DOWNLOAD_CSP } from "../http/headers.ts";
import { publishMeta, topicView } from "./reviews.ts";

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
function downloadFilename(title: string, seq: number) {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "emend";
  return `${slug}-r${seq}.html`;
}
async function revisionDownload(
  ownerId: string,
  q: Queries,
  deps: AppDeps,
  reviewId: string,
  rawSeq: string,
  budget: number,
) {
  const row = await q
    .select({ review: reviews, repoName: repos.name })
    .from(reviews)
    .leftJoin(repos, and(eq(repos.ownerId, ownerId), eq(repos.id, reviews.repoId)))
    .where(and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewId)))
    .get();
  if (!row) throw new ApiError("unknown_review");
  const { review, repoName } = row;
  if (review.binnedAt !== null && review.movedToUrl === null) throw new ApiError("review_in_bin");
  const seq = Number(rawSeq);
  if (!/^[1-9]\d*$/.test(rawSeq) || !Number.isSafeInteger(seq)) throw new ApiError("not_found");
  const revision = await q
    .select()
    .from(revisions)
    .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), eq(revisions.seq, seq)))
    .get();
  if (!revision) throw new ApiError("not_found");
  const ownedFiles = and(eq(files.ownerId, ownerId), eq(files.revisionId, revision.id));
  const fileRows = await q.select().from(files).where(ownedFiles).orderBy(files.ord, files.id).all();
  const writeup = await q
    .select({ hash: writeups.renderedBlob })
    .from(writeups)
    .where(and(eq(writeups.ownerId, ownerId), eq(writeups.revisionId, revision.id)))
    .get();
  if (!writeup) throw new ApiError("not_found");
  const readJson = async (hash: string | null): Promise<unknown> => {
    const bytes = hash ? await deps.blobs.get(ownerId, hash, q) : null;
    if (!bytes) throw new ApiError("not_found");
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ApiError("not_found");
    }
  };
  const parse = <T>(
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    value: unknown,
  ): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiError("not_found");
    return result.data;
  };
  const stored = await readJson(writeup.hash);
  const rendered = parse(RenderedWriteup, stored);
  const details = {
    project: review.project ?? (repoName !== ".git" ? repoName : null),
    branch: review.branch,
    seq,
    publishedAt: new Date(revision.createdAt).toISOString(),
    links: publishMeta(stored).links,
  };
  let total = 0;
  // Cache bytes by blob, separately from the builders' path cache: aliases spend the budget once.
  const blobs = new Map<string, Uint8Array | null | "too-large">();
  const resolveFile = async (file: typeof files.$inferSelect | undefined): Promise<ResolveResult> => {
    if (!file?.newBlob) return null;
    let bytes = blobs.get(file.newBlob);
    if (bytes === undefined) {
      bytes = await deps.blobs.get(ownerId, file.newBlob, q);
      if (bytes) {
        if (total + bytes.byteLength > budget) bytes = "too-large";
        else total += bytes.byteLength;
      }
      blobs.set(file.newBlob, bytes);
    }
    return bytes === null || bytes === "too-large" ? bytes : { bytes, mediaType: file.mediaType };
  };
  const media = new Map(
    fileRows
      .filter((file) => file.role === "asset" && file.parentDocId === null && imageTypes.has(file.mediaType))
      .sort((a, b) => a.mediaType.localeCompare(b.mediaType))
      .map((file) => [file.newBlob, file]),
  );
  const resolveMedia = (sha: string) => resolveFile(media.get(sha));
  const docs = fileRows.filter((file) => file.role === "doc");
  const doc = revision.writeupEmpty ? (docs.find((file) => file.path === revision.main) ?? docs[0]) : undefined;
  let html: string;
  if (doc?.mediaType === "text/html") {
    const bytes = doc.newBlob ? await deps.blobs.get(ownerId, doc.newBlob, q) : null;
    if (!bytes) throw new ApiError("not_found");
    const rows = await q
      .select({ file: files })
      .from(files)
      .innerJoin(
        docAssets,
        and(
          eq(docAssets.ownerId, ownerId),
          eq(docAssets.revisionId, revision.id),
          eq(docAssets.docId, doc.id),
          eq(docAssets.assetId, files.id),
        ),
      )
      .where(and(ownedFiles, eq(files.role, "asset")))
      .all();
    const assets = new Map(
      rows.filter(({ file }) => file.mediaType !== "text/javascript").map(({ file }) => [file.path, file]),
    );
    html = await buildHtmlDocDownload({
      html: new TextDecoder().decode(bytes),
      docPath: doc.path,
      title: review.title,
      resolveAsset: (path) => resolveFile(assets.get(path)),
    });
  } else if (doc) {
    const content = await readJson(doc.renderedBlob);
    html = await buildDocDownload({
      title: review.title,
      details,
      resolveMedia,
      content:
        doc.mediaType === "text/plain"
          ? { kind: "source", lines: parse(SourceContent, content).lines }
          : { kind: "markdown", blocks: parse(RenderedBlock.array().max(LIMITS.blocksPerRevision), content) },
    });
  } else {
    const topicRows = await q
      .select()
      .from(topics)
      .where(and(eq(topics.ownerId, ownerId), eq(topics.revisionId, revision.id)))
      .orderBy(topics.importance, sql`${topics}.rowid`)
      .all();
    html = await buildWriteupDownload({
      title: review.title,
      details,
      writeup: rendered,
      topics: parse(TopicMeta.array().max(LIMITS.topicsPerReview), topicRows.map(topicView)),
      resolveMedia,
    });
  }
  return { html, filename: downloadFilename(review.title, seq) };
}

/** The budget parameter is internal; requests cannot change the export ceiling. */
export function downloadRoutes(app: Hono<AppEnv>, deps: AppDeps, budget: number = LIMITS.downloadInlineBytes) {
  app.get("/api/v1/reviews/:id/revisions/:seq/download", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const result = await deps.db.read((q) =>
      revisionDownload(ownerId, q, deps, c.req.param("id"), c.req.param("seq"), budget),
    );
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${result.filename}"`);
    c.header("Content-Security-Policy", DOWNLOAD_CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    return c.body(result.html);
  });
}
