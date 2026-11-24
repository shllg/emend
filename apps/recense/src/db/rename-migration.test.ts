import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

const LOOK_MIGRATION = "0029_look_recense";

// A database as the release before the rename left it: history in `__emend_migrations`, looks named `emend`.
async function legacyDatabase(table: "__emend_migrations" | "__recense_migrations" = "__emend_migrations") {
  const dir = await mkdtemp(join(tmpdir(), "recense-rename-migration-"));
  const db = openDb(join(dir, "test.db"));
  const owner = randomUUID();
  const instance = randomUUID();
  const review = randomUUID();
  const revision = randomUUID();
  const ids = { emend: randomUUID(), custom: randomUUID(), none: randomUUID() };
  await db.transaction(async (q) => {
    await q.exec(`CREATE TABLE ${table} (hash text primary key, tag text not null, applied_at integer not null)`);
    for (const migration of MIGRATIONS.filter((m) => m.tag < LOOK_MIGRATION)) {
      for (const statement of migration.statements) await q.exec(statement);
      await q.run(sql.raw(`INSERT INTO ${table} VALUES ('${migration.hash}', '${migration.tag}', 0)`));
    }
    await q.run(sql`INSERT INTO owners (id) VALUES (${owner})`);
    await q.run(sql`INSERT INTO instances (id,name) VALUES (${instance},'Synthetic')`);
    await q.run(
      sql`INSERT INTO reviews (id,owner_id,origin_instance_id,review_key,title,created_at,updated_at) VALUES (${review},${owner},${instance},'synthetic','Synthetic',0,0)`,
    );
    await q.run(
      sql`INSERT INTO revisions (id,owner_id,review_id,seq,content_key,created_at) VALUES (${revision},${owner},${review},1,'synthetic',0)`,
    );
    for (const [name, look] of [
      ["emend", "emend"],
      ["custom", "custom"],
      ["none", null],
    ] as const)
      await q.run(
        sql`INSERT INTO files (id,owner_id,revision_id,path,role,ord,media_type,look) VALUES (${ids[name]},${owner},${revision},${`${name}.html`},'doc',0,'text/html',${look})`,
      );
  });
  return { db, ids, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const tables = (db: Awaited<ReturnType<typeof legacyDatabase>>["db"]) =>
  db.read((q) =>
    q.values<[string]>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('__emend_migrations','__recense_migrations') ORDER BY name`,
    ),
  );

test("a database migrated under the old table name keeps its history under the new one", async () => {
  const { db, cleanup } = await legacyDatabase();
  try {
    const before = await db.read((q) =>
      q.values(sql`SELECT hash, tag, applied_at FROM __emend_migrations ORDER BY hash`),
    );
    expect(await migrate(db)).toBe(MIGRATIONS.filter((m) => m.tag >= LOOK_MIGRATION).length);
    expect(await tables(db)).toEqual([["__recense_migrations"]]);
    const after = await db.read((q) =>
      q.values(sql`SELECT hash, tag, applied_at FROM __recense_migrations WHERE tag < ${LOOK_MIGRATION} ORDER BY hash`),
    );
    expect(after).toEqual(before);
    expect(await migrate(db)).toBe(0);
  } finally {
    await db.close();
    await cleanup();
  }
});

test("a database that already has the new table name is left alone", async () => {
  const { db, cleanup } = await legacyDatabase("__recense_migrations");
  try {
    await migrate(db);
    expect(await tables(db)).toEqual([["__recense_migrations"]]);
    expect(await migrate(db)).toBe(0);
  } finally {
    await db.close();
    await cleanup();
  }
});

test("when both history tables exist, the new one is used and the old one is not renamed over it", async () => {
  const { db, cleanup } = await legacyDatabase("__recense_migrations");
  try {
    await db.transaction(async (q) => {
      await q.exec(
        "CREATE TABLE __emend_migrations (hash text primary key, tag text not null, applied_at integer not null)",
      );
    });
    await migrate(db);
    expect((await tables(db)).sort()).toEqual([["__emend_migrations"], ["__recense_migrations"]]);
  } finally {
    await db.close();
    await cleanup();
  }
});

test("the look migration renames stored `emend` looks and leaves custom and absent ones", async () => {
  const { db, ids, cleanup } = await legacyDatabase();
  try {
    await migrate(db);
    const looks = await db.read((q) => q.values<[string, string | null]>(sql`SELECT id, look FROM files`));
    expect(Object.fromEntries(looks)).toEqual({ [ids.emend]: "recense", [ids.custom]: "custom", [ids.none]: null });
  } finally {
    await db.close();
    await cleanup();
  }
});
