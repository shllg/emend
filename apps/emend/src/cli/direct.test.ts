import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InboxList, PublishResponse, ReplyCreated, RevisionView, ThreadCreated, WaitResult } from "@emend/contract";
import { sql } from "drizzle-orm";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import * as client from "../db/client.ts";
import { instances, owners, reviews, revisions } from "../db/schema.ts";
import { run } from "../main.ts";
import * as executors from "../server/publish/executor.ts";
import { startServer } from "../server/serve.ts";
import { advanceWhilePaused, trackPauses, untilReal } from "../test/advance-until-settled.ts";
import { workInThread } from "../test/in-thread-worker.ts";
import { deliverFeedback, takeFeedback } from "./commands/wait.ts";
import { directFixture } from "./direct-test-support.ts";
import * as pauseModule from "./pause.ts";
import { resolveTarget } from "./target.ts";
import { provenTestServer } from "./test-support.ts";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    throw new Error("agent must not spawn");
  }),
}));
vi.mock("./pause.ts", async (original) => ({ ...(await original<typeof import("./pause.ts")>()) }));
vi.mock("../db/client.ts", async (original) => ({ ...(await original<typeof import("../db/client.ts")>()) }));
vi.mock("../server/publish/executor.ts", async (original) => ({
  ...(await original<typeof import("../server/publish/executor.ts")>()),
}));

let inThread: ReturnType<typeof workInThread>;
beforeEach(() => {
  inThread = workInThread(executors);
});
// A comparison of two Buffers through toEqual walks every byte; a digest says the same, faster.
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("publish without a server never spawns, renders documents, and is visible to a later reviewer", async () => {
  // The default wiring of a direct publish, its own worker thread, stays covered here.
  inThread.mockRestore();
  const f = await directFixture();
  vi.mocked(spawn).mockClear();
  const out = await f.publish();
  expect(spawn).not.toHaveBeenCalled();
  expect(out.stdout).toEqual([`${JSON.stringify(out.result)}\n`]);
  expect(out.stderr).toEqual([
    `emend: published revision 1: ${out.result.url}\n`,
    "emend: emend is not running; the review opens once it runs (emend serve, or emend service install)\n",
  ]);
  expect(out.result.unrendered).toEqual([]);
  expect(out.result.url).toBe(`http://127.0.0.1:3636/r/${out.result.reviewId}`);
  expect((await stat(f.stateDir)).mode & 0o777).toBe(0o700);
  expect((await stat(join(f.stateDir, "emend.db"))).mode & 0o777).toBe(0o600);
  const server = await f.reviewer();
  const inbox = InboxList.parse(await (await server.request("/reviews")).json());
  expect(inbox.items).toMatchObject([{ id: out.result.reviewId, agentWaiting: false }]);
  const view = RevisionView.parse(await (await server.request(`/reviews/${out.result.reviewId}/revisions/1`)).json());
  expect(view.docs[0]).toMatchObject({ kind: "markdown", blocks: expect.any(Array) });
});

test("publish against a discovered server uses the API without opening a database", async () => {
  const f = await directFixture();
  const first = await f.publish();
  await f.reviewer();
  const proof = provenTestServer(f.stateDir);
  const fetcher = vi.fn(
    async (url: string | URL, init?: RequestInit) =>
      proof(url, init) ?? (init?.method === "HEAD" ? new Response(null, { status: 200 }) : Response.json(first.result)),
  );
  vi.stubGlobal("fetch", fetcher);
  const open = vi.spyOn(client, "openDb");
  const out = await f.publish();
  expect(out.stdout).toEqual(first.stdout);
  expect(out.stderr).toEqual([`emend: published revision 1: ${out.result.url}\n`]);
  expect(open).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/publish"))).toBe(true);
});

test.each(["absent", "stale", "dead pid", "failed proof"])("discovery %s selects direct mode", async (kind) => {
  const f = await directFixture();
  if (kind !== "absent") await writeFile(join(f.dir, "unused"), "synthetic");
  await f.publish();
  if (kind !== "absent")
    await writeFile(
      join(f.stateDir, "server.json"),
      kind === "stale"
        ? "{}"
        : JSON.stringify({
            pid: kind === "dead pid" ? 2147483647 : process.pid,
            url: "http://127.0.0.1:3636",
            key: "A".repeat(43),
          }),
    );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ api: 1, version: "0.1.0", features: [] })),
  );
  expect(await resolveTarget(f.stateDir)).toEqual({ via: "direct" });
});

