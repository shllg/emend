import {
  type HandoffComment,
  LIMITS,
  MODE_LABELS,
  type Placement,
  type PlacementLocation,
  type Target,
  type UnplacedReason,
  type WaitResult,
} from "@emend/contract";
import { sql } from "drizzle-orm";
import type { Queries } from "../../db/client.ts";
import { ApiError } from "../http/errors.ts";

type Go = Extract<WaitResult, { kind: "go" }>;
type HistoryEntry = HandoffComment["history"][number];
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const placeholder = "00000000-0000-4000-8000-000000000000";
// Reserve the largest envelope, including sequence growth on future revisions.
export const envelopeBytes = Math.max(
  ...Object.entries(MODE_LABELS).map(([mode, modeLabel]) =>
    jsonBytes({
      kind: "go",
      reviewId: placeholder,
      deliveryId: placeholder,
      revision: Number.MAX_SAFE_INTEGER,
      sentOn: Number.MAX_SAFE_INTEGER,
      mode,
      modeLabel,
      instructions: [],
      approvalSetAside: false,
      comments: [],
    }),
  ),
);

function placementReserve(target: Target) {
  // Paths may grow on a later rename. Three UTF-8 bytes per UTF-16 unit bounds
  // permitted paths (controls and lone surrogates are rejected by the contract).
  const path = "界".repeat(LIMITS.pathChars);
  const blockId = "9".repeat(LIMITS.pathChars);
  const range = { start: Number.MAX_SAFE_INTEGER - 1, end: Number.MAX_SAFE_INTEGER };
  let location: unknown;
  switch (target.kind) {
    case "review":
    case "topic":
      location = target;
      break;
    case "file":
      location = { kind: target.kind, path };
      break;
    case "lines":
      location = { kind: target.kind, path, side: target.side, ...range };
      break;
    case "writeup-span":
      location = { kind: target.kind, blockId, ...range };
      break;
    case "doc-span":
      location = { kind: target.kind, path, blockId, ...range };
      break;
    case "source-lines":
    case "html-span":
      location = { kind: target.kind, path, ...range };
      break;
  }
  return Math.max(jsonBytes({ status: "placed", location }), jsonBytes({ status: "unplaced", reason: "not-placed" }));
}

export function commentTargetReserve(target: Target) {
  return (
    jsonBytes({
      id: placeholder,
      threadId: placeholder,
      target,
      body: "",
      placement: null,
      history: [],
      historyTrimmed: true,
    }) -
    4 +
    placementReserve(target) +
    1
  );
}

export function commentReserve(target: Target, body: string) {
  return commentTargetReserve(target) + jsonBytes(body) - 2;
}

const trimmedFieldBytes = Buffer.byteLength(',"historyTrimmed":true');

// Size only the required payload; history is loaded after the whole-Send claim.
// CROSS JOIN keeps selected Sends ahead of the indexed comment membership lookup.
export function pendingCommentSizes(ownerId: string, reviewId: string, revisionId: string) {
  return sql`select c.rowid as insertion_order, c.thread_id, c.send_id, length(cast(json_object(
    'id', c.id, 'threadId', c.thread_id, 'target', json(t.target), 'body', c.body,
    'placement', json(case when p.status = 'placed' and p.location is not null
      then json_object('status', 'placed', 'location', json(p.location))
      else json_object('status', 'unplaced', 'reason', coalesce(p.reason, 'not-placed')) end),
    'history', json('[]')) as blob)) + 1 + ${trimmedFieldBytes} as bytes
    from sends s
    cross join comments c indexed by comments_owner_review_send_idx
      on c.owner_id = ${ownerId} and c.review_id = ${reviewId} and c.send_id = s.id
    join threads t on t.owner_id = ${ownerId} and t.review_id = ${reviewId} and t.id = c.thread_id
    left join placements p on p.owner_id = ${ownerId} and p.review_id = ${reviewId}
      and p.thread_id = c.thread_id and p.revision_id = ${revisionId}
    where s.owner_id = ${ownerId} and s.review_id = ${reviewId}
      and s.delivery_id is null and s.set_aside_at is null and c.author = 'user'`;
}

export function sendSizes() {
  return sql`select send_id, count(*) as comment_count, sum(bytes) as bytes
    from pending_comments group by send_id`;
}

export function placementOrMissing(
  row: { status: "placed" | "unplaced"; location: PlacementLocation | null; reason: UnplacedReason | null } | null,
): Placement {
  if (row?.status === "placed" && row.location) return { status: "placed", location: row.location };
  if (row?.status === "unplaced" && row.reason) return { status: "unplaced", reason: row.reason };
  return { status: "unplaced", reason: "not-placed" };
}

