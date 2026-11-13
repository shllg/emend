import {
  DownloadComments,
  DownloadDocIds,
  LIMITS,
  RenderedBlock,
  RenderedWriteup,
  SourceContent,
  TopicMeta,
} from "@emend/contract";
import {
  buildCommentsDownload,
  buildDocDownload,
  buildHtmlDocDownload,
  buildOmittedDownload,
  buildWriteupDownload,
  createDownloadWork,
  type DownloadFile,
  type DownloadThreadInput,
  type FileThreads,
  type ResolveResult,
  routeDownloadThreads,
} from "@emend/core";
import { and, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Queries } from "../../db/client.ts";
import {
  blobs,
  comments,
  docAssets,
  files,
  placements,
  repos,
  reviews,
  revisions,
  threads,
  topics,
  writeups,
} from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { downloadDocNames } from "../http/download-names.ts";
import { ApiError } from "../http/errors.ts";
import { DOWNLOAD_CSP } from "../http/headers.ts";
import { ZipWriter } from "../http/zip.ts";
import { commentHtml } from "./comment-html.ts";
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
const hasThreads = (threads: FileThreads): boolean =>
  threads.top.length > 0 ||
  threads.end.length > 0 ||
  [...threads.blocks.values(), ...threads.topics.values(), ...threads.lines.values()].some((list) => list.length > 0);
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
  commentBudget: number,
  headOnly: boolean,
  docIds: string[],
  withComments: boolean,
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
  const baseDoc = <T extends { path: string }>(docs: T[]) =>
    revision.writeupEmpty && revision.base === null
      ? (docs.find((file) => file.path === revision.main) ?? docs[0])
      : undefined;
  if (headOnly) {
    const docs =
      withComments && revision.writeupEmpty && revision.base === null
        ? await q
            .select({ path: files.path, mediaType: files.mediaType })
            .from(files)
            .where(and(ownedFiles, eq(files.role, "doc")))
            .orderBy(files.ord, files.id)
            .all()
        : [];
    const zip = docIds.length > 0 || baseDoc(docs)?.mediaType === "text/html";
    return { body: null, filename: zip ? filename.replace(/\.html$/, ".zip") : filename, zip };
  }
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
  const readLimited = async (hash: string | null): Promise<Uint8Array | null | "too-large"> => {
    if (!hash) return null;
    const stored = await q
      .select({ size: blobs.size })
      .from(blobs)
      .where(and(eq(blobs.ownerId, ownerId), eq(blobs.sha256, hash)))
      .get();
    if (!stored) return null;
    if (stored.size > budget - total) return "too-large";
    const bytes = await deps.blobs.get(ownerId, hash, q);
    if (bytes) total += stored.size;
    return bytes;
  };
  const resolveFile = async (file: typeof files.$inferSelect | undefined): Promise<ResolveResult> => {
    if (!file?.newBlob) return null;
    let bytes = blobCache.get(file.newBlob);
    if (bytes === undefined) {
      bytes = await readLimited(file.newBlob);
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
  const doc = baseDoc(docs);
  const zip = docIds.length > 0 || (withComments && doc?.mediaType === "text/html");
  const work = createDownloadWork(commentBudget);
  const fileKind = (file: typeof files.$inferSelect): "markdown" | "source" | "html" =>
    file.mediaType === "text/html" ? "html" : file.mediaType === "text/plain" ? "source" : "markdown";
  const loadThreads = async () => {
    const threadRows = await q
      .select({ thread: threads, createdOn: revisions.seq, placement: placements })
      .from(threads)
      .innerJoin(
        revisions,
        and(
          eq(revisions.ownerId, ownerId),
          eq(revisions.reviewId, reviewId),
          eq(revisions.id, threads.createdRevisionId),
        ),
      )
      .leftJoin(
        placements,
        and(
          eq(placements.ownerId, ownerId),
          eq(placements.reviewId, reviewId),
          eq(placements.threadId, threads.id),
          eq(placements.revisionId, revision.id),
        ),
      )
      .where(and(eq(threads.ownerId, ownerId), eq(threads.reviewId, reviewId), lte(revisions.seq, seq)))
      .orderBy(sql`${threads}.rowid`)
      .all();
    // Unsent reviewer comments never leave the database.
    const commentRows = await q
      .select({
        threadId: comments.threadId,
        author: comments.author,
        body: comments.body,
        outcome: comments.outcome,
        sendId: comments.sendId,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .innerJoin(
        threads,
        and(eq(threads.ownerId, ownerId), eq(threads.reviewId, reviewId), eq(threads.id, comments.threadId)),
      )
      .innerJoin(
        revisions,
        and(
          eq(revisions.ownerId, ownerId),
          eq(revisions.reviewId, reviewId),
          eq(revisions.id, threads.createdRevisionId),
        ),
      )
      .where(
        and(
          eq(comments.ownerId, ownerId),
          eq(comments.reviewId, reviewId),
          lte(revisions.seq, seq),
          or(eq(comments.author, "agent"), isNotNull(comments.sendId)),
        ),
      )
      .orderBy(sql`${comments}.rowid`)
      .all();
    // A missing or unreadable writeup only means comment links have no repository to resolve against.
    const meta = await readWriteup()
      .then(publishMeta)
      .catch((error: unknown) => {
        if (error instanceof ApiError) return publishMeta(undefined);
        throw error;
      });
    const htmls = await commentHtml(
      deps,
      ownerId,
      commentRows.map((row) => row.body),
      "repoUrl" in meta && meta.repoUrl ? meta.repoUrl : undefined,
    );
    const byThread = new Map<string, DownloadThreadInput["comments"]>();
    commentRows.forEach((row, index) => {
      const list = byThread.get(row.threadId) ?? [];
      list.push({
        author: row.author,
        sent: row.sendId !== null,
        body: row.body,
        html: htmls[index] ?? null,
        createdAt: row.createdAt,
        ...(row.outcome === null ? {} : { outcome: row.outcome }),
      });
      byThread.set(row.threadId, list);
    });
    const topicRows = await q
      .select()
      .from(topics)
      .where(and(eq(topics.ownerId, ownerId), eq(topics.revisionId, revision.id)))
      .orderBy(topics.importance, sql`${topics}.rowid`)
      .all();
    const base: DownloadFile = doc ? { kind: fileKind(doc), path: doc.path } : { kind: "writeup" };
    return routeDownloadThreads({
      importedAt: review.importedAt,
      threads: threadRows.map(({ thread, createdOn, placement }) => ({
        target: thread.target,
        state: thread.state,
        createdOn,
        comments: byThread.get(thread.id) ?? [],
        placement:
          placement?.status === "placed" && placement.location
            ? { status: "placed" as const, location: placement.location }
            : { status: "unplaced" as const, reason: placement?.reason ?? "not-placed" },
      })),
      seq,
      topics: parse(TopicMeta.array().max(LIMITS.topicsPerReview + 1), topicRows.map(topicView)),
      base,
      docs: selectedDocs.map((file) => ({ kind: fileKind(file), path: file.path })),
    });
  };
  const routed = withComments ? await loadThreads() : undefined;
  const buildHtmlDoc = async (
    doc: typeof files.$inferSelect,
    title: string,
    inlineBudget: number,
    body?: Uint8Array,
  ) => {
    const bytes = body ?? (doc.newBlob ? await deps.blobs.get(ownerId, doc.newBlob, q) : null);
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
      work,
    });
  };
  const buildBase = async () => {
    if (doc?.mediaType === "text/html") {
      return buildHtmlDoc(doc, review.title, budget);
    } else if (doc) {
      const content = await readJson(doc.renderedBlob);
      const meta = await readWriteup()
        .then(publishMeta)
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.code === "not_found") return publishMeta(undefined);
          throw error;
        });
      return buildDocDownload({
        title: review.title,
        details: { ...details, links: meta.links },
        resolveMedia,
        inlineBudget: budget,
        pause,
        work,
        threads: routed?.base,
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
      return buildWriteupDownload({
        title: review.title,
        details: { ...details, links: publishMeta(stored).links },
        writeup: rendered,
        topics: parse(TopicMeta.array().max(LIMITS.topicsPerReview + 1), topicRows.map(topicView)),
        resolveMedia,
        inlineBudget: budget,
        pause,
        work,
        threads: routed?.base,
      });
    }
  };
  if (!zip) return { body: await buildBase(), filename, zip };
  const writer = new ZipWriter(new Date(revision.createdAt));
  let bytesSoFar = 0;
  const addHtml = async (name: string, html: string) => {
    const data = Buffer.from(html, "utf8");
    bytesSoFar += data.byteLength;
    await writer.add(name, data);
  };
  const buildSelected = async (selected: typeof files.$inferSelect, index: number): Promise<string> => {
    const inlineBudget = Math.max(0, budget - bytesSoFar);
    const title = selected.title ?? selected.path;
    const routedThreads = routed?.docs[index];
    const threads = routedThreads && hasThreads(routedThreads) ? routedThreads : undefined;
    const omitted = () => buildOmittedDownload({ title, threads, inlineBudget, pause, work });
    if (inlineBudget === 0) return omitted();
    // Do not cache doc bodies: each is released after its ZIP entry is compressed.
    const bytes = await readLimited(selected.mediaType === "text/html" ? selected.newBlob : selected.renderedBlob);
    if (bytes === "too-large") return omitted();
    if (selected.mediaType === "text/html") {
      if (!bytes) throw new ApiError("not_found");
      return buildHtmlDoc(selected, title, inlineBudget, bytes);
    }
    let stored: unknown;
    if (bytes) {
      try {
        stored = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        /* Missing or invalid rendering follows the reading view's fallback. */
      }
    }
    const source = selected.mediaType === "text/plain" ? SourceContent.safeParse(stored) : undefined;
    const markdown = source ? undefined : RenderedBlock.array().max(LIMITS.blocksPerRevision).safeParse(stored);
    return buildDocDownload({
      title,
      details: { ...details, links: undefined },
      resolveMedia,
      inlineBudget,
      pause,
      work,
      threads,
      content: source
        ? source.success
          ? { kind: "source", lines: source.data.lines }
          : { kind: "source", lines: [], unrendered: true }
        : { kind: "markdown", blocks: markdown?.success ? markdown.data : [] },
    });
  };
  await addHtml(filename, await buildBase());
  if (routed?.comments) {
    await addHtml(
      "comments.html",
      await buildCommentsDownload({
        title: review.title,
        details: { ...details, links: undefined },
        resolveMedia,
        threads: routed.comments,
        elsewhere: routed.docs.some(hasThreads),
        inlineBudget: Math.max(0, budget - bytesSoFar),
        pause,
        work,
      }),
    );
  }
  const names = downloadDocNames(selectedDocs.map((file) => file.path));
  for (const [index, selected] of selectedDocs.entries()) {
    await pause();
    const name = names[index];
    if (name === undefined) throw new Error("Missing download entry name");
    await addHtml(name, await buildSelected(selected, index));
  }
  return { body: writer.finish(), filename: filename.replace(/\.html$/, ".zip"), zip };
}

