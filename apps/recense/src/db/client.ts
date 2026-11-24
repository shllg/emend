import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, fchmodSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { ensureStateDir, stateFileError, tightenSecretFile } from "../state/files.ts";
import * as schema from "./schema.ts";

// Raw all/get assume object rows; use typed builders or values() for positional SQL.
export type Queries = Omit<SqliteRemoteDatabase<typeof schema>, "transaction" | "all" | "get"> & {
  // Trusted application SQL only, including complete migration chunks.
  exec(sql: string): Promise<void>;
};
type Operation<T> = (queries: Queries) => Promise<T>;

export class NestedDbCallError extends Error {
  constructor() {
    super("Nested database calls are not allowed; use the current query scope");
    this.name = "NestedDbCallError";
  }
}

export interface Db {
  // Await all work through the supplied scope; do not nest calls back into Db.
  query<T>(fn: Operation<T>): Promise<T>;
  // A separate read-only WAL connection sees committed rows during a writer transaction.
  read<T>(fn: Operation<T>): Promise<T>;
  transaction<T>(fn: Operation<T>, options?: { offThread?: boolean }): Promise<T>;
  close(): Promise<void>;
}

// Keep the writer connection on one worker: even COMMIT/fsync and automatic WAL
// checkpoints must not block HTTP. This fixed script uses only Node builtins and
// survives CLI bundling without a separate executable or repo-supplied code.
const transactionWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
for (const [name, expected] of [
  ["foreign_keys", 1], ["journal_mode", "wal"], ["synchronous", 2], ["busy_timeout", 5000],
]) {
  const row = db.prepare("PRAGMA " + name).get();
  if (!row || Object.values(row)[0] !== expected) throw new Error("SQLite pragma " + name + " was not applied");
}
parentPort.on("message", ({ id, query, params, method }) => {
  try {
    let rows;
    if (method === "close") db.close();
    else if (method === "exec") db.exec(query);
    else {
      const statement = db.prepare(query);
      if (method === "run") { statement.run(...params); rows = []; }
      else {
        statement.setReturnArrays(true);
        rows = method === "get" ? statement.get(...params) : statement.all(...params);
      }
    }
    parentPort.postMessage({ id, rows });
    if (method === "close") parentPort.close();
  } catch (error) { parentPort.postMessage({ id, error, code: error.code, errcode: error.errcode }); }
});
`;
function transactionWriter(file: string, onFailure: () => void) {
  const worker = new Worker(transactionWorkerSource, { eval: true, workerData: file });
  const pending = new Map<number, { resolve(value: unknown[]): void; reject(error: Error): void }>();
  const interrupted = new Set<(error: Error) => void>();
  let sequence = 0;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    onFailure();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const reject of interrupted) reject(error);
    interrupted.clear();
  };
  worker.on("error", fail);
  worker.on("exit", () => fail(new Error("Database worker closed")));
  worker.on("message", (message: { id: number; rows: unknown[]; error?: Error; code?: string; errcode?: number }) => {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (!pending.size) worker.unref();
    if (message.error) request?.reject(Object.assign(message.error, { code: message.code, errcode: message.errcode }));
    else request?.resolve(message.rows);
  });
  worker.unref();
  const request = (query: string, params: unknown[], method: string): Promise<unknown[]> => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = sequence++;
      pending.set(id, { resolve, reject });
      worker.ref();
      try {
        worker.postMessage({ id, query, params, method });
      } catch (error) {
        pending.delete(id);
        if (!pending.size) worker.unref();
        reject(error);
      }
    });
  };
  return {
    request,
    get isFailed() {
      return failure !== undefined;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (failure) throw failure;
      const failed = Promise.withResolvers<never>();
      interrupted.add(failed.reject);
      try {
        return await Promise.race([fn(), failed.promise]);
      } finally {
        interrupted.delete(failed.reject);
      }
    },
    exec: (query: string) => request(query, [], "exec").then(() => {}),
    async close() {
      try {
        if (!failure) await request("", [], "close");
      } finally {
        await worker.terminate();
      }
    },
  };
}

export function openDb(file: string): Db {
  ensureStateDir(dirname(file));
  const fd = openSync(file, "a", 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw stateFileError(file, error);
  }
  for (const sidecar of [`${file}-wal`, `${file}-shm`]) tightenSecretFile(sidecar);
  const raw = new DatabaseSync(file);
  try {
    raw.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    for (const [name, expected] of [
      ["journal_mode", "wal"],
      ["busy_timeout", 5000],
      ["foreign_keys", 1],
    ] as const) {
      const row = raw.prepare(`PRAGMA ${name}`).get();
      if (!row || Object.values(row)[0] !== expected) throw new Error(`SQLite pragma ${name} was not applied`);
    }
  } catch (error) {
    raw.close();
    throw error;
  }

  const reader = new DatabaseSync(file, { readOnly: true });
  reader.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA query_only = ON;");
  const reads = new Set<Promise<unknown>>();
  let writer: ReturnType<typeof transactionWriter> | undefined;
  let queue = Promise.resolve();
  const scope = new AsyncLocalStorage<{ active: boolean }>();
  let closing: Promise<void> | undefined;
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  function execute<T>(fn: Operation<T>, transaction: boolean, readOnly = false, offThread = false): Promise<T> {
    if (scope.getStore()?.active) return Promise.reject(new NestedDbCallError());
    if (closing) return Promise.reject(new Error("Database is closed"));
    const connection = readOnly ? reader : raw;
    const run = async () => {
      if (transaction && offThread && !writer) {
        const created = transactionWriter(file, () => {
          // The old worker's exit must not clear a replacement created after its error.
          if (writer === created) writer = undefined;
        });
        writer = created;
      }
      const remote = transaction && offThread ? writer : undefined;
      const exec = async (query: string) => {
        if (remote) await remote.exec(query);
        else connection.exec(query);
      };
      const context = { active: true };
      return scope.run(context, async () => {
        const queries = drizzle(
          async (query, params, method) => {
            if (!context.active) throw new Error("Database query scope has ended");
            if (remote) return { rows: await remote.request(query, params, method) };
            const statement = connection.prepare(query);
            if (method === "run") {
              statement.run(...params);
              return { rows: [] };
            }
            statement.setReturnArrays(true);
            if (method === "get") {
              // The proxy type omits undefined for a missing positional row.
              return { rows: statement.get(...params) as unknown as unknown[] };
            }
            return { rows: statement.all(...params) as unknown as unknown[][] };
          },
          { schema, logger: false },
        );
        const scoped = Object.assign(queries, {
          async exec(query: string) {
            if (!context.active) throw new Error("Database query scope has ended");
            await exec(query);
          },
        });
        let began = false;
        try {
          if (transaction) {
            await exec("BEGIN IMMEDIATE");
            began = true;
          }
          // Failure also ends callbacks paused between queries and releases the queue.
          const value = remote ? await remote.run(() => fn(scoped)) : await fn(scoped);
          if (transaction) await exec("COMMIT");
          return value;
        } catch (error) {
          if (began && !remote?.isFailed) await exec("ROLLBACK");
          throw error;
        } finally {
          context.active = false;
        }
      });
    };
    return readOnly ? run() : enqueue(run);
  }

  return {
    query: (fn) => execute(fn, false),
    read: (fn) => {
      const pending = execute(fn, false, true);
      reads.add(pending);
      pending.then(
        () => reads.delete(pending),
        () => reads.delete(pending),
      );
      return pending;
    },
    transaction: (fn, options) => execute(fn, true, false, options?.offThread),
    close() {
      if (scope.getStore()?.active) return Promise.reject(new NestedDbCallError());
      closing ??= enqueue(async () => {
        await Promise.allSettled(reads);
        await writer?.close();
        reader.close();
        raw.close();
      });
      return closing;
    },
  };
}
