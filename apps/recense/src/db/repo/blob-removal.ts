import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";

/**
 * Remove an owner's blob row once no row of that owner references it. The reference check and the
 * delete are one statement in one write transaction, so a row that gained a reference cannot lose its
 * blob. The caller holds the sha's lock and then calls BlobStore.unlinkIfUnheld, which checks every owner.
 */
export function removeUnreferencedBlob(db: Db, ownerId: string, sha: string) {
  return db.transaction(
    async (q) => {
      if (!/^[0-9a-f]{64}$/.test(sha)) return { removed: false };
      const removed = await q.values<[string]>(sql`DELETE FROM blobs
        WHERE owner_id = ${ownerId} AND sha256 = ${sha}
          AND NOT EXISTS (SELECT 1 FROM files WHERE owner_id = ${ownerId}
            AND (old_blob = ${sha} OR new_blob = ${sha} OR rendered_blob = ${sha}))
          AND NOT EXISTS (SELECT 1 FROM writeups WHERE owner_id = ${ownerId}
            AND (source_blob = ${sha} OR rendered_blob = ${sha}))
          AND NOT EXISTS (SELECT 1 FROM viewed_files WHERE owner_id = ${ownerId}
            AND (old_blob = ${sha} OR new_blob = ${sha}))
        RETURNING sha256`);
      return { removed: removed.length > 0 };
    },
    { offThread: true },
  );
}
