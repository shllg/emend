import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { createApp } from "../server/app.ts";
import { BlobStore } from "../store/blobs.ts";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";
import { files, instances, owners, reviews, revisions } from "./schema.ts";

test("migration backfills only parent-listed assets and keeps them serving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-doc-assets-"));
  const db = openDb(join(dir, "test.db"));
  const owner = randomUUID(),
    instance = randomUUID(),
    review = randomUUID(),
    revision = randomUUID(),
    doc = randomUUID();
  const origin = "http://127.0.0.1:3636";
  try {
    await db.transaction(async (q) => {
      await q.exec(
        "CREATE TABLE __emend_migrations (hash text primary key, tag text not null, applied_at integer not null)",
      );
      for (const migration of MIGRATIONS.filter((m) => !m.statements.some((s) => s.includes("doc_assets")))) {
        for (const statement of migration.statements) await q.exec(statement);
        await q.run(sql`INSERT INTO __emend_migrations VALUES (${migration.hash}, ${migration.tag}, 0)`);
      }
      await q.insert(owners).values({ id: owner });
      await q.insert(instances).values({ id: instance, name: "Synthetic" });
      await q.insert(reviews).values({
        id: review,
        ownerId: owner,
        originInstanceId: instance,
        reviewKey: "a".repeat(64),
        title: "Synthetic",
      });
      await q
        .insert(revisions)
        .values({ id: revision, ownerId: owner, reviewId: review, seq: 1, contentKey: "k".repeat(43) });
    });
    const blobs = new BlobStore(db, join(dir, "state"));
    const hash = await blobs.put(owner, Buffer.from("p {}"), "text/css");
    await db.query(async (q) => {
      await q.insert(files).values({
        id: doc,
        ownerId: owner,
        revisionId: revision,
        path: "doc.html",
        role: "doc",
        ord: 0,
        mediaType: "text/html",
        newBlob: hash,
      });
      await q.insert(files).values({
        ownerId: owner,
        revisionId: revision,
        path: "shared.css",
        role: "asset",
        ord: 1,
        mediaType: "text/css",
        newBlob: hash,
        parentDocId: doc,
      });
    });
    expect(await migrate(db)).toBe(2);
    expect(
      await db.read((q) =>
        q.values(sql`SELECT owner_id, revision_id, doc_id FROM doc_assets WHERE owner_id = ${owner}`),
      ),
    ).toEqual([[owner, revision, doc]]);
    const app = createApp({
      db,
      blobs,
      instance: { id: instance, name: "Synthetic" },
      now: Date.now,
      config: {
        baseUrl: origin,
        allowedHosts: ["127.0.0.1:3636"],
        appOrigins: [origin],
        secureCookieHost: undefined,
        serverKey: "k".repeat(43),
        webRoot: dir,
      },
    });
    const response = await app.request(`${origin}/content/${"k".repeat(43)}${doc.replaceAll("-", "")}/shared.css`, {
      headers: { Host: "127.0.0.1:3636" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("p {}");
    expect(await db.read((q) => q.values(sql`PRAGMA foreign_key_check`))).toEqual([]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
