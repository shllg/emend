import type { BlobRead } from "../../store/blob-read.ts";
import type { BlobStore } from "../../store/blobs.ts";
import { ApiError } from "../http/errors.ts";
import { IMAGE_HEAD_BYTES } from "./image-size.ts";

/** Reads at most `limit` leading bytes of a blob without pulling the rest of its stream. */
export async function readBlobHead(
  open: () => Promise<BlobRead | null>,
  limit = IMAGE_HEAD_BYTES,
): Promise<ArrayBuffer | null> {
  const blob = await open();
  if (!blob) return null;
  try {
    const out = new Uint8Array(Math.min(blob.size, limit));
    let length = 0;
    if (out.length > 0) {
      const reader = blob.stream().getReader();
      try {
        while (length < out.length) {
          const { done, value } = await reader.read();
          if (done) break;
          const take = Math.min(value.length, out.length - length);
          out.set(value.subarray(0, take), length);
          length += take;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    return length === out.length ? out.buffer : out.slice(0, length).buffer;
  } finally {
    await blob.close();
  }
}

/** Reads an owner's blob head; a missing blob is `blob_missing`. */
export function ownerHead(
  blobs: Pick<BlobStore, "open">,
  ownerId: string,
  signal?: AbortSignal,
): (sha: string) => Promise<ArrayBuffer> {
  return async (sha) => {
    const head = await readBlobHead(() => blobs.open(ownerId, sha, signal));
    if (!head) throw new ApiError("blob_missing");
    return head;
  };
}

/**
 * Loads each hash once; every read returns its own copy because the render worker detaches what it gets.
 * `keep` drops every cached head outside the given hashes.
 */
export function memoizedHeads(load: (hash: string) => Promise<ArrayBuffer>): {
  read(hash: string): Promise<ArrayBuffer>;
  keep(hashes: Iterable<string>): void;
} {
  const heads = new Map<string, Promise<ArrayBuffer>>();
  return {
    async read(hash) {
      let head = heads.get(hash);
      if (!head) {
        head = load(hash);
        heads.set(hash, head);
        head.catch(() => heads.delete(hash));
      }
      return (await head).slice(0);
    },
    keep(hashes) {
      const wanted = new Set(hashes);
      for (const hash of heads.keys()) if (!wanted.has(hash)) heads.delete(hash);
    },
  };
}
