import {
  type ImportBundle,
  type ImportRevisionIndex,
  isRenderedHtmlDoc,
  LIMITS,
  type Placement,
  type PlacementLocation,
} from "@emend/contract";
import type { placements } from "../../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { yieldToLoop } from "../pacing.ts";
import { WorkTimeout } from "../publish/executor.ts";
import { revisionTransition } from "../publish/transitions.ts";
import type { EncodedPlacementDoc, Executor, SharedSides, Work, WorkLast } from "../publish/work.ts";
import { checkImportSignal } from "./lifecycle.ts";
import { chargePlacementMetadata } from "./placement-budget.ts";

type Thread = ImportBundle["threads"][number];
type File = ImportBundle["files"][number];
type Carried = NonNullable<typeof placements.$inferSelect.carried>;
export type ImportPlacement = Omit<typeof placements.$inferInsert, "ownerId">;
type State = { thread: Thread; last: PlacementLocation | null; anchor?: File; carried: Carried };

function originalLocation(target: Thread["target"], placement: Placement) {
  if (placement.status !== "placed" || target.kind !== placement.location.kind) return false;
  for (const key of ["path", "blockId", "side", "slug", "start", "end"] as const)
    if (key in target && Reflect.get(target, key) !== Reflect.get(placement.location, key)) return false;
  return true;
}

