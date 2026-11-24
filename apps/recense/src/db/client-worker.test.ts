import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import type { Queries } from "./client.ts";
import { owners } from "./schema.ts";
import { testDb } from "./test-support.ts";

const injection = vi.hoisted(() => ({
  workers: [] as Worker[],
  next: "" as "" | "constructor" | "startup",
  pragma: "",
}));
vi.mock("node:worker_threads", async (original) => {
  const module = await original<typeof import("node:worker_threads")>();
  return {
    ...module,
    Worker: class extends module.Worker {
      constructor(...args: ConstructorParameters<typeof module.Worker>) {
        const failure = injection.next;
        injection.next = "";
        const pragma = injection.pragma;
        injection.pragma = "";
        if (failure === "constructor") throw new Error("synthetic worker constructor failure");
        const source = pragma
          ? `
          const { DatabaseSync: InjectedDb } = require("node:sqlite");
          const prepare = InjectedDb.prototype.prepare;
          InjectedDb.prototype.prepare = function(query) {
            const statement = prepare.call(this, query);
            if (query === ${JSON.stringify(`PRAGMA ${pragma}`)}) statement.get = () => ({ value: null });
            return statement;
          };
          ${args[0]}
        `
          : args[0];
        super(failure === "startup" ? 'throw new Error("synthetic worker startup failure")' : source, args[1]);
        injection.workers.push(this);
      }
    },
  };
});
afterEach(async () => {
  injection.next = "";
  injection.pragma = "";
  await Promise.all(injection.workers.splice(0).map((worker) => worker.terminate()));
});

test("worker termination rolls back, rejects a paused transaction and releases queued work to a fresh writer", async () => {
  const f = await testDb();
  onTestFinished(() => f.cleanup());
  const inserted = randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let escaped: Queries | undefined;
  const failed = f.db.transaction(
    async (q) => {
      escaped = q;
      await q.insert(owners).values({ id: inserted });
      entered.resolve();
      await release.promise;
    },
    { offThread: true },
  );
  const outcome = failed.then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  const pending: Promise<unknown>[] = [outcome];
  onTestFinished(async () => {
    release.resolve();
    await Promise.allSettled(pending);
  });
  await entered.promise;
  const queuedRead = f.db.query((q) => q.select().from(owners).where(eq(owners.id, inserted)).get());
  const replacement = f.db.transaction((q) => q.insert(owners).values({ id: inserted }).run(), { offThread: true });
  const queued = Promise.allSettled([queuedRead, replacement]);
  pending.push(queued);
  await injection.workers[0]?.terminate();
  expect((await outcome).error).toMatchObject({ message: "Database worker closed" });
  expect(await queued).toMatchObject([{ status: "fulfilled", value: undefined }, { status: "fulfilled" }]);
  expect(injection.workers).toHaveLength(2);
  expect(await f.db.read((q) => q.select().from(owners).where(eq(owners.id, inserted)).get())).toEqual({
    id: inserted,
  });
  if (!escaped) throw new Error("missing query scope");
  await expect(escaped.exec("SELECT 1")).rejects.toThrow("Database query scope has ended");
});

test.each(["constructor", "startup"] as const)(
  "a worker %s failure rejects only its transaction and the queue recovers",
  async (failure) => {
    const f = await testDb();
    onTestFinished(() => f.cleanup());
    try {
      injection.next = failure;
      const callback = vi.fn(async (q: Queries) => q.values(sql`SELECT 1`));
      const failed = f.db.transaction(callback, { offThread: true });
      const rejected = expect(failed).rejects.toThrow(`synthetic worker ${failure} failure`);
      const replacement = f.db.transaction((q) => q.values(sql`SELECT 2`), { offThread: true });
      const queued = f.db.query((q) => q.values(sql`SELECT 3`));
      const settled = Promise.allSettled([failed, replacement, queued]);
      onTestFinished(() => settled.then(() => {}));
      await rejected;
      expect(callback).not.toHaveBeenCalled();
      expect(await replacement).toEqual([[2]]);
      expect(await queued).toEqual([[3]]);
      expect(injection.workers).toHaveLength(failure === "constructor" ? 1 : 2);
    } finally {
      await f.cleanup();
    }
  },
);

