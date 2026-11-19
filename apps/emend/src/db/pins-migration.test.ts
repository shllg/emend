import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";

test("the pins migration adds review_pins with its key, foreign keys and owner index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-pins-"));
  const db = openDb(join(dir, "test.db"));
  const ownerA = randomUUID(),
    ownerB = randomUUID(),
    instance = randomUUID(),
    review = randomUUID();
  try {
    await migrate(db);
    const tables = await db.read((q) =>
      q.values(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_pins'`),
    );
    expect(tables.flat()).toEqual(["review_pins"]);
    const indexes = await db.read((q) =>
      q.values(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'review_pins_owner_idx'`),
    );
    expect(indexes.flat()).toEqual(["review_pins_owner_idx"]);

    await db.query(async (q) => {
      await q.run(sql`INSERT INTO owners (id) VALUES (${ownerA})`);
      await q.run(sql`INSERT INTO owners (id) VALUES (${ownerB})`);
      await q.run(sql`INSERT INTO instances (id, name) VALUES (${instance}, 'Synthetic')`);
      await q.run(
        sql`INSERT INTO reviews (id, owner_id, origin_instance_id, review_key, title, state, created_at, updated_at) VALUES (${review}, ${ownerA}, ${instance}, 'synthetic', 'Synthetic', 'open', 5, 6)`,
      );
    });

    await db.query((q) =>
      q.run(sql`INSERT INTO review_pins (owner_id, review_id, created_at) VALUES (${ownerA}, ${review}, 7)`),
    );

    // A second pin for the same owner and review is refused by the primary key.
    await expect(
      db.query((q) =>
        q.run(sql`INSERT INTO review_pins (owner_id, review_id, created_at) VALUES (${ownerA}, ${review}, 8)`),
      ),
    ).rejects.toThrow();

    // A pin for a review that does not exist is refused by the foreign key.
    await expect(
      db.query((q) =>
        q.run(sql`INSERT INTO review_pins (owner_id, review_id, created_at) VALUES (${ownerA}, ${randomUUID()}, 9)`),
      ),
    ).rejects.toThrow();

    // A pin for another owner's review is refused by the composite foreign key.
    await expect(
      db.query((q) =>
        q.run(sql`INSERT INTO review_pins (owner_id, review_id, created_at) VALUES (${ownerB}, ${review}, 10)`),
      ),
    ).rejects.toThrow();

    expect(await db.read((q) => q.values(sql`SELECT owner_id, review_id FROM review_pins`))).toEqual([
      [ownerA, review],
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