test("direct feedback and reply share API output, and confirm only after stdout flushes", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  const thread = ThreadCreated.parse(
    await (
      await server.request(`/reviews/${result.reviewId}/threads`, {
        revision: 1,
        target: { kind: "review" },
        body: "Synthetic question",
      })
    ).json(),
  );
  expect((await server.request(`/reviews/${result.reviewId}/sends`, { revision: 1, kind: "go" })).status).toBe(201);
  const out = f.output();
  const writing = Promise.withResolvers<void>();
  const flush = Promise.withResolvers<void>();
  out.io.stdoutAsync = async (line) => {
    out.stdout.push(line);
    writing.resolve();
    await flush.promise;
  };
  const command = run(["feedback", result.reviewId], out.io);
  onTestFinished(async () => {
    flush.resolve();
    await command;
  });
  await writing.promise;
  const confirmed = () =>
    server.db.read((q) => q.values(sql`select confirmed_at from deliveries where owner_id = ${server.ownerId}`));
  expect(await confirmed()).toEqual([[null]]);
  flush.resolve();
  expect(await command).toBe(0);
  expect((await confirmed())[0]?.[0]).toEqual(expect.any(Number));
  expect(WaitResult.parse(JSON.parse(out.stdout.join("")))).toMatchObject({
    kind: "go",
    comments: [{ id: thread.commentId, body: "Synthetic question" }],
  });
  expect(out.stdout).toEqual([`${JSON.stringify(WaitResult.parse(JSON.parse(out.stdout.join(""))))}\n`]);
  const reply = f.output();
  expect(await run(["reply", thread.commentId, "--status", "fixed", "--body", "Synthetic answer"], reply.io)).toBe(0);
  expect(ReplyCreated.parse(JSON.parse(reply.stdout.join("")))).toMatchObject({
    threadId: thread.threadId,
    state: "answered",
  });
  const pending = f.output();
  expect(await run(["feedback", result.reviewId], pending.io)).toBe(0);
  expect(JSON.parse(pending.stdout.join(""))).toEqual({ kind: "pending", reviewId: result.reviewId, waitedSeconds: 0 });
});

test("two direct waits claim a later reviewer Send only once and clear their waiter rows", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const target = await resolveTarget(f.stateDir);
  const server = await f.reviewer();
  // The loser of the claim waits out its whole timeout and each wait polls once a second: fake those
  // timers, but not Date, so leases and waiter expiry keep real time.
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const pauses = trackPauses(pauseModule);
  const controller = new AbortController();
  const first = takeFeedback(f.stateDir, target, result.reviewId, 2, { signal: controller.signal });
  const second = takeFeedback(f.stateDir, target, result.reviewId, 2, { signal: controller.signal });
  // Observe both rejections immediately; teardown aborts and drains before restoring timers/spies.
  const settled = Promise.allSettled([first, second]);
  onTestFinished(async () => {
    controller.abort();
    await settled;
  });
  const rows = () =>
    server.db.read((q) =>
      q.values(sql`select id from agent_waiters where owner_id = ${server.ownerId} and review_id = ${result.reviewId}`),
    );
  await untilReal("both waiter rows", async () => expect(await rows()).toHaveLength(2));
  const inbox = InboxList.parse(await (await server.request("/reviews")).json());
  expect(inbox.items[0]?.agentWaiting).toBe(true);
  expect(
    (await server.request(`/reviews/${result.reviewId}/sends`, { revision: 1, kind: "go", instruction: "Continue" }))
      .status,
  ).toBe(201);
  const results = await advanceWhilePaused(Promise.all([first, second]), pauses);
  expect(results.map((value) => value.kind).sort()).toEqual(["go", "pending"]);
  for (const value of results) await deliverFeedback(f.stateDir, target, value, f.output().io);
  expect(await rows()).toEqual([]);
  expect(InboxList.parse(await (await server.request("/reviews")).json()).items[0]?.agentWaiting).toBe(false);
  expect(await takeFeedback(f.stateDir, target, result.reviewId, 0)).toMatchObject({ kind: "pending" });
});

test("failed stdout leaves a lease unconfirmed and expired feedback is offered again", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  await server.request(`/reviews/${result.reviewId}/sends`, { revision: 1, kind: "approve" });
  const out = f.output();
  out.io.stdoutAsync = async () => {
    throw new Error("closed pipe");
  };
  expect(await run(["wait", result.reviewId, "--timeout", "1"], out.io)).toBe(1);
  expect(
    await server.db.read((q) => q.values(sql`select confirmed_at from deliveries where owner_id = ${server.ownerId}`)),
  ).toEqual([[null]]);
  await server.db.query((q) => q.run(sql`update deliveries set lease_until = 0 where owner_id = ${server.ownerId}`));
  expect(await takeFeedback(f.stateDir, await resolveTarget(f.stateDir), result.reviewId, 0)).toMatchObject({
    kind: "approve",
  });
});

