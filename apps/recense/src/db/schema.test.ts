import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { expect, test } from "vitest";
import {
  blobs,
  comments,
  devices,
  files,
  pairings,
  placements,
  reviews,
  revisions,
  sends,
  threads,
  tokens,
} from "./schema.ts";
import { testDb } from "./test-support.ts";

test("every owned table has an indexed non-null owner and every owned parent FK includes it", async () => {
  const ctx = await testDb();
  try {
    await ctx.db.query(async (q) => {
      const tables = (
        await q.values<[string]>(sql`select name from sqlite_schema where type = 'table' and name not like 'sqlite_%'`)
      ).map(([name]) => name);
      for (const table of tables.filter((name) => !["owners", "instances", "__recense_migrations"].includes(name))) {
        const columns = await q.values<[string, number]>(sql`select name, "notnull" from pragma_table_info(${table})`);
        expect(
          columns.find(([name]) => name === "owner_id"),
          table,
        ).toEqual(["owner_id", 1]);
        const indexes = await q.values<[string]>(sql`select name from pragma_index_list(${table})`);
        const firstColumns = await Promise.all(
          indexes.map(
            async ([name]) =>
              (await q.values<[string]>(sql`select name from pragma_index_info(${name}) order by seqno`))[0]?.[0],
          ),
        );
        expect(firstColumns, table).toContain("owner_id");
        const fks = await q.values<[number, string, string, string]>(
          sql`select id, "table", "from", "to" from pragma_foreign_key_list(${table})`,
        );
        expect(
          fks.some(([, parent, from, to]) => parent === "owners" && from === "owner_id" && to === "id"),
          table,
        ).toBe(true);
        for (const [id, parent] of fks.filter(([, parent]) => !["owners", "instances"].includes(parent))) {
          expect(
            fks.some(([partId, , from, to]) => partId === id && from === "owner_id" && to === "owner_id"),
            `${table} -> ${parent}`,
          ).toBe(true);
        }
      }
    });
  } finally {
    await ctx.cleanup();
  }
});

test("foreign owners cannot attach blobs, placements, comments, sends, devices or pairings", async () => {
  const ctx = await testDb();
  try {
    await ctx.db.query(async (q) => {
      const reviewId = randomUUID();
      const revisionId = randomUUID();
      const threadId = randomUUID();
      const deviceId = randomUUID();
      const tokenId = randomUUID();
      await q.insert(reviews).values({
        id: reviewId,
        ownerId: ctx.ownerId,
        originInstanceId: ctx.instanceId,
        reviewKey: "synthetic",
        title: "Synthetic",
      });
      await q
        .insert(revisions)
        .values({ id: revisionId, ownerId: ctx.ownerId, reviewId, seq: 1, contentKey: randomUUID() });
      await q.insert(threads).values({
        id: threadId,
        ownerId: ctx.ownerId,
        reviewId,
        createdRevisionId: revisionId,
        target: { kind: "review" },
      });
      await q.insert(devices).values({ id: deviceId, ownerId: ctx.ownerId, kind: "browser", name: "Synthetic" });
      await q
        .insert(tokens)
        .values({ id: tokenId, ownerId: ctx.ownerId, kind: "admin", name: "Synthetic", secretHash: "a".repeat(64) });
      const ownerId = ctx.otherOwnerId;
      await expect(
        q
          .insert(placements)
          .values({ ownerId, reviewId, threadId, revisionId, status: "placed", location: { kind: "review" } })
          .run(),
      ).rejects.toThrow();
      await expect(
        q.insert(comments).values({ ownerId, reviewId, threadId, author: "user", body: "Synthetic" }).run(),
      ).rejects.toThrow();
      await expect(q.insert(sends).values({ ownerId, reviewId, revisionId, kind: "approve" }).run()).rejects.toThrow();
      await expect(
        q
          .insert(tokens)
          .values({ ownerId, deviceId, kind: "reviewer", name: "Synthetic", secretHash: "b".repeat(64) })
          .run(),
      ).rejects.toThrow();
      await expect(
        q
          .insert(pairings)
          .values({
            ownerId,
            createdBy: tokenId,
            secretHash: "c".repeat(64),
            codeHash: "d".repeat(64),
            expiresAt: Date.now(),
          })
          .run(),
      ).rejects.toThrow();
      await q.insert(blobs).values({ ownerId, sha256: "e".repeat(64), size: 0, mediaType: "text/plain" });
      await expect(
        q
          .insert(files)
          .values({
            ownerId: ctx.ownerId,
            revisionId,
            path: "synthetic.txt",
            role: "doc",
            ord: 0,
            mediaType: "text/plain",
            newBlob: "e".repeat(64),
          })
          .run(),
      ).rejects.toThrow();
      await q.insert(placements).values({
        ownerId: ctx.ownerId,
        reviewId,
        threadId,
        revisionId,
        status: "placed",
        location: { kind: "review" },
      });
      expect(
        await q
          .select()
          .from(placements)
          .where(and(eq(placements.ownerId, ctx.ownerId), eq(placements.threadId, threadId)))
          .get(),
      ).toMatchObject({ location: { kind: "review" } });
      await expect(
        q.run(
          sql`update placements set status = 'unplaced' where owner_id = ${ctx.ownerId} and thread_id = ${threadId}`,
        ),
      ).rejects.toThrow();
      await expect(
        q.run(sql`update threads set state = 'invalid' where owner_id = ${ctx.ownerId} and id = ${threadId}`),
      ).rejects.toThrow();
    });
  } finally {
    await ctx.cleanup();
  }
});

