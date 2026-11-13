import { DownloadDocIds, LIMITS, RenderedBlock, RenderedWriteup, SourceContent, TopicMeta } from "@emend/contract";
import { buildDocDownload, buildHtmlDocDownload, buildWriteupDownload, type ResolveResult } from "@emend/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Queries } from "../../db/client.ts";
import { blobs, docAssets, files, repos, reviews, revisions, topics, writeups } from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { downloadDocNames } from "../http/download-names.ts";
import { ApiError } from "../http/errors.ts";
import { DOWNLOAD_CSP } from "../http/headers.ts";
import { zipFiles } from "../http/zip.ts";
import { publishMeta, topicView } from "./reviews.ts";

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
// One builder per owner; waiting requests have not opened a database read yet.
const downloadQueues = new Map<string, (() => void)[]>();
async function acquireDownload(ownerId: string): Promise<() => void> {
  const queue = downloadQueues.get(ownerId);
  if (queue) {
    if (queue.length >= 2) throw new ApiError("rate_limited", "download_busy");
    await new Promise<void>((resolve) => queue.push(resolve));
  } else downloadQueues.set(ownerId, []);
  return () => {
    const next = downloadQueues.get(ownerId)?.shift();
    if (next) next();
    else downloadQueues.delete(ownerId);
  };
}
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
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
  headOnly: boolean,
  docIds: string[],
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
  const filename = downloadFilename(review.title, seq);
  const ownedFiles = and(eq(files.ownerId, ownerId), eq(files.revisionId, revision.id));
  const selectedDocs = docIds.length
    ? await q
        .select()
        .from(files)
        .where(and(ownedFiles, eq(files.role, "doc"), inArray(files.id, docIds)))
        .orderBy(files.ord, files.id)
        .all()
    : [];
  if (selectedDocs.length !== docIds.length) throw new ApiError("not_found");
  const responseFilename = docIds.length ? filename.replace(/\.html$/, ".zip") : filename;
  if (headOnly) return { body: null, filename: responseFilename };
  const fileRows = await q.select().from(files).where(ownedFiles).orderBy(files.ord, files.id).all();
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
  const readWriteup = async () => {
    const writeup = await q
      .select({ hash: writeups.renderedBlob })
      .from(writeups)
      .where(and(eq(writeups.ownerId, ownerId), eq(writeups.revisionId, revision.id)))
      .get();
    if (!writeup) throw new ApiError("not_found");
    return readJson(writeup.hash);
  };
  const details = {
    project: review.project ?? (repoName !== ".git" ? repoName : null),
    branch: review.branch,
    seq,
    publishedAt: new Date(revision.createdAt).toISOString(),
  };
  let total = 0;
  // Cache bytes by blob, separately from the builders' path cache: aliases spend the budget once.
  const blobCache = new Map<string, Uint8Array | null | "too-large">();
  const resolveFile = async (file: typeof files.$inferSelect | undefined): Promise<ResolveResult> => {
    if (!file?.newBlob) return null;
    let bytes = blobCache.get(file.newBlob);
    if (bytes === undefined) {
      const stored = await q
        .select({ size: blobs.size })
        .from(blobs)
        .where(and(eq(blobs.ownerId, ownerId), eq(blobs.sha256, file.newBlob)))
        .get();
      if (!stored) bytes = null;
      else if (stored.size > budget - total) bytes = "too-large";
      else {
        bytes = await deps.blobs.get(ownerId, file.newBlob, q);
        if (bytes) total += stored.size;
      }
      blobCache.set(file.newBlob, bytes);
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
  const doc =
    revision.writeupEmpty && revision.base === null
      ? (docs.find((file) => file.path === revision.main) ?? docs[0])
      : undefined;
  const buildHtmlDoc = async (doc: typeof files.$inferSelect, title: string, inlineBudget: number) => {
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
    return buildHtmlDocDownload({
      html: new TextDecoder().decode(bytes),
      docPath: doc.path,
      title,
      resolveAsset: (path) => resolveFile(assets.get(path)),
      inlineBudget,
      pause,
    });
  };
  let html: string;
  if (doc?.mediaType === "text/html") {
    html = await buildHtmlDoc(doc, review.title, budget);
  } else if (doc) {
    const content = await readJson(doc.renderedBlob);
    const meta = await readWriteup()
      .then(publishMeta)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "not_found") return publishMeta(undefined);
        throw error;
      });
    html = await buildDocDownload({
      title: review.title,
      details: { ...details, links: meta.links },
      resolveMedia,
      inlineBudget: budget,
      pause,
      content:
        doc.mediaType === "text/plain"
          ? { kind: "source", lines: parse(SourceContent, content).lines }
          : { kind: "markdown", blocks: parse(RenderedBlock.array().max(LIMITS.blocksPerRevision), content) },
    });
  } else {
    const stored = await readWriteup();
    const rendered = parse(RenderedWriteup, stored);
    const topicRows = await q
      .select()
      .from(topics)
      .where(and(eq(topics.ownerId, ownerId), eq(topics.revisionId, revision.id)))
      .orderBy(topics.importance, sql`${topics}.rowid`)
      .all();
    html = await buildWriteupDownload({
      title: review.title,
      details: { ...details, links: publishMeta(stored).links },
      writeup: rendered,
      topics: parse(TopicMeta.array().max(LIMITS.topicsPerReview + 1), topicRows.map(topicView)),
      resolveMedia,
      inlineBudget: budget,
      pause,
    });
  }
  if (!selectedDocs.length) return { body: html, filename };
  const baseData = Buffer.from(html, "utf8");
  const entries = [{ name: filename, data: baseData }];
  const names = downloadDocNames(selectedDocs.map((file) => file.path));
  let bytesSoFar = baseData.byteLength;
  for (const [index, selected] of selectedDocs.entries()) {
    await pause();
    const inlineBudget = Math.max(0, budget - bytesSoFar);
    const title = selected.title ?? selected.path;
    let docHtml: string;
    if (selected.mediaType === "text/html") docHtml = await buildHtmlDoc(selected, title, inlineBudget);
    else {
      const stored = await readJson(selected.renderedBlob).catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "not_found") return undefined;
        throw error;
      });
      const source = selected.mediaType === "text/plain" ? SourceContent.safeParse(stored) : undefined;
      const markdown = source ? undefined : RenderedBlock.array().max(LIMITS.blocksPerRevision).safeParse(stored);
      docHtml = await buildDocDownload({
        title,
        details: { ...details, links: undefined },
        resolveMedia,
        inlineBudget,
        pause,
        content: source
          ? source.success
            ? { kind: "source", lines: source.data.lines }
            : { kind: "source", lines: [], unrendered: true }
          : { kind: "markdown", blocks: markdown?.success ? markdown.data : [] },
      });
    }
    const data = Buffer.from(docHtml, "utf8");
    bytesSoFar += data.byteLength;
    const name = names[index];
    if (name === undefined) throw new Error("Missing download entry name");
    entries.push({ name, data });
  }
  return { body: await zipFiles(entries, new Date(revision.createdAt)), filename: responseFilename };
}

/** The budget parameter is internal; requests cannot change the export ceiling. */
export function downloadRoutes(app: Hono<AppEnv>, deps: AppDeps, budget: number = LIMITS.downloadInlineBytes) {
  app.get("/api/v1/reviews/:id/revisions/:seq/download", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const headOnly = c.req.method === "HEAD";
    const parsed = DownloadDocIds.safeParse(c.req.queries("doc") ?? []);
    if (!parsed.success) throw new ApiError("invalid_request");
    const docIds = parsed.data;
    const release = headOnly ? undefined : await acquireDownload(ownerId);
    try {
      const result = await deps.db.read((q) =>
        revisionDownload(ownerId, q, deps, c.req.param("id"), c.req.param("seq"), budget, headOnly, docIds),
      );
      c.header("Content-Type", docIds.length ? "application/zip" : "text/html; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="${result.filename}"`);
      c.header("Content-Security-Policy", DOWNLOAD_CSP);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cache-Control", "no-store");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
      return result.body === null
        ? c.body(null)
        : c.body(typeof result.body === "string" ? result.body : new Uint8Array(result.body));
    } finally {
      release?.();
    }
  });
}
