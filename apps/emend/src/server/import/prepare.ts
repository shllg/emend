import { randomUUID } from "node:crypto";
import {
  docViewOf,
  type ImportBundle,
  importPublishInput,
  importRowCount,
  indexImportBundle,
  LIMITS,
  PublishRequest,
  writeupMarkdown,
} from "@emend/contract";
import { decodeText } from "@emend/core";
import { and, eq } from "drizzle-orm";
import { blobs, changedBlocks as changedTable, placements as placementTable } from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import { ApiError } from "../http/errors.ts";
import { commentTargetReserve, envelopeBytes, jsonBytes } from "../mailbox/payload.ts";
import { yieldToLoop } from "../pacing.ts";
import { countDiffFiles } from "../publish/counts.ts";
import { workerExecutor } from "../publish/executor.ts";
import { IMAGE_HEAD_BYTES } from "../publish/image-size.ts";
import { abortable } from "../publish/lifecycle.ts";
import { fileMediaType } from "../publish/media.ts";
import { memoizedHeads, ownerHead } from "../publish/media-head.ts";
import { validateNoteRanges } from "../publish/notes.ts";
import { renderRevision } from "../publish/render.ts";
import type { Executor, Work, WorkResult } from "../publish/work.ts";
import { derivedRowBytes } from "./bytes.ts";
import { checkImportSignal } from "./lifecycle.ts";
import { type ImportPlacement, importPlacements } from "./placements.ts";

