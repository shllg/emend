import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";

test("the groups migration adds review_groups and review_group_members with their constraints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-groups-"));
  const db = openDb(join(dir, "test.db"));
  const ownerA = randomUUID(),
    ownerB = randomUUID(),
    instance = randomUUID(),
    review = randomUUID(),
    groupA = randomUUID(),
    groupA2 = randomUUID(),
    groupB = randomUUID();
  try {
    await migrate(db);
    const tables = await db.read((q) =>
      q.values(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'review_group%' ORDER BY name`),
    );
    expect(tables.flat()).toEqual(["review_group_members", "review_groups"]);

    await db.query(async (q) => {
      await q.run(sql`INSERT INTO owners (id) VALUES (${ownerA})`);
      await q.run(sql`INSERT INTO owners (id) VALUES (${ownerB})`);
      await q.run(sql`INSERT INTO instances (id, name) VALUES (${instance}, 'Synthetic')`);
      await q.run(
        sql`INSERT INTO reviews (id, owner_id, origin_instance_id, review_key, title, state, created_at, updated_at) VALUES (${review}, ${ownerA}, ${instance}, 'synthetic', 'Synthetic', 'open', 5, 6)`,
      );
      await q.run(
        sql`INSERT INTO review_groups (id, owner_id, name, created_at, updated_at) VALUES (${groupA}, ${ownerA}, 'Alpha', 1, 1)`,
      );
      await q.run(
        sql`INSERT INTO review_groups (id, owner_id, name, created_at, updated_at) VALUES (${groupA2}, ${ownerA}, 'Beta', 1, 1)`,
      );
      // The same name for another owner works.
      await q.run(
        sql`INSERT INTO review_groups (id, owner_id, name, created_at, updated_at) VALUES (${groupB}, ${ownerB}, 'Alpha', 1, 1)`,
      );
    });

    // A second group with the same owner and name throws.
    await expect(
      db.query((q) =>
        q.run(
          sql`INSERT INTO review_groups (id, owner_id, name, created_at, updated_at) VALUES (${randomUUID()}, ${ownerA}, 'Alpha', 2, 2)`,
        ),
      ),
    ).rejects.toThrow();

    // A member whose group belongs to another owner is refused by the foreign key.
    await expect(
      db.query((q) =>
        q.run(
          sql`INSERT INTO review_group_members (owner_id, review_id, group_id, created_at) VALUES (${ownerA}, ${review}, ${groupB}, 3)`,
        ),
      ),
    ).rejects.toThrow();

    await db.query((q) =>
      q.run(
        sql`INSERT INTO review_group_members (owner_id, review_id, group_id, created_at) VALUES (${ownerA}, ${review}, ${groupA}, 3)`,
      ),
    );

    // A second member row for the same review is refused by the primary key.
    await expect(
      db.query((q) =>
        q.run(
          sql`INSERT INTO review_group_members (owner_id, review_id, group_id, created_at) VALUES (${ownerA}, ${review}, ${groupA2}, 4)`,
        ),
      ),
    ).rejects.toThrow();

    expect(
      await db.read((q) => q.values(sql`SELECT group_id FROM review_group_members WHERE review_id = ${review}`)),
    ).toEqual([[groupA]]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
