import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db, Queries } from "../db/client.ts";
import { blobs } from "../db/schema.ts";
import { ensurePrivateDir, ensureStateDir, syncDirectory, tightenSecretFile, writeSecretFile } from "../state/files.ts";
import { type BlobRead, BlobReadCache } from "./blob-read.ts";

export class BlobMismatchError extends Error {
  constructor() {
    super("Blob content does not match the expected SHA-256");
    this.name = "BlobMismatchError";
  }
}
export class BlobTooLargeError extends Error {}

/** A staged file with no blobs row yet stays off limits to removal this long (the window of an import). */
export const STAGE_PIN_MS = 15 * 60 * 1000;

export class BlobStore {
  private readonly db: Db;
  private readonly dir: string;
  private readonly reads = new BlobReadCache();
  // Per-sha queue, in this process only: file writes and the blobs row go in together, and the
  // removal of a file waits for them. Each tail never rejects.
  private readonly locks = new Map<string, Promise<unknown>>();
  // Files staged without a row (import) until released or expired: removal must leave them.
  // Reference-counted: each stage holds once and a release drops one hold. `until` is the newest
  // expiry of the newest hold, after which the pin no longer protects the file.
  private readonly pins = new Map<string, { holds: number; until: number }>();

  constructor(db: Db, dir: string) {
    ensureStateDir(dir);
    this.db = db;
    this.dir = dir;
  }

  /** Run `fn` with the lock for this sha; callers for the same sha run one at a time, in order. */
  exclusive<T>(sha: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(sha) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(sha, tail);
    void tail.then(() => {
      if (this.locks.get(sha) === tail) this.locks.delete(sha);
    });
    return run;
  }

  async put(
    ownerId: string,
    bytes: Uint8Array,
    mediaType: string,
    expectedSha?: string,
    scope?: Queries,
  ): Promise<string> {
    // Snapshot caller-owned bytes before hashing or awaiting anything.
    const content = Uint8Array.from(bytes);
    const sha = createHash("sha256").update(content).digest("hex");
    if (expectedSha !== undefined && sha !== expectedSha) throw new BlobMismatchError();
    const size = content.length;
    const record = async (q: Queries) => {
      await q
        .insert(blobs)
        .values({ ownerId, sha256: sha, size, mediaType })
        .onConflictDoNothing({ target: [blobs.ownerId, blobs.sha256] });
    };
    if (scope) {
      // The transaction of the caller commits the row later, so the lock cannot cover it: pin the file.
      this.pin(sha);
      this.writeFile(content, sha);
      await record(scope);
    } else {
      // Write the file and commit the row inside the lock, so a removal sees one or the other whole.
      await this.exclusive(sha, async () => {
        this.writeFile(content, sha);
        await this.db.transaction(record, { offThread: true });
      });
    }
    return sha;
  }

  /** Persist immutable content without publishing an owner reference; the caller commits metadata later. */
  stage(bytes: Uint8Array, expectedSha?: string): { sha256: string; size: number } {
    // Snapshot caller-owned bytes before hashing or awaiting anything.
    const content = Uint8Array.from(bytes);
    const sha = createHash("sha256").update(content).digest("hex");
    if (expectedSha !== undefined && sha !== expectedSha) throw new BlobMismatchError();
    // No row exists until the caller commits one: pin the file against removal, synchronously.
    this.pin(sha);
    this.writeFile(content, sha);
    return { sha256: sha, size: content.length };
  }

  /**
   * Drop one hold per sha once its row is committed or its import has failed. Pass each sha once
   * per stage call you made: the hold of another import on the same content stays.
   */
  release(shas: Iterable<string>): void {
    for (const sha of shas) {
      const pin = this.pins.get(sha);
      if (!pin) continue;
      if (pin.holds <= 1) this.pins.delete(sha);
      else pin.holds -= 1;
    }
  }

  private pin(sha: string): void {
    const now = Date.now();
    if (this.pins.size > 4096) for (const [key, pin] of this.pins) if (pin.until <= now) this.pins.delete(key);
    const live = this.pins.get(sha);
    // An expired pin starts over: its holds were abandoned.
    const holds = live && live.until > now ? live.holds + 1 : 1;
    this.pins.set(sha, { holds, until: now + STAGE_PIN_MS });
  }

  private writeFile(content: Uint8Array, sha: string): void {
    const file = this.path(sha);
    ensurePrivateDir(dirname(file), this.dir);
    const valid = tightenSecretFile(file) && createHash("sha256").update(readFileSync(file)).digest("hex") === sha;
    if (!valid) writeSecretFile(file, content, this.dir);
  }

