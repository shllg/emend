import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

test("intent review migration preserves reviews and adds a nullable text column with an owner index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-intent-review-"));
  const db = openDb(join(dir, "test.db"));
  const owner = randomUUID(),
    instance = randomUUID(),
    review = randomUUID();
  try {
    await db.transaction(async (q) => {
      await q.exec(
        "CREATE TABLE __recense_migrations (hash text primary key, tag text not null, applied_at integer not null)",
      );
      for (const migration of MIGRATIONS.filter((m) => m.tag < "0027")) {
        for (const statement of migration.statements) await q.exec(statement);
        await q.run(sql`INSERT INTO __recense_migrations VALUES (${migration.hash}, ${migration.tag}, 0)`);
      }
      await q.run(sql`INSERT INTO owners (id) VALUES (${owner})`);
      await q.run(sql`INSERT INTO instances (id, name) VALUES (${instance}, 'Synthetic')`);
      await q.run(
        sql`INSERT INTO reviews (id, owner_id, origin_instance_id, review_key, title, created_at, updated_at) VALUES (${review}, ${owner}, ${instance}, ${review}, 'Synthetic', 5, 6)`,
      );
    });
    expect(await migrate(db)).toBe(MIGRATIONS.filter((m) => m.tag >= "0027").length);
    expect(await migrate(db)).toBe(0);
    expect(
      await db.read((q) =>
        q.values(
          sql`SELECT id, title, created_at, updated_at, intent_review_id FROM reviews WHERE owner_id = ${owner}`,
        ),
      ),
    ).toEqual([[review, "Synthetic", 5, 6, null]]);
    const columns = await db.read((q) => q.values(sql`PRAGMA table_info(reviews)`));
    expect(columns.find(([, name]) => name === "intent_review_id")?.slice(1)).toEqual([
      "intent_review_id",
      "TEXT",
      0,
      null,
      0,
    ]);
    const indexes = await db.read((q) => q.values(sql`PRAGMA index_list(reviews)`));
    expect(indexes.some(([, name]) => name === "reviews_owner_intent_idx")).toBe(true);
    const indexColumns = await db.read((q) => q.values(sql`PRAGMA index_info(reviews_owner_intent_idx)`));
    expect(indexColumns.map(([, , name]) => name)).toEqual(["owner_id", "intent_review_id"]);
    // No foreign key: an intent review may arrive after the code review during attach.
    await db.query((q) =>
      q.run(sql`UPDATE reviews SET intent_review_id = ${randomUUID()} WHERE owner_id = ${owner} AND id = ${review}`),
    );
    expect(await db.read((q) => q.values(sql`PRAGMA foreign_key_check`))).toEqual([]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