/** No database writes: even a late validation failure leaves no imported rows or blob metadata. */
export async function prepareImport(ownerId: string, bundle: ImportBundle, deps: AppDeps, signal?: AbortSignal) {
  checkImportSignal(signal);
  const index = indexImportBundle(bundle);
  let rowCount = importRowCount(bundle);
  let derivedBytes = 0;
  const addDerivedBytes = (bytes: number) => {
    derivedBytes += bytes;
    if (derivedBytes > LIMITS.importDerivedBytes) throw new ApiError("too_large");
  };
  const addRows = (count: number) => {
    rowCount += count;
    if (rowCount > LIMITS.importRows) throw new ApiError("invalid_request");
  };
  addRows(0);
  let renderedBytes = 0;
  const onRendered = (bytes: number) => {
    renderedBytes += bytes;
    if (renderedBytes > LIMITS.importRenderedBytes) throw new ApiError("too_large");
  };
  const place = importPlacements();
  const placements: ImportPlacement[] = [];
  const changedBlocks: (typeof changedTable.$inferInsert)[] = [];

  const hashes = new Set(
    [
      ...bundle.files.flatMap((f) => [f.oldBlob, f.newBlob, f.renderedBlob]),
      ...bundle.writeups.flatMap((w) => [w.sourceBlob, w.renderedBlob]),
    ].filter((hash): hash is string => hash !== null),
  );
  const sizes = await deps.db.read(async (q) => {
    const sizes = new Map<string, number>();
    for (const hash of hashes) {
      checkImportSignal(signal);
      const row = await q
        .select({ size: blobs.size })
        .from(blobs)
        .where(and(eq(blobs.ownerId, ownerId), eq(blobs.sha256, hash)))
        .get();
      if (!row) throw new ApiError("blob_missing");
      sizes.set(hash, row.size);
    }
    return sizes;
  });
  const staged = new Map<string, number>();
  const holds: string[] = [];
  const current = new Map<string, Buffer>();
  const read = async (hash: string): Promise<ArrayBuffer> => {
    checkImportSignal(signal);
    const size = staged.get(hash);
    const bytes =
      current.get(hash) ??
      (size === undefined ? await deps.blobs.get(ownerId, hash) : await deps.blobs.readStaged(hash, size));
    if (!bytes) throw new ApiError("blob_missing");
    return Uint8Array.from(bytes).buffer;
  };
  // Heads are keyed by SHA-256, so one memoized head stays valid across revisions although `current` is cleared.
  const openHead = ownerHead(deps.blobs, ownerId, signal);
  const heads = memoizedHeads(async (hash) => {
    checkImportSignal(signal);
    const size = staged.get(hash);
    const own = current.get(hash);
    if (own) return Uint8Array.from(own.subarray(0, IMAGE_HEAD_BYTES)).buffer;
    if (size === undefined) return openHead(hash);
    const head = (await deps.blobs.readStaged(hash, size))?.slice(0, IMAGE_HEAD_BYTES).buffer;
    if (!head) throw new ApiError("blob_missing");
    return head as ArrayBuffer;
  });
  const put = async (bytes: Buffer) => {
    checkImportSignal(signal);
    const { sha256: hash, size } = deps.blobs.stage(bytes);
    // Every stage call holds the file once; the import releases each hold.
    holds.push(hash);
    if (!staged.has(hash)) addRows(1);
    staged.set(hash, size);
    current.set(hash, bytes);
    return hash;
  };
  const worker = deps.publishExecutor ? undefined : workerExecutor();
  const run = deps.publishExecutor ?? worker;
  if (!run) throw new Error("Missing renderer");
  const execute: Executor = (work) => abortable(signal, () => run(work));
  const stop = () => {
    void worker?.close();
  };
  signal?.addEventListener("abort", stop, { once: true });
  const rendered = new Map<
    string,
    Pick<
      Awaited<ReturnType<typeof renderRevision>>,
      "sourceBlob" | "renderedBlob" | "docBlobs" | "metadata" | "sourceBlobs" | "sourceMetadata"
    >
  >();
  const empty = new Map<string, boolean>();
  const counted = new Map<string, Awaited<ReturnType<typeof countDiffFiles>>>();
  try {
    const targetReserves = new Map<string, number>();
    let checkedComments = 0;
    for (const send of bundle.sends) {
      let bytes = envelopeBytes + (send.instruction?.trim() ? jsonBytes(send.instruction) + 1 : 0);
      for (const comment of index.commentsBySend.get(send.id) ?? []) {
        const thread = index.threads.get(comment.threadId);
        if (!thread) throw new ApiError("invalid_request");
        let targetBytes = targetReserves.get(thread.id);
        if (targetBytes === undefined) {
          targetBytes = commentTargetReserve(thread.target);
          targetReserves.set(thread.id, targetBytes);
        }
        bytes += targetBytes + jsonBytes(comment.body) - 2;
        if (bytes > LIMITS.handoffBytes) throw new ApiError("too_large");
        if (++checkedComments % 500 === 0) await yieldToLoop("import-prepare-comments");
      }
    }
    let previous: { renderedBlob: string; docBlobs: Map<string, string> } | undefined;
    const writeupSources = new Map<string, Extract<WorkResult, { kind: "writeup-source" }>>();
    const checkedSources = new Set<string>();
    let previousSourceHash: string | undefined;
    let previousMedia: string[] = [];
    for (const revision of bundle.revisions) {
      checkImportSignal(signal);
      current.clear();
      const rows = index.revisions.get(revision.id);
      const writeup = rows?.writeups[0];
      if (!writeup) throw new ApiError("invalid_request");
      if ((sizes.get(writeup.sourceBlob) ?? 0) > LIMITS.publishJsonBytes) throw new ApiError("too_large");
      // Retain only sources named by this revision and its immediate predecessor.
      for (const hash of writeupSources.keys())
        if (hash !== writeup.sourceBlob && hash !== previousSourceHash) writeupSources.delete(hash);
      previousSourceHash = writeup.sourceBlob;
      let source = writeupSources.get(writeup.sourceBlob);
      if (!source) {
        try {
          const result = await execute({ kind: "writeup-source", bytes: await read(writeup.sourceBlob) });
          if (result.kind !== "writeup-source") throw new ApiError("invalid_request");
          source = result;
          writeupSources.set(writeup.sourceBlob, source);
        } catch (error) {
          checkImportSignal(signal);
          if (error instanceof ApiError) throw error;
          throw new ApiError("invalid_request");
        }
      }
      const parsed = PublishRequest.safeParse(importPublishInput(bundle, revision.id, source.source, source));
      if (!parsed.success) throw new ApiError("invalid_request");
      const input = parsed.data;
      const sources = new Set(
        input.files.flatMap((f) => [f.oldBlob, f.newBlob]).filter((s): s is string => s !== null),
      );
      if (
        [...sources].reduce((total, hash) => total + (sizes.get(hash) ?? 0), sizes.get(writeup.sourceBlob) ?? 0) >
        LIMITS.revisionBytes
      )
        throw new ApiError("too_large");
      for (const file of input.files) {
        const type = fileMediaType(file);
        const limit =
          file.role === "diff"
            ? LIMITS.diffSideBytes
            : file.role === "asset"
              ? LIMITS.assetBytes
              : type === "text/html"
                ? LIMITS.htmlDocBytes
                : LIMITS.markdownDocBytes;
        for (const hash of [file.oldBlob, file.newBlob])
          if (hash && (sizes.get(hash) ?? 0) > limit) throw new ApiError("too_large");
        if (file.role === "doc" && docViewOf(file) === "source" && file.newBlob && !checkedSources.has(file.newBlob)) {
          const bytes = await read(file.newBlob);
          try {
            decodeText(new Uint8Array(bytes));
            checkedSources.add(file.newBlob);
          } catch {
            throw new ApiError("invalid_request");
          }
        }
        if (file.assets) {
          const total = file.assets.reduce(
            (sum, path) => sum + (sizes.get(rows?.docPaths.get(path)?.newBlob ?? "") ?? 0),
            sizes.get(file.newBlob ?? "") ?? 0,
          );
          if (total > LIMITS.htmlDocWithAssetsBytes) throw new ApiError("too_large");
        }
      }
      await validateNoteRanges(input.files, read, execute);
      counted.set(revision.id, await countDiffFiles(input.files, read, execute, signal));
      // Keep only this revision's and its predecessor's image heads.
      const media = input.files
        .filter((f) => f.role === "asset" && f.parent === undefined && f.newBlob)
        .map((f) => f.newBlob as string);
      heads.keep([...media, ...previousMedia]);
      previousMedia = media;
      const result = await renderRevision(input, execute, read, heads.read, put, signal, onRendered);
      if (!rows) throw new ApiError("invalid_request");
      if (previous) {
        const previousBlobs: Extract<Work, { kind: "changed" }>["previous"] = [];
        previousBlobs.push({ format: "writeup", bytes: await read(previous.renderedBlob) });
        for (const hash of previous.docBlobs.values()) previousBlobs.push({ format: "doc", bytes: await read(hash) });
        const changed = await execute({ kind: "changed", previous: previousBlobs, next: result.ids });
        if (changed.kind !== "changed") throw new ApiError("invalid_request");
        const packed = Buffer.from(changed.bytes).toString("utf8");
        let changedLines = 0;
        for (const line of packed ? packed.split("\n") : []) {
          addRows(1);
          const blockId = JSON.parse(line) as string;
          const row = { id: randomUUID(), ownerId, revisionId: revision.id, blockId };
          addDerivedBytes(derivedRowBytes(changedTable, row));
          changedBlocks.push(row);
          if (++changedLines % 500 === 0) await yieldToLoop("import-prepare-changed");
        }
      }
      previous = { renderedBlob: result.renderedBlob, docBlobs: result.docBlobs };
      for (const placement of await place(rows, result, read, execute, signal)) {
        addDerivedBytes(derivedRowBytes(placementTable, { ...placement, ownerId }));
        placements.push(placement);
      }
      rendered.set(revision.id, {
        sourceBlob: result.sourceBlob,
        renderedBlob: result.renderedBlob,
        docBlobs: result.docBlobs,
        metadata: result.metadata,
        sourceBlobs: result.sourceBlobs,
        sourceMetadata: result.sourceMetadata,
      });
      empty.set(
        revision.id,
        writeupMarkdown(input.writeup).every((s) => !s?.trim()),
      );
    }
    // Check even supplied derived references, which will never be served as trusted HTML.
    for (const hash of hashes) {
      checkImportSignal(signal);
      if (!(await deps.blobs.hasContent(ownerId, hash, sizes.get(hash) ?? 0))) throw new ApiError("blob_missing");
    }
    checkImportSignal(signal);
    return { staged, holds, rendered, empty, counted, placements, changedBlocks };
  } finally {
    signal?.removeEventListener("abort", stop);
    await worker?.close();
  }
}
