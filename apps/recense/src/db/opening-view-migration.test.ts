import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";
import { getRevision } from "./repo/reviews.ts";

test("opening view migration preserves an existing revision's writeup default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-opening-"));
  const db = openDb(join(dir, "test.db"));
  const owner = randomUUID(),
    instance = randomUUID(),
    review = randomUUID(),
    revision = randomUUID();
  try {
    await db.transaction(async (q) => {
      await q.exec(
        "CREATE TABLE __recense_migrations (hash text primary key, tag text not null, applied_at integer not null)",
      );
      for (const migration of MIGRATIONS) {
        if (migration.statements.some((s) => s.includes("writeup_empty"))) break;
        for (const statement of migration.statements) await q.exec(statement);
        await q.run(sql`INSERT INTO __recense_migrations VALUES (${migration.hash}, ${migration.tag}, 0)`);
      }
      await q.run(sql`INSERT INTO owners (id) VALUES (${owner})`);
      await q.run(sql`INSERT INTO instances (id, name) VALUES (${instance}, 'Synthetic')`);
      await q.run(
        sql`INSERT INTO reviews (id, owner_id, origin_instance_id, review_key, title, created_at, updated_at) VALUES (${review}, ${owner}, ${instance}, 'synthetic', 'Synthetic', 0, 0)`,
      );
      await q.run(
        sql`INSERT INTO revisions (id, owner_id, review_id, seq, content_key, created_at) VALUES (${revision}, ${owner}, ${review}, 1, 'synthetic', 0)`,
      );
    });
    const firstPending = MIGRATIONS.findIndex((migration) =>
      migration.statements.some((s) => s.includes("writeup_empty")),
    );
    expect(await migrate(db)).toBe(MIGRATIONS.length - firstPending);
    expect(await getRevision(owner, db, review, 1)).toMatchObject({ id: revision, main: null, writeupEmpty: false });
    expect(await db.read((q) => q.values(sql`PRAGMA foreign_key_check`))).toEqual([]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
