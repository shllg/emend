import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Queries } from "../../db/client.ts";
import { changedBlocks } from "../../db/schema.ts";
import { yieldToLoop } from "../pacing.ts";
import { checkPublishSignal } from "./lifecycle.ts";

/** Stream packed JSON-string IDs into bounded inserts, without per-ID objects. */
export async function insertChangedBlocks(
  q: Queries,
  ownerId: string,
  revisionId: string,
  packed: ArrayBuffer,
  signal?: AbortSignal,
) {
  const bytes = Buffer.from(packed);
  let offset = 0;
  while (offset < bytes.length) {
    checkPublishSignal(signal);
    let batch = "[";
    let count = 0;
    while (offset < bytes.length && count < 500) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      // The worker already escaped the ID as a JSON string. Assemble only this
      // bounded batch's text, without allocating per-ID objects or row arrays.
      if (count) batch += ",";
      batch += `["${randomUUID()}",${bytes.toString("utf8", offset, end)}]`;
      offset = newline < 0 ? bytes.length : end + 1;
      count++;
    }
    batch += "]";
    // Each extraction walks one two-field row, rather than rescanning a batch-wide
    // UUID array for every ID. The entire JSON batch remains a bound parameter.
    await q.run(sql`INSERT INTO ${changedBlocks} (id, owner_id, revision_id, block_id)
      SELECT json_extract(value, '$[0]'), ${ownerId}, ${revisionId}, json_extract(value, '$[1]') FROM json_each(${batch})`);
    await yieldToLoop("publish-changed");
  }
}
