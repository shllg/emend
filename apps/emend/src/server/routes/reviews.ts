import {
  InboxList,
  LIMITS,
  PublishMeta,
  ReviewView,
  RevisionView,
  SourceContent,
  type ThreadView,
} from "@emend/contract";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  ne,
  not,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Hono } from "hono";
import type { Queries } from "../../db/client.ts";
import { snoozeInEffect } from "../../db/repo/snooze.ts";
import {
  agentNotes,
  agentWaiters,
  changedBlocks,
  comments,
  deliveries,
  files,
  instances,
  placements,
  repos,
  reviews,
  revisions,
  sends,
  threads,
  topics,
  viewedFiles,
  writeups,
} from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";
import { noteView } from "../publish/notes.ts";
import { type FileSetting, readFileSetting, readSettings } from "../settings.ts";
import { commentHtml } from "./comment-html.ts";

export function publishMeta(rendered: unknown) {
  const meta = PublishMeta.safeParse(rendered);
  // Invalid stored values are dropped, never shown.
  return meta.success ? { links: meta.data.links ?? [], repoUrl: meta.data.repoUrl ?? null } : {};
}

export function topicView(topic: typeof topics.$inferSelect) {
  return {
    slug: topic.slug,
    title: topic.title,
    importance: topic.importance,
    summary: topic.summary,
    ...(topic.attention === null ? {} : { attention: topic.attention }),
    ...(topic.door === null ? {} : { door: topic.door }),
    ...(topic.blastScope === null || topic.blastNote === null
      ? {}
      : { blastRadius: { scope: topic.blastScope, note: topic.blastNote } }),
  };
}

