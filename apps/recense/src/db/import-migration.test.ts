import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { MIGRATIONS } from "./migrations.gen.ts";
import { instances, reviews } from "./schema.ts";

test("0007 retains existing reviews and remembers current and retired self identities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-import-migration-"));
  const db = openDb(join(dir, "recense.db"));
  try {
    const owner = randomUUID(),
      current = randomUUID(),
      retired = randomUUID(),
      tokenless = randomUUID(),
      review = randomUUID();
    await db.transaction(async (q) => {
      for (const migration of MIGRATIONS.filter((migration) => migration.tag < "0007_"))
        for (const statement of migration.statements) await q.exec(statement);
      await q.run(sql`insert into owners (id) values (${owner})`);
      for (const [id, self] of [
        [current, 1],
        [retired, 0],
        [tokenless, 0],
      ] as const)
        await q.run(sql`insert into instances (id, name, is_self) values (${id}, 'Synthetic', ${self})`);
      await q.run(
        sql`insert into tokens (id, owner_id, kind, instance_id, name, secret_hash, created_at, revoked_at) values (${randomUUID()}, ${owner}, 'agent', ${retired}, 'retired local', ${"a".repeat(64)}, 1, 2)`,
      );
      await q.run(
        sql`insert into reviews (id, owner_id, origin_instance_id, review_key, title, created_at, updated_at) values (${review}, ${owner}, ${retired}, ${"b".repeat(64)}, 'Synthetic review', 1, 2)`,
      );
      const migration = MIGRATIONS.find((migration) => migration.tag.startsWith("0007_"));
      expect(migration?.tag).toMatch(/^0007_/);
      for (const statement of migration?.statements ?? []) await q.exec(statement);
    });
    const rows = await db.read((q) => q.select().from(instances));
    expect(rows.find((r) => r.id === current)?.wasSelf).toBe(true);
    expect(rows.find((r) => r.id === retired)?.wasSelf).toBe(true);
    expect(rows.find((r) => r.id === tokenless)?.wasSelf).toBe(true);
    // Name the columns: later migrations add reviews columns this database does not have yet.
    const columns = { id: reviews.id, title: reviews.title, importedAt: reviews.importedAt };
    expect(await db.read((q) => q.select(columns).from(reviews).where(eq(reviews.ownerId, owner)).get())).toMatchObject(
      {
        id: review,
        title: "Synthetic review",
        importedAt: null,
      },
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