test("SIGTERM before stdout flush prevents confirmation", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  await server.request(`/reviews/${result.reviewId}/sends`, { revision: 1, kind: "approve" });
  const out = f.output();
  const writing = Promise.withResolvers<void>();
  const flush = Promise.withResolvers<void>();
  out.io.stdoutAsync = async () => {
    writing.resolve();
    await flush.promise;
  };
  const command = run(["wait", result.reviewId], out.io);
  onTestFinished(async () => {
    process.emit("SIGTERM");
    flush.resolve();
    await command;
  });
  await writing.promise;
  process.emit("SIGTERM");
  flush.resolve();
  expect(await command).toBe(143);
  expect(out.stderr).toEqual([]);
  expect(
    await server.db.read((q) => q.values(sql`select confirmed_at from deliveries where owner_id = ${server.ownerId}`)),
  ).toEqual([[null]]);
});

test("a direct byte-budget error keeps the Send queued and deletes the waiter", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  const thread = ThreadCreated.parse(
    await (
      await server.request(`/reviews/${result.reviewId}/threads`, {
        revision: 1,
        target: { kind: "review" },
        body: '"'.repeat(20000),
      })
    ).json(),
  );
  await server.request(`/threads/${thread.threadId}/comments`, { body: '"'.repeat(20000) });
  await server.request(`/reviews/${result.reviewId}/sends`, { revision: 1, kind: "go" });
  await expect(
    takeFeedback(f.stateDir, await resolveTarget(f.stateDir), result.reviewId, 1, { maxBytes: 65536 }),
  ).rejects.toMatchObject({ code: "too_large" });
  expect(
    await server.db.read((q) => q.values(sql`select id from agent_waiters where owner_id = ${server.ownerId}`)),
  ).toEqual([]);
  expect(
    await server.db.read((q) => q.values(sql`select delivery_id from sends where owner_id = ${server.ownerId}`)),
  ).toEqual([[null]]);
  expect(await takeFeedback(f.stateDir, await resolveTarget(f.stateDir), result.reviewId, 0)).toMatchObject({
    kind: "go",
    comments: [{}, {}],
  });
});

test.each(["owner", "origin"])("direct waits refuse a foreign %s without leaving waiter rows", async (foreign) => {
  const f = await directFixture();
  await f.publish();
  const server = await f.reviewer();
  const ownerId = foreign === "owner" ? randomUUID() : server.ownerId;
  const instanceId = foreign === "origin" ? randomUUID() : server.instance.id;
  const reviewId = randomUUID();
  await server.db.transaction(async (q) => {
    if (foreign === "owner") await q.insert(owners).values({ id: ownerId });
    else await q.insert(instances).values({ id: instanceId, name: "Synthetic other origin" });
    await q.insert(reviews).values({
      id: reviewId,
      ownerId,
      originInstanceId: instanceId,
      reviewKey: "f".repeat(64),
      title: "Synthetic foreign review",
    });
    await q.insert(revisions).values({ ownerId, reviewId, seq: 1, contentKey: randomUUID() });
  });
  await expect(takeFeedback(f.stateDir, await resolveTarget(f.stateDir), reviewId, 1)).rejects.toMatchObject({
    message: `review ${reviewId} was deleted or never existed`,
  });
  expect(
    await server.db.read((q) => q.values(sql`select id from agent_waiters where owner_id = ${server.ownerId}`)),
  ).toEqual([]);
});

test("direct publish bootstraps a missing state folder with private files", async () => {
  const f = await directFixture();
  await rm(f.stateDir, { recursive: true });
  const manifest = JSON.parse(await readFile(f.manifest, "utf8"));
  await writeFile(f.manifest, JSON.stringify({ ...manifest, files: [] }));
  await f.publish();
  expect((await stat(f.stateDir)).mode & 0o777).toBe(0o700);
  for (const file of ["emend.db", "instance.json"])
    expect((await stat(join(f.stateDir, file))).mode & 0o777).toBe(0o600);
});

test("direct wait renews every ten seconds, reports progress, and removes its row on cancellation", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  const controller = new AbortController();
  const progress = vi.fn(async () => {});
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const wait = takeFeedback(f.stateDir, await resolveTarget(f.stateDir), result.reviewId, 60, {
    signal: controller.signal,
    progress,
  }).catch((error: unknown) => error);
  onTestFinished(async () => {
    controller.abort();
    await wait;
  });
  const expiry = async () =>
    (
      await server.db.read((q) =>
        q.values<[number]>(sql`select expires_at from agent_waiters where owner_id = ${server.ownerId}`),
      )
    )[0]?.[0];
  await untilReal("the waiter row", async () => expect(await expiry()).toEqual(expect.any(Number)));
  try {
    const initial = await expiry();
    await untilReal("the wait's pause timer", () => expect(vi.getTimerCount()).toBeGreaterThan(0));
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await untilReal("the wait's next pause timer", () => expect(vi.getTimerCount()).toBeGreaterThan(0));
    }
    expect(await expiry()).toBeGreaterThan(initial ?? 0);
    expect(progress).toHaveBeenCalledWith(25);
  } finally {
    controller.abort();
    expect(await wait).toMatchObject({ name: "AbortError" });
    expect(await expiry()).toBeUndefined();
  }
});