/** Counts use one grouped query per kind, independent of the number of inbox rows. */
async function inbox(ownerId: string, q: Queries, deps: AppDeps, file: FileSetting, reviewId?: string) {
  const latest = q
    .select({ reviewId: revisions.reviewId, seq: max(revisions.seq).as("seq") })
    .from(revisions)
    .where(eq(revisions.ownerId, ownerId))
    .groupBy(revisions.reviewId)
    .as("latest");
  const now = deps.now();
  const serverTime = new Date(now).toISOString();
  const approvedActiveHours = (await readSettings(ownerId, q, file)).approvedActiveHours.value;
  const approvedWindow = approvedActiveHours * 3_600_000;
  const cutoff = now - approvedWindow;
  const select = (where: SQL | undefined, order: SQL[], limit: number) =>
    q
      .select({
        review: reviews,
        origin: { id: instances.id, name: instances.name },
        repo: repos.key,
        repoName: repos.name,
        newestRevision: latest.seq,
      })
      .from(reviews)
      .innerJoin(latest, eq(latest.reviewId, reviews.id))
      .innerJoin(instances, eq(instances.id, reviews.originInstanceId))
      .leftJoin(repos, and(eq(repos.ownerId, ownerId), eq(repos.id, reviews.repoId)))
      .where(
        and(
          eq(reviews.ownerId, ownerId),
          reviewId === undefined
            ? isNull(reviews.binnedAt)
            : or(isNull(reviews.binnedAt), isNotNull(reviews.movedToUrl)),
          where,
        ),
      )
      .orderBy(...order)
      .limit(limit)
      .all();
  const asleep = and(isNotNull(reviews.snoozedAt), or(isNull(reviews.snoozedUntil), gt(reviews.snoozedUntil, now)));
  const isOpen = eq(reviews.state, "open");
  const recentlyApproved = and(
    sql`${approvedActiveHours} > 0`,
    eq(reviews.state, "approved"),
    isNotNull(reviews.approvedAt),
    gt(reviews.approvedAt, cutoff),
  );
  const activity = (review: typeof reviews.$inferSelect) =>
    review.state === "open" ? Math.max(review.updatedAt, review.snoozedUntil ?? 0) : review.updatedAt;
  // Open reviews take Active's capped places first; display order still follows activity.
  const active =
    reviewId === undefined
      ? // Only open reviews count a passed timed snooze as an update at its wake time.
        (
          await select(
            or(and(isOpen, not(asleep as SQL)), recentlyApproved),
            [
              asc(eq(reviews.state, "approved")),
              sql`case when ${isOpen} then max(${reviews.updatedAt}, coalesce(${reviews.snoozedUntil}, 0)) else ${reviews.updatedAt} end desc`,
              asc(reviews.id),
            ],
            LIMITS.inboxItems,
          )
        ).sort(
          (a, b) =>
            activity(b.review) - activity(a.review) ||
            (a.review.id < b.review.id ? -1 : a.review.id > b.review.id ? 1 : 0),
        )
      : [];
  const activeApprovedIds = new Set(
    active.filter(({ review }) => review.state === "approved").map(({ review }) => review.id),
  );
  const rows =
    reviewId === undefined
      ? [
          ...active,
          ...(await select(
            and(isOpen, asleep),
            [asc(sql`${reviews.snoozedUntil} is null`), asc(reviews.snoozedUntil), asc(reviews.id)],
            LIMITS.inboxItems,
          )),
          ...(await select(
            and(
              ne(reviews.state, "open"),
              activeApprovedIds.size ? notInArray(reviews.id, [...activeApprovedIds]) : undefined,
            ),
            [desc(reviews.updatedAt), asc(reviews.id)],
            LIMITS.inboxItems,
          )),
        ]
      : await select(eq(reviews.id, reviewId), [asc(reviews.id)], 1);
  if (!rows.length) return { items: [], serverTime, approvedActiveHours };
  const ids = rows.map((row) => row.review.id);
  const drafts = await q
    .select({ id: comments.reviewId, count: count() })
    .from(comments)
    .where(
      and(
        eq(comments.ownerId, ownerId),
        inArray(comments.reviewId, ids),
        eq(comments.author, "user"),
        isNull(comments.sendId),
      ),
    )
    .groupBy(comments.reviewId)
    .all();
  const open = await q
    .select({ id: threads.reviewId, count: count() })
    .from(threads)
    .where(and(eq(threads.ownerId, ownerId), inArray(threads.reviewId, ids), ne(threads.state, "resolved")))
    .groupBy(threads.reviewId)
    .all();
  const pending = await q
    .select({ id: sends.reviewId, count: count() })
    .from(sends)
    .leftJoin(
      deliveries,
      and(
        eq(deliveries.ownerId, ownerId),
        eq(deliveries.reviewId, sends.reviewId),
        eq(deliveries.id, sends.deliveryId),
      ),
    )
    .where(
      and(
        eq(sends.ownerId, ownerId),
        inArray(sends.reviewId, ids),
        isNull(sends.setAsideAt),
        isNull(deliveries.confirmedAt),
      ),
    )
    .groupBy(sends.reviewId)
    .all();
  // Latest confirmed delivery that carried a live Send made on the review's newest revision.
  const confirmed = await q
    .select({ id: sends.reviewId, seq: revisions.seq, at: max(deliveries.confirmedAt) })
    .from(sends)
    .innerJoin(
      deliveries,
      and(
        eq(deliveries.ownerId, ownerId),
        eq(deliveries.reviewId, sends.reviewId),
        eq(deliveries.id, sends.deliveryId),
      ),
    )
    .innerJoin(revisions, and(eq(revisions.ownerId, ownerId), eq(revisions.id, sends.revisionId)))
    .where(
      and(
        eq(sends.ownerId, ownerId),
        inArray(sends.reviewId, ids),
        isNull(sends.setAsideAt),
        isNotNull(deliveries.confirmedAt),
      ),
    )
    .groupBy(sends.reviewId, revisions.seq)
    .all();
  const newestSeq = new Map(rows.map(({ review, newestRevision }) => [review.id, newestRevision]));
  // A published document has an empty writeup and no diff base on its newest revision.
  const shapes = await q
    .select({ id: revisions.reviewId, seq: revisions.seq, empty: revisions.writeupEmpty, base: revisions.base })
    .from(revisions)
    .where(and(eq(revisions.ownerId, ownerId), inArray(revisions.reviewId, ids)))
    .all();
  const publishIds = new Set(
    shapes.filter((row) => row.seq === newestSeq.get(row.id) && row.empty && row.base === null).map((row) => row.id),
  );
  const pickedUp = new Map<string, number>();
  for (const row of confirmed) if (row.at !== null && row.seq === newestSeq.get(row.id)) pickedUp.set(row.id, row.at);
  const draftCounts = new Map(drafts.map((row) => [row.id, row.count]));
  const openCounts = new Map(open.map((row) => [row.id, row.count]));
  const pendingIds = new Set(pending.map((row) => row.id));
  const directWaits = await q
    .select({ reviewId: agentWaiters.reviewId })
    .from(agentWaiters)
    .where(
      and(
        eq(agentWaiters.ownerId, ownerId),
        inArray(agentWaiters.reviewId, ids),
        gt(agentWaiters.expiresAt, deps.now()),
      ),
    )
    .groupBy(agentWaiters.reviewId);
  const waitingIds = new Set(directWaits.map((row) => row.reviewId));
  const items = rows.map(({ review, origin, repo, repoName, newestRevision }) => {
    const snoozed = review.state === "open" && snoozeInEffect(review, now);
    const activeUntil =
      approvedActiveHours > 0 &&
      review.state === "approved" &&
      review.approvedAt !== null &&
      (reviewId === undefined ? activeApprovedIds.has(review.id) : review.approvedAt > cutoff)
        ? new Date(review.approvedAt + approvedWindow).toISOString()
        : null;
    return {
      id: review.id,
      title: review.title,
      origin,
      repo,
      project: review.project ?? (repoName !== ".git" ? repoName : null),
      branch: review.branch,
      state: review.state,
      newestRevision,
      unsentCount: draftCounts.get(review.id) ?? 0,
      openThreads: openCounts.get(review.id) ?? 0,
      pendingSend: pendingIds.has(review.id),
      agentWaiting: (deps.events?.agentWaiting(ownerId, review.id) ?? false) || waitingIds.has(review.id),
      updatedAt: new Date(review.updatedAt).toISOString(),
      movedTo: review.movedToUrl,
      importedAt: review.importedAt === null ? null : new Date(review.importedAt).toISOString(),
      list:
        review.state === "settled" || (review.state === "approved" && activeUntil === null)
          ? ("done" as const)
          : snoozed
            ? ("snoozed" as const)
            : ("active" as const),
      snoozed,
      activeUntil,
      snoozedUntil: snoozed && review.snoozedUntil !== null ? new Date(review.snoozedUntil).toISOString() : null,
      releasedAt: review.releasedAt === null ? null : new Date(review.releasedAt).toISOString(),
      kind: publishIds.has(review.id) ? ("publish" as const) : ("review" as const),
      pickedUpAt: pickedUp.has(review.id) ? new Date(pickedUp.get(review.id) as number).toISOString() : null,
    };
  });
  // Inside Active, a review with a waiting agent comes first; the rows already run newest first.
  return {
    serverTime,
    approvedActiveHours,
    items: [
      ...items.filter((item) => item.list === "active" && item.agentWaiting),
      ...items.filter((item) => item.list === "active" && !item.agentWaiting),
      ...items.filter((item) => item.list !== "active"),
    ],
  };
}

