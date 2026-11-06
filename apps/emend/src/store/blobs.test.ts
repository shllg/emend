import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { constants } from "node:fs";
import {
  appendFile,
  chmod,
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ReadableStreamReadResult } from "node:stream/web";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { blobs } from "../db/schema.ts";
import { testDb } from "../db/test-support.ts";
import { BlobReadCache, VERIFIED_LIMIT } from "./blob-read.ts";
import { BlobMismatchError, BlobStore } from "./blobs.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});

afterEach(() => vi.restoreAllMocks());

test("blobs share content-addressed files but require a separate owner row", async () => {
  const ctx = await testDb();
  const store = new BlobStore(ctx.db, ctx.dir);
  const bytes = new TextEncoder().encode("Synthetic blob content");
  const expected = createHash("sha256").update(bytes).digest("hex");
  try {
    const sha = await store.put(ctx.ownerId, bytes, "text/plain");
    expect(sha).toBe(expected);
    const file = join(ctx.dir, "blobs", sha.slice(0, 2), sha);
    expect(new Uint8Array(await readFile(file))).toEqual(bytes);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(ctx.dir, "blobs", sha.slice(0, 2)))).mode & 0o777).toBe(0o700);
    expect((await stat(join(ctx.dir, "blobs"))).mode & 0o777).toBe(0o700);
    expect(await store.has(ctx.ownerId, sha)).toBe(true);
    expect(await store.get(ctx.ownerId, sha)).toEqual(bytes);
    expect(await store.has(ctx.otherOwnerId, sha)).toBe(false);
    expect(await store.get(ctx.otherOwnerId, sha)).toBeNull();
    await store.put(ctx.ownerId, bytes, "text/plain", sha);
    await store.put(ctx.otherOwnerId, bytes, "text/plain");
    expect(await store.get(ctx.otherOwnerId, sha)).toEqual(bytes);
    expect(await readdir(join(ctx.dir, "blobs", sha.slice(0, 2)))).toEqual([sha]);
    expect(
      await ctx.db.query((q) =>
        q
          .select()
          .from(blobs)
          .where(and(eq(blobs.ownerId, ctx.ownerId), eq(blobs.sha256, sha))),
      ),
    ).toEqual([{ ownerId: ctx.ownerId, sha256: sha, size: bytes.length, mediaType: "text/plain" }]);
  } finally {
    await ctx.cleanup();
  }
});