test("an idle worker exit is replaced on the next off-thread transaction", async () => {
  const f = await testDb();
  onTestFinished(() => f.cleanup());
  try {
    expect(await f.db.transaction((q) => q.values(sql`SELECT 1`), { offThread: true })).toEqual([[1]]);
    await injection.workers[0]?.terminate();
    expect(await f.db.transaction((q) => q.values(sql`SELECT 2`), { offThread: true })).toEqual([[2]]);
    expect(injection.workers).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

test.each(["exec", "run"] as const)(
  "worker %s UNIQUE errors retain the main connection's SQLite codes",
  async (method) => {
    const f = await testDb();
    onTestFinished(() => f.cleanup());
    try {
      await f.db.query((q) =>
        q.exec(
          "CREATE TABLE synthetic_unique (owner_id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(owner_id, value));" +
            "INSERT INTO synthetic_unique VALUES ('synthetic-owner', 'duplicate');",
        ),
      );
      const errors = [];
      for (const offThread of [false, true]) {
        const error = await f.db
          .transaction(
            async (q) => {
              if (method === "exec")
                await q.exec("INSERT INTO synthetic_unique VALUES ('synthetic-owner', 'duplicate')");
              else await q.run(sql`INSERT INTO synthetic_unique VALUES ('synthetic-owner', 'duplicate')`);
            },
            { offThread },
          )
          .catch((error: Error) => error);
        expect(error).toBeInstanceOf(Error);
        const native = method === "exec" ? error : (error as Error).cause;
        expect(native).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 2067 });
        errors.push(native);
      }
      expect(errors[1]).toMatchObject({
        message: (errors[0] as Error).message,
        name: (errors[0] as Error).name,
      });
      expect(injection.workers).toHaveLength(1);
      expect(await f.db.transaction((q) => q.values(sql`SELECT 1`), { offThread: true })).toEqual([[1]]);
    } finally {
      await f.cleanup();
    }
  },
);

test.each(["foreign_keys", "journal_mode", "synchronous", "busy_timeout"])(
  "a worker %s pragma mismatch fails startup before the callback and the next transaction recovers",
  async (pragma) => {
    const f = await testDb();
    onTestFinished(() => f.cleanup());
    try {
      injection.pragma = pragma;
      const callback = vi.fn(async (q: Queries) => q.values(sql`SELECT 1`));
      const failed = f.db.transaction(callback, { offThread: true });
      const rejected = expect(failed).rejects.toThrow(`SQLite pragma ${pragma} was not applied`);
      const replacement = f.db.transaction((q) => q.values(sql`SELECT 2`), { offThread: true });
      const settled = Promise.allSettled([failed, replacement]);
      onTestFinished(() => settled.then(() => {}));
      await rejected;
      expect(callback).not.toHaveBeenCalled();
      expect(await replacement).toEqual([[2]]);
      expect(injection.workers).toHaveLength(2);
    } finally {
      await f.cleanup();
    }
  },
);

test("the worker applies all required pragmas before admitting a transaction", async () => {
  const f = await testDb();
  onTestFinished(() => f.cleanup());
  try {
    await f.db.transaction(
      async (q) => {
        for (const [name, expected] of [
          ["foreign_keys", 1],
          ["journal_mode", "wal"],
          ["synchronous", 2],
          ["busy_timeout", 5000],
        ] as const) {
          expect(await q.values(sql.raw(`PRAGMA ${name}`))).toEqual([[expected]]);
        }
      },
      { offThread: true },
    );
  } finally {
    await f.cleanup();
  }
});