async function revisionView(ownerId: string, q: Queries, deps: AppDeps, reviewId: string, seq: number) {
  const revision = await q
    .select()
    .from(revisions)
    .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), eq(revisions.seq, seq)))
    .get();
  if (!revision) throw new ApiError("not_found");
  const revisionId = revision.id;
  const marks = await q
    .select({ ...getTableColumns(viewedFiles), fileId: files.id, flag: files.flag, oldPath: files.oldPath })
    .from(viewedFiles)
    // LEFT JOIN preserves the mark-first query plan: other reviews' files are never scanned.
    .leftJoin(
      revisions,
      and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), eq(revisions.seq, viewedFiles.revisionSeq)),
    )
    .leftJoin(
      files,
      and(
        eq(files.ownerId, ownerId),
        eq(files.revisionId, revisions.id),
        eq(files.path, viewedFiles.path),
        eq(files.role, "diff"),
      ),
    )
    .where(and(eq(viewedFiles.ownerId, ownerId), eq(viewedFiles.reviewId, reviewId)));
  const marksByPath = new Map(marks.filter((mark) => mark.fileId !== null).map((mark) => [mark.path, mark]));
  const fileRows = await q
    .select()
    .from(files)
    .where(and(eq(files.ownerId, ownerId), eq(files.revisionId, revisionId), ne(files.role, "asset")))
    .orderBy(files.ord, files.id)
    .all();
  // Probe notes by this revision's file IDs, avoiding a scan of the owner's note history.
  const noteRows = await q
    .select({ note: agentNotes })
    .from(agentNotes)
    .where(
      and(
        eq(agentNotes.ownerId, ownerId),
        inArray(
          agentNotes.fileId,
          q
            .select({ id: files.id })
            .from(files)
            .where(and(eq(files.ownerId, ownerId), eq(files.revisionId, revisionId))),
        ),
      ),
    )
    .orderBy(agentNotes.fileId, agentNotes.ord);
  const notesByFile = new Map<string, ReturnType<typeof noteView>[]>();
  for (const { note } of noteRows) {
    const notes = notesByFile.get(note.fileId) ?? [];
    notes.push(noteView(note));
    notesByFile.set(note.fileId, notes);
  }
  const topicRows = await q
    .select()
    .from(topics)
    .where(and(eq(topics.ownerId, ownerId), eq(topics.revisionId, revisionId)))
    .orderBy(topics.importance, sql`${topics}.rowid`)
    .all();
  const writeup = await q
    .select({ hash: writeups.renderedBlob })
    .from(writeups)
    .where(and(eq(writeups.ownerId, ownerId), eq(writeups.revisionId, revisionId)))
    .get();
  const readJson = async (hash: string): Promise<unknown> => {
    const bytes = await deps.blobs.get(ownerId, hash, q);
    if (!bytes) throw new ApiError("not_found");
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  if (!writeup) throw new ApiError("not_found");
  const rendered = await readJson(writeup.hash);
  const docs = [];
  for (const file of fileRows) {
    if (file.role !== "doc") continue;
    const metadata = {
      ...(file.title !== null ? { title: file.title } : {}),
      ...(file.headings !== null ? { headings: file.headings } : {}),
    };
    if (file.mediaType === "text/plain") {
      const stored = file.renderedBlob ? await readJson(file.renderedBlob).catch(() => undefined) : undefined;
      const content = SourceContent.safeParse(stored);
      docs.push({
        path: file.path,
        kind: "source",
        ...(file.title ? { title: file.title } : {}),
        language: content.success ? content.data.language : "text",
        lines: content.success ? content.data.lines : [],
        ...(!content.success ? { unrendered: true } : {}),
      });
    } else if (file.mediaType === "text/html") {
      docs.push({
        ...metadata,
        path: file.path,
        kind: "html",
        contentUrl: `/content/${revision.contentKey}${file.id.replaceAll("-", "")}/${file.path.split("/").map(encodeURIComponent).join("/")}`,
      });
    } else {
      docs.push({
        path: file.path,
        kind: "markdown",
        ...metadata,
        blocks: file.renderedBlob ? await readJson(file.renderedBlob) : [],
      });
    }
  }
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
        eq(placements.revisionId, revisionId),
      ),
    )
    .where(and(eq(threads.ownerId, ownerId), eq(threads.reviewId, reviewId)))
    .orderBy(sql`${threads}.rowid`)
    .all();
  const commentRows = await q
    .select({ comment: comments, sentOn: revisions.seq })
    .from(comments)
    .leftJoin(sends, and(eq(sends.ownerId, ownerId), eq(sends.reviewId, reviewId), eq(sends.id, comments.sendId)))
    .leftJoin(
      revisions,
      and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), eq(revisions.id, sends.revisionId)),
    )
    .where(and(eq(comments.ownerId, ownerId), eq(comments.reviewId, reviewId)))
    .orderBy(sql`${comments}.rowid`)
    .all();
  const byThread = new Map<string, ThreadView["comments"]>();
  for (const { comment, sentOn } of commentRows) {
    const list = byThread.get(comment.threadId) ?? [];
    list.push({
      id: comment.id,
      author: comment.author,
      body: comment.body,
      sent: comment.sendId !== null,
      sentOn: comment.author === "user" ? sentOn : null,
      ...(comment.outcome === null ? {} : { outcome: comment.outcome }),
    });
    byThread.set(comment.threadId, list);
  }
  // Comment Markdown renders on read, never stored; null leaves the comment as plain text.
  const meta = publishMeta(rendered);
  const everyComment = [...byThread.values()].flat();
  const htmls = await commentHtml(
    deps,
    ownerId,
    everyComment.map((comment) => comment.body),
    "repoUrl" in meta && meta.repoUrl ? meta.repoUrl : undefined,
  );
  everyComment.forEach((comment, index) => {
    comment.html = htmls[index] ?? null;
  });
  const lastSend = await q
    .select({ seq: revisions.seq })
    .from(sends)
    .innerJoin(
      revisions,
      and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), eq(revisions.id, sends.revisionId)),
    )
    .where(and(eq(sends.ownerId, ownerId), eq(sends.reviewId, reviewId)))
    .orderBy(desc(sql`${sends}.rowid`))
    .limit(1)
    .get();
  const changed = await q
    .select({ blockId: changedBlocks.blockId, revision: max(revisions.seq) })
    .from(changedBlocks)
    .innerJoin(
      revisions,
      and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), eq(revisions.id, changedBlocks.revisionId)),
    )
    .where(
      and(
        eq(changedBlocks.ownerId, ownerId),
        gt(revisions.seq, Math.max(lastSend?.seq ?? 0, 1)),
        lte(revisions.seq, seq),
      ),
    )
    .groupBy(changedBlocks.blockId)
    .orderBy(changedBlocks.blockId)
    .all();
  return RevisionView.parse({
    seq,
    base: revision.base,
    head: revision.head,
    main: revision.main,
    writeupEmpty: revision.writeupEmpty,
    topics: topicRows.map(topicView),
    files: fileRows.map((file) => {
      const mark = file.role === "diff" ? marksByPath.get(file.path) : undefined;
      return {
        id: file.id,
        path: file.path,
        oldPath: file.oldPath,
        role: file.role,
        status: file.status,
        topic: file.topicSlug,
        order: file.ord,
        mediaType: file.mediaType,
        ...(file.role === "doc" && file.mediaType === "text/plain" ? { view: "source" } : {}),
        flag: file.flag,
        hasOld: file.oldBlob !== null,
        hasNew: file.newBlob !== null,
        ...(file.role === "diff" && file.additions !== null && file.deletions !== null
          ? { counts: { additions: file.additions, deletions: file.deletions } }
          : {}),
        ...(notesByFile.has(file.id) ? { notes: notesByFile.get(file.id) } : {}),
        ...(mark
          ? {
              viewed: (
                mark.flag !== null || file.flag !== null
                  ? mark.revisionSeq === seq
                  : mark.oldBlob === file.oldBlob && mark.newBlob === file.newBlob && mark.oldPath === file.oldPath
              )
                ? "viewed"
                : "stale",
              viewedOn: mark.revisionSeq,
            }
          : {}),
      };
    }),
    writeup: rendered,
    // The rendered blob carries the publish-level fields beside its sections; RenderedWriteup strips them.
    ...meta,
    docs,
    threads: threadRows.map(({ thread, createdOn, placement }) => ({
      id: thread.id,
      target: thread.target,
      state: thread.state,
      createdOn,
      comments: byThread.get(thread.id) ?? [],
      placement:
        placement?.status === "placed"
          ? { status: "placed", location: placement.location }
          : { status: "unplaced", reason: placement?.reason ?? "not-placed" },
    })),
    changedBlocks: changed,
  });
}

