import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

test.each([false, true])("settings migration preserves existing data (previous=%s)", async (previous) => {
  const dir = await mkdtemp(join(tmpdir(), "emend-settings-"));
  const db = openDb(join(dir, "test.db"));
  const owner = randomUUID(),
    other = randomUUID();
  try {
    if (previous)
      await db.transaction(async (q) => {
        await q.exec(
          "CREATE TABLE __emend_migrations (hash text primary key, tag text not null, applied_at integer not null)",
        );
        for (const migration of MIGRATIONS.filter((m) => m.tag < "0015")) {
          for (const statement of migration.statements) await q.exec(statement);
          await q.run(sql`INSERT INTO __emend_migrations VALUES (${migration.hash}, ${migration.tag}, 0)`);
        }
        await q.run(sql`INSERT INTO owners VALUES (${owner}), (${other})`);
      });
    // Later migrations may alter the reviews table (the bin adds a column), so it stays out of the comparison.
    const snapshot = () =>
      db.read((q) =>
        q.values(
          sql`SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'settings%' AND name <> 'reviews' ORDER BY name`,
        ),
      );
    const before = await snapshot();
    expect(await migrate(db)).toBe(previous ? MIGRATIONS.filter((m) => m.tag >= "0015").length : MIGRATIONS.length);
    expect(await migrate(db)).toBe(0);
    if (previous) expect(await snapshot()).toEqual(before);
    else await db.query((q) => q.run(sql`INSERT INTO owners VALUES (${owner}), (${other})`));
    await db.query(async (q) => {
      await q.run(
        sql`INSERT INTO settings VALUES (${owner}, 'approvedActiveHours', '12', 0), (${other}, 'approvedActiveHours', '24', 1)`,
      );
      expect(await q.values(sql`SELECT value FROM settings WHERE owner_id = ${owner}`)).toEqual([["12"]]);
      await expect(
        q.run(sql`INSERT INTO settings VALUES (${owner}, 'approvedActiveHours', '24', 2)`),
      ).rejects.toThrow();
      await expect(q.run(sql`INSERT INTO settings VALUES (${owner}, 'unknown', '12', 0)`)).rejects.toThrow();
      await expect(
        q.run(sql`INSERT INTO settings VALUES (${randomUUID()}, 'approvedActiveHours', '12', 0)`),
      ).rejects.toThrow();
      expect(await q.values(sql`PRAGMA foreign_key_check`)).toEqual([]);
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
