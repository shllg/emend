import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

const tag = "0011_";

test("the lifecycle migration adds columns, an index and the tombstone table without touching rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-lifecycle-"));
  const db = openDb(join(dir, "test.db"));
  const owner = randomUUID(),
    instance = randomUUID(),
    review = randomUUID();
  try {
    await db.transaction(async (q) => {
      await q.exec(
        "CREATE TABLE __recense_migrations (hash text primary key, tag text not null, applied_at integer not null)",
      );
      for (const migration of MIGRATIONS) {
        if (migration.tag.startsWith(tag)) break;
        for (const statement of migration.statements) await q.exec(statement);
        await q.run(sql`INSERT INTO __recense_migrations VALUES (${migration.hash}, ${migration.tag}, 0)`);
      }
      await q.run(sql`INSERT INTO owners (id) VALUES (${owner})`);
      await q.run(sql`INSERT INTO instances (id, name) VALUES (${instance}, 'Synthetic')`);
      await q.run(
        sql`INSERT INTO reviews (id, owner_id, origin_instance_id, review_key, title, state, created_at, updated_at) VALUES (${review}, ${owner}, ${instance}, 'synthetic', 'Synthetic', 'settled', 5, 6)`,
      );
    });
    expect(MIGRATIONS.some((m) => m.tag.startsWith(tag))).toBe(true);
    expect(await migrate(db)).toBe(MIGRATIONS.length - MIGRATIONS.findIndex((m) => m.tag.startsWith(tag)));
    expect(
      await db.read((q) =>
        q.values(
          sql`SELECT title, state, created_at, updated_at, snoozed_at, snoozed_until, released_at, released_reason FROM reviews WHERE id = ${review}`,
        ),
      ),
    ).toEqual([["Synthetic", "settled", 5, 6, null, null, null, null]]);
    await db.query((q) =>
      q.run(sql`UPDATE reviews SET released_at = 9, released_reason = 'snoozed' WHERE id = ${review}`),
    );
    await expect(
      db.query((q) => q.run(sql`UPDATE reviews SET released_reason = 'deleted' WHERE id = ${review}`)),
    ).rejects.toThrow();
    // The state check keeps its values: retired is stored as settled.
    await expect(
      db.query((q) => q.run(sql`UPDATE reviews SET state = 'retired' WHERE id = ${review}`)),
    ).rejects.toThrow();
    expect(
      await db.read((q) =>
        q.values(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'reviews_owner_state_updated_idx'`),
      ),
    ).toHaveLength(1);
    // The delete's reference check and the blob lookups use these indexes.
    expect(
      await db.read((q) =>
        q.values<[string]>(
          sql`SELECT name FROM sqlite_master WHERE type = 'index' AND (name = 'blobs_sha256_idx' OR name LIKE '%_blob_idx') ORDER BY name`,
        ),
      ),
    ).toEqual(
      [
        "blobs_sha256_idx",
        "diff_images_owner_blob_idx",
        "files_owner_new_blob_idx",
        "files_owner_old_blob_idx",
        "files_owner_rendered_blob_idx",
        "viewed_files_owner_new_blob_idx",
        "viewed_files_owner_old_blob_idx",
        "writeups_owner_rendered_blob_idx",
        "writeups_owner_source_blob_idx",
      ].map((name) => [name]),
    );
    await db.query((q) =>
      q.run(sql`INSERT INTO review_tombstones (owner_id, review_id, deleted_at) VALUES (${owner}, ${review}, 7)`),
    );
    await expect(
      db.query((q) =>
        q.run(sql`INSERT INTO review_tombstones (owner_id, review_id, deleted_at) VALUES (${owner}, ${review}, 8)`),
      ),
    ).rejects.toThrow();
    await expect(
      db.query((q) =>
        q.run(
          sql`INSERT INTO review_tombstones (owner_id, review_id, deleted_at) VALUES (${randomUUID()}, ${randomUUID()}, 8)`,
        ),
      ),
    ).rejects.toThrow();
    expect(await db.read((q) => q.values(sql`PRAGMA foreign_key_check`))).toEqual([]);
    expect(await migrate(db)).toBe(0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