/** A direct read refuses a binned review unless it is a moved copy. */
async function refuseBinned(ownerId: string, q: Queries, reviewId: string) {
  const review = await q
    .select({ binnedAt: reviews.binnedAt, movedToUrl: reviews.movedToUrl })
    .from(reviews)
    .where(and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewId)))
    .get();
  if (review && review.binnedAt !== null && review.movedToUrl === null) throw new ApiError("review_in_bin");
}

export function reviewRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/reviews", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const file = await readFileSetting(deps.configFile);
    const list = await deps.db.read((q) => inbox(ownerId, q, deps, file));
    return c.json(InboxList.parse(list));
  });
  app.get("/api/v1/reviews/:id", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const reviewId = c.req.param("id");
    const file = await readFileSetting(deps.configFile);
    const view = await deps.db.read(async (q) => {
      await refuseBinned(ownerId, q, reviewId);
      const {
        items: [item],
      } = await inbox(ownerId, q, deps, file, reviewId);
      if (!item) throw new ApiError("unknown_review");
      const rows = await q
        .select({ seq: revisions.seq, createdAt: revisions.createdAt })
        .from(revisions)
        .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId)))
        .orderBy(revisions.seq)
        .all();
      return ReviewView.parse({
        ...item,
        revisions: rows.map((row) => ({ seq: row.seq, createdAt: new Date(row.createdAt).toISOString() })),
      });
    });
    return c.json(view);
  });
  app.get("/api/v1/reviews/:id/revisions/:seq", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const reviewId = c.req.param("id");
    const view = await deps.db.read(async (q) => {
      const review = await q
        .select({ id: reviews.id, binnedAt: reviews.binnedAt, movedToUrl: reviews.movedToUrl })
        .from(reviews)
        .where(and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewId)))
        .get();
      if (!review) throw new ApiError("unknown_review");
      if (review.binnedAt !== null && review.movedToUrl === null) throw new ApiError("review_in_bin");
      const seq = Number(c.req.param("seq"));
      if (!/^[1-9]\d*$/.test(c.req.param("seq")) || !Number.isSafeInteger(seq)) throw new ApiError("not_found");
      return revisionView(ownerId, q, deps, reviewId, seq);
    });
    return c.json(view);
  });
}
