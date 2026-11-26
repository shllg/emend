import { createHash } from "node:crypto";
import { type AgentReviewDiff, AgentReviewList, type AgentReviewQuery, diffImageType, LIMITS } from "@recense/contract";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Principal } from "../../server/auth/principal.ts";
import { yieldToLoop } from "../../server/pacing.ts";
import type { Db } from "../client.ts";
import { deliveries, diffImages, files, reviews, revisions, sends } from "../schema.ts";

type DiffRow = Pick<typeof files.$inferSelect, "oldPath" | "status" | "oldBlob" | "newBlob" | "flag"> & {
  path: string | null;
  oldImageBlob: string | null;
  newImageBlob: string | null;
  oldImageFlag: typeof diffImages.$inferSelect.flag;
  newImageFlag: typeof diffImages.$inferSelect.flag;
};

const LINE_END = Buffer.from("\n");

function sideValue(row: DiffRow, side: "old" | "new", sidePath: string) {
  const old = side === "old";
  const inStatus = row.status !== (old ? "added" : "deleted");
  const text = old ? row.oldBlob : row.newBlob;
  const image = old ? row.oldImageBlob : row.newImageBlob;
  const imageFlag = old ? row.oldImageFlag : row.newImageFlag;
  if (!inStatus) return text !== null || image !== null || imageFlag !== null ? "unexpected" : null;
  if (imageFlag !== null) return imageFlag;
  if (image === null) return text ?? row.flag;
  if (text !== null && text !== image) return "unexpected";
  if (text === null && diffImageType(sidePath) === "image/svg+xml") return row.flag ?? "unexpected";
  return image;
}

export async function revisionDiff(rows: readonly DiffRow[], signal?: AbortSignal): Promise<AgentReviewDiff | null> {
  if (signal?.aborted) return null;
  const lines: Buffer[] = [];
  let processed = 0;
  for (const row of rows) {
    // The left join produces a single null path for a revision without diff files.
    if (row.path === null) continue;
    for (const side of ["old", "new"] as const) {
      const sidePath = side === "old" ? (row.oldPath ?? row.path) : row.path;
      const value = sideValue(row, side, sidePath);
      if (value !== null) lines.push(Buffer.concat([Buffer.from(`${sidePath}\t${side}\t${value}`), LINE_END]));
    }
    if (++processed % 500 === 0) {
      await yieldToLoop("agent-review-diff");
      if (signal?.aborted) return null;
    }
  }
  const hash = createHash("sha256");
  let hashed = 0;
  for (const line of lines.sort(Buffer.compare)) {
    hash.update(line);
    if (++hashed % 500 === 0) {
      await yieldToLoop("agent-review-diff");
      if (signal?.aborted) return null;
    }
  }
  return { files: processed, digest: hash.digest("hex") };
}

async function readRevisionDiff(
  db: Db,
  ownerId: string,
  revisionId: string,
  signal?: AbortSignal,
): Promise<AgentReviewDiff | null> {
  const oldImage = alias(diffImages, "old_image");
  const newImage = alias(diffImages, "new_image");
  const rows = await db.read((q) =>
    q
      .select({
        path: files.path,
        oldPath: files.oldPath,
        status: files.status,
        oldBlob: files.oldBlob,
        newBlob: files.newBlob,
        flag: files.flag,
        oldImageBlob: oldImage.blob,
        oldImageFlag: oldImage.flag,
        newImageBlob: newImage.blob,
        newImageFlag: newImage.flag,
      })
      .from(revisions)
      .leftJoin(
        files,
        and(eq(files.ownerId, revisions.ownerId), eq(files.revisionId, revisions.id), eq(files.role, "diff")),
      )
      .leftJoin(
        oldImage,
        and(eq(oldImage.ownerId, files.ownerId), eq(oldImage.fileId, files.id), eq(oldImage.side, "old")),
      )
      .leftJoin(
        newImage,
        and(eq(newImage.ownerId, files.ownerId), eq(newImage.fileId, files.id), eq(newImage.side, "new")),
      )
      .where(and(eq(revisions.ownerId, ownerId), eq(revisions.id, revisionId)))
      .all(),
  );
  return rows.length ? revisionDiff(rows, signal) : null;
}