test("a mismatched expected hash creates neither a file nor an owner row", async () => {
  const ctx = await testDb();
  const store = new BlobStore(ctx.db, ctx.dir);
  try {
    await expect(
      store.put(ctx.ownerId, new Uint8Array([1, 2, 3]), "application/octet-stream", "a".repeat(64)),
    ).rejects.toBeInstanceOf(BlobMismatchError);
    expect(await ctx.db.query((q) => q.select().from(blobs).where(eq(blobs.ownerId, ctx.ownerId)))).toEqual([]);
    await expect(stat(join(ctx.dir, "blobs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.has(ctx.ownerId, "a".repeat(64))).toBe(false);
    expect(await store.get(ctx.ownerId, "a".repeat(64))).toBeNull();
    expect(await store.get(ctx.ownerId, "../../outside")).toBeNull();
  } finally {
    await ctx.cleanup();
  }
});

test("blob reuse tightens folders and files, refuses truncated reads and repairs corrupt content", async () => {
  const ctx = await testDb();
  const store = new BlobStore(ctx.db, ctx.dir);
  // Pick synthetic content that exercises the ab shard specified by the state layout.
  let bytes = new Uint8Array();
  for (let i = 0; ; i++) {
    bytes = new TextEncoder().encode(`Synthetic ab blob ${i}`);
    if (createHash("sha256").update(bytes).digest("hex").startsWith("ab")) break;
  }
  try {
    const sha = await store.put(ctx.ownerId, bytes, "text/plain");
    const shard = join(ctx.dir, "blobs", "ab");
    const file = join(shard, sha);
    for (const reuse of [
      () => store.put(ctx.ownerId, bytes, "text/plain"),
      () => store.get(ctx.ownerId, sha),
      async () => {
        const read = await store.open(ctx.ownerId, sha);
        expect(read).not.toBeNull();
        await read?.close();
      },
    ]) {
      await chmod(join(ctx.dir, "blobs"), 0o755);
      await chmod(shard, 0o755);
      await chmod(file, 0o644);
      await reuse();
      expect((await stat(join(ctx.dir, "blobs"))).mode & 0o777).toBe(0o700);
      expect((await stat(shard)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    await writeFile(file, bytes.subarray(0, 3));
    expect(await store.get(ctx.ownerId, sha)).toBeNull();
    await store.put(ctx.ownerId, bytes, "text/plain");
    expect(await store.get(ctx.ownerId, sha)).toEqual(bytes);
    await writeFile(file, new Uint8Array(bytes.length));
    await store.put(ctx.ownerId, bytes, "text/plain");
    expect(await store.get(ctx.ownerId, sha)).toEqual(bytes);
  } finally {
    await ctx.cleanup();
  }
});

async function streamFixture(bytes = Uint8Array.from({ length: 300 * 1024 }, (_, i) => i % 251)) {
  const ctx = await testDb();
  const store = new BlobStore(ctx.db, ctx.dir);
  const sha = await store.put(ctx.ownerId, bytes, "application/octet-stream");
  const file = join(ctx.dir, "blobs", sha.slice(0, 2), sha);
  const probe = await open(file, "r");
  const prototype: FileHandle = Object.getPrototypeOf(probe);
  await probe.close();
  const stats = vi.spyOn(prototype, "stat");
  const opens = vi.spyOn(store, "open");
  return {
    ...ctx,
    store,
    sha,
    file,
    bytes,
    prototype,
    originalRead: prototype.read,
    reads: vi.spyOn(prototype, "read"),
    stats,
    expectClosed(count: number) {
      expect(opens).toHaveBeenCalledTimes(count);
      const handles = [...new Set(stats.mock.contexts as FileHandle[])];
      expect(handles).toHaveLength(count);
      expect(handles.filter((handle) => handle.fd === -1)).toHaveLength(count);
    },
  };
}

function observeClose(handle: FileHandle) {
  const closed = Promise.withResolvers<void>();
  const original = handle.close.bind(handle);
  const close = vi.spyOn(handle, "close").mockImplementation(async () => {
    await original();
    closed.resolve();
  });
  return { close, closed: closed.promise };
}

test("an already aborted open finishes verification, closes its descriptor and returns null", async () => {
  const f = await streamFixture();
  const controller = new AbortController();
  controller.abort();
  const read = await f.store.open(f.ownerId, f.sha, controller.signal);
  try {
    expect(read).toBeNull();
    expect(f.reads).toHaveBeenCalledTimes(Math.ceil(f.bytes.length / (64 * 1024)) + 1);
    f.expectClosed(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    await read?.close();
    await f.cleanup();
  }
});

test("aborting an opened blob closes its descriptor even when no stream was taken", async () => {
  const f = await streamFixture();
  const controller = new AbortController();
  const read = await f.store.open(f.ownerId, f.sha, controller.signal);
  try {
    if (!read) throw new Error("Missing blob");
    const { close, closed } = observeClose(f.stats.mock.contexts[0] as FileHandle);
    expect(read.closed).toBe(false);
    controller.abort();
    expect(read.closed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    await closed;
    f.expectClosed(1);
    expect(() => read.stream()).toThrow("closed");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    await read?.close();
    await f.cleanup();
  }
});

test("aborting mid-stream closes the descriptor and errors the next pull", async () => {
  const f = await streamFixture();
  const controller = new AbortController();
  const read = await f.store.open(f.ownerId, f.sha, controller.signal);
  try {
    if (!read) throw new Error("Missing blob");
    const { close, closed } = observeClose(f.stats.mock.contexts[0] as FileHandle);
    const reader = read.stream().getReader();
    expect((await reader.read()).value?.byteLength).toBe(64 * 1024);
    controller.abort();
    expect(close).toHaveBeenCalledTimes(1);
    await closed;
    await expect(reader.read()).rejects.toThrow("Blob read is closed");
    f.expectClosed(1);
  } finally {
    await read?.close();
    await f.cleanup();
  }
});

test("an abort during a pending pull errors that pull without enqueueing its bytes", async () => {
  const f = await streamFixture();
  const controller = new AbortController();
  const read = await f.store.open(f.ownerId, f.sha, controller.signal);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  try {
    if (!read) throw new Error("Missing blob");
    const { close, closed } = observeClose(f.stats.mock.contexts[0] as FileHandle);
    f.reads.mockImplementationOnce(async function (this: FileHandle, ...args) {
      const result = await f.originalRead.apply(this, args);
      entered.resolve();
      await release.promise;
      return result;
    });
    pending = read.stream().getReader().read();
    await entered.promise;
    controller.abort();
    expect(close).toHaveBeenCalledTimes(1);
    await closed;
    release.resolve();
    await expect(pending).rejects.toThrow("Blob read is closed");
    f.expectClosed(1);
  } finally {
    release.resolve();
    await pending?.catch(() => {});
    await read?.close();
    await f.cleanup();
  }
});

test.each(["end", "close", "cancel", "error"])("a blob removes its abort listener on %s", async (ending) => {
  const f = await streamFixture();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const read = await f.store.open(f.ownerId, f.sha, controller.signal);
  try {
    if (!read) throw new Error("Missing blob");
    expect(read.closed).toBe(false);
    const [listener] = getEventListeners(controller.signal, "abort");
    expect(listener).toBeTypeOf("function");
    const { close } = observeClose(f.stats.mock.contexts[0] as FileHandle);
    if (ending === "end") await new Response(read.stream()).arrayBuffer();
    else if (ending === "close") await read.close();
    else if (ending === "cancel") await read.stream().cancel();
    else {
      await truncate(f.file, 0);
      await expect(new Response(read.stream()).arrayBuffer()).rejects.toThrow();
    }
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", listener);
    expect(read.closed).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    await read.close();
    expect(close).toHaveBeenCalledTimes(1);
    f.expectClosed(1);
  } finally {
    await read?.close();
    await f.cleanup();
  }
});

test("closed becomes true as soon as descriptor closure starts", async () => {
  const f = await streamFixture();
  const gate = Promise.withResolvers<void>();
  const read = await f.store.open(f.ownerId, f.sha);
  try {
    if (!read) throw new Error("Missing blob");
    const handle = f.stats.mock.contexts[0] as FileHandle;
    const original = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      await gate.promise;
      await original();
    });
    expect(read.closed).toBe(false);
    const closing = read.close();
    expect(read.closed).toBe(true);
    expect(handle.fd).not.toBe(-1);
    gate.resolve();
    await closing;
    f.expectClosed(1);
  } finally {
    gate.resolve();
    await read?.close();
    await f.cleanup();
  }
});

test("an abort consumes close failures while explicit close still reports them", async () => {
  const f = await streamFixture();
  const controller = new AbortController();
  const read = await f.store.open(f.ownerId, f.sha, controller.signal);
  try {
    if (!read) throw new Error("Missing blob");
    const handle = f.stats.mock.contexts[0] as FileHandle;
    const original = handle.close.bind(handle);
    const close = vi.spyOn(handle, "close").mockImplementation(async () => {
      await original();
      throw new Error("Synthetic close failure");
    });
    controller.abort();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(read.close()).rejects.toThrow("Synthetic close failure");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    f.expectClosed(1);
  } finally {
    await read?.close().catch(() => {});
    await f.cleanup();
  }
});

test("open streams bounded, independent chunks and closes the descriptor at EOF", async () => {
  const f = await streamFixture();
  try {
    const read = await f.store.open(f.ownerId, f.sha);
    if (!read) throw new Error("Missing blob");
    expect(read.size).toBe(f.bytes.length);
    f.reads.mockClear();
    const stream = read.stream();
    expect(f.reads).not.toHaveBeenCalled();
    expect(() => read.stream()).toThrow();
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      expect(chunk.byteLength).toBeGreaterThan(0);
      expect(chunk.byteLength).toBeLessThanOrEqual(64 * 1024);
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(f.bytes));
    f.expectClosed(1);
    await read.close();
  } finally {
    await f.cleanup();
  }
});

test("open refuses foreign or missing rows and invalid hashes without reading disk", async () => {
  const f = await streamFixture();
  try {
    for (const [owner, sha] of [
      [f.otherOwnerId, f.sha],
      [f.ownerId, "a".repeat(64)],
      [f.ownerId, "../outside"],
      [f.ownerId, f.sha.toUpperCase()],
    ] as const)
      expect(await f.store.open(owner, sha)).toBeNull();
    expect(f.stats).not.toHaveBeenCalled();
    expect(f.reads).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

test.each(["size", "hash"])("open refuses a mismatched %s before exposing a stream", async (mismatch) => {
  const f = await streamFixture();
  try {
    await writeFile(f.file, new Uint8Array(mismatch === "size" ? 17 : f.bytes.length));
    expect(await f.store.open(f.ownerId, f.sha)).toBeNull();
    if (mismatch === "size") expect(f.reads).not.toHaveBeenCalled();
    f.expectClosed(1);
  } finally {
    await f.cleanup();
  }
});

test("parallel opens verify once, and cached opens neither read nor chmod a private file", async () => {
  const f = await streamFixture();
  try {
    const chmodSpy = vi.spyOn(f.prototype, "chmod");
    const before = await stat(f.file, { bigint: true });
    const opened = await Promise.all(Array.from({ length: 20 }, () => f.store.open(f.ownerId, f.sha)));
    expect(opened.every(Boolean)).toBe(true);
    // Five data reads plus EOF, regardless of the number of concurrent callers.
    expect(f.reads).toHaveBeenCalledTimes(Math.ceil(f.bytes.length / (64 * 1024)) + 1);
    expect(new Set(f.reads.mock.calls.map(([buffer]) => buffer)).size).toBe(1);
    await Promise.all(opened.map((read) => read?.close()));
    f.reads.mockClear();
    const cached = await f.store.open(f.ownerId, f.sha);
    expect(cached).not.toBeNull();
    await cached?.close();
    expect(f.reads).not.toHaveBeenCalled();
    expect(chmodSpy).not.toHaveBeenCalled();
    expect((await stat(f.file, { bigint: true })).ctimeNs).toBe(before.ctimeNs);
    f.expectClosed(21);
  } finally {
    await f.cleanup();
  }
});

test("changed identities invalidate verification and failed verification does not poison restoration", async () => {
  const f = await streamFixture();
  try {
    const verificationReads = Math.ceil(f.bytes.length / (64 * 1024)) + 1;
    const original = await f.store.open(f.ownerId, f.sha);
    if (!original) throw new Error("Missing blob");
    await original.close();
    expect(f.reads).toHaveBeenCalledTimes(verificationReads);
    const before = await stat(f.file, { bigint: true });
    await writeFile(f.file, new Uint8Array(f.bytes.length));
    await utimes(f.file, 1000, 1000);
    const wrong = await stat(f.file, { bigint: true });
    expect(wrong.ino).toBe(before.ino);
    expect(wrong.size).toBe(before.size);
    expect(wrong.mtimeNs).not.toBe(before.mtimeNs);
    f.reads.mockClear();
    expect(await f.store.open(f.ownerId, f.sha)).toBeNull();
    expect(f.reads).toHaveBeenCalledTimes(verificationReads);
    f.expectClosed(2);
    f.reads.mockClear();
    expect(await f.store.open(f.ownerId, f.sha)).toBeNull();
    expect(f.reads).toHaveBeenCalledTimes(verificationReads);
    const unchanged = await stat(f.file, { bigint: true });
    expect([unchanged.ino, unchanged.size, unchanged.mtimeNs, unchanged.ctimeNs]).toEqual([
      wrong.ino,
      wrong.size,
      wrong.mtimeNs,
      wrong.ctimeNs,
    ]);
    f.expectClosed(3);
    await writeFile(f.file, f.bytes);
    await utimes(f.file, 2000, 2000);
    f.reads.mockClear();
    const restored = await f.store.open(f.ownerId, f.sha);
    if (!restored) throw new Error("Missing restored blob");
    expect(f.reads).toHaveBeenCalledTimes(verificationReads);
    expect(new Uint8Array(await new Response(restored.stream()).arrayBuffer())).toEqual(f.bytes);
    f.expectClosed(4);
  } finally {
    await f.cleanup();
  }
});

test("buffered reads, presence checks and reuse preserve a verified file's cache entry", async () => {
  const f = await streamFixture();
  try {
    const first = await f.store.open(f.ownerId, f.sha);
    if (!first) throw new Error("Missing blob");
    await first.close();
    const before = await stat(f.file, { bigint: true });
    for (const reuse of [
      () => f.store.get(f.ownerId, f.sha),
      () => f.store.hasContent(f.ownerId, f.sha, f.bytes.length),
      () => f.store.hasWhole(f.ownerId, f.sha),
      () => f.store.put(f.ownerId, f.bytes, "application/octet-stream"),
      async () => {
        const staged = f.store.stage(f.bytes);
        f.store.release([staged.sha256]);
      },
    ]) {
      await reuse();
      expect((await stat(f.file, { bigint: true })).ctimeNs).toBe(before.ctimeNs);
      f.reads.mockClear();
      const cached = await f.store.open(f.ownerId, f.sha);
      expect(cached).not.toBeNull();
      await cached?.close();
      expect(f.reads).not.toHaveBeenCalled();
    }
    f.expectClosed(6);
  } finally {
    await f.cleanup();
  }
});

test("ctime alone invalidates a verified blob when the inode, size and other timestamps are restored", async () => {
  const f = await streamFixture();
  try {
    // Whole seconds let utimes restore the original values without losing nanosecond precision.
    await utimes(f.file, 1000, 1000);
    const before = await stat(f.file, { bigint: true });
    const first = await f.store.open(f.ownerId, f.sha);
    if (!first) throw new Error("Missing blob");
    await first.close();
    await writeFile(f.file, new Uint8Array(f.bytes.length));
    await utimes(f.file, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
    const after = await stat(f.file, { bigint: true });
    expect([after.dev, after.ino, after.size, after.atimeNs, after.mtimeNs]).toEqual([
      before.dev,
      before.ino,
      before.size,
      before.atimeNs,
      before.mtimeNs,
    ]);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    f.reads.mockClear();
    expect(await f.store.open(f.ownerId, f.sha)).toBeNull();
    expect(f.reads).toHaveBeenCalledTimes(Math.ceil(f.bytes.length / (64 * 1024)) + 1);
    f.expectClosed(2);
  } finally {
    await f.cleanup();
  }
});

test("a FIFO blob is opened without blocking and its descriptor is refused and closed", async () => {
  const f = await streamFixture();
  try {
    await rename(f.file, `${f.file}.original`);
    execFileSync("mkfifo", [f.file], { stdio: "ignore" });
    const original = vi.mocked(open).getMockImplementation();
    if (!original) throw new Error("Missing open implementation");
    vi.mocked(open).mockImplementationOnce((...args) => {
      // Fail before the syscall if the flag regresses, rather than hanging a libuv worker.
      expect(Number(args[1]) & constants.O_NONBLOCK).not.toBe(0);
      return original(...args);
    });
    expect(await f.store.open(f.ownerId, f.sha)).toBeNull();
    expect(f.reads).not.toHaveBeenCalled();
    f.expectClosed(1);
  } finally {
    await f.cleanup();
  }
});

test("a renamed replacement cannot reuse the previous inode's verification", async () => {
  const f = await streamFixture();
  try {
    const original = await f.store.open(f.ownerId, f.sha);
    if (!original) throw new Error("Missing blob");
    const before = await stat(f.file, { bigint: true });
    await writeFile(`${f.file}.replacement`, new Uint8Array(f.bytes.length), { mode: 0o600 });
    await rename(`${f.file}.replacement`, f.file);
    const replaced = await stat(f.file, { bigint: true });
    expect(replaced.ino).not.toBe(before.ino);
    expect(replaced.size).toBe(before.size);
    f.reads.mockClear();
    expect(await f.store.open(f.ownerId, f.sha)).toBeNull();
    expect(f.reads).toHaveBeenCalledTimes(Math.ceil(f.bytes.length / (64 * 1024)) + 1);
    expect(new Uint8Array(await new Response(original.stream()).arrayBuffer())).toEqual(f.bytes);
    f.expectClosed(2);
  } finally {
    await f.cleanup();
  }
});

test("verified identities stay within the cache limit and evict the oldest first", async () => {
  const f = await streamFixture(new Uint8Array([1, 2, 3]));
  try {
    expect(VERIFIED_LIMIT).toBeGreaterThan(0);
    const cache = new BlobReadCache();
    const inserted: string[] = [];
    expect(cache.verifiedKeysForTesting()).toEqual([]);
    for (let i = 0; i < VERIFIED_LIMIT + 2; i++) {
      // Distinct timestamps give this one file a new identity without relying on clock resolution.
      await utimes(f.file, i + 1, i + 1);
      const read = await cache.open(f.file, f.sha, f.bytes.length);
      if (!read) throw new Error("Missing blob");
      await read.close();
      const keys = cache.verifiedKeysForTesting();
      const newest = keys.at(-1);
      if (newest === undefined) throw new Error("Missing verified identity");
      inserted.push(newest);
      expect(keys).toHaveLength(Math.min(inserted.length, VERIFIED_LIMIT));
      expect(keys[0]).toBe(inserted[Math.max(0, inserted.length - VERIFIED_LIMIT)]);
    }
    expect(new Set(inserted).size).toBe(VERIFIED_LIMIT + 2);
    expect(cache.verifiedKeysForTesting()).toEqual(inserted.slice(2));
    expect(f.reads).toHaveBeenCalledTimes(2 * (VERIFIED_LIMIT + 2));
    const handles = [...new Set(f.stats.mock.contexts as FileHandle[])];
    expect(handles).toHaveLength(VERIFIED_LIMIT + 2);
    expect(handles.filter((handle) => handle.fd === -1)).toHaveLength(VERIFIED_LIMIT + 2);
  } finally {
    await f.cleanup();
  }
});

test.each(["missing", "symlink", "directory"])("open refuses a %s blob file", async (kind) => {
  const f = await streamFixture();
  try {
    await rename(f.file, `${f.file}.original`);
    if (kind === "symlink") await symlink(`${f.file}.original`, f.file);
    if (kind === "directory") await mkdir(f.file);
    expect(await f.store.open(f.ownerId, f.sha)).toBeNull();
    expect(f.reads).not.toHaveBeenCalled();
    expect((f.stats.mock.contexts as FileHandle[]).every((handle) => handle.fd === -1)).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("truncation after verification errors the stream and closes its descriptor", async () => {
  const f = await streamFixture();
  try {
    const read = await f.store.open(f.ownerId, f.sha);
    if (!read) throw new Error("Missing blob");
    await truncate(f.file, 0);
    await expect(new Response(read.stream()).arrayBuffer()).rejects.toThrow();
    f.expectClosed(1);
  } finally {
    await f.cleanup();
  }
});

test.each(["growth", "shrinkage", "timestamp"])("%s during verification refuses the descriptor", async (change) => {
  const f = await streamFixture();
  try {
    f.reads.mockImplementationOnce(async function (this: FileHandle, ...args) {
      const result = await f.originalRead.apply(this, args);
      if (change === "growth") await truncate(f.file, f.bytes.length + 1);
      else if (change === "shrinkage") await truncate(f.file, 64 * 1024);
      else await utimes(f.file, 1000, 1000);
      return result;
    });
    expect(await f.store.open(f.ownerId, f.sha)).toBeNull();
    expect((f.stats.mock.contexts[0] as FileHandle).fd).toBe(-1);
  } finally {
    await f.cleanup();
  }
});

test("a stream never yields bytes appended beyond its verified size", async () => {
  const f = await streamFixture();
  try {
    const read = await f.store.open(f.ownerId, f.sha);
    if (!read) throw new Error("Missing blob");
    await appendFile(f.file, "Synthetic appended bytes");
    expect(Buffer.from(await new Response(read.stream()).arrayBuffer()).equals(Buffer.from(f.bytes))).toBe(true);
    expect((f.stats.mock.contexts[0] as FileHandle).fd).toBe(-1);
  } finally {
    await f.cleanup();
  }
});

test("closing a taken stream releases the descriptor and errors its next pull", async () => {
  const f = await streamFixture();
  try {
    const read = await f.store.open(f.ownerId, f.sha);
    if (!read) throw new Error("Missing blob");
    const stream = read.stream();
    await read.close();
    await expect(stream.getReader().read()).rejects.toThrow();
    expect((f.stats.mock.contexts[0] as FileHandle).fd).toBe(-1);
  } finally {
    await f.cleanup();
  }
});

test("close without a stream is idempotent and cancellation closes a partially read descriptor", async () => {
  const f = await streamFixture();
  try {
    const head = await f.store.open(f.ownerId, f.sha);
    if (!head) throw new Error("Missing blob");
    await Promise.all([head.close(), head.close()]);
    f.expectClosed(1);
    expect(() => head.stream()).toThrow();
    const read = await f.store.open(f.ownerId, f.sha);
    if (!read) throw new Error("Missing blob");
    const reader = read.stream().getReader();
    expect((await reader.read()).value?.byteLength).toBe(64 * 1024);
    await reader.cancel();
    f.expectClosed(2);
    await read.close();
  } finally {
    await f.cleanup();
  }
});

test("read failures close the descriptor during verification and streaming", async () => {
  const f = await streamFixture();
  try {
    f.reads.mockRejectedValueOnce(new Error("Synthetic read failure"));
    await expect(f.store.open(f.ownerId, f.sha)).rejects.toThrow("Synthetic read failure");
    expect((f.stats.mock.contexts[0] as FileHandle).fd).toBe(-1);
    f.stats.mockClear();
    const read = await f.store.open(f.ownerId, f.sha);
    if (!read) throw new Error("Missing blob");
    f.reads.mockRejectedValueOnce(new Error("Synthetic stream failure"));
    await expect(new Response(read.stream()).arrayBuffer()).rejects.toThrow("Synthetic stream failure");
    expect((f.stats.mock.contexts[0] as FileHandle).fd).toBe(-1);
  } finally {
    await f.cleanup();
  }
});

test("empty blobs verify EOF and close without yielding any chunks", async () => {
  const f = await streamFixture(new Uint8Array());
  try {
    const read = await f.store.open(f.ownerId, f.sha);
    if (!read) throw new Error("Missing blob");
    expect(read.size).toBe(0);
    expect(f.reads).toHaveBeenCalledTimes(1);
    expect(await read.stream().getReader().read()).toEqual({ done: true, value: undefined });
    expect((f.stats.mock.contexts[0] as FileHandle).fd).toBe(-1);
  } finally {
    await f.cleanup();
  }
});

test("staging generated content retains only metadata and grants no owner access before commit", async () => {
  const ctx = await testDb();
  const store = new BlobStore(ctx.db, ctx.dir);
  try {
    const bytes = Buffer.from("Synthetic staged content");
    const staged = store.stage(bytes);
    expect(staged).toEqual({ sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
    expect(await readFile(join(ctx.dir, "blobs", staged.sha256.slice(0, 2), staged.sha256))).toEqual(bytes);
    expect(await store.get(ctx.ownerId, staged.sha256)).toBeNull();
    expect(await store.get(ctx.otherOwnerId, staged.sha256)).toBeNull();
    await ctx.db.transaction((q) =>
      q
        .insert(blobs)
        .values({ ...staged, ownerId: ctx.ownerId, mediaType: "text/plain" })
        .then(() => {}),
    );
    expect(await store.get(ctx.ownerId, staged.sha256)).toEqual(new Uint8Array(bytes));
  } finally {
    await ctx.cleanup();
  }
});
