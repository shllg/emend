import { createHash } from "node:crypto";
import { expect, onTestFinished, test, vi } from "vitest";
import { removeUnreferencedBlob } from "../db/repo/blob-removal.ts";
import { testDb } from "../db/test-support.ts";
import { BlobStore, STAGE_PIN_MS } from "./blobs.ts";

const bytes = new TextEncoder().encode("Synthetic content for a removal race");
const sha = createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const ctx = await testDb();
  const store = new BlobStore(ctx.db, ctx.dir);
  return { ...ctx, store, fileThere: async () => (await store.readStaged(sha, bytes.length)) !== null };
}
/** A removal that stops after its row delete, holding the sha's lock until `release` is called. */
function pausedRemoval(f: Awaited<ReturnType<typeof fixture>>, ownerId: string, order: string[] = []) {
  const gate = Promise.withResolvers<void>();
  const rowGone = Promise.withResolvers<boolean>();
  const done = f.store.exclusive(sha, async () => {
    const { removed } = await removeUnreferencedBlob(f.db, ownerId, sha);
    rowGone.resolve(removed);
    await gate.promise;
    const unlinked = await f.store.unlinkIfUnheld(sha);
    order.push("removal ended");
    return unlinked;
  });
  onTestFinished(async () => {
    gate.resolve();
    await done;
  });
  return { done, rowGone: rowGone.promise, release: () => gate.resolve() };
}

function observeQueuedPut(store: BlobStore, order: string[]) {
  const queued = Promise.withResolvers<void>();
  const exclusive = store.exclusive.bind(store);
  vi.spyOn(store, "exclusive").mockImplementationOnce((sha, operation) => {
    const result = exclusive(sha, () => {
      order.push("put entered");
      return operation();
    });
    queued.resolve();
    return result;
  });
  return queued.promise;
}

test("a put of the same content queues behind a removal, so its file and row survive together", async () => {
  const f = await fixture();
  onTestFinished(() => f.cleanup());
  await f.store.put(f.ownerId, bytes, "text/plain");
  const order: string[] = [];
  const removal = pausedRemoval(f, f.ownerId, order);
  expect(await removal.rowGone).toBe(true);
  // The other owner's put arrives while the removal holds the lock: it must not run yet.
  const queued = observeQueuedPut(f.store, order);
  const putting = f.store.put(f.otherOwnerId, bytes, "text/plain");
  onTestFinished(async () => {
    removal.release();
    await removal.done;
    await putting;
  });
  await queued;
  removal.release();
  const removed = await removal.done;
  await putting;
  expect(order).toEqual(["removal ended", "put entered"]);
  expect(removed).toBe(true);
  expect(await f.store.has(f.otherOwnerId, sha)).toBe(true);
  expect(await f.fileThere()).toBe(true);
  expect(await f.store.get(f.otherOwnerId, sha)).toEqual(bytes);
});

test("a put queued first is whole before the removal checks for rows, so the file stays", async () => {
  const f = await fixture();
  onTestFinished(() => f.cleanup());
  await f.store.put(f.ownerId, bytes, "text/plain");
  let rowWhenRemovalStarted: boolean | undefined;
  // Hold the lock, queue a put, queue the removal behind it, then let them run in order.
  const gate = Promise.withResolvers<void>();
  const order: string[] = [];
  const holder = f.store.exclusive(sha, async () => {
    await gate.promise;
    order.push("holder ended");
  });
  onTestFinished(async () => {
    gate.resolve();
    await holder;
  });
  const queued = observeQueuedPut(f.store, order);
  const putting = f.store.put(f.otherOwnerId, bytes, "text/plain");
  onTestFinished(async () => {
    gate.resolve();
    await holder;
    await putting;
  });
  await queued;
  const removal = f.store.exclusive(sha, async () => {
    order.push("removal entered");
    rowWhenRemovalStarted = await f.store.has(f.otherOwnerId, sha);
    await removeUnreferencedBlob(f.db, f.ownerId, sha);
    return f.store.unlinkIfUnheld(sha);
  });
  gate.resolve();
  await holder;
  await putting;
  expect(await removal).toBe(false);
  expect(order).toEqual(["holder ended", "put entered", "removal entered"]);
  // The put's file and row were both committed when the removal looked.
  expect(rowWhenRemovalStarted).toBe(true);
  expect(await f.store.get(f.otherOwnerId, sha)).toEqual(bytes);
});

