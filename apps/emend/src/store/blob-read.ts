import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

const CHUNK_SIZE = 64 * 1024;
export const VERIFIED_LIMIT = 4096;

export interface BlobRead {
  size: number;
  readonly closed: boolean;
  stream(): ReadableStream<Uint8Array>;
  close(): Promise<void>;
}

function identity(sha: string, stat: BigIntStats): string {
  return [sha, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

async function verify(handle: FileHandle, sha: string, size: number, key: string): Promise<boolean> {
  const hash = createHash("sha256");
  const buffer = new Uint8Array(CHUNK_SIZE);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_SIZE, size - position), position);
    if (bytesRead === 0) return false;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if ((await handle.read(buffer, 0, 1, position)).bytesRead !== 0) return false;
  return hash.digest("hex") === sha && identity(sha, await handle.stat({ bigint: true })) === key;
}

/** Verification belongs to an inode, so replacing a blob by rename cannot inherit its cached result. */
export class BlobReadCache {
  private readonly verified = new Set<string>();
  private readonly verifying = new Map<string, Promise<boolean>>();

  /** Tests inspect FIFO eviction through a snapshot so they cannot mutate the live cache. */
  verifiedKeysForTesting(): readonly string[] {
    return [...this.verified];
  }

  async open(file: string, sha: string, size: number, signal?: AbortSignal): Promise<BlobRead | null> {
    let handle: FileHandle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    }
    let retained = false;
    try {
      let stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size !== BigInt(size)) return null;
      // Even an unchanged chmod advances ctime and would discard a valid verification.
      if ((stat.mode & 0o777n) !== 0o600n) {
        await handle.chmod(0o600);
        stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.size !== BigInt(size)) return null;
      }
      const key = identity(sha, stat);
      if (!this.verified.has(key)) {
        let pending = this.verifying.get(key);
        if (!pending) {
          pending = verify(handle, sha, size, key)
            .then((valid) => {
              if (valid) {
                this.verified.add(key);
                if (this.verified.size > VERIFIED_LIMIT) {
                  const oldest = this.verified.values().next().value;
                  if (oldest !== undefined) this.verified.delete(oldest);
                }
              }
              return valid;
            })
            .finally(() => this.verifying.delete(key));
          this.verifying.set(key, pending);
        }
        // A waiter must still hold the identity verified by the other opener's descriptor.
        if (!(await pending) || identity(sha, await handle.stat({ bigint: true })) !== key) return null;
      }
      if (signal?.aborted) return null;
      const read = blobRead(handle, size, signal);
      retained = true;
      return read;
    } finally {
      if (!retained) await handle.close();
    }
  }
}

function blobRead(handle: FileHandle, size: number, signal?: AbortSignal): BlobRead {
  let taken = false;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (!closing) {
      signal?.removeEventListener("abort", onAbort);
      closing = handle.close();
    }
    return closing;
  };
  const onAbort = () => {
    // Event listeners have no promise consumer; close() and pulls still report a close failure.
    void close().catch(() => {});
  };
  // The HTTP adapter can discard an aborted response without reading or cancelling its body.
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    size,
    get closed() {
      return closing !== undefined;
    },
    close,
    stream() {
      if (taken || closing) throw new Error("Blob stream is already taken or closed");
      taken = true;
      let position = 0;
      let cancelled = false;
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              if (closing) throw new Error("Blob read is closed");
              if (position < size) {
                // Consumers retain chunks, so each pull must own its buffer.
                const chunk = new Uint8Array(Math.min(CHUNK_SIZE, size - position));
                const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
                if (cancelled) return;
                if (closing) throw new Error("Blob read is closed");
                if (bytesRead === 0) throw new Error("Blob ended before its verified size");
                position += bytesRead;
                controller.enqueue(chunk.subarray(0, bytesRead));
              }
              if (position === size) {
                await close();
                if (!cancelled) controller.close();
              }
            } catch (error) {
              await close();
              if (!cancelled) controller.error(error);
            }
          },
          cancel() {
            cancelled = true;
            return close();
          },
        },
        { highWaterMark: 0 },
      );
    },
  };
}
