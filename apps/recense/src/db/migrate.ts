import { sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

export class NewerDatabaseError extends Error {
  constructor() {
    super("The recense database is newer than this recense. Update recense, then try again.");
    this.name = "NewerDatabaseError";
  }
}

export function migrate(db: Db, options?: { offThread?: boolean }): Promise<number> {
  return db.transaction(async (q) => {
    // A database migrated before the rename keeps its history under the old table name.
    const [legacy, current] = await Promise.all(
      ["__emend_migrations", "__recense_migrations"].map(
        async (name) =>
          (
            await q.values<[number]>(sql`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ${name}`)
          )[0]?.[0] === 1,
      ),
    );
    if (legacy && !current) await q.run(sql`ALTER TABLE __emend_migrations RENAME TO __recense_migrations`);
    await q.run(
      sql`CREATE TABLE IF NOT EXISTS __recense_migrations (hash text primary key, tag text not null, applied_at integer not null)`,
    );
    const applied = new Set(
      (await q.values<[string]>(sql`SELECT hash FROM __recense_migrations`)).map(([hash]) => hash),
    );
    const known = new Set(MIGRATIONS.map((migration) => migration.hash));
    if ([...applied].some((hash) => !known.has(hash))) throw new NewerDatabaseError();
    let count = 0;
    for (const migration of [...MIGRATIONS].sort((a, b) => a.when - b.when)) {
      if (applied.has(migration.hash)) continue;
      for (const statement of migration.statements) await q.exec(statement);
      await q.run(
        sql`INSERT INTO __recense_migrations (hash, tag, applied_at) VALUES (${migration.hash}, ${migration.tag}, ${Date.now()})`,
      );
      applied.add(migration.hash);
      count++;
    }
    return count;
  }, options);
}