export async function loadHistory(
  ownerId: string,
  q: Queries,
  reviewId: string,
  result: Go,
  commentOrders: Map<string, number>,
  maxBytes: number = LIMITS.handoffBytes,
): Promise<Go> {
  if (!result.comments.length) return result;
  type Carrier = { comment: HandoffComment; count: number };
  const carriers = new Map<number, Carrier>();
  const byThread = new Map<string, number[]>();
  for (const comment of result.comments) {
    const order = commentOrders.get(comment.id);
    if (order === undefined) throw new Error("Missing delivered comment within transaction");
    carriers.set(order, { comment, count: 0 });
    const orders = byThread.get(comment.threadId) ?? [];
    orders.push(order);
    byThread.set(comment.threadId, orders);
  }
  const entries = new Map<number, { order: number; bytes: number; carriers: Carrier[] }>();
  for (const [threadId, orders] of byThread) {
    // Delivered comments arrive in insertion order. One descending cursor per thread
    // reuses overlapping windows and passes each same-handoff comment at most once.
    let cursor = Number.MAX_SAFE_INTEGER;
    let nextSelected = 0;
    let exhausted = false;
    let window: [number, number][] = [];
    for (const order of orders.reverse()) {
      const carrier = carriers.get(order);
      if (!carrier) throw new Error("Missing delivered comment within transaction");
      window = window.filter(([rowid]) => rowid < order);
      while (window.length <= LIMITS.historyPerComment && !exhausted) {
        cursor = Math.min(cursor, order);
        // Contiguous delivered rows cannot contain eligible history. Skip them
        // from the known rowids without fetching or sizing them again in SQLite.
        while (nextSelected < orders.length) {
          const selected = orders[nextSelected];
          if (selected === undefined || selected < cursor - 1) break;
          if (selected === cursor - 1) cursor--;
          nextSelected++;
        }
        const limit = LIMITS.historyPerComment + 1 - window.length;
        const rows = await q.values<[number, number]>(sql`
          select rowid, length(cast(case when outcome is null
            then json_object('author', author, 'body', body)
            else json_object('author', author, 'body', body, 'outcome', outcome) end as blob))
          from comments indexed by comments_owner_review_thread_idx
          where owner_id = ${ownerId} and review_id = ${reviewId} and thread_id = ${threadId}
            and rowid < ${cursor} and (author = 'agent' or send_id is not null)
          order by rowid desc limit ${limit}
        `);
        exhausted = rows.length < limit;
        cursor = rows.at(-1)?.[0] ?? cursor;
        for (const row of rows) if (!carriers.has(row[0])) window.push(row);
      }
      if (window.length > LIMITS.historyPerComment) carrier.comment.historyTrimmed = true;
      // The extra row is only a sentinel. Shared entry sizes and bodies are retained once.
      for (const [rowid, bytes] of window.slice(0, LIMITS.historyPerComment)) {
        const entry = entries.get(rowid) ?? { order: rowid, bytes, carriers: [] };
        entry.carriers.push(carrier);
        entries.set(rowid, entry);
        carrier.count++;
      }
    }
  }
  const ordered = [...entries.values()].sort((a, b) => a.order - b.order);
  let bytes =
    jsonBytes({ ...result, comments: [], instructions: [] }) +
    result.instructions.reduce(
      (sum, instruction) => sum + jsonBytes(instruction),
      Math.max(0, result.instructions.length - 1),
    ) +
    Math.max(0, result.comments.length - 1);
  for (const carrier of carriers.values()) bytes += jsonBytes(carrier.comment) + Math.max(0, carrier.count - 1);
  for (const entry of ordered) bytes += entry.bytes * entry.carriers.length;
  let dropped = 0;
  for (const entry of ordered) {
    if (bytes <= maxBytes) break;
    for (const carrier of entry.carriers) {
      bytes -= entry.bytes + (carrier.count > 1 ? 1 : 0);
      carrier.count--;
      if (!carrier.comment.historyTrimmed) {
        carrier.comment.historyTrimmed = true;
        bytes += trimmedFieldBytes;
      }
    }
    dropped++;
  }
  if (bytes > maxBytes) throw new ApiError("too_large");

  const kept = ordered.slice(dropped);
  // Bound SQL parameters as well as bodies. Shared entries are loaded just once.
  for (let offset = 0; offset < kept.length; offset += LIMITS.historyPerComment) {
    const batch = kept.slice(offset, offset + LIMITS.historyPerComment);
    const bodies = await q.values<[number, HistoryEntry["author"], string, HistoryEntry["outcome"] | null]>(sql`
      select comments.rowid, author, body, outcome from comments not indexed
      where owner_id = ${ownerId} and review_id = ${reviewId}
        and rowid in (${sql.join(
          batch.map(({ order }) => sql`${order}`),
          sql`, `,
        )})
    `);
    const loaded = new Map(
      bodies.map(([order, author, body, outcome]) => [
        order,
        {
          author,
          body,
          ...(outcome ? { outcome } : {}),
        },
      ]),
    );
    for (const entry of batch) {
      const body = loaded.get(entry.order);
      if (!body) throw new Error("History entry disappeared within transaction");
      for (const carrier of entry.carriers) carrier.comment.history.push(body);
    }
  }
  return result;
}