test("a stage between the row delete and the unlink pins the file; release lets a later removal go", async () => {
  const f = await fixture();
  onTestFinished(() => f.cleanup());
  await f.store.put(f.ownerId, bytes, "text/plain");
  const removal = pausedRemoval(f, f.ownerId);
  expect(await removal.rowGone).toBe(true);
  // An import stages the same bytes: no row exists yet, only the file and the pin.
  f.store.stage(bytes);
  removal.release();
  expect(await removal.done).toBe(false);
  expect(await f.fileThere()).toBe(true);
  f.store.release([sha]);
  expect(await f.store.exclusive(sha, () => f.store.unlinkIfUnheld(sha))).toBe(true);
  expect(await f.fileThere()).toBe(false);
});

test("pins are reference-counted: one import's release leaves another import's hold", async () => {
  const f = await fixture();
  try {
    f.store.stage(bytes);
    f.store.stage(bytes);
    f.store.release([sha]);
    expect(await f.store.exclusive(sha, () => f.store.unlinkIfUnheld(sha))).toBe(false);
    expect(await f.fileThere()).toBe(true);
    f.store.release([sha]);
    expect(await f.store.exclusive(sha, () => f.store.unlinkIfUnheld(sha))).toBe(true);
    expect(await f.fileThere()).toBe(false);
    // A release with no hold is harmless.
    f.store.release([sha]);
  } finally {
    await f.cleanup();
  }
});

test("a pin expires, so an orphaned staged file does not stay forever", async () => {
  const f = await fixture();
  try {
    f.store.stage(bytes);
    expect(await f.store.exclusive(sha, () => f.store.unlinkIfUnheld(sha))).toBe(false);
    const real = Date.now;
    Date.now = () => real() + STAGE_PIN_MS + 1;
    try {
      expect(await f.store.exclusive(sha, () => f.store.unlinkIfUnheld(sha))).toBe(true);
    } finally {
      Date.now = real;
    }
    expect(await f.fileThere()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("another owner's row keeps the file; the owner's own unreferenced row goes", async () => {
  const f = await fixture();
  try {
    await f.store.put(f.ownerId, bytes, "text/plain");
    await f.store.put(f.otherOwnerId, bytes, "text/plain");
    const removed = await f.store.exclusive(sha, async () => {
      const row = await removeUnreferencedBlob(f.db, f.ownerId, sha);
      return { row: row.removed, file: await f.store.unlinkIfUnheld(sha) };
    });
    expect(removed).toEqual({ row: true, file: false });
    expect(await f.store.has(f.ownerId, sha)).toBe(false);
    expect(await f.store.get(f.otherOwnerId, sha)).toEqual(bytes);
    const last = await f.store.exclusive(sha, async () => {
      const row = await removeUnreferencedBlob(f.db, f.otherOwnerId, sha);
      return { row: row.removed, file: await f.store.unlinkIfUnheld(sha) };
    });
    expect(last).toEqual({ row: true, file: true });
    expect(await f.fileThere()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("the lock runs callers in order and keeps going after one throws", async () => {
  const f = await fixture();
  onTestFinished(() => f.cleanup());
  const order: number[] = [];
  const release = Promise.withResolvers<void>();
  const first = f.store.exclusive(sha, async () => {
    await release.promise;
    order.push(1);
    throw new Error("first failed");
  });
  const second = f.store.exclusive(sha, async () => order.push(2));
  const third = f.store.exclusive("0".repeat(64), async () => order.push(3));
  const failed = expect(first).rejects.toThrow("first failed");
  onTestFinished(async () => {
    release.resolve();
    await failed;
    await second;
  });
  await third;
  release.resolve();
  await failed;
  await second;
  expect(order).toEqual([3, 1, 2]);
});