/**
 * Lists the owner's reviews published from the token's instance, newest first. A token without
 * an instance sees an empty list. The optional exact head (newest or approved) and key filters
 * apply before the row limit. Each listed revision carries its number, head and code diff summary.
 * A Send on the newest open revision passes the turn to the agent unless set aside. An answer
 * waits until set aside or confirmed. An older approval counts only during a live delivery lease.
 * The list reads no comment, writeup or doc content and writes nothing.
 */
export async function listAgentReviews(
  db: Db,
  principal: Principal,
  baseUrl: string,
  query: AgentReviewQuery = {},
  { now = Date.now(), signal }: { now?: number; signal?: AbortSignal } = {},
): Promise<AgentReviewList> {
  if (principal.instanceId === null) return { items: [] };
  const instanceId = principal.instanceId;
  const newest = alias(revisions, "newest");
  const approved = alias(revisions, "approved");
  const rows = await db.read((q) =>
    q
      .select({
        id: reviews.id,
        title: reviews.title,
        branch: reviews.branch,
        state: reviews.state,
        movedToUrl: reviews.movedToUrl,
        updatedAt: reviews.updatedAt,
        newestId: newest.id,
        newestSeq: newest.seq,
        newestHead: newest.head,
        newestSent: sql<boolean>`exists (select 1 from ${sends} s where s.owner_id = ${reviews.ownerId} and s.review_id = ${reviews.id} and s.revision_id = ${newest.id} and s.set_aside_at is null)`,
        answerWaiting: sql<number>`exists (select 1 from ${sends} s left join ${deliveries} d on d.owner_id = s.owner_id and d.review_id = s.review_id and d.id = s.delivery_id where s.owner_id = ${reviews.ownerId} and s.review_id = ${reviews.id} and s.kind in ('go', 'approve') and s.set_aside_at is null and d.confirmed_at is null and (s.kind = 'go' or s.revision_id = ${newest.id} or d.lease_until >= ${now}))`,
        approvedId: approved.id,
        approvedSeq: approved.seq,
        approvedHead: approved.head,
      })
      .from(reviews)
      .leftJoin(
        newest,
        and(
          eq(newest.ownerId, reviews.ownerId),
          eq(newest.reviewId, reviews.id),
          eq(
            newest.seq,
            sql`(select max(r.seq) from ${revisions} r where r.owner_id = ${reviews.ownerId} and r.review_id = ${reviews.id})`,
          ),
        ),
      )
      .leftJoin(
        approved,
        and(
          eq(approved.ownerId, reviews.ownerId),
          eq(approved.reviewId, reviews.id),
          eq(approved.id, reviews.approvedRevision),
        ),
      )
      .where(
        and(
          eq(reviews.ownerId, principal.ownerId),
          eq(reviews.originInstanceId, instanceId),
          isNull(reviews.binnedAt),
          query.key === undefined ? undefined : eq(reviews.reviewKey, query.key),
          query.head === undefined ? undefined : or(eq(approved.head, query.head), eq(newest.head, query.head)),
        ),
      )
      .orderBy(desc(reviews.updatedAt), asc(reviews.id))
      .limit(LIMITS.agentReviews)
      .all(),
  );
  const diffs = new Map<string, AgentReviewDiff | null>();
  if (query.diff !== "0") {
    const revisionIds = rows.flatMap((row) => (row.movedToUrl === null ? [row.newestId, row.approvedId] : []));
    for (const id of new Set(revisionIds)) {
      if (id === null) continue;
      if (diffs.size) await yieldToLoop("agent-review-diff");
      if (signal?.aborted) break;
      const diff = await readRevisionDiff(db, principal.ownerId, id, signal);
      if (signal?.aborted) break;
      diffs.set(id, diff);
    }
  }
  return AgentReviewList.parse({
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      branch: row.branch,
      state: row.state,
      turn: row.state !== "open" || row.newestId === null ? null : row.newestSent ? "agent" : "reviewer",
      answerWaiting: row.movedToUrl === null ? Boolean(row.answerWaiting) : null,
      newest:
        row.newestId === null ? null : { revision: row.newestSeq, head: row.newestHead, diff: diffs.get(row.newestId) },
      approved:
        row.approvedId === null
          ? null
          : { revision: row.approvedSeq, head: row.approvedHead, diff: diffs.get(row.approvedId) },
      updatedAt: new Date(row.updatedAt).toISOString(),
      url: `${baseUrl}/r/${row.id}`,
    })),
  });
}
