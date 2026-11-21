import { randomUUID } from "node:crypto";
import type { Block } from "@emend/core";
import { and, eq, sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { changedBlocks, reviews, revisions } from "../../db/schema.ts";
import { testDb } from "../../db/test-support.ts";
import { insertChangedBlocks } from "./changed.ts";
import { workerExecutor } from "./executor.ts";
import { packIds, serializeRendered } from "./work.ts";

const block = (id: string): Block => ({ id, section: "overview", kind: "paragraph", html: "x", text: "x" });
test("changed IDs exclude previous writeup and doc IDs, deduplicate new IDs and transfer only packed bytes", async () => {
  const execute = workerExecutor();
  try {
    const writeup = serializeRendered({
      sections: [{ key: "overview", label: "Overview", topic: null, blocks: [block("overview-aaaaaaaa")] }],
    });
    const doc = serializeRendered([block("doc-aaaaaaaa-aaaaaaaa")]);
    const html = packIds(["doc-bbbbbbbb-aaaaaaaa", ""]);
    const next = serializeRendered([
      block("overview-aaaaaaaa"),
      block("doc-aaaaaaaa-aaaaaaaa"),
      block("doc-bbbbbbbb-aaaaaaaa"),
      block("overview-bbbbbbbb"),
      block("overview-bbbbbbbb"),
    ]);
    const changed = await execute({
      kind: "changed",
      previous: [
        { format: "writeup", bytes: writeup.bytes },
        { format: "doc", bytes: doc.bytes },
        { format: "ids", bytes: html },
      ],
      next: [next.ids],
    });
    expect(writeup.bytes.byteLength).toBe(0);
    expect(doc.bytes.byteLength).toBe(0);
    expect(html.byteLength).toBe(0);
    expect(next.ids.byteLength).toBe(0);
    expect(changed.kind).toBe("changed");
    if (changed.kind !== "changed") throw new Error("wrong result");
    expect(new TextDecoder().decode(changed.bytes)).toBe('"overview-bbbbbbbb"');
    expect(await execute({ kind: "changed", previous: [], next: [] })).toEqual({
      kind: "changed",
      bytes: new ArrayBuffer(0),
    });
  } finally {
    await execute.close();
  }
});

test("packed IDs stream across batch boundaries as bound data with random row IDs in one durable transaction", async () => {
  const f = await testDb();
  try {
    const ids = Array.from({ length: 1001 }, (_, i) => `overview-${i.toString(16).padStart(8, "0")}`);
    // Escaping is done by the worker; the insert layer must preserve its JSON strings as data.
    ids[500] = 'synthetic"quote';
    const packed = new TextEncoder().encode(ids.map((id) => JSON.stringify(id)).join("\n")).buffer;
    await f.db.transaction(
      async (q) => {
        expect(await q.values(sql`PRAGMA synchronous`)).toEqual([[2]]);
        expect(await q.values(sql`PRAGMA foreign_keys`)).toEqual([[1]]);
        expect(await q.values(sql`PRAGMA wal_autocheckpoint`)).toEqual([[1000]]);
        const review = await q
          .insert(reviews)
          .values({ ownerId: f.ownerId, originInstanceId: f.instanceId, reviewKey: "synthetic", title: "Synthetic" })
          .returning()
          .get();
        const revision = await q
          .insert(revisions)
          .values({ ownerId: f.ownerId, reviewId: review.id, seq: 1, contentKey: "synthetic" })
          .returning()
          .get();
        await insertChangedBlocks(q, f.ownerId, revision.id, packed);
        await insertChangedBlocks(q, f.ownerId, revision.id, new ArrayBuffer(0));
      },
      { offThread: true },
    );
    const rows = await f.db.query((q) => q.select().from(changedBlocks).where(eq(changedBlocks.ownerId, f.ownerId)));
    expect(new Set(rows.map((row) => row.blockId))).toEqual(new Set(ids));
    expect(new Set(rows.map((row) => row.id)).size).toBe(1001);
    expect(
      rows.every((row) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.id)),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("off-thread publication transactions preserve WAL visibility, writer ordering and rollback", async () => {
  const f = await testDb();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const id = randomUUID();
  const row = { id, ownerId: f.ownerId, originInstanceId: f.instanceId, reviewKey: "synthetic", title: "Synthetic" };
  const filter = and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, id));
  try {
    const transaction = f.db.transaction(
      async (q) => {
        await q.insert(reviews).values(row);
        entered.resolve();
        await release.promise;
        throw new Error("synthetic rollback");
      },
      { offThread: true },
    );
    const rejected = expect(transaction).rejects.toThrow("synthetic rollback");
    await entered.promise;
    expect(await f.db.read((q) => q.select().from(reviews).where(filter).get())).toBeUndefined();
    let ran = false;
    const queued = f.db.query(async (q) => {
      ran = true;
      return q.select().from(reviews).where(filter).get();
    });
    await Promise.resolve();
    expect(ran).toBe(false);
    release.resolve();
    await rejected;
    expect(await queued).toBeUndefined();
    await f.db.transaction((q) => q.insert(reviews).values(row).run(), { offThread: true });
    expect(await f.db.read((q) => q.select().from(reviews).where(filter).get())).toMatchObject(row);
  } finally {
    release.resolve();
    await f.cleanup();
  }
});
