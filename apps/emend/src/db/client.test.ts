import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { StateDirModeError } from "../state/files.ts";
import { NestedDbCallError, openDb, type Queries } from "./client.ts";
import { owners, reviews, revisions, threads } from "./schema.ts";
import { testDb } from "./test-support.ts";

test("the connection applies and reads back pragmas and creates private database files", async () => {
  const ctx = await testDb();
  onTestFinished(() => ctx.cleanup());
  try {
    for (const [name, expected] of [
      ["journal_mode", "wal"],
      ["busy_timeout", 5000],
      ["foreign_keys", 1],
    ] as const) {
      expect(await ctx.db.query((q) => q.values(sql.raw(`PRAGMA ${name}`)))).toEqual([[expected]]);
    }
    expect((await stat(dirname(ctx.file))).mode & 0o777).toBe(0o700);
    for (const file of [ctx.file, `${ctx.file}-wal`, `${ctx.file}-shm`]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  } finally {
    await ctx.cleanup();
  }
});

test("positional rows preserve duplicate column names, JSON, returning and missing get", async () => {
  const ctx = await testDb();
  onTestFinished(() => ctx.cleanup());
  try {
    await ctx.db.query(async (q) => {
      const [review] = await q
        .insert(reviews)
        .values({ ownerId: ctx.ownerId, originInstanceId: ctx.instanceId, reviewKey: "synthetic", title: "Synthetic" })
        .returning();
      if (!review) throw new Error("missing insert");
      const [revision] = await q
        .insert(revisions)
        .values({ ownerId: ctx.ownerId, reviewId: review.id, seq: 1, contentKey: randomUUID(), createdAt: Date.now() })
        .returning();
      if (!revision) throw new Error("missing insert");
      const target = { kind: "file", path: "synthetic.ts" } as const;
      const [thread] = await q
        .insert(threads)
        .values({
          ownerId: ctx.ownerId,
          reviewId: review.id,
          target,
          state: "open",
          createdRevisionId: revision.id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .returning();
      expect(thread?.target).toEqual(target);
      const joined = await q
        .select({ reviewId: reviews.id, revisionId: revisions.id })
        .from(reviews)
        .innerJoin(revisions, and(eq(revisions.reviewId, reviews.id), eq(revisions.ownerId, reviews.ownerId)))
        .where(and(eq(reviews.ownerId, ctx.ownerId), eq(revisions.ownerId, ctx.ownerId)));
      expect(joined).toEqual([{ reviewId: review.id, revisionId: revision.id }]);
      expect(
        await q
          .select()
          .from(reviews)
          .where(and(eq(reviews.ownerId, ctx.ownerId), eq(reviews.id, randomUUID())))
          .get(),
      ).toBeUndefined();
      await expect(
        q
          .insert(revisions)
          .values({
            ownerId: ctx.otherOwnerId,
            reviewId: review.id,
            seq: 2,
            contentKey: randomUUID(),
            createdAt: Date.now(),
          })
          .run(),
      ).rejects.toThrow();
    });
  } finally {
    await ctx.cleanup();
  }
});

test("a failing transaction rolls back and unrelated statements wait outside it", async () => {
  const ctx = await testDb();
  onTestFinished(() => ctx.cleanup());
  const insertedId = randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const transaction = ctx.db.transaction(async (q) => {
    await q.insert(owners).values({ id: insertedId });
    entered.resolve();
    await release.promise;
    throw new Error("synthetic rollback");
  });
  const rejection = expect(transaction).rejects.toThrow("synthetic rollback");
  onTestFinished(async () => {
    release.resolve();
    await rejection;
  });
  await entered.promise;
  let ran = false;
  const unrelated = ctx.db.query(async (q) => {
    ran = true;
    return q.select().from(owners).where(eq(owners.id, insertedId)).get();
  });
  await Promise.resolve();
  expect(ran).toBe(false);
  release.resolve();
  await rejection;
  expect(await unrelated).toBeUndefined();
  await ctx.db.transaction(async (q) => {
    await q.insert(owners).values({ id: insertedId });
  });
  expect(await ctx.db.query((q) => q.select().from(owners).where(eq(owners.id, insertedId)).get())).toEqual({
    id: insertedId,
  });
});

test("read-only WAL queries stay responsive, hide uncommitted rows and reject writes", async () => {
  const ctx = await testDb();
  onTestFinished(() => ctx.cleanup());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const id = randomUUID();
  const transaction = ctx.db.transaction(async (q) => {
    await q.insert(owners).values({ id });
    entered.resolve();
    await release.promise;
  });
  onTestFinished(async () => {
    release.resolve();
    await transaction;
  });
  await entered.promise;
  expect(await ctx.db.read((q) => q.select().from(owners).where(eq(owners.id, id)).get())).toBeUndefined();
  await expect(ctx.db.read((q) => q.insert(owners).values({ id: randomUUID() }).run())).rejects.toThrow();
  release.resolve();
  await transaction;
  expect(await ctx.db.read((q) => q.select().from(owners).where(eq(owners.id, id)).get())).toEqual({ id });
});

test("query scopes cannot escape the queue and close drains pending work", async () => {
  const ctx = await testDb();
  onTestFinished(() => ctx.cleanup());
  let escaped: Queries | undefined;
  try {
    await ctx.db.query(async (q) => {
      escaped = q;
    });
    if (!escaped) throw new Error("missing query scope");
    await expect(escaped.values(sql`select 1`)).rejects.toThrow();
    const pending = ctx.db.query((q) => q.values(sql`select 2`));
    const closing = ctx.db.close();
    await expect(ctx.db.query((q) => q.values(sql`select 3`))).rejects.toThrow("closed");
    expect(await pending).toEqual([[2]]);
    await closing;
  } finally {
    await ctx.cleanup();
  }
});

test("reopening tightens the database and existing WAL/SHM sidecars", async () => {
  const ctx = await testDb();
  onTestFinished(() => ctx.cleanup());
  try {
    for (const file of [ctx.file, `${ctx.file}-wal`, `${ctx.file}-shm`]) await chmod(file, 0o644);
    const reopened = openDb(ctx.file);
    onTestFinished(() => reopened.close());
    try {
      for (const file of [ctx.file, `${ctx.file}-wal`, `${ctx.file}-shm`])
        expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await reopened.close();
    }
  } finally {
    await ctx.cleanup();
  }
});

test("opening a public state directory refuses it without changing its permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-db-mode-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  try {
    await chmod(dir, 0o755);
    expect(() => openDb(join(dir, "emend.db"))).toThrow(StateDirModeError);
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nested query and transaction calls reject immediately instead of deadlocking", async () => {
  const ctx = await testDb();
  onTestFinished(() => ctx.cleanup());
  try {
    for (const outer of ["query", "transaction"] as const) {
      for (const inner of ["query", "transaction"] as const) {
        const interrupted = Promise.withResolvers<Error>();
        const stopped = new Error("test finished during a nested database call");
        const nested: Promise<unknown>[] = [];
        const operation = ctx.db[outer](async () => {
          const result = ctx.db[inner]((q) => q.values(sql`select 1`)).then(
            () => undefined,
            (error: unknown) => error,
          );
          nested.push(result);
          // Teardown can release the outer queue slot even if the nested guard regresses.
          const error = await Promise.race([result, interrupted.promise]);
          if (error === stopped) throw stopped;
          expect(error).toBeInstanceOf(NestedDbCallError);
        });
        const settled = Promise.allSettled([operation]);
        onTestFinished(async () => {
          interrupted.resolve(stopped);
          await settled;
          await Promise.allSettled(nested);
        });
        await operation;
      }
    }
    expect(await ctx.db.query((q) => q.values(sql`select 2`))).toEqual([[2]]);
  } finally {
    await ctx.cleanup();
  }
});
