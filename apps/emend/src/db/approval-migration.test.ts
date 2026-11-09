import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

test("the approval migration preserves existing approval records without backfilling a time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-approved-at-"));
  const db = openDb(join(dir, "test.db"));
  const owner = randomUUID(),
    instance = randomUUID(),
    review = randomUUID(),
    revision = randomUUID();
  try {
    await db.transaction(async (q) => {
      await q.exec(
        "CREATE TABLE __emend_migrations (hash text primary key, tag text not null, applied_at integer not null)",
      );
      for (const migration of MIGRATIONS.filter((m) => m.tag < "0013")) {
        for (const statement of migration.statements) await q.exec(statement);
        await q.run(sql`INSERT INTO __emend_migrations VALUES (${migration.hash}, ${migration.tag}, 0)`);
      }
      await q.run(sql`INSERT INTO owners (id) VALUES (${owner})`);
      await q.run(sql`INSERT INTO instances (id, name) VALUES (${instance}, 'Synthetic')`);
      await q.run(sql`INSERT INTO reviews (id, owner_id, origin_instance_id, review_key, title, state, created_at, updated_at)
        VALUES (${review}, ${owner}, ${instance}, 'synthetic', 'Synthetic', 'approved', 5, 6)`);
      await q.run(sql`INSERT INTO revisions (id, owner_id, review_id, seq, content_key, created_at)
        VALUES (${revision}, ${owner}, ${review}, 1, 'synthetic', 5)`);
      await q.run(sql`UPDATE reviews SET approved_revision = ${revision} WHERE owner_id = ${owner} AND id = ${review}`);
    });
    expect(await migrate(db)).toBe(1);
    expect(await migrate(db)).toBe(0);
    expect(
      await db.read((q) =>
        q.values(sql`SELECT title, state, approved_revision, approved_at, created_at, updated_at
      FROM reviews WHERE owner_id = ${owner} AND id = ${review}`),
      ),
    ).toEqual([["Synthetic", "approved", revision, null, 5, 6]]);
    expect(await db.read((q) => q.values(sql`PRAGMA foreign_key_check`))).toEqual([]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
