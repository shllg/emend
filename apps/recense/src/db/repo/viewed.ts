import type { ViewedRequest } from "@recense/contract";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ApiError } from "../../server/http/errors.ts";
import type { Db } from "../client.ts";
import { files, revisions, viewedFiles } from "../schema.ts";
import { requireReview } from "./thread-access.ts";

export function setViewed(ownerId: string, db: Db, reviewId: string, request: ViewedRequest, now: number) {
  return db.transaction(
    async (q) => {
      await requireReview(ownerId, q, reviewId);
      const revision = await q
        .select({ id: revisions.id })
        .from(revisions)
        .where(
          and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), eq(revisions.seq, request.revision)),
        )
        .get();
      if (!revision) throw new ApiError("not_found");
      const rows = await q
        .select({ path: files.path, oldBlob: files.oldBlob, newBlob: files.newBlob })
        .from(files)
        .where(and(eq(files.ownerId, ownerId), eq(files.revisionId, revision.id), eq(files.role, "diff")));
      const byPath = new Map(rows.map((file) => [file.path, file]));
      const paths = [...new Set(request.paths)];
      const selected = paths.map((path) => {
        const file = byPath.get(path);
        if (!file) throw new ApiError("invalid_request");
        return { ...file, ownerId, reviewId, revisionSeq: request.revision, createdAt: now };
      });
      // Bound statement parameters even for a whole topic at the revision file limit.
      for (let start = 0; start < paths.length; start += 500) {
        if (request.viewed) {
          await q
            .insert(viewedFiles)
            .values(selected.slice(start, start + 500))
            .onConflictDoUpdate({
              target: [viewedFiles.ownerId, viewedFiles.reviewId, viewedFiles.path],
              set: {
                revisionSeq: sql`excluded.revision_seq`,
                oldBlob: sql`excluded.old_blob`,
                newBlob: sql`excluded.new_blob`,
                createdAt: sql`excluded.created_at`,
              },
              setWhere: and(eq(viewedFiles.ownerId, ownerId), eq(viewedFiles.reviewId, reviewId)),
            });
        } else {
          await q
            .delete(viewedFiles)
            .where(
              and(
                eq(viewedFiles.ownerId, ownerId),
                eq(viewedFiles.reviewId, reviewId),
                inArray(viewedFiles.path, paths.slice(start, start + 500)),
              ),
            );
        }
      }
    },
    { offThread: true },
  );
}