test("expired waiter rows do not mark the inbox waiting", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  await server.db.query((q) =>
    q.run(
      sql`insert into agent_waiters (id, owner_id, review_id, expires_at) values (${randomUUID()}, ${server.ownerId}, ${result.reviewId}, ${Date.now() - 1})`,
    ),
  );
  expect(InboxList.parse(await (await server.request("/reviews")).json()).items[0]?.agentWaiting).toBe(false);
});

test("server and direct publish on the same state both succeed concurrently", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  const { readTokenFile } = await import("../state/token-file.ts");
  const agent = await readTokenFile(join(f.stateDir, "agent.token"));
  const remote = server.app.request("http://127.0.0.1:3636/api/v1/publish", {
    method: "POST",
    headers: { Host: "127.0.0.1:3636", Authorization: `Bearer ${agent}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      reviewId: result.reviewId,
      reviewKey: "a".repeat(64),
      title: "Synthetic concurrent review",
      repo: null,
      branch: null,
      base: null,
      head: null,
      topics: [],
      files: [],
      writeup: { overview: "Concurrent", tldr: "Review", decisions: null, topics: {} },
    }),
  });
  const [response, direct] = await Promise.all([remote, f.publish()]);
  expect(response.status).toBe(200);
  expect([PublishResponse.parse(await response.json()).revision, direct.result.revision].sort()).toEqual([2, 3]);
});

test.each(["feedback", "serve", "publish"])(
  "%s refuses a newer database with one exact error line and no changes",
  async (command) => {
    const f = await directFixture();
    const { result } = await f.publish();
    const db = client.openDb(join(f.stateDir, "emend.db"));
    await db.query((q) => q.run(sql`insert into __emend_migrations values ('synthetic-future', 'future', 1)`));
    await db.close();
    const before = await readFile(join(f.stateDir, "emend.db"));
    const out = f.output();
    vi.spyOn(process, "cwd").mockReturnValue(f.source);
    const args =
      command === "publish"
        ? ["publish", "--manifest", f.manifest, "--key", "synthetic"]
        : command === "serve"
          ? ["serve", "--port", "0"]
          : ["feedback", result.reviewId];
    expect(await run(args, out.io)).toBe(1);
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual(["The emend database is newer than this emend. Update emend, then try again.\n"]);
    expect(digest(await readFile(join(f.stateDir, "emend.db")))).toBe(digest(before));
  },
);

test("a listening server started after a direct wait records the claimed Send through its reviewer API", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const reviewer = await f.reviewer();
  const controller = new AbortController();
  const target = await resolveTarget(f.stateDir);
  // The wait polls once a second: fake its timers (not Date) and step them once the Send is stored.
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const pauses = trackPauses(pauseModule);
  const wait = takeFeedback(f.stateDir, target, result.reviewId, 3, {
    signal: controller.signal,
  }).catch((error: unknown) => error);
  onTestFinished(async () => {
    controller.abort();
    await wait;
  });
  try {
    await untilReal("the waiter row", async () =>
      expect(
        await reviewer.db.read((q) => q.values(sql`select id from agent_waiters where owner_id = ${reviewer.ownerId}`)),
      ).toHaveLength(1),
    );
    const server = await startServer({ stateDir: f.stateDir, port: 0 });
    f.cleanup.push(server.close);
    const inbox = await fetch(`${server.url}/api/v1/reviews`, { headers: reviewer.headers(server.url) });
    expect(InboxList.parse(await inbox.json()).items).toMatchObject([{ id: result.reviewId, agentWaiting: true }]);
    const response = await fetch(`${server.url}/api/v1/reviews/${result.reviewId}/sends`, {
      method: "POST",
      headers: reviewer.headers(server.url),
      body: JSON.stringify({ revision: 1, kind: "go", instruction: "Continue" }),
    });
    expect(response.status).toBe(201);
    const delivery = await advanceWhilePaused(wait, pauses);
    expect(delivery).toMatchObject({ kind: "go" });
    await deliverFeedback(f.stateDir, target, WaitResult.parse(delivery), f.output().io);
    expect(
      await reviewer.db.read((q) =>
        q.values(sql`select confirmed_at from deliveries where owner_id = ${reviewer.ownerId}`),
      ),
    ).toEqual([[expect.any(Number)]]);
  } finally {
    controller.abort();
    await wait;
  }
});
