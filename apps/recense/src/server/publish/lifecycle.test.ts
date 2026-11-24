import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import type { Db } from "../../db/client.ts";
import { revisions } from "../../db/schema.ts";
import { testDb } from "../../db/test-support.ts";
import { BlobStore } from "../../store/blobs.ts";
import { createApp } from "../app.ts";
import { createToken } from "../auth/tokens.ts";
import { ingest } from "./ingest.ts";
import { createPublishSlots } from "./lifecycle.ts";
import { executeWork } from "./work.ts";

test("only two publishes get slots and the third has a 30 second wait ceiling", async () => {
  vi.useFakeTimers();
  try {
    const slots = createPublishSlots();
    const a = await slots.acquire();
    const b = await slots.acquire();
    const pending = slots.acquire();
    const rejected = expect(pending).rejects.toMatchObject({
      code: "rate_limited",
      message: "The server is busy publishing; try again.",
    });
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    a();
    b();
    (await slots.acquire())();
  } finally {
    vi.useRealTimers();
  }
});
test("a queued publish is removed on abort and a released slot serves the next waiter", async () => {
  const slots = createPublishSlots();
  const a = await slots.acquire();
  const b = await slots.acquire();
  const controller = new AbortController();
  const cancelled = expect(slots.acquire(controller.signal)).rejects.toMatchObject({ detail: "publish_aborted" });
  controller.abort();
  await cancelled;
  const waiting = slots.acquire();
  a();
  (await waiting)();
  b();
});
test("an abort during changed-block insertion rolls back the entire revision", async () => {
  const f = await testDb();
  const controller = new AbortController();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const input = {
      reviewKey: "a".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic",
      base: null,
      head: null,
      topics: [],
      files: [],
      writeup: { overview: "one", tldr: "", decisions: null, topics: {} },
    };
    const blobs = new BlobStore(f.db, join(f.dir, "state"));
    const deps = { db: f.db, blobs, baseUrl: "http://127.0.0.1:3636", executor: executeWork };
    await ingest(f.ownerId, f.instanceId, input, deps);
    const before = await f.db.read((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)));
    const db: Db = {
      ...f.db,
      transaction: (callback, options) =>
        f.db.transaction(
          (q) =>
            callback(
              new Proxy(q, {
                get(target, key) {
                  if (key !== "run") return Reflect.get(target, key);
                  return async (...args: Parameters<typeof q.run>) => {
                    const result = await q.run(...args);
                    controller.abort();
                    return result;
                  };
                },
              }),
            ),
          options,
        ),
    };
    await expect(
      ingest(
        f.ownerId,
        f.instanceId,
        {
          ...input,
          writeup: { ...input.writeup, overview: "two" },
        },
        {
          ...deps,
          db,
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ detail: "publish_aborted" });
    expect(await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)))).toEqual(before);
    expect(log.mock.calls).toEqual([["recense: publish abandoned"]]);
  } finally {
    log.mockRestore();
    await f.cleanup();
  }
});

test("the real Hono Node adapter aborts publish on client disconnect and commits no revision", async () => {
  const f = await testDb();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const socket = new Socket();
  try {
    const store = new BlobStore(f.db, join(f.dir, "state"));
    const hash = await store.put(f.ownerId, Buffer.from("# Plan"), "text/markdown");
    const token = (await createToken(f.db, f.ownerId, "agent", { instanceId: f.instanceId })).secret;
    const origin = "http://127.0.0.1:3636";
    const app = createApp({
      db: f.db,
      blobs: store,
      instance: { id: f.instanceId, name: "Synthetic" },
      now: Date.now,
      publishExecutor: async (work) => {
        if (work.kind === "doc") {
          started.resolve();
          await release.promise;
        }
        return executeWork(work);
      },
      config: {
        baseUrl: origin,
        allowedHosts: ["127.0.0.1:3636"],
        appOrigins: [origin],
        secureCookieHost: undefined,
        webRoot: f.dir,
        serverKey: "A".repeat(43),
      },
    });
    const body = JSON.stringify({
      reviewKey: "a".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic",
      base: null,
      head: null,
      topics: [],
      files: [{ path: "plan.md", role: "doc", oldPath: null, oldBlob: null, newBlob: hash, flag: null }],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    });
    const incoming = new IncomingMessage(socket);
    incoming.method = "POST";
    incoming.url = "/api/v1/publish";
    incoming.headers = {
      host: "127.0.0.1:3636",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    };
    incoming.rawHeaders = Object.entries(incoming.headers).flatMap(([key, value]) => [key, String(value)]);
    incoming.push(Buffer.from(body));
    incoming.push(null);
    const outgoing = new ServerResponse(incoming);
    let signal: AbortSignal | undefined;
    const listener = getRequestListener(
      (request) => {
        signal = request.signal;
        return app.fetch(request);
      },
      { overrideGlobalObjects: false },
    );
    const serving = listener(incoming, outgoing);
    await started.promise;
    outgoing.destroy();
    outgoing.emit("close");
    expect(signal?.aborted).toBe(true);
    await serving;
    release.resolve();
    expect(await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)))).toEqual([]);
    expect(log.mock.calls).toEqual([["recense: publish abandoned"]]);
  } finally {
    release.resolve();
    socket.destroy();
    log.mockRestore();
    await f.cleanup();
  }
});
