import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";
import { pairings } from "./schema.ts";

test("pairing purpose migration preserves old rows as device and enforces its CHECK", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-purpose-"));
  const db = openDb(join(dir, "recense.db"));
  const initial = MIGRATIONS[0];
  if (!initial) throw new Error("Missing initial migration");
  const owner = randomUUID();
  const token = randomUUID();
  const id = randomUUID();
  try {
    await db.transaction(async (q) => {
      for (const statement of initial.statements) await q.exec(statement);
      await q.exec(
        "CREATE TABLE __recense_migrations (hash text primary key, tag text not null, applied_at integer not null)",
      );
      await q.run(sql`INSERT INTO __recense_migrations VALUES (${initial.hash}, ${initial.tag}, 0)`);
      await q.run(sql`INSERT INTO owners VALUES (${owner})`);
      await q.run(
        sql`INSERT INTO tokens (id, owner_id, kind, name, secret_hash, created_at) VALUES (${token}, ${owner}, 'admin', 'Synthetic', 'synthetic-token-hash', 0)`,
      );
      await q.run(
        sql`INSERT INTO pairings (id, owner_id, secret_hash, code_hash, created_by, expires_at) VALUES (${id}, ${owner}, 'synthetic-pairing-hash', 'synthetic-code-hash', ${token}, 600000)`,
      );
    });
    await migrate(db);
    expect(await db.query((q) => q.values(sql`SELECT id, purpose FROM pairings WHERE owner_id = ${owner}`))).toEqual([
      [id, "device"],
    ]);
    await expect(
      db.query((q) => q.run(sql`UPDATE pairings SET purpose = 'invalid' WHERE owner_id = ${owner}`)),
    ).rejects.toThrow();
    expect(await db.query((q) => q.values(sql`PRAGMA foreign_keys`))).toEqual([[1]]);
    expect(await db.query((q) => q.values(sql`PRAGMA foreign_key_check`))).toEqual([]);
    await db.query((q) =>
      q.insert(pairings).values({
        ownerId: owner,
        purpose: "machine",
        secretHash: "machine-hash",
        codeHash: "machine-code",
        createdBy: token,
        expiresAt: 600000,
      }),
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
