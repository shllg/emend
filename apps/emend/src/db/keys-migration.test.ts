import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

test.each([false, true])("keys migration preserves settings and constraints (previous=%s)", async (previous) => {
  const dir = await mkdtemp(join(tmpdir(), "emend-keys-"));
  const db = openDb(join(dir, "test.db"));
  const owner = randomUUID(),
    other = randomUUID();
  const seed = () =>
    db.query(async (q) => {
      await q.run(sql`INSERT INTO owners VALUES (${owner}), (${other})`);
      await q.run(
        sql`INSERT INTO settings (owner_id, key, value, updated_at) VALUES (${owner}, 'approvedActiveHours', '12', 123), (${other}, 'approvedActiveHours', '24', 456)`,
      );
    });
  const rows = () =>
    db.read((q) => q.values(sql`SELECT owner_id, key, value, updated_at FROM settings ORDER BY updated_at`));
  try {
    if (previous) {
      await db.transaction(async (q) => {
        await q.exec(
          "CREATE TABLE __emend_migrations (hash text primary key, tag text not null, applied_at integer not null)",
        );
        for (const migration of MIGRATIONS.filter((m) => m.tag < "0018")) {
          for (const statement of migration.statements) await q.exec(statement);
          await q.run(sql`INSERT INTO __emend_migrations VALUES (${migration.hash}, ${migration.tag}, 0)`);
        }
      });
      await seed();
      await expect(
        db.query((q) => q.run(sql`INSERT INTO settings VALUES (${owner}, 'keys', '{}', 789)`)),
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining("CHECK constraint failed: settings_key_check") },
      });
    }
    expect(await migrate(db)).toBe(previous ? MIGRATIONS.filter((m) => m.tag >= "0018").length : MIGRATIONS.length);
    if (!previous) await seed();
    expect(await rows()).toEqual([
      [owner, "approvedActiveHours", "12", 123],
      [other, "approvedActiveHours", "24", 456],
    ]);
    await db.query(async (q) => {
      await q.run(
        sql`INSERT INTO settings (owner_id, key, value, updated_at) VALUES (${owner}, 'keys', '{}', 789), (${other}, 'keys', '{}', 987)`,
      );
      await expect(
        q.run(sql`INSERT INTO settings VALUES (${owner}, 'approvedActiveHours', '48', 0)`),
      ).rejects.toMatchObject({ cause: { message: expect.stringContaining("UNIQUE constraint failed") } });
      await expect(q.run(sql`INSERT INTO settings VALUES (${owner}, 'keys', '{}', 0)`)).rejects.toMatchObject({
        cause: { message: expect.stringContaining("UNIQUE constraint failed") },
      });
      await expect(q.run(sql`INSERT INTO settings VALUES (${owner}, 'unknown', '{}', 0)`)).rejects.toMatchObject({
        cause: { message: expect.stringContaining("CHECK constraint failed: settings_key_check") },
      });
      await expect(q.run(sql`INSERT INTO settings VALUES (${randomUUID()}, 'keys', '{}', 0)`)).rejects.toMatchObject({
        cause: { message: expect.stringContaining("FOREIGN KEY constraint failed") },
      });
      await expect(q.run(sql`DELETE FROM owners WHERE id = ${owner}`)).rejects.toMatchObject({
        cause: { message: expect.stringContaining("FOREIGN KEY constraint failed") },
      });
      expect(await q.values(sql`PRAGMA index_info(settings_owner_idx)`)).toEqual([[0, 0, "owner_id"]]);
      expect(await q.values(sql`PRAGMA foreign_keys`)).toEqual([[1]]);
      expect(await q.values(sql`PRAGMA foreign_key_check`)).toEqual([]);
    });
    const expected = [
      [owner, "approvedActiveHours", "12", 123],
      [other, "approvedActiveHours", "24", 456],
      [owner, "keys", "{}", 789],
      [other, "keys", "{}", 987],
    ];
    expect(await rows()).toEqual(expected);
    expect(await migrate(db)).toBe(0);
    expect(await rows()).toEqual(expected);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "approval cap migration preserves settings and constraints (previous=%s)",
  async (previous) => {
    const dir = await mkdtemp(join(tmpdir(), "emend-limit-"));
    const db = openDb(join(dir, "test.db"));
    const owner = randomUUID(),
      other = randomUUID();
    const seed = () =>
      db.query(async (q) => {
        await q.run(sql`INSERT INTO owners VALUES (${owner}), (${other})`);
        await q.run(
          sql`INSERT INTO settings (owner_id, key, value, updated_at) VALUES
          (${owner}, 'approvedActiveHours', '12', 123),
          (${other}, 'approvedActiveHours', '24', 456),
          (${owner}, 'keys', '{"inbox.next":"x"}', 789),
          (${other}, 'keys', '{"inbox.next":null}', 987)`,
        );
      });
    const rows = () =>
      db.read((q) => q.values(sql`SELECT owner_id, key, value, updated_at FROM settings ORDER BY updated_at`));
    const existing = [
      [owner, "approvedActiveHours", "12", 123],
      [other, "approvedActiveHours", "24", 456],
      [owner, "keys", '{"inbox.next":"x"}', 789],
      [other, "keys", '{"inbox.next":null}', 987],
    ];
    try {
      if (previous) {
        await db.transaction(async (q) => {
          await q.exec(
            "CREATE TABLE __emend_migrations (hash text primary key, tag text not null, applied_at integer not null)",
          );
          for (const migration of MIGRATIONS.filter((m) => m.tag < "0019")) {
            for (const statement of migration.statements) await q.exec(statement);
            await q.run(sql`INSERT INTO __emend_migrations VALUES (${migration.hash}, ${migration.tag}, 0)`);
          }
        });
        await seed();
        await expect(
          db.query((q) => q.run(sql`INSERT INTO settings VALUES (${owner}, 'approvedActiveLimit', '5', 1000)`)),
        ).rejects.toMatchObject({
          cause: { message: expect.stringContaining("CHECK constraint failed: settings_key_check") },
        });
        expect(await rows()).toEqual(existing);
      }
      expect(await migrate(db)).toBe(previous ? MIGRATIONS.filter((m) => m.tag >= "0019").length : MIGRATIONS.length);
      if (!previous) await seed();
      expect(await rows()).toEqual(existing);
      await db.query(async (q) => {
        await q.run(
          sql`INSERT INTO settings (owner_id, key, value, updated_at) VALUES
          (${owner}, 'approvedActiveLimit', '5', 1000), (${other}, 'approvedActiveLimit', '0', 1001)`,
        );
        for (const key of ["approvedActiveHours", "keys", "approvedActiveLimit"])
          await expect(q.run(sql`INSERT INTO settings VALUES (${owner}, ${key}, '5', 0)`)).rejects.toMatchObject({
            cause: { message: expect.stringContaining("UNIQUE constraint failed") },
          });
        await expect(q.run(sql`INSERT INTO settings VALUES (${owner}, 'unknown', '5', 0)`)).rejects.toMatchObject({
          cause: { message: expect.stringContaining("CHECK constraint failed: settings_key_check") },
        });
        await expect(
          q.run(sql`INSERT INTO settings VALUES (${randomUUID()}, 'approvedActiveLimit', '5', 0)`),
        ).rejects.toMatchObject({ cause: { message: expect.stringContaining("FOREIGN KEY constraint failed") } });
        await expect(q.run(sql`DELETE FROM owners WHERE id = ${owner}`)).rejects.toMatchObject({
          cause: { message: expect.stringContaining("FOREIGN KEY constraint failed") },
        });
        expect(await q.values(sql`PRAGMA index_info(settings_owner_idx)`)).toEqual([[0, 0, "owner_id"]]);
        expect(await q.values(sql`PRAGMA foreign_keys`)).toEqual([[1]]);
        expect(await q.values(sql`PRAGMA foreign_key_check`)).toEqual([]);
      });
      const expected = [
        ...existing,
        [owner, "approvedActiveLimit", "5", 1000],
        [other, "approvedActiveLimit", "0", 1001],
      ];
      expect(await rows()).toEqual(expected);
      expect(await migrate(db)).toBe(0);
      expect(await rows()).toEqual(expected);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