/** Sequential replay, with the same last-successful anchor and carried identity as thread creation. */
export function importPlacements() {
  const active = new Map<string, State>();
  let previous: ImportRevisionIndex | undefined;
  let cachedDocs = new Map<string, EncodedPlacementDoc>();
  let placementBytes = 0;
  const charge = (bytes: number) => {
    if (bytes > LIMITS.importPlacementBytes - placementBytes) throw new ApiError("too_large");
    placementBytes += bytes;
  };
  return async (
    revision: ImportRevisionIndex,
    rendered: { renderedBlob: string; docBlobs: Map<string, string> },
    read: (hash: string) => Promise<ArrayBuffer>,
    execute: Executor,
    signal?: AbortSignal,
  ): Promise<ImportPlacement[]> => {
    const previousDocs = cachedDocs;
    cachedDocs = new Map();
    const parsedDocs = new Map<string, EncodedPlacementDoc>();
    const loadParsed = async (hash: string, format: "html" | "markdown" | "writeup") => {
      const key = `${format}:${hash}`;
      let cached = cachedDocs.get(key) ?? previousDocs.get(key);
      if (!cached) {
        const bytes = await read(hash);
        charge(bytes.byteLength);
        const work: Work = { kind: "placement-doc", format, bytes };
        chargePlacementMetadata(work, charge);
        try {
          const result = await execute(work);
          if (result.kind !== "placement-doc") throw new Error("Wrong result");
          cached = { bytes: result.bytes, textBytes: result.textBytes, encodedBytes: result.encodedBytes };
        } catch (error) {
          checkImportSignal(signal);
          if (error instanceof WorkTimeout) throw new ApiError("too_large", "placement_timeout");
          throw new ApiError("invalid_request", "placement_failed");
        }
      }
      cachedDocs.set(key, cached);
      return cached;
    };
    const created = new Set(revision.threads.map((t) => t.id));
    for (const thread of revision.threads)
      active.set(thread.id, {
        thread,
        last: null,
        carried: {
          path: "path" in thread.target ? thread.target.path : null,
          ...(thread.target.kind === "lines" ? { side: thread.target.side } : {}),
        },
      });
    const transition = previous
      ? revisionTransition(previous.files, revision.files, previous.row.base, revision.row.base)
      : new Map<string, string | null>();
    previous = revision;
    if (!active.size) return [];
    const texts = new Map<string, ArrayBuffer>();
    const sideTextBytes = new Map<string, number>();
    const include = async (hash: string, countText: boolean) => {
      if (!texts.has(hash)) {
        const bytes = await read(hash);
        charge(bytes.byteLength);
        texts.set(hash, bytes);
        // Match TextDecoder in the worker, including replacement of invalid UTF-8.
        sideTextBytes.set(hash, Buffer.byteLength(new TextDecoder().decode(bytes)));
      }
      if (countText) charge(sideTextBytes.get(hash) ?? 0);
      return hash;
    };
    const sideHash = (file: File | undefined, side: "old" | "new") =>
      file?.flag ? null : side === "old" ? file?.oldBlob : file?.newBlob;
    const sides = async (
      hash: string | null | undefined,
      side: "old" | "new",
      countText = true,
    ): Promise<SharedSides> => {
      return hash
        ? side === "old"
          ? { oldHash: await include(hash, countText) }
          : { newHash: await include(hash, countText) }
        : {};
    };
    // File membership and diff sides have separate passes: a doc cannot erase diff hashes.
    const files = new Map<string, SharedSides>(revision.files.map((f) => [f.path, {}]));
    const sources = new Map<string, string>();
    const docs: Extract<Work, { kind: "place" }>["docs"] = new Map();
    const workThreads: Extract<Work, { kind: "place" }>["threads"] = [];
    const nextCarried = new Map<string, Carried>();
    let writeup: Awaited<ReturnType<typeof loadParsed>> | undefined;
    for (const [id, state] of active) {
      checkImportSignal(signal);
      const { target } = state.thread;
      const steps = !created.has(id) && (target.kind === "lines" || target.kind === "file") ? [transition] : [];
      const mapped = state.carried.path === null ? null : steps[0]?.get(state.carried.path);
      const next = { ...state.carried, path: mapped === undefined ? state.carried.path : mapped };
      nextCarried.set(id, next);
      let last: WorkLast = state.last ? { location: state.last } : null;
      if (target.kind === "source-lines") {
        const current = next.path === null ? undefined : revision.sourcePaths.get(next.path);
        if (created.has(id)) {
          state.anchor = current;
          state.last = { kind: "source-lines", path: target.path, start: target.start, end: target.end };
        }
        const previousHash = sideHash(state.anchor, "new");
        const nextHash = sideHash(current, "new");
        if (state.last)
          last = { location: state.last, sides: await sides(previousHash, "new", previousHash !== nextHash) };
        if (current && nextHash) sources.set(current.path, await include(nextHash, true));
      }
      if (target.kind === "lines") {
        const current = next.path === null ? undefined : revision.diffPaths.get(next.path);
        if (created.has(id)) {
          state.anchor = current;
          state.last = { kind: "lines", path: target.path, side: target.side, start: target.start, end: target.end };
        }
        const previousHash = sideHash(state.anchor, target.side);
        const nextHash = sideHash(current, target.side);
        // Equal hashes use tier 0: it checks the new text without mapping the previous side.
        if (state.last)
          last = { location: state.last, sides: await sides(previousHash, target.side, previousHash !== nextHash) };
        if (current) files.set(current.path, { ...files.get(current.path), ...(await sides(nextHash, target.side)) });
      }
      if (target.kind === "doc-span" || target.kind === "html-span") {
        const doc = revision.docPaths.get(target.path);
        if (doc?.role === "doc" && doc.newBlob) {
          if (!parsedDocs.has(doc.path) && !docs.has(doc.path)) {
            const html = isRenderedHtmlDoc(doc);
            const hash = html ? doc.newBlob : rendered.docBlobs.get(doc.path);
            const parsed = hash ? await loadParsed(hash, html ? "html" : "markdown") : undefined;
            if (parsed) parsedDocs.set(doc.path, parsed);
            else docs.set(doc.path, { kind: "markdown", hash: null });
          }
          charge(parsedDocs.get(doc.path)?.textBytes ?? 0);
        }
      }
      if (target.kind === "writeup-span") {
        writeup ??= await loadParsed(rendered.renderedBlob, "writeup");
        charge(writeup.textBytes);
      }
      workThreads.push({ id, target, last, renames: steps, carried: state.carried });
    }
    const work: Work = {
      kind: "place",
      writeup: null,
      parsedWriteup: writeup,
      docs,
      sources,
      parsedDocs,
      texts,
      files,
      topics: revision.topicSlugs,
      threads: workThreads,
    };
    chargePlacementMetadata(work, charge);
    // Charge every shared payload once, before making any copies. Retain the cache's
    // buffers; only the per-job copies are transferred (and detached) by the executor.
    const payloads = new Set(parsedDocs.values());
    if (writeup) payloads.add(writeup);
    for (const doc of payloads) charge(doc.encodedBytes);
    const copies = new Map<EncodedPlacementDoc, EncodedPlacementDoc>();
    const copy = async (doc: EncodedPlacementDoc) => {
      let copied = copies.get(doc);
      if (!copied) {
        copied = { ...doc, bytes: doc.bytes.slice(0) };
        copies.set(doc, copied);
        await yieldToLoop("import-placement-copy");
        checkImportSignal(signal);
      }
      return copied;
    };
    const copiedDocs = new Map<string, EncodedPlacementDoc>();
    for (const [path, doc] of parsedDocs) copiedDocs.set(path, await copy(doc));
    work.parsedDocs = copiedDocs;
    work.parsedWriteup = writeup ? await copy(writeup) : undefined;
    let result: Awaited<ReturnType<Executor>>;
    try {
      result = await execute(work);
    } catch (error) {
      checkImportSignal(signal);
      if (error instanceof WorkTimeout) throw new ApiError("too_large", "placement_timeout");
      throw new ApiError("invalid_request", "placement_failed");
    }
    if (result.kind !== "place" || result.placements.length !== active.size)
      throw new ApiError("invalid_request", "placement_failed");
    const rows: ImportPlacement[] = [];
    for (const { id, placement } of result.placements) {
      const state = active.get(id),
        carried = nextCarried.get(id);
      if (!state || !carried || (created.has(id) && !originalLocation(state.thread.target, placement)))
        throw new ApiError("invalid_request");
      rows.push({
        reviewId: state.thread.reviewId,
        threadId: id,
        revisionId: revision.row.id,
        status: placement.status,
        location: placement.status === "placed" ? placement.location : null,
        reason: placement.status === "unplaced" ? placement.reason : null,
        carried,
      });
      if (placement.status === "placed") {
        state.last = placement.location;
        state.anchor =
          carried.path === null
            ? undefined
            : (state.thread.target.kind === "source-lines" ? revision.sourcePaths : revision.diffPaths).get(
                carried.path,
              );
      }
      state.carried = carried;
    }
    return rows;
  };
}
