import type { RemoteCallback } from "drizzle-orm/sqlite-proxy";
import { SQLiteRemoteSession } from "drizzle-orm/sqlite-proxy";
import { expect, vi } from "vitest";
import type { AppDeps } from "./app.ts";
import { type PacingPhase, pacing } from "./pacing.ts";
import type { Work } from "./publish/work.ts";

export type PacingUnit = "comment-bytes" | "changed-block-bytes" | "row-date";

export type PacingEvent =
  | { kind: "yield"; phase: PacingPhase }
  | { kind: "statement"; sql: string; method: string; table?: string; rows: number; checkedIds: number }
  | { kind: "executor"; work: Work["kind"] }
  | { kind: "work"; unit: PacingUnit }
  | { kind: "blob-put" | "payload-copy" | "blob-removal" };

type Units = (event: PacingEvent) => number;
export const insertedRows =
  (table?: string): Units =>
  (event) =>
    event.kind === "statement" && (table === undefined || event.table === table) ? event.rows : 0;
export const checkedIds: Units = (event) => (event.kind === "statement" ? event.checkedIds : 0);
export const renderUnits: Units = (event) => Number(event.kind === "executor" || event.kind === "blob-put");
export const unitsOf =
  (kind: "payload-copy" | "blob-removal" | PacingUnit): Units =>
  (event) =>
    Number(event.kind === "work" ? event.unit === kind : event.kind === kind);

/** Include the leading and trailing runs, and reset only at an actual probe event of any phase. */
export function expectPaced(events: PacingEvent[], phase: PacingPhase, units: Units, bound: number) {
  let run = 0;
  let max = 0;
  let total = 0;
  let yields = 0;
  for (const event of events) {
    if (event.kind === "yield") {
      if (event.phase === phase) yields++;
      run = 0;
    } else {
      const count = units(event);
      total += count;
      run += count;
      max = Math.max(max, run);
    }
  }
  // Check the work bound first so mutation failures demonstrate an oversized run, not just a missing label.
  expect(max, `${phase}: units between yields`).toBeLessThanOrEqual(bound);
  expect(total, `${phase}: input must exceed the bound`).toBeGreaterThan(bound);
  expect(yields, `${phase}: at least two yields`).toBeGreaterThanOrEqual(2);
  return total;
}

function statement(sql: string, params: unknown[], method: string): PacingEvent {
  const table = /^insert into "(\w+)"/i.exec(sql)?.[1];
  let rows = 0;
  if (table) {
    if (/from json_each\(/i.test(sql)) {
      // insertChangedBlocks packs one [row id, block id] pair per inserted row.
      rows = JSON.parse(String(params.at(-1))).length;
    } else {
      const values = /\bvalues\s+(.+?)(?:\s+on conflict|\s+returning|$)/i.exec(sql)?.[1];
      if (!values) throw new Error(`Unrecognized insert in pacing observer: ${sql}`);
      rows = [...values.matchAll(/\([^()]*\)/g)].length;
      if (!rows) throw new Error(`Missing insert rows in pacing observer: ${sql}`);
    }
  }
  const checkedIds = /with incoming as \(select value from json_each\(/i.test(sql)
    ? JSON.parse(String(params[0])).length
    : 0;
  return { kind: "statement", sql, method, table, rows, checkedIds };
}

/** Observe real work independently of the probe, including SQL sent to the off-thread writer. */
export function observePacing(deps: AppDeps) {
  const execute = deps.publishExecutor;
  if (!execute) throw new Error("Pacing tests require an explicit executor");
  const events: PacingEvent[] = [];
  const previousProbe = pacing.probe;
  pacing.probe = (phase) => events.push({ kind: "yield", phase });
  const prepare = SQLiteRemoteSession.prototype.prepareQuery;
  const sqlSpy = vi.spyOn(SQLiteRemoteSession.prototype, "prepareQuery").mockImplementation(function (
    this: SQLiteRemoteSession<Record<string, never>, Record<string, never>>,
    ...args
  ) {
    const prepared = prepare.apply(this, args);
    // Drizzle keeps its remote callback private. Both builders and q.run reach this callback;
    // DatabaseSync.prepare on the main thread would miss every off-thread transaction insert.
    const client = (prepared as unknown as { client: RemoteCallback }).client;
    return Object.assign(prepared, {
      client: ((query, params, method) => {
        events.push(statement(query, params, method));
        return client(query, params, method);
      }) satisfies RemoteCallback,
    });
  });
  const payloads = new Set<ArrayBuffer>();
  deps.publishExecutor = async (work) => {
    events.push({ kind: "executor", work: work.kind });
    const result = await execute(work);
    if (result.kind === "placement-doc") payloads.add(result.bytes);
    return result;
  };
  const put = deps.blobs.put.bind(deps.blobs);
  const putSpy = vi.spyOn(deps.blobs, "put").mockImplementation((...args) => {
    events.push({ kind: "blob-put" });
    return put(...args);
  });
  const slice = ArrayBuffer.prototype.slice;
  const sliceSpy = vi.spyOn(ArrayBuffer.prototype, "slice").mockImplementation(function (this: ArrayBuffer, ...args) {
    if (payloads.has(this)) events.push({ kind: "payload-copy" });
    return slice.apply(this, args);
  });
  const unlink = deps.blobs.unlinkIfUnheld.bind(deps.blobs);
  const unlinkSpy = vi.spyOn(deps.blobs, "unlinkIfUnheld").mockImplementation((...args) => {
    events.push({ kind: "blob-removal" });
    return unlink(...args);
  });
  return {
    events,
    record(unit: PacingUnit) {
      events.push({ kind: "work", unit });
    },
    restore() {
      pacing.probe = previousProbe;
      deps.publishExecutor = execute;
      sqlSpy.mockRestore();
      putSpy.mockRestore();
      sliceSpy.mockRestore();
      unlinkSpy.mockRestore();
    },
  };
}
