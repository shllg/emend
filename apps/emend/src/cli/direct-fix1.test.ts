import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import * as client from "../db/client.ts";
import * as waiters from "../db/repo/waiters.ts";
import { run } from "../main.ts";
import { verifyBearer } from "../server/auth/tokens.ts";
import * as executors from "../server/publish/executor.ts";
import { startServer } from "../server/serve.ts";
import { initializeServerState } from "../server/state.ts";
import * as tokenFiles from "../state/token-file.ts";
import { workInThread } from "../test/in-thread-worker.ts";
import { takeFeedback } from "./commands/wait.ts";
import { directFixture } from "./direct-test-support.ts";
import { sandboxHint } from "./http.ts";
import * as timers from "./pause.ts";

vi.mock("../db/client.ts", async (original) => ({ ...(await original<typeof import("../db/client.ts")>()) }));
vi.mock("../db/repo/waiters.ts", async (original) => ({
  ...(await original<typeof import("../db/repo/waiters.ts")>()),
}));
vi.mock("../state/token-file.ts", async (original) => ({
  ...(await original<typeof import("../state/token-file.ts")>()),
}));
vi.mock("../server/publish/executor.ts", async (original) => ({
  ...(await original<typeof import("../server/publish/executor.ts")>()),
}));
vi.mock("./pause.ts", async (original) => ({ ...(await original<typeof import("./pause.ts")>()) }));

beforeEach(() => {
  workInThread(executors);
});

test("direct publish leaves missing tokens absent; the next server bootstrap creates both", async () => {
  const f = await directFixture();
  const read = vi.spyOn(tokenFiles, "readTokenFile");
  await f.publish();
  expect(read).not.toHaveBeenCalled();
  for (const kind of ["agent", "admin"])
    await expect(stat(join(f.stateDir, `${kind}.token`))).rejects.toMatchObject({ code: "ENOENT" });
  const server = await initializeServerState(f.stateDir);
  f.cleanup.push(() => server.db.close());
  for (const kind of ["agent", "admin"]) {
    const path = join(f.stateDir, `${kind}.token`);
    const secret = await readFile(path, "utf8");
    expect((await verifyBearer(server.db, `Bearer ${secret}`, Date.now()))?.kind).toBe(kind);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }
});

test("direct publish never reads or repairs existing token files", async () => {
  const f = await directFixture();
  for (const kind of ["agent", "admin"])
    await writeFile(join(f.stateDir, `${kind}.token`), "synthetic-invalid", { mode: 0o600 });
  const read = vi.spyOn(tokenFiles, "readTokenFile");
  await f.publish();
  expect(read).not.toHaveBeenCalled();
  for (const kind of ["agent", "admin"])
    expect(await readFile(join(f.stateDir, `${kind}.token`), "utf8")).toBe("synthetic-invalid");
});

test("concurrent bootstraps leave both token files authenticating as their kind", async () => {
  const f = await directFixture();
  const committed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const openDb = client.openDb;
  let first = true;
  vi.spyOn(client, "openDb").mockImplementation((file) => {
    const db = openDb(file);
    if (!first) return db;
    first = false;
    let calls = 0;
    return {
      ...db,
      async transaction(fn, options) {
        const result = await db.transaction(fn, options);
        if (++calls === 2) {
          committed.resolve();
          await release.promise;
        }
        return result;
      },
    };
  });
  const initial = initializeServerState(f.stateDir);
  onTestFinished(async () => {
    release.resolve();
    await (await initial).db.close();
  });
  await committed.promise;
  try {
    const others = await Promise.all(Array.from({ length: 3 }, () => initializeServerState(f.stateDir)));
    for (const state of others) f.cleanup.push(() => state.db.close());
  } finally {
    release.resolve();
  }
  const state = await initial;
  for (const kind of ["agent", "admin"]) {
    const secret = await readFile(join(f.stateDir, `${kind}.token`), "utf8");
    expect((await verifyBearer(state.db, `Bearer ${secret}`, Date.now()))?.kind).toBe(kind);
  }
});

test.each(["https://review.example", "http://127.0.0.1:4545"])(
  "direct publish uses saved origin %s",
  async (baseUrl) => {
    const f = await directFixture();
    await writeFile(join(f.stateDir, "server-url.json"), JSON.stringify({ baseUrl }));
    const { result } = await f.publish();
    expect(result.url).toBe(`${baseUrl}/r/${result.reviewId}`);
  },
);

