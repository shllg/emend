import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { instances, owners } from "./schema.ts";

export async function testDb() {
  const dir = await mkdtemp(join(tmpdir(), "recense-db-"));
  const file = join(dir, "state", "recense.db");
  const db = openDb(file);
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const instanceId = randomUUID();
  await migrate(db);
  await db.query(async (q) => {
    await q.insert(owners).values([{ id: ownerId }, { id: otherOwnerId }]);
    await q.insert(instances).values({ id: instanceId, name: "Synthetic instance", isSelf: true });
  });
  return {
    db,
    dir,
    file,
    ownerId,
    otherOwnerId,
    instanceId,
    async cleanup() {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
