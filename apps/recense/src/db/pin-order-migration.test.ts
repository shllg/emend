import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

test("pin order migration keeps existing pins at zero and adds a non-null column with default zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-pin-order-"));
  const db = openDb(join(dir, "test.db"));
  const owner = randomUUID(),
    instance = randomUUID(),
    review = randomUUID(),
    next = randomUUID();
  try {
    await db.transaction(async (q) => {
      await q.exec(
        "CREATE TABLE __recense_migrations (hash text primary key, tag text not null, applied_at integer not null)",
      );
      for (const migration of MIGRATIONS.filter((m) => m.tag < "0026")) {
        for (const statement of migration.statements) await q.exec(statement);
        await q.run(sql`INSERT INTO __recense_migrations VALUES (${migration.hash}, ${migration.tag}, 0)`);
      }
      await q.run(sql`INSERT INTO owners (id) VALUES (${owner})`);
      await q.run(sql`INSERT INTO instances (id, name) VALUES (${instance}, 'Synthetic')`);
      for (const id of [review, next])
        await q.run(
          sql`INSERT INTO reviews (id, owner_id, origin_instance_id, review_key, title, created_at, updated_at) VALUES (${id}, ${owner}, ${instance}, ${id}, 'Synthetic', 5, 6)`,
        );
      await q.run(sql`INSERT INTO review_pins (owner_id, review_id, created_at) VALUES (${owner}, ${review}, 7)`);
    });

    expect(await migrate(db)).toBe(MIGRATIONS.filter((m) => m.tag >= "0026").length);
    expect(await migrate(db)).toBe(0);
    expect(
      await db.read((q) =>
        q.values(sql`SELECT review_id, created_at, position FROM review_pins WHERE owner_id = ${owner}`),
      ),
    ).toEqual([[review, 7, 0]]);
    const columns = await db.read((q) => q.values(sql`PRAGMA table_info(review_pins)`));
    expect(columns.find(([, name]) => name === "position")).toEqual([3, "position", "INTEGER", 1, "0", 0]);
    await db.query((q) =>
      q.run(sql`INSERT INTO review_pins (owner_id, review_id, created_at) VALUES (${owner}, ${next}, 8)`),
    );
    expect(
      await db.read((q) =>
        q.values(sql`SELECT position FROM review_pins WHERE owner_id = ${owner} AND review_id = ${next}`),
      ),
    ).toEqual([[0]]);
    await expect(
      db.query((q) =>
        q.run(sql`UPDATE review_pins SET position = NULL WHERE owner_id = ${owner} AND review_id = ${review}`),
      ),
    ).rejects.toThrow();
    expect(await db.read((q) => q.values(sql`PRAGMA foreign_key_check`))).toEqual([]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