test("comments and placements cannot cross reviews belonging to the same owner", async () => {
  const ctx = await testDb();
  try {
    await ctx.db.query(async (q) => {
      const ownerId = ctx.ownerId;
      const reviewIds = [randomUUID(), randomUUID()] as const;
      const revisionIds = [randomUUID(), randomUUID()] as const;
      for (const i of [0, 1] as const) {
        await q.insert(reviews).values({
          id: reviewIds[i],
          ownerId,
          originInstanceId: ctx.instanceId,
          reviewKey: `synthetic-${i}`,
          title: "Synthetic",
        });
        await q
          .insert(revisions)
          .values({ id: revisionIds[i], ownerId, reviewId: reviewIds[i], seq: 1, contentKey: randomUUID() });
      }
      const threadId = randomUUID();
      const sendId = randomUUID();
      await q.insert(threads).values({
        id: threadId,
        ownerId,
        reviewId: reviewIds[0],
        createdRevisionId: revisionIds[0],
        target: { kind: "review" },
      });
      await q
        .insert(sends)
        .values({ id: sendId, ownerId, reviewId: reviewIds[1], revisionId: revisionIds[1], kind: "approve" });
      for (const reviewId of reviewIds) {
        await expect(
          q.insert(comments).values({ ownerId, reviewId, threadId, sendId, author: "user", body: "Synthetic" }).run(),
        ).rejects.toThrow();
        await expect(
          q
            .insert(placements)
            .values({
              ownerId,
              reviewId,
              threadId,
              revisionId: revisionIds[1],
              status: "placed",
              location: { kind: "review" },
            })
            .run(),
        ).rejects.toThrow();
      }
      await q.insert(comments).values({ ownerId, reviewId: reviewIds[0], threadId, author: "user", body: "Synthetic" });
      await q.insert(placements).values({
        ownerId,
        reviewId: reviewIds[0],
        threadId,
        revisionId: revisionIds[0],
        status: "placed",
        location: { kind: "review" },
      });
    });
  } finally {
    await ctx.cleanup();
  }
});

test("agent tokens require an instance binding", async () => {
  const ctx = await testDb();
  try {
    await ctx.db.query(async (q) => {
      const input = { ownerId: ctx.ownerId, kind: "agent", name: "Synthetic", secretHash: "f".repeat(64) } as const;
      await expect(q.insert(tokens).values(input).run()).rejects.toThrow();
      await q.insert(tokens).values({ ...input, instanceId: ctx.instanceId });
    });
  } finally {
    await ctx.cleanup();
  }
});
