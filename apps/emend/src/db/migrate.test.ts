import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

vi.mock("./migrations.gen.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./migrations.gen.ts")>();
  return { MIGRATIONS: [...actual.MIGRATIONS] };
});

// migrate() uses one transaction: foreign_keys is a no-op there, so table rebuilds fail with foreign-key children.
test.each(MIGRATIONS.filter(({ tag }) => tag.slice(0, 4) > "0001"))(
  "$tag avoids foreign_keys pragmas and table rebuilds",
  ({ statements }) => {
    const source = statements.join("\n");
    expect(source).not.toMatch(/\bPRAGMA\s+foreign_keys\b/i);
    expect(source).not.toMatch(/__new_/i);
  },
);

test("the embedded migrations exactly match the generated journal and SQL", async () => {
  const root = new URL("../../drizzle/", import.meta.url);
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", root), "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const expected = await Promise.all(
    journal.entries.map(async ({ tag, when }) => {
      const source = await readFile(new URL(`${tag}.sql`, root), "utf8");
      return {
        tag,
        when,
        hash: createHash("sha256").update(source).digest("hex"),
        statements: source
          .split("--> statement-breakpoint")
          .map((part) => part.trim())
          .filter(Boolean),
      };
    }),
  );
  expect(MIGRATIONS).toEqual(expected);
});

test("migrations apply to an empty file and a second run applies nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-migrations-"));
  const db = openDb(join(dir, "emend.db"));
  try {
    expect(await migrate(db)).toBe(MIGRATIONS.length);
    expect(await migrate(db)).toBe(0);
    expect(await db.query((q) => q.values(sql`select count(*) from __emend_migrations`))).toEqual([
      [MIGRATIONS.length],
    ]);
    const tables = await db.query((q) =>
      q.values<string[]>(
        sql`select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name`,
      ),
    );
    expect(tables.flat()).toEqual([
      "__emend_migrations",
      "agent_notes",
      "agent_waiters",
      "blobs",
      "changed_blocks",
      "comments",
      "deliveries",
      "devices",
      "doc_assets",
      "files",
      "instances",
      "owners",
      "pairings",
      "placements",
      "repos",
      "review_tombstones",
      "reviews",
      "revisions",
      "sends",
      "settings",
      "threads",
      "tokens",
      "topics",
      "viewed_files",
      "writeups",
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a migration failure rolls back DDL and ledger, allowing a clean retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-migration-rollback-"));
  const db = openDb(join(dir, "emend.db"));
  const migrations = MIGRATIONS as { tag: string; when: number; hash: string; statements: string[] }[];
  migrations.push({
    tag: "synthetic_failure",
    when: Number.MAX_SAFE_INTEGER,
    hash: "synthetic",
    statements: ["CREATE TABLE synthetic_probe (id text)", "INVALID SQL"],
  });
  try {
    await expect(migrate(db)).rejects.toThrow();
    expect(await db.query((q) => q.values(sql`select name from sqlite_schema where type = 'table'`))).toEqual([]);
  } finally {
    migrations.pop();
  }
  try {
    expect(await migrate(db)).toBe(MIGRATIONS.length);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime migrations execute every statement in a supplied chunk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-migration-chunk-"));
  const db = openDb(join(dir, "emend.db"));
  const migrations = MIGRATIONS as { tag: string; when: number; hash: string; statements: string[] }[];
  migrations.push({
    tag: "synthetic_chunk",
    when: Number.MAX_SAFE_INTEGER,
    hash: "synthetic-chunk",
    statements: ["CREATE TABLE synthetic_one (id text); CREATE TABLE synthetic_two (id text);"],
  });
  try {
    await migrate(db);
    expect(
      await db.query((q) =>
        q.values(sql`select name from sqlite_schema where name in ('synthetic_one', 'synthetic_two') order by name`),
      ),
    ).toEqual([["synthetic_one"], ["synthetic_two"]]);
  } finally {
    migrations.pop();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown applied hash refuses before any pending migration can write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-migration-future-"));
  const db = openDb(join(dir, "emend.db"));
  try {
    await db.query(async (q) => {
      await q.exec(
        "CREATE TABLE __emend_migrations (hash text primary key, tag text not null, applied_at integer not null)",
      );
      await q.run(sql`insert into __emend_migrations values ('synthetic-future', 'future', 1)`);
    });
    const before = await db.read((q) => q.values(sql`select * from sqlite_schema`));
    await expect(migrate(db)).rejects.toMatchObject({
      name: "NewerDatabaseError",
      message: "The emend database is newer than this emend. Update emend, then try again.",
    });
    expect(await db.read((q) => q.values(sql`select * from sqlite_schema`))).toEqual(before);
    expect(await db.read((q) => q.values(sql`select * from __emend_migrations`))).toEqual([
      ["synthetic-future", "future", 1],
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
