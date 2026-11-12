import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

const tag = "0016_";

test("the bin migration adds binned_at and leaves an existing review unbinned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-bin-"));
  const db = openDb(join(dir, "test.db"));
  const owner = randomUUID(),
    instance = randomUUID(),
    review = randomUUID();
  try {
    await db.transaction(async (q) => {
      await q.exec(
        "CREATE TABLE __emend_migrations (hash text primary key, tag text not null, applied_at integer not null)",
      );
      for (const migration of MIGRATIONS) {
        if (migration.tag.startsWith(tag)) break;
        for (const statement of migration.statements) await q.exec(statement);
        await q.run(sql`INSERT INTO __emend_migrations VALUES (${migration.hash}, ${migration.tag}, 0)`);
      }
      await q.run(sql`INSERT INTO owners (id) VALUES (${owner})`);
      await q.run(sql`INSERT INTO instances (id, name) VALUES (${instance}, 'Synthetic')`);
      await q.run(
        sql`INSERT INTO reviews (id, owner_id, origin_instance_id, review_key, title, state, created_at, updated_at) VALUES (${review}, ${owner}, ${instance}, 'synthetic', 'Synthetic', 'open', 5, 6)`,
      );
    });
    expect(MIGRATIONS.some((m) => m.tag.startsWith(tag))).toBe(true);
    expect(await migrate(db)).toBe(MIGRATIONS.length - MIGRATIONS.findIndex((m) => m.tag.startsWith(tag)));
    expect(
      await db.read((q) =>
        q.values(sql`SELECT title, state, created_at, updated_at, binned_at FROM reviews WHERE id = ${review}`),
      ),
    ).toEqual([["Synthetic", "open", 5, 6, null]]);
    await db.query((q) => q.run(sql`UPDATE reviews SET binned_at = 9 WHERE id = ${review}`));
    expect(await db.read((q) => q.values(sql`SELECT binned_at FROM reviews WHERE id = ${review}`))).toEqual([[9]]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
