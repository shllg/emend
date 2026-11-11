import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

test("the project migration leaves legacy projects null and preserves repository links and names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-project-migration-"));
  const db = openDb(join(dir, "test.db"));
  const owner = randomUUID(),
    instance = randomUUID(),
    repo = randomUUID(),
    review = randomUUID();
  try {
    await db.transaction(async (q) => {
      await q.exec(
        "CREATE TABLE __emend_migrations (hash text primary key, tag text not null, applied_at integer not null)",
      );
      for (const migration of MIGRATIONS.filter((m) => m.tag < "0014")) {
        for (const statement of migration.statements) await q.exec(statement);
        await q.run(sql`INSERT INTO __emend_migrations VALUES (${migration.hash}, ${migration.tag}, 0)`);
      }
      await q.run(sql`INSERT INTO owners (id) VALUES (${owner})`);
      await q.run(sql`INSERT INTO instances (id, name) VALUES (${instance}, 'Synthetic')`);
      await q.run(sql`INSERT INTO repos (id, owner_id, key, name) VALUES (${repo}, ${owner}, 'synthetic', 'Legacy')`);
      await q.run(sql`INSERT INTO reviews (id, owner_id, origin_instance_id, review_key, repo_id, title, created_at, updated_at)
        VALUES (${review}, ${owner}, ${instance}, 'synthetic', ${repo}, 'Synthetic', 5, 6)`);
    });
    expect(await migrate(db)).toBe(MIGRATIONS.filter((m) => m.tag >= "0014").length);
    expect(await migrate(db)).toBe(0);
    expect(
      await db.read((q) =>
        q.values(sql`SELECT repo_id, project, title, created_at, updated_at FROM reviews
      WHERE owner_id = ${owner} AND id = ${review}`),
      ),
    ).toEqual([[repo, null, "Synthetic", 5, 6]]);
    expect(
      await db.read((q) => q.values(sql`SELECT name FROM repos WHERE owner_id = ${owner} AND id = ${repo}`)),
    ).toEqual([["Legacy"]]);
    expect(await db.read((q) => q.values(sql`PRAGMA foreign_key_check`))).toEqual([]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