  async has(ownerId: string, sha: string, scope?: Queries): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(sha)) return false;
    return this.query(
      scope,
      async (q) =>
        Boolean(
          await q
            .select({ sha256: blobs.sha256 })
            .from(blobs)
            .where(and(eq(blobs.ownerId, ownerId), eq(blobs.sha256, sha)))
            .get(),
        ),
      true,
    );
  }

  async get(ownerId: string, sha: string, scope?: Queries): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    const row = await this.query(scope, (q) =>
      q
        .select({ size: blobs.size })
        .from(blobs)
        .where(and(eq(blobs.ownerId, ownerId), eq(blobs.sha256, sha)))
        .get(),
    );
    if (!row) return null;
    return this.readStaged(sha, row.size);
  }

  async open(ownerId: string, sha: string, signal?: AbortSignal): Promise<BlobRead | null> {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    const row = await this.db.read((q) =>
      q
        .select({ size: blobs.size })
        .from(blobs)
        .where(and(eq(blobs.ownerId, ownerId), eq(blobs.sha256, sha)))
        .get(),
    );
    if (!row) return null;
    const file = this.path(sha);
    ensurePrivateDir(dirname(file), this.dir);
    return this.reads.open(file, sha, row.size, signal);
  }

  /** Trusted callers must hold metadata for bytes they staged themselves; no owner access is granted. */
  async readStaged(sha: string, size: number): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    try {
      const file = this.path(sha);
      ensurePrivateDir(dirname(file), this.dir);
      if (!tightenSecretFile(file)) return null;
      const bytes = new Uint8Array(await readFile(file));
      return bytes.byteLength === size && createHash("sha256").update(bytes).digest("hex") === sha ? bytes : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** True when the owner has the row and its file is present at the recorded size. */
  async hasWhole(ownerId: string, sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(sha)) return false;
    const row = await this.db.read((q) =>
      q
        .select({ size: blobs.size })
        .from(blobs)
        .where(and(eq(blobs.ownerId, ownerId), eq(blobs.sha256, sha)))
        .get(),
    );
    return row ? this.hasContent(ownerId, sha, row.size) : false;
  }

  /** Presence-only check for an already owner-validated reference; does not load its contents. */
  async hasContent(ownerId: string, sha: string, size: number): Promise<boolean> {
    if (!(await this.has(ownerId, sha))) return false;
    try {
      const file = this.path(sha);
      ensurePrivateDir(dirname(file), this.dir);
      return tightenSecretFile(file) && (await stat(file)).size === size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async putStream(
    ownerId: string,
    stream: AsyncIterable<Uint8Array>,
    sha: string,
    size: number,
    limit: number,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(sha) || !Number.isSafeInteger(size) || size < 0) throw new BlobMismatchError();
    if (size > limit) throw new BlobTooLargeError();
    const file = this.path(sha);
    ensurePrivateDir(dirname(file), this.dir);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let received = 0;
    try {
      for await (const bytes of stream) {
        received += bytes.byteLength;
        if (received > limit) throw new BlobTooLargeError();
        if (received > size) throw new BlobMismatchError();
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) offset += (await handle.write(bytes, offset)).bytesWritten;
      }
      if (received !== size || hash.digest("hex") !== sha) throw new BlobMismatchError();
      await handle.sync();
      await handle.close();
      // The file lands and its row commits inside the lock, so a removal sees both or neither.
      await this.exclusive(sha, async () => {
        await rename(temporary, file);
        syncDirectory(dirname(file));
        await this.db.query((q) =>
          q
            .insert(blobs)
            .values({ ownerId, sha256: sha, size, mediaType: "application/octet-stream" })
            .onConflictDoNothing({ target: [blobs.ownerId, blobs.sha256] }),
        );
      });
    } finally {
      await handle.close();
      await rm(temporary, { force: true });
    }
  }

  /**
   * Unlink the content file if no owner has a blobs row for it and nothing staged it lately. The caller
   * holds `exclusive(sha)`, so no put is half done. The pin check and the unlink are one synchronous
   * step, so a stage cannot slip between them. Returns whether the file went.
   */
  async unlinkIfUnheld(sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(sha)) return false;
    const held = await this.db.read((q) =>
      q.select({ sha256: blobs.sha256 }).from(blobs).where(eq(blobs.sha256, sha)).limit(1).get(),
    );
    if (held) return false;
    const pin = this.pins.get(sha);
    if (pin) {
      if (pin.until > Date.now()) return false;
      this.pins.delete(sha);
    }
    rmSync(this.path(sha), { force: true });
    return true;
  }

  private query<T>(scope: Queries | undefined, fn: (q: Queries) => Promise<T>, readOnly = false): Promise<T> {
    return scope ? fn(scope) : readOnly ? this.db.read(fn) : this.db.query(fn);
  }

  private path(sha: string): string {
    return join(this.dir, "blobs", sha.slice(0, 2), sha);
  }
}
