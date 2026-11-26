import { createHash } from "node:crypto";
import { type AgentReviewDiff, AgentReviewList, type AgentReviewQuery, LIMITS } from "@recense/contract";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Principal } from "../../server/auth/principal.ts";
import type { Db, Queries } from "../client.ts";
import { deliveries, files, reviews, revisions, sends } from "../schema.ts";

type DiffRow = Pick<typeof files.$inferSelect, "path" | "oldPath" | "status" | "oldBlob" | "newBlob" | "flag">;

export function revisionDiff(rows: readonly DiffRow[]): AgentReviewDiff {
  const lines: Buffer[] = [];
  for (const { path, oldPath, status, oldBlob, newBlob, flag } of rows) {
    // A rename's two paths give the same lines as git diff-tree -r --no-renames and SHA-256 of each blob's bytes.
    if (status !== "added") lines.push(Buffer.from(`${oldPath ?? path}\told\t${oldBlob ?? flag ?? "missing"}\n`));
    if (status !== "deleted") lines.push(Buffer.from(`${path}\tnew\t${newBlob ?? flag ?? "missing"}\n`));
  }
  const hash = createHash("sha256");
  for (const line of lines.sort(Buffer.compare)) hash.update(line);
  return { files: rows.length, digest: hash.digest("hex") };
}

async function readRevisionDiff(q: Queries, ownerId: string, revisionId: string): Promise<AgentReviewDiff | null> {
  const rows = await q
    .select({
      file: {
        path: files.path,
        oldPath: files.oldPath,
        status: files.status,
        oldBlob: files.oldBlob,
        newBlob: files.newBlob,
        flag: files.flag,
      },
    })
    .from(revisions)
    .leftJoin(
      files,
      and(eq(files.ownerId, revisions.ownerId), eq(files.revisionId, revisions.id), eq(files.role, "diff")),
    )
    .where(and(eq(revisions.ownerId, ownerId), eq(revisions.id, revisionId)))
    .all();
  // A missing revision has no rows. A revision without diff files has one null file from the join.
  return rows.length ? revisionDiff(rows.flatMap(({ file }) => (file ? [file] : []))) : null;
}

/**
 * Lists the owner's reviews published from the token's instance, newest first. A token without
 * an instance sees an empty list. The optional exact head (newest or approved) and key filters
 * apply before the row limit. Each listed revision carries its number, head and code diff summary.
 * A Send on the newest open revision passes the turn to the agent unless set aside. A Send on
 * any revision that is neither set aside nor confirmed makes an answer wait. The list reads no
 * comment, writeup or doc content and writes nothing.
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
  await db.read(async (q) => {
    for (const id of new Set(rows.flatMap((row) => [row.newestId, row.approvedId]))) {
      if (id !== null) diffs.set(id, await readRevisionDiff(q, principal.ownerId, id));
    }
  });
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
