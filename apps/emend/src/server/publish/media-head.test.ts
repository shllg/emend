import { expect, test, vi } from "vitest";
import type { BlobRead } from "../../store/blob-read.ts";
import { IMAGE_HEAD_BYTES } from "./image-size.ts";
import { memoizedHeads, readBlobHead } from "./media-head.ts";

const CHUNK = 64 * 1024;

function fakeRead(data: Uint8Array, failAfter?: number) {
  let pulls = 0;
  let position = 0;
  const state = { closed: false, pulls: () => pulls };
  const read: BlobRead = {
    size: data.length,
    get closed() {
      return state.closed;
    },
    async close() {
      state.closed = true;
    },
    stream() {
      return new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            if (failAfter !== undefined && pulls > failAfter) {
              controller.error(new Error("boom"));
              return;
            }
            if (position >= data.length) return controller.close();
            controller.enqueue(data.slice(position, position + CHUNK));
            position += CHUNK;
          },
        },
        { highWaterMark: 0 },
      );
    },
  };
  return { read, state };
}

const bytes = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 7 + (i >> 8)) & 255);

test("a large blob yields exactly the head bytes and pulls only the chunks it needs", async () => {
  const data = bytes(2 * 1024 * 1024);
  const { read, state } = fakeRead(data);
  const head = await readBlobHead(async () => read);
  expect(head?.byteLength).toBe(IMAGE_HEAD_BYTES);
  expect(Buffer.from(head ?? new ArrayBuffer(0)).equals(Buffer.from(data.subarray(0, IMAGE_HEAD_BYTES)))).toBe(true);
  expect(state.pulls()).toBeLessThanOrEqual(IMAGE_HEAD_BYTES / CHUNK + 1);
  expect(state.closed).toBe(true);
});

test("a small blob returns all its bytes", async () => {
  const data = bytes(1024);
  const { read, state } = fakeRead(data);
  const head = await readBlobHead(async () => read);
  expect(Buffer.from(head ?? new ArrayBuffer(0)).equals(Buffer.from(data))).toBe(true);
  expect(state.closed).toBe(true);
});

test("a missing blob gives null", async () => {
  expect(await readBlobHead(async () => null)).toBeNull();
});

test("a failing stream rejects and still closes the read", async () => {
  const { read, state } = fakeRead(bytes(1024 * 1024), 1);
  await expect(readBlobHead(async () => read)).rejects.toThrow("boom");
  expect(state.closed).toBe(true);
});

test("memoized heads load once per hash and survive a detached earlier result", async () => {
  const load = vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer);
  const head = memoizedHeads(load);
  const first = await head("a");
  structuredClone(first, { transfer: [first] });
  expect(first.byteLength).toBe(0);
  const second = await head("a");
  expect([...new Uint8Array(second)]).toEqual([1, 2, 3]);
  await head("b");
  expect(load).toHaveBeenCalledTimes(2);
});
