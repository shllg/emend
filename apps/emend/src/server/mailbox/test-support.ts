import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CommentCreated, SendCreated, type Target, ThreadCreated, WaitResult } from "@emend/contract";
import { and, eq, sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import { devices, instances, reviews, revisions } from "../../db/schema.ts";
import { testDb } from "../../db/test-support.ts";
import type { BlobRead } from "../../store/blob-read.ts";
import { BlobStore } from "../../store/blobs.ts";
import { type AppDeps, createApp } from "../app.ts";
import { createToken, SESSION_MS } from "../auth/tokens.ts";
import type { ReviewEvents } from "../events.ts";
import { executeWork } from "../publish/work.ts";

export function guardBlobReads(store: BlobStore): () => Promise<void> {
  const reads = new Set<BlobRead>();
  const open = store.open.bind(store);
  // A plain wrapper survives restoreAllMocks, which many fixtures run before cleanup.
  store.open = async (...args) => {
    const read = await open(...args);
    if (read) reads.add(read);
    return read;
  };
  return async () => {
    const leaked = [...reads].filter((read) => !read.closed);
    reads.clear();
    if (leaked.length === 0) return;
    // Report the leak only after every close has settled, including any that reject.
    await Promise.allSettled(leaked.map((read) => read.close()));
    throw new Error(`${leaked.length} BlobRead${leaked.length === 1 ? "" : "s"} left open at fixture cleanup`);
  };
}

export async function mailboxFixture() {
  const f = await testDb();
  let now = Date.now();
  const otherInstance = randomUUID();
  await f.db.query((q) => q.insert(instances).values({ id: otherInstance, name: "Other synthetic instance" }));
  const agent = (await createToken(f.db, f.ownerId, "agent", { instanceId: f.instanceId })).secret;
  const stranger = (await createToken(f.db, f.otherOwnerId, "agent", { instanceId: f.instanceId })).secret;
  const otherAgent = (await createToken(f.db, f.ownerId, "agent", { instanceId: otherInstance })).secret;
  async function reviewer(ownerId: string) {
    const deviceId = randomUUID();
    await f.db.query((q) => q.insert(devices).values({ id: deviceId, ownerId, kind: "browser", name: "Synthetic" }));
    return (await createToken(f.db, ownerId, "reviewer", { deviceId, now, expiresAt: now + SESSION_MS })).secret;
  }
  const session = await reviewer(f.ownerId);
  const foreign = await reviewer(f.otherOwnerId);
  const origin = "http://127.0.0.1:3636";
  const cleanups: Promise<void>[] = [];
  const deps: AppDeps = {
    db: f.db,
    blobs: new BlobStore(f.db, join(f.dir, "state")),
    instance: { id: f.instanceId, name: "Synthetic" },
    now: () => now,
    publishExecutor: executeWork,
    onBlobCleanup: (cleanup) => {
      cleanups.push(cleanup);
    },
    config: {
      baseUrl: origin,
      allowedHosts: ["127.0.0.1:3636"],
      appOrigins: [origin],
      secureCookieHost: undefined,
      webRoot: f.dir,
      serverKey: "A".repeat(43),
    },
  };
  const checkBlobReads = guardBlobReads(deps.blobs);
  const app = createApp(deps);
  const reviewId = randomUUID();
  await f.db.query((q) =>
    q.insert(reviews).values({
      id: reviewId,
      ownerId: f.ownerId,
      originInstanceId: f.instanceId,
      reviewKey: "a".repeat(64),
      title: "Synthetic review",
      createdAt: now,
    }),
  );
  async function revision(seq: number) {
    const id = randomUUID();
    await f.db.query((q) =>
      q.insert(revisions).values({ id, ownerId: f.ownerId, reviewId, seq, contentKey: randomUUID(), createdAt: now }),
    );
    return id;
  }
  const revisionId = await revision(1);
  const credentials = { reviewer: session, foreign, agent, stranger, otherAgent };
  // undici's Request follows the caller's signal only through a weak reference, so an abort is lost once the
  // Request is collected. Keep every Request that carries a signal alive until cleanup.
  // Tests that call f.app.request directly with a signal wrap their Request in f.keep.
  const liveRequests: Request[] = [];
  const keep = (req: Request) => {
    liveRequests.push(req);
    return req;
  };
  function request(
    path: string,
    method = "POST",
    body?: unknown,
    who: keyof typeof credentials = "reviewer",
    signal?: AbortSignal,
  ) {
    const credential = credentials[who];
    const url = `${origin}/api/v1${path}`;
    const init = {
      method,
      headers: {
        Host: "127.0.0.1:3636",
        Origin: origin,
        "Content-Type": "application/json",
        ...(who === "reviewer" || who === "foreign"
          ? { Cookie: `emend_session=${credential}` }
          : { Authorization: `Bearer ${credential}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    return signal ? app.request(keep(new Request(url, { ...init, signal }))) : app.request(url, init);
  }
  async function thread(body = "Please explain.", target: Target = { kind: "review" }, seq = 1) {
    const response = await request(`/reviews/${reviewId}/threads`, "POST", { revision: seq, target, body });
    expect(response.status).toBe(201);
    return ThreadCreated.parse(await response.json());
  }
  async function comment(threadId: string, body: string) {
    const response = await request(`/threads/${threadId}/comments`, "POST", { body });
    expect(response.status).toBe(201);
    return CommentCreated.parse(await response.json());
  }
  async function send(body: unknown = { revision: 1, kind: "go" }) {
    const response = await request(`/reviews/${reviewId}/sends`, "POST", body);
    expect(response.status).toBe(201);
    return SendCreated.parse(await response.json());
  }
  async function take(waitSeconds = 0, signal?: AbortSignal) {
    const response = await request(`/reviews/${reviewId}/take`, "POST", { waitSeconds }, "agent", signal);
    expect(response.status).toBe(200);
    return WaitResult.parse(await response.json());
  }
  const review = () =>
    f.db.read((q) =>
      q
        .select()
        .from(reviews)
        .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, reviewId)))
        .get(),
    );
  return {
    ...f,
    async cleanup() {
      try {
        await checkBlobReads();
      } finally {
        liveRequests.length = 0;
        await f.cleanup();
      }
    },
    deps,
    app,
    keep,
    /** Wait for the background blob cleanup of every review delete so far. */
    blobCleanup: async () => {
      await Promise.all(cleanups.splice(0));
    },
    request,
    thread,
    comment,
    send,
    take,
    review,
    revision,
    reviewId,
    revisionId,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

export async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

/** Seed an ordered comment series in one statement, without thousands of writer-queue round trips. */
export async function seedComments(
  f: Awaited<ReturnType<typeof mailboxFixture>>,
  threadIds: string | string[],
  count: number,
  {
    author = "user",
    body = "Feedback",
    digits,
    offset = 0,
    reviewId = f.reviewId,
  }: {
    author?: "user" | "agent";
    body?: string;
    digits?: number;
    offset?: number;
    reviewId?: string;
  } = {},
) {
  if (count === 0) return;
  const suffix = digits === undefined ? sql`` : sql` || printf(${`%0${digits}d`}, n + ${offset})`;
  await f.db.query((q) =>
    q.run(sql`
    with recursive numbers(n) as (select 1 union all select n + 1 from numbers where n < ${count})
    insert into comments (id, owner_id, review_id, thread_id, author, body, outcome, created_at, updated_at)
    select ${randomUUID().slice(0, 24)} || printf('%012x', t.key * ${count} + n),
      ${f.ownerId}, ${reviewId}, t.value, ${author}, ${body}${suffix},
      ${author === "agent" ? "held" : null}, ${f.deps.now()}, ${f.deps.now()}
    from json_each(${JSON.stringify(typeof threadIds === "string" ? [threadIds] : threadIds)}) t
    cross join numbers order by t.key, n
  `),
  );
}

/** Resolve after the real registration has set waiting state, without a polling deadline. */
export function nextWaiting(events: ReviewEvents | undefined, ownerId: string, reviewId: string) {
  if (!events) throw new Error("Missing review events");
  const registered = Promise.withResolvers<void>();
  const begin = events.beginWaiting.bind(events);
  const spy = vi.spyOn(events, "beginWaiting").mockImplementation((owner, review, revision) => {
    const end = begin(owner, review, revision);
    if (owner === ownerId && review === reviewId) {
      spy.mockRestore();
      registered.resolve();
    }
    return end;
  });
  return registered.promise;
}

type TakePlan = { query: string; steps: { id: number; parent: number; detail: string }[] };

/** Observe only work done by the operation, including positional Drizzle rows and iterators. */
export async function observeTake<T>(operation: () => Promise<T>) {
  const reads: { query: string; rows: number }[] = [];
  const plans: TakePlan[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    query: string,
  ) {
    const statement = prepare.call(this, query);
    const explain = (...params: Parameters<typeof statement.all>) => {
      if (/\b(comments|sends)\b/i.test(query)) {
        plans.push({
          query,
          steps: prepare
            .call(this, `EXPLAIN QUERY PLAN ${query}`)
            .all(...params)
            .map((row) => ({
              id: Number(row.id),
              parent: Number(row.parent),
              detail: String(row.detail),
            })),
        });
      }
    };
    const all = statement.all.bind(statement);
    vi.spyOn(statement, "all").mockImplementation((...params) => {
      explain(...params);
      const rows = all(...params);
      reads.push({ query, rows: rows.length });
      return rows;
    });
    const get = statement.get.bind(statement);
    vi.spyOn(statement, "get").mockImplementation((...params) => {
      explain(...params);
      const row = get(...params);
      reads.push({ query, rows: row === undefined ? 0 : 1 });
      return row;
    });
    const iterate = statement.iterate.bind(statement);
    vi.spyOn(statement, "iterate").mockImplementation(function* (...params) {
      explain(...params);
      for (const row of iterate(...params)) {
        reads.push({ query, rows: 1 });
        yield row;
      }
      return undefined;
    });
    const run = statement.run.bind(statement);
    vi.spyOn(statement, "run").mockImplementation((...params) => {
      explain(...params);
      return run(...params);
    });
    return statement;
  });
  try {
    const result = await operation();
    return { result, reads, plans, rows: reads.reduce((sum, read) => sum + read.rows, 0) };
  } finally {
    spy.mockRestore();
  }
}

export function expectIndexedTake(plans: TakePlan[]) {
  const details = plans.flatMap(({ steps }) => steps.map(({ detail }) => detail));
  // c and s are the aliases in the claim's pending-comments and FIFO subqueries.
  expect(details.some((line) => /^SEARCH (?:comments|c)\b/.test(line))).toBe(true);
  expect(details.some((line) => /^SEARCH (?:sends|s)\b/.test(line))).toBe(true);
  expect(details.filter((line) => /^SCAN (?:comments|sends|c|s)\b/.test(line))).toEqual([]);
  for (const detail of details.filter((line) => /^SEARCH (?:comments|sends|c|s)\b/.test(line))) {
    const constraints = detail.match(/\(([^)]*)\)/)?.[1]?.trim() ?? "";
    // Primary-key equality fetches individual rows; every other lookup must stay within the review.
    const pointLookup =
      /\bUSING (?:INTEGER )?PRIMARY KEY\b/.test(detail) && /^(?:rowid|id)\s*=\s*\?$/.test(constraints);
    if (!pointLookup) expect(constraints, detail).toMatch(/\breview_id\s*=/);
  }
  const history = plans.filter(({ query }) => /from\s+"?comments"?\s/i.test(query));
  expect(history.length).toBeGreaterThan(0);
  for (const { steps } of history) expect(steps.filter(({ detail }) => /USE TEMP B-TREE/.test(detail))).toEqual([]);
  // The claim groups pending comments and sorts pending Sends; delivered rows are sorted too.
  // Those sorts are intentional. Its indexed pending-comment lookup, like history, must not sort.
  const claim = plans.find(({ query }) => query.includes("with pending_comments as materialized"));
  const pending = claim?.steps.find(({ detail }) => /MATERIALIZE pending_comments\b/.test(detail));
  expect(pending).toBeDefined();
  if (!claim || !pending) throw new Error("Missing pending-comments claim plan");
  const descendants = new Set([pending.id]);
  for (const step of claim.steps) {
    if (descendants.has(step.parent)) descendants.add(step.id);
  }
  expect(claim.steps.filter(({ id, detail }) => descendants.has(id) && /USE TEMP B-TREE/.test(detail))).toEqual([]);
}
