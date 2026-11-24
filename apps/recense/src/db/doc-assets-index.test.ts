import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { mediaAsset } from "../server/media.ts";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { files, reviews, revisions } from "./schema.ts";

test.each(["media", "download"])(
  "the %s query probes doc_assets by owner and asset, then the doc by id",
  async (route) => {
    const dir = await mkdtemp(join(tmpdir(), "recense-doc-assets-index-"));
    const db = openDb(join(dir, "test.db"));
    try {
      await migrate(db);
      expect(
        await db.read((q) =>
          q.values(sql`SELECT origin FROM pragma_index_list('files') WHERE name = 'sqlite_autoindex_files_1'`),
        ),
      ).toEqual([["pk"]]);
      expect(
        await db.read((q) => q.values(sql`SELECT name FROM pragma_index_info('sqlite_autoindex_files_1')`)),
      ).toEqual([["id"]]);
      const ownerId = "synthetic-owner";
      const plan = await db.read((q) => {
        const query =
          route === "media"
            ? q
                .select({ mediaType: files.mediaType })
                .from(files)
                .innerJoin(revisions, and(eq(revisions.ownerId, ownerId), eq(revisions.id, files.revisionId)))
                .innerJoin(reviews, and(eq(reviews.ownerId, ownerId), eq(reviews.id, revisions.reviewId)))
                .where(
                  and(
                    eq(files.ownerId, ownerId),
                    or(isNull(reviews.binnedAt), isNotNull(reviews.movedToUrl)),
                    eq(files.newBlob, "a".repeat(64)),
                    mediaAsset(q, ownerId),
                  ),
                )
                .orderBy(files.mediaType)
                .limit(1)
            : q
                .select()
                .from(files)
                .where(
                  and(eq(files.ownerId, ownerId), eq(files.revisionId, "synthetic-revision"), mediaAsset(q, ownerId)),
                )
                .orderBy(files.mediaType);
        return q.values(sql`EXPLAIN QUERY PLAN ${query.getSQL()}`);
      });
      const probes = plan
        .map((row) => String(row[3]))
        .filter((line) => /^(SEARCH|SCAN) (doc_assets|media_doc) /.test(line));
      expect(probes).toEqual([
        "SEARCH doc_assets USING INDEX doc_assets_owner_asset_idx (owner_id=? AND asset_id=?)",
        "SEARCH media_doc USING INDEX sqlite_autoindex_files_1 (id=?)",
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