/** The budget parameters are internal; requests cannot change the export ceilings. */
export function downloadRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  budget: number = LIMITS.downloadInlineBytes,
  commentBudget: number = LIMITS.downloadCommentBytes,
) {
  app.get("/api/v1/reviews/:id/revisions/:seq/download", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const headOnly = c.req.method === "HEAD";
    const parsed = DownloadDocIds.safeParse(c.req.queries("doc") ?? []);
    if (!parsed.success) throw new ApiError("invalid_request");
    const docIds = parsed.data;
    const commentsParsed = DownloadComments.safeParse(c.req.queries("comments") ?? []);
    if (!commentsParsed.success) throw new ApiError("invalid_request");
    const withComments = commentsParsed.data.length === 1;
    const release = headOnly ? undefined : await acquireDownload(ownerId);
    try {
      const result = await deps.db.read((q) =>
        revisionDownload(
          ownerId,
          q,
          deps,
          c.req.param("id"),
          c.req.param("seq"),
          budget,
          commentBudget,
          headOnly,
          docIds,
          withComments,
        ),
      );
      c.header("Content-Type", result.zip ? "application/zip" : "text/html; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="${result.filename}"`);
      c.header("Content-Security-Policy", DOWNLOAD_CSP);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cache-Control", "no-store");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
      return result.body === null ? c.body(null) : c.body(result.body);
    } finally {
      release?.();
    }
  });
}
