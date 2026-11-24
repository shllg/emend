import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

test("attention migration preserves existing topics, referencing files, constraints and owner isolation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-attention-"));
  const db = openDb(join(dir, "test.db"));
  const owner = randomUUID(),
    instance = randomUUID(),
    review = randomUUID(),
    revision = randomUUID(),
    file = randomUUID();
  try {
    await db.transaction(async (q) => {
      await q.exec(
        "CREATE TABLE __recense_migrations (hash text primary key, tag text not null, applied_at integer not null)",
      );
      for (const migration of MIGRATIONS) {
        if (migration.tag.startsWith("0008_")) break;
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
      await q.run(
        sql`INSERT INTO topics (id, owner_id, revision_id, slug, title, importance, summary, door, blast_scope, blast_note) VALUES (${randomUUID()}, ${owner}, ${revision}, 'seed', 'Seed', 12, 'Growing', 'one-way', 'garden', 'Seed bed')`,
      );
      await q.run(
        sql`INSERT INTO files (id, owner_id, revision_id, path, role, topic_slug, ord, media_type) VALUES (${file}, ${owner}, ${revision}, 'src/a.ts', 'diff', 'seed', 0, 'text/plain')`,
      );
    });
    expect(await migrate(db)).toBe(MIGRATIONS.length - MIGRATIONS.findIndex((m) => m.tag.startsWith("0008_")));
    const rows = () =>
      db.read((q) =>
        q.values(
          sql`SELECT slug, title, importance, summary, attention, door, blast_scope, blast_note FROM topics WHERE owner_id = ${owner}`,
        ),
      );
    expect(await rows()).toEqual([["seed", "Seed", 12, "Growing", null, "one-way", "garden", "Seed bed"]]);
    expect(
      await db.read((q) =>
        q.values(
          sql`SELECT id, revision_id, path, role, topic_slug, ord, media_type FROM files WHERE owner_id = ${owner} AND id = ${file}`,
        ),
      ),
    ).toEqual([[file, revision, "src/a.ts", "diff", "seed", 0, "text/plain"]]);
    for (const attention of ["critical", "review", "skim", null]) {
      await db.query((q) => q.run(sql`UPDATE topics SET attention = ${attention} WHERE owner_id = ${owner}`));
      expect((await rows())[0]?.[4]).toBe(attention);
    }
    await expect(
      db.query((q) => q.run(sql`UPDATE topics SET attention = 'urgent' WHERE owner_id = ${owner}`)),
    ).rejects.toThrow();
    await expect(
      db.query((q) => q.run(sql`UPDATE topics SET door = 'three-way' WHERE owner_id = ${owner}`)),
    ).rejects.toThrow();
    await expect(
      db.query((q) => q.run(sql`UPDATE topics SET owner_id = ${randomUUID()} WHERE owner_id = ${owner}`)),
    ).rejects.toThrow();
    expect(await db.read((q) => q.values(sql`PRAGMA foreign_key_check`))).toEqual([]);
    expect(await migrate(db)).toBe(0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
