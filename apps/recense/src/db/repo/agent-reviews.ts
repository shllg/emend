import { createHash } from "node:crypto";
import { type AgentReviewDiff, AgentReviewList, type AgentReviewQuery, LIMITS } from "@recense/contract";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Principal } from "../../server/auth/principal.ts";
import { yieldToLoop } from "../../server/pacing.ts";
import type { Db } from "../client.ts";
import { deliveries, diffImages, files, reviews, revisions, sends } from "../schema.ts";

type DiffRow = Pick<typeof files.$inferSelect, "path" | "oldPath" | "status" | "oldBlob" | "newBlob" | "flag"> & {
  oldImageBlob: string | null;
  newImageBlob: string | null;
  oldImageFlag: typeof diffImages.$inferSelect.flag;
  newImageFlag: typeof diffImages.$inferSelect.flag;
};

export async function revisionDiff(rows: readonly DiffRow[]): Promise<AgentReviewDiff> {
  const lines: Buffer[] = [];
  let processed = 0;
  for (const row of rows) {
    const old = row.oldImageBlob ?? row.oldImageFlag ?? row.oldBlob ?? (row.status !== "added" ? row.flag : null);
    const next = row.newImageBlob ?? row.newImageFlag ?? row.newBlob ?? (row.status !== "deleted" ? row.flag : null);
    // Keeping each side at its own path makes a rename equivalent to a deletion and an addition.
    if (old !== null) lines.push(Buffer.from(`${row.oldPath ?? row.path}\told\t${old}\n`));
    if (next !== null) lines.push(Buffer.from(`${row.path}\tnew\t${next}\n`));
    if (++processed % 500 === 0) await yieldToLoop("agent-review-diff");
  }
  const hash = createHash("sha256");
  let hashed = 0;
  for (const line of lines.sort(Buffer.compare)) {
    hash.update(line);
    if (++hashed % 500 === 0) await yieldToLoop("agent-review-diff");
  }
  return { files: rows.length, digest: hash.digest("hex") };
}

async function readRevisionDiff(db: Db, ownerId: string, revisionId: string): Promise<AgentReviewDiff | null> {
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
  // A missing revision has no rows. A revision without diff files has one null file from the join.
  return rows.length ? revisionDiff(rows.filter((row): row is DiffRow => row.path !== null)) : null;
}

/**
 * Lists the owner's reviews published from the token's instance, newest first. A token without
 * an instance sees an empty list. The optional exact head (newest or approved) and key filters
 * apply before the row limit. Each listed revision carries its number, head and code diff summary.
 * A Send on the newest open revision passes the turn to the agent unless set aside. An answer
 * waits until set aside or confirmed, except for an unclaimed approval take will set aside as
 * stale. The list reads no comment, writeup or doc content and writes nothing.
 */
export async function listAgentReviews(
  db: Db,
  principal: Principal,
  baseUrl: string,
  query: AgentReviewQuery = {},
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
        updatedAt: reviews.updatedAt,
        newestId: newest.id,
        newestSeq: newest.seq,
        newestHead: newest.head,
        newestSent: sql<boolean>`exists (select 1 from ${sends} s where s.owner_id = ${reviews.ownerId} and s.review_id = ${reviews.id} and s.revision_id = ${newest.id} and s.set_aside_at is null)`,
        answerWaiting: sql<number>`exists (
          select 1 from ${sends} s
          left join ${deliveries} d on d.owner_id = s.owner_id and d.review_id = s.review_id and d.id = s.delivery_id
          where s.owner_id = ${reviews.ownerId} and s.review_id = ${reviews.id}
            and s.kind in ('go', 'approve') and s.set_aside_at is null
            and (s.kind = 'go' or s.delivery_id is not null or s.revision_id = ${newest.id})
            and (s.delivery_id is null or d.confirmed_at is null)
        )`,
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
  for (const id of new Set(rows.flatMap((row) => [row.newestId, row.approvedId]))) {
    if (id === null) continue;
    if (diffs.size) await yieldToLoop("agent-review-diff");
    diffs.set(id, await readRevisionDiff(db, principal.ownerId, id));
  }
  return AgentReviewList.parse({
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      branch: row.branch,
      state: row.state,
      turn: row.state !== "open" || row.newestId === null ? null : row.newestSent ? "agent" : "reviewer",
      answerWaiting: Boolean(row.answerWaiting),
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