test.each([
  "not json",
  "null",
  "[]",
  "{}",
  '{"baseUrl":4}',
  ...[
    "ftp://review.example",
    "https://user:pass@review.example",
    "https://review.example/path",
    "https://review.example/?x",
    "https://review.example/#x",
    "https://review.example/?",
    "https://review.example/#",
    " https://review.example",
    "https://review.example/../",
    "https://review.example\\path",
  ].map((baseUrl) => JSON.stringify({ baseUrl })),
])("direct publish falls back for invalid saved origin %s", async (source) => {
  const f = await directFixture();
  await writeFile(join(f.stateDir, "server-url.json"), source);
  const { result } = await f.publish();
  expect(result.url).toBe(`http://127.0.0.1:3636/r/${result.reviewId}`);
});

test("a stopped server leaves its private public origin for direct publish", async () => {
  const f = await directFixture();
  const server = await startServer({ stateDir: f.stateDir, port: 0, publicOrigin: "https://review.example" });
  f.cleanup.push(server.close);
  server.setPublicOriginReady(true);
  await server.close();
  const path = join(f.stateDir, "server-url.json");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ baseUrl: "https://review.example" });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const { result } = await f.publish();
  expect(result.url).toBe(`https://review.example/r/${result.reviewId}`);
});

test("attached publish without a local server refuses an unreachable hub without falling back", async () => {
  const f = await directFixture();
  await writeFile(
    join(f.stateDir, "attach.json"),
    JSON.stringify({ hubId: randomUUID(), hubName: "Synthetic hub", hubUrl: "https://hub.example" }),
  );
  await writeFile(join(f.stateDir, "hub.token"), `em_${"a".repeat(43)}`, { mode: 0o600 });
  const fetcher = vi.fn(() => {
    throw new Error("Synthetic unavailable hub");
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(f.publish()).rejects.toThrow(
    "cannot reach the hub at https://hub.example: connection failed. Nothing was changed.",
  );
  expect(fetcher).toHaveBeenCalledOnce();
  await expect(stat(join(f.stateDir, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("direct wait takes a Send that arrives during its final sleep", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(timers, "pause").mockImplementation(async () => {
    await server.request(`/reviews/${result.reviewId}/sends`, { revision: 1, kind: "approve" });
    now = 1000;
  });
  expect(await takeFeedback(f.stateDir, { via: "direct" }, result.reviewId, 1)).toMatchObject({ kind: "approve" });
});

test("the next wait removes only its owner's expired rows", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  const foreignOwner = randomUUID();
  const foreignReview = randomUUID();
  const expired = randomUUID();
  const live = randomUUID();
  const foreign = randomUUID();
  await server.db.transaction(async (q) => {
    await q.run(sql`insert into owners (id) values (${foreignOwner})`);
    await q.run(
      sql`insert into reviews (id, owner_id, origin_instance_id, review_key, title, created_at, updated_at) values (${foreignReview}, ${foreignOwner}, ${server.instance.id}, ${"f".repeat(64)}, 'Synthetic', 1, 1)`,
    );
    for (const [id, owner, review, expiry] of [
      [expired, server.ownerId, result.reviewId, 1],
      [live, server.ownerId, result.reviewId, Date.now() + 60000],
      [foreign, foreignOwner, foreignReview, 1],
    ])
      await q.run(
        sql`insert into agent_waiters (id, owner_id, review_id, expires_at) values (${id}, ${owner}, ${review}, ${expiry})`,
      );
  });
  await server.request(`/reviews/${result.reviewId}/sends`, { revision: 1, kind: "approve" });
  await takeFeedback(f.stateDir, { via: "direct" }, result.reviewId, 1);
  expect(await server.db.read((q) => q.values(sql`select id from agent_waiters order by id`))).toEqual(
    [live, foreign].sort().map((id) => [id]),
  );
});

test.each(["result", "error"])("wait cleanup failure preserves the original %s", async (outcome) => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  await server.request(`/reviews/${result.reviewId}/sends`, { revision: 1, kind: "approve" });
  vi.spyOn(waiters, "endWait").mockRejectedValue(new Error("synthetic cleanup failure"));
  if (outcome === "result")
    expect(await takeFeedback(f.stateDir, { via: "direct" }, result.reviewId, 1)).toMatchObject({ kind: "approve" });
  else {
    const error = new Error("synthetic original failure");
    const controller = new AbortController();
    const beginWait = waiters.beginWait;
    vi.spyOn(waiters, "beginWait").mockImplementation(async (...args) => {
      const id = await beginWait(...args);
      controller.abort(error);
      return id;
    });
    await expect(
      takeFeedback(f.stateDir, { via: "direct" }, result.reviewId, 1, { signal: controller.signal }),
    ).rejects.toBe(error);
  }
});

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)("%s during direct waiting exits silently and removes its row", async (signal, code) => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  const out = f.output();
  const before = process.listenerCount(signal);
  const started = Promise.withResolvers<void>();
  const beginWait = waiters.beginWait;
  vi.spyOn(waiters, "beginWait").mockImplementation(async (...args) => {
    const id = await beginWait(...args);
    started.resolve();
    return id;
  });
  const command = run(["wait", result.reviewId], out.io);
  const rows = () =>
    server.db.read((q) => q.values(sql`select id from agent_waiters where owner_id = ${server.ownerId}`));
  await started.promise;
  expect(await rows()).toHaveLength(1);
  process.emit(signal);
  expect(await command).toBe(code);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual([]);
  expect(await rows()).toEqual([]);
  expect(process.listenerCount(signal)).toBe(before);
});

test.skipIf(process.getuid?.() === 0).each(["publish", "wait"])(
  "%s reports an unwritable state parent in one exact line",
  async (command) => {
    const f = await directFixture();
    const parent = join(f.dir, "readonly");
    await mkdir(parent, { mode: 0o500 });
    const stateDir = join(parent, "missing", "state");
    const manifest = JSON.parse(await readFile(f.manifest, "utf8"));
    await writeFile(f.manifest, JSON.stringify({ ...manifest, files: [] }));
    vi.spyOn(process, "cwd").mockReturnValue(f.source);
    const out = f.output();
    out.io.env.EMEND_HOME = stateDir;
    try {
      expect(
        await run(
          command === "publish"
            ? ["publish", "--manifest", f.manifest, "--key", "synthetic"]
            : ["wait", randomUUID(), "--timeout", "1"],
          out.io,
        ),
      ).toBe(1);
      expect(out.stdout).toEqual([]);
      expect(out.stderr).toEqual([`emend cannot write its state folder ${stateDir}. ${sandboxHint}\n`]);
    } finally {
      await chmod(parent, 0o700);
    }
  },
);

test.each(["publish", "wait"])("%s preserves the state-mode chmod diagnostic", async (command) => {
  const f = await directFixture();
  await chmod(f.stateDir, 0o750);
  vi.spyOn(process, "cwd").mockReturnValue(f.source);
  const out = f.output();
  expect(
    await run(
      command === "publish"
        ? ["publish", "--manifest", f.manifest, "--key", "synthetic"]
        : ["wait", randomUUID(), "--timeout", "1"],
      out.io,
    ),
  ).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual([
    `State directory ${f.stateDir} has group or other permissions; fix it with chmod 700 '${f.stateDir}'\n`,
  ]);
});

test.each(["wait", "feedback"])(
  "%s abandons direct confirmation on either signal during stdout flush",
  async (command) => {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const f = await directFixture();
      const { result } = await f.publish();
      const server = await f.reviewer();
      await server.request(`/reviews/${result.reviewId}/sends`, { revision: 1, kind: "approve" });
      const out = f.output();
      const writing = Promise.withResolvers<void>();
      const flush = Promise.withResolvers<void>();
      out.io.stdoutAsync = async (line) => {
        out.stdout.push(line);
        writing.resolve();
        await flush.promise;
      };
      const pending = run([command, result.reviewId], out.io);
      onTestFinished(async () => {
        process.emit(signal);
        flush.resolve();
        await pending;
      });
      await writing.promise;
      process.emit(signal);
      try {
        expect(await pending).toBe(code);
        expect(out.stderr).toEqual([]);
        expect(out.stdout).toHaveLength(1);
        expect(
          await server.db.read((q) =>
            q.values(sql`select confirmed_at from deliveries where owner_id = ${server.ownerId}`),
          ),
        ).toEqual([[null]]);
        await server.db.query((q) =>
          q.run(sql`update deliveries set lease_until = 0 where owner_id = ${server.ownerId}`),
        );
        expect(await takeFeedback(f.stateDir, { via: "direct" }, result.reviewId, 0)).toMatchObject({
          kind: "approve",
        });
      } finally {
        flush.resolve();
      }
    }
  },
);
