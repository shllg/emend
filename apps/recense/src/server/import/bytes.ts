import { getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

/** Use the insert encoders, including JSON escaping; callers supply generated ids too. */
export function derivedRowBytes(table: SQLiteTable, row: Record<string, unknown>): number {
  let bytes = 64;
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    const stored = column.mapToDriverValue(value);
    if (typeof stored === "string") bytes += Buffer.byteLength(stored);
  }
  return bytes;
}
