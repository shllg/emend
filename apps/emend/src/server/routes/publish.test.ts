import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import { beforeEach, expect, onTestFinished, test } from "vitest";
import { blobs as metadata } from "../../db/schema.ts";
import { testDb } from "../../db/test-support.ts";
import { BlobStore } from "../../store/blobs.ts";
import { createApp } from "../app.ts";
import { createToken } from "../auth/tokens.ts";
import { executeWork } from "../publish/work.ts";

let f: Awaited<ReturnType<typeof testDb>>;
let app: ReturnType<typeof createApp>;
let agent: string;
let foreign: string;
const origin = "http://127.0.0.1:3636";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
beforeEach(async () => {
  f = await testDb();
  onTestFinished(() => f.cleanup());
  agent = (await createToken(f.db, f.ownerId, "agent", { instanceId: f.instanceId })).secret;
  foreign = (await createToken(f.db, f.otherOwnerId, "agent", { instanceId: f.instanceId })).secret;
  app = createApp({
    db: f.db,
    blobs: new BlobStore(f.db, join(f.dir, "state")),
    instance: { id: f.instanceId, name: "Synthetic" },
    now: Date.now,
    publishExecutor: executeWork,
    config: {
      baseUrl: origin,
      allowedHosts: ["127.0.0.1:3636"],
      appOrigins: [origin],
      secureCookieHost: undefined,
      webRoot: f.dir,
      serverKey: "A".repeat(43),
    },
  });
});
function request(
  path: string,
  method: string,
  body?: RequestInit["body"],
  headers: Record<string, string> = {},
  token = agent,
) {
  return app.request(`${origin}/api/v1${path}`, {
    method,
    headers: { Host: "127.0.0.1:3636", Authorization: `Bearer ${token}`, ...headers },
    body,
  });
}
test("HEAD answers 404 for a row whose file is missing or the wrong size, and the next upload repairs it", async () => {
  const bytes = new TextEncoder().encode("# Plan with a lost file");
  const hash = sha(bytes);
  const path = `/blobs/${hash}`;
  const file = join(f.dir, "state", "blobs", hash.slice(0, 2), hash);
  const upload = () => request(path, "PUT", bytes, { "Content-Length": String(bytes.length) });
  expect((await upload()).status).toBe(204);
  expect((await request(path, "HEAD")).status).toBe(204);
  await rm(file);
  expect((await request(path, "HEAD")).status).toBe(404);
  expect((await upload()).status).toBe(204);
  expect((await request(path, "HEAD")).status).toBe(204);
  await writeFile(file, bytes.subarray(0, 3), { mode: 0o600 });
  expect((await request(path, "HEAD")).status).toBe(404);
  expect((await upload()).status).toBe(204);
  expect((await request(path, "HEAD")).status).toBe(204);
  expect(new Uint8Array(await readFile(file))).toEqual(bytes);
});

test("blob upload checks hash and actual size; HEAD is owner scoped; publish uses the stored blob", async () => {
  const bytes = new TextEncoder().encode("# Plan");
  const hash = sha(bytes);
  const path = `/blobs/${hash}`;
  expect((await request(path, "HEAD")).status).toBe(404);
  expect((await request(path, "PUT", bytes, { "Content-Length": String(bytes.length) })).status).toBe(204);
  expect((await request(path, "HEAD")).status).toBe(204);
  expect((await request(path, "HEAD", undefined, {}, foreign)).status).toBe(404);
  for (const [body, length] of [
    [new Uint8Array([1, 2]), "2"],
    [bytes, "99"],
    [bytes, "1"],
  ] as const) {
    const response = await request(`/blobs/${"a".repeat(64)}`, "PUT", body, { "Content-Length": length });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "blob_mismatch" } });
  }
  const input = {
    reviewKey: "b".repeat(64),
    repo: null,
    branch: null,
    title: "Synthetic",
    base: null,
    head: null,
    topics: [],
    writeup: { overview: "hello", tldr: "summary", decisions: null, topics: {} },
    files: [{ path: "plan.md", role: "doc", oldPath: null, oldBlob: null, newBlob: hash, flag: null }],
  };
  const response = await request("/publish", "POST", JSON.stringify(input), { "Content-Type": "application/json" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ revision: 1, placed: 0, unplaced: 0 });
});
test("blob upload accepts the asset byte limit and refuses one byte over", async () => {
  const bytes = new Uint8Array(LIMITS.assetBytes);
  const path = `/blobs/${sha(bytes)}`;
  expect((await request(path, "PUT", bytes, { "Content-Length": String(LIMITS.assetBytes) })).status).toBe(204);
  expect((await request(path, "HEAD")).status).toBe(204);
  const response = await request(path, "PUT", undefined, { "Content-Length": String(LIMITS.assetBytes + 1) });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: "too_large" } });
});

test("blob upload refuses streamed bytes over the asset limit despite an allowed declared length", async () => {
  const hash = "e".repeat(64);
  const path = `/blobs/${hash}`;
  const chunk = new Uint8Array(64 * 1024);
  let remaining = LIMITS.assetBytes + 1;
  const body = new ReadableStream(
    {
      pull(controller) {
        const length = Math.min(remaining, chunk.length);
        controller.enqueue(chunk.subarray(0, length));
        remaining -= length;
        if (remaining === 0) controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const raw = new Request(`${origin}/api/v1${path}`, {
    method: "PUT",
    headers: {
      Host: "127.0.0.1:3636",
      Authorization: `Bearer ${agent}`,
      "Content-Length": String(LIMITS.assetBytes),
    },
    body,
    duplex: "half",
  } as RequestInit);
  const response = await app.request(raw);
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: "too_large" } });
  expect(remaining).toBe(0);
  expect((await request(path, "HEAD")).status).toBe(404);
  // Temporary uploads live beside the final blob, without a separate staging folder.
  expect(await readdir(join(f.dir, "state", "blobs", hash.slice(0, 2)))).toEqual([]);
});

test("raw upload validates length and hash and authenticates before pulling bytes", async () => {
  for (const length of [undefined, "-1", "1.5", "bad"]) {
    const response = await request(
      `/blobs/${"a".repeat(64)}`,
      "PUT",
      undefined,
      length === undefined ? {} : { "Content-Length": length },
    );
    expect(response.status).toBe(400);
  }
  expect((await request("/blobs/bad", "HEAD")).status).toBe(400);
  expect(
    (
      await request(
        `/blobs/${"a".repeat(64)}`,
        "PUT",
        undefined,
        { "Content-Length": String(LIMITS.assetBytes + 1) },
        "invalid",
      )
    ).status,
  ).toBe(413);
  let pulled = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([0]));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const raw = new Request(`${origin}/api/v1/blobs/${"a".repeat(64)}`, {
    method: "PUT",
    headers: { Host: "127.0.0.1:3636", "Content-Length": "1" },
    body,
    duplex: "half",
  } as RequestInit);
  expect((await app.request(raw)).status).toBe(401);
  expect(pulled).toBe(false);
});

test("shared assets count against each HTML doc's bundle limit", async () => {
  const [small, large, a, b] = ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64)];
  // The first doc fits exactly; the shared assets put the second doc one byte over.
  await f.db.query((q) =>
    q.insert(metadata).values([
      { ownerId: f.ownerId, sha256: small, size: LIMITS.htmlDocBytes - 1, mediaType: "text/html" },
      { ownerId: f.ownerId, sha256: large, size: LIMITS.htmlDocBytes, mediaType: "text/html" },
      { ownerId: f.ownerId, sha256: a, size: LIMITS.assetBytes, mediaType: "image/png" },
      {
        ownerId: f.ownerId,
        sha256: b,
        size: LIMITS.htmlDocWithAssetsBytes - LIMITS.assetBytes - (LIMITS.htmlDocBytes - 1),
        mediaType: "image/png",
      },
    ]),
  );
  const base = { oldPath: null, oldBlob: null, flag: null };
  const response = await request(
    "/publish",
    "POST",
    JSON.stringify({
      reviewKey: "a".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic",
      base: null,
      head: null,
      topics: [],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      files: [
        { ...base, path: "a.html", role: "doc", newBlob: small, assets: ["a.png", "b.png"] },
        { ...base, path: "b.html", role: "doc", newBlob: large, assets: ["a.png", "b.png"] },
        { ...base, path: "a.png", role: "asset", newBlob: a, parent: "a.html" },
        { ...base, path: "b.png", role: "asset", newBlob: b, parent: "a.html" },
      ],
    }),
    { "Content-Type": "application/json" },
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: "too_large" } });
});

test("slow doc computation leaves capabilities and authenticated blob requests responsive", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const store = new BlobStore(f.db, join(f.dir, "slow-state"));
  const hash = await store.put(f.ownerId, Buffer.from("# Slow"), "text/markdown");
  app = createApp({
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
  const body = {
    reviewKey: "d".repeat(64),
    repo: null,
    branch: null,
    title: "Slow",
    base: null,
    head: null,
    topics: [],
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    files: [{ path: "slow.md", role: "doc", oldPath: null, oldBlob: null, newBlob: hash, flag: null }],
  };
  const publishing = request("/publish", "POST", JSON.stringify(body), { "Content-Type": "application/json" });
  onTestFinished(async () => {
    release.resolve();
    await publishing;
  });
  await started.promise;
  try {
    const responses = await Promise.all([request("/capabilities", "GET"), request(`/blobs/${hash}`, "HEAD")]);
    expect(responses.map((r) => r.status)).toEqual([200, 204]);
  } finally {
    release.resolve();
    expect((await publishing).status).toBe(200);
  }
});

test.each([false, true])("writeup failure responses use fixed public stage messages (timeout=%s)", async (timeout) => {
  const { WorkTimeout } = await import("../publish/executor.ts");
  app = createApp({
    db: f.db,
    blobs: new BlobStore(f.db, join(f.dir, "error-state")),
    instance: { id: f.instanceId, name: "Synthetic" },
    now: Date.now,
    publishExecutor: async () => {
      throw timeout ? new WorkTimeout() : new Error("private renderer details");
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
  const body = {
    reviewKey: "e".repeat(64),
    repo: null,
    branch: null,
    title: "Synthetic",
    base: null,
    head: null,
    topics: [],
    files: [],
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
  };
  const response = await request("/publish", "POST", JSON.stringify(body), { "Content-Type": "application/json" });
  expect(response.status).toBe(timeout ? 413 : 400);
  expect(await response.json()).toEqual({
    error: {
      code: timeout ? "too_large" : "invalid_request",
      message: timeout ? "The writeup rendering timed out." : "The writeup could not be rendered.",
    },
  });
});
