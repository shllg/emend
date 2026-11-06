import { randomBytes, randomUUID } from "node:crypto";
import {
  type DocView,
  docViewOf,
  isRenderedHtmlDoc,
  LIMITS,
  type PublishRequest,
  type PublishResponse,
} from "@emend/contract";
import { composeRenames, decodeText } from "@emend/core";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db, Queries } from "../../db/client.ts";
import { DuplicateReviewKeyError } from "../../db/repo/reviews.ts";
import {
  agentNotes,
  blobs as blobRows,
  docAssets,
  files,
  placements,
  repos,
  reviews,
  revisions,
  threads,
  topics,
  writeups,
} from "../../db/schema.ts";
import type { BlobStore } from "../../store/blobs.ts";
import { ApiError } from "../http/errors.ts";
import { yieldToLoop } from "../pacing.ts";
import { insertChangedBlocks } from "./changed.ts";
import { WorkTimeout, workerExecutor } from "./executor.ts";
import { abortable, checkPublishSignal, PublishAborted, publishSlots } from "./lifecycle.ts";
import { fileMediaType } from "./media.ts";
import { validateNoteRanges } from "./notes.ts";
import { renderRevision } from "./render.ts";
import { revisionTransition } from "./transitions.ts";
import type { Executor, SharedSides, Work, WorkLast } from "./work.ts";

type Deps = { db: Db; blobs: BlobStore; baseUrl: string; executor?: Executor; signal?: AbortSignal };
type FileRow = typeof files.$inferSelect;
async function findReview(ownerId: string, instanceId: string, input: PublishRequest, q: Queries, create = true) {
  const owned = and(eq(reviews.ownerId, ownerId), eq(reviews.originInstanceId, instanceId));
  const existing = await q
    .select()
    .from(reviews)
    .where(and(owned, input.reviewId ? eq(reviews.id, input.reviewId) : eq(reviews.reviewKey, input.reviewKey)))
    .get();
  if (existing) {
    if (existing.movedToUrl) throw new ApiError("review_moved");
    return existing;
  }
  if (input.reviewId) throw new ApiError("unknown_review");
  if (!create) return undefined;
  let repoId: string | null = null;
  if (input.repo) {
    await q
      .insert(repos)
      .values({ ownerId, ...input.repo })
      .onConflictDoNothing({ target: [repos.ownerId, repos.key] });
    const repo = await q
      .select()
      .from(repos)
      .where(and(eq(repos.ownerId, ownerId), eq(repos.key, input.repo.key)))
      .get();
    if (!repo) throw new Error("Repository insert failed");
    repoId = repo.id;
  }
  const review = await q
    .insert(reviews)
    .values({
      ownerId,
      originInstanceId: instanceId,
      reviewKey: input.reviewKey,
      repoId,
      branch: input.branch,
      title: input.title,
    })
    .onConflictDoNothing({ target: [reviews.ownerId, reviews.originInstanceId, reviews.reviewKey] })
    .returning()
    .get();
  if (!review) throw new DuplicateReviewKeyError();
  return review;
}
export async function ingest(
  ownerId: string,
  instanceId: string,
  input: PublishRequest,
  deps: Deps,
): Promise<PublishResponse> {
  let release: (() => void) | undefined;
  try {
    release = await publishSlots.acquire(deps.signal);
    return await computePublish(ownerId, instanceId, input, deps);
  } catch (error) {
    if (deps.signal?.aborted || error instanceof PublishAborted) {
      console.error("emend: publish abandoned");
      throw new PublishAborted();
    }
    throw error;
  } finally {
    release?.();
  }
}
async function computePublish(
  ownerId: string,
  instanceId: string,
  input: PublishRequest,
  deps: Deps,
): Promise<PublishResponse> {
  const writeup = input.writeup;
  const writeupEmpty = [
    writeup.overview,
    writeup.tldr,
    writeup.decisions,
    writeup.glossary,
    ...Object.values(writeup.topics).flatMap((topic) => [topic.why, topic.example, topic.body]),
  ].every((section) => !section?.trim());
  const worker = deps.executor ? undefined : workerExecutor();
  const run = deps.executor ?? worker;
  if (!run) throw new Error("Missing executor");
  const execute: Executor = (work) => abortable(deps.signal, () => run(work));
  const stop = () => {
    void worker?.close();
  };
  deps.signal?.addEventListener("abort", stop, { once: true });
  let prepared: Awaited<ReturnType<typeof renderRevision>> | undefined;
  const attempt = async () => {
    checkPublishSignal(deps.signal);
    // Snapshot only metadata while holding the queue; no rendering or filesystem reads.
    const snapshot = await deps.db.query(async (q) => {
      const review = await findReview(ownerId, instanceId, input, q, false);
      const previous = review
        ? await q
            .select()
            .from(revisions)
            .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, review.id)))
            .orderBy(desc(revisions.seq))
            .get()
        : undefined;
      let history: (typeof revisions.$inferSelect)[] = [];
      const sizes = new Map<string, number>();
      for (const sha of new Set(input.files.flatMap((f) => [f.oldBlob, f.newBlob]).filter((s): s is string => !!s))) {
        const blob = await q
          .select()
          .from(blobRows)
          .where(and(eq(blobRows.ownerId, ownerId), eq(blobRows.sha256, sha)))
          .get();
        if (!blob) throw new ApiError("blob_missing");
        sizes.set(sha, blob.size);
      }
      const threadRows = review
        ? await q
            .select()
            .from(threads)
            .where(and(eq(threads.ownerId, ownerId), eq(threads.reviewId, review.id)))
        : [];
      const priorPlacements = previous
        ? await q
            .select()
            .from(placements)
            .where(and(eq(placements.ownerId, ownerId), eq(placements.revisionId, previous.id)))
        : [];
      const carriedByThread = new Map(priorPlacements.map((row) => [row.threadId, row.carried]));
      const threadSnapshots = [];
      const needed = new Set(previous ? [previous.id] : []);
      for (const thread of threadRows) {
        const latest = await q
          .select({ placement: placements, revision: revisions })
          .from(placements)
          .innerJoin(revisions, and(eq(revisions.id, placements.revisionId), eq(revisions.ownerId, ownerId)))
          .where(
            and(
              eq(placements.ownerId, ownerId),
              eq(placements.threadId, thread.id),
              eq(placements.reviewId, thread.reviewId),
              eq(placements.status, "placed"),
            ),
          )
          .orderBy(desc(revisions.seq))
          .get();
        const from =
          latest?.revision ??
          (await q
            .select()
            .from(revisions)
            .where(
              and(
                eq(revisions.ownerId, ownerId),
                eq(revisions.reviewId, thread.reviewId),
                eq(revisions.id, thread.createdRevisionId),
              ),
            )
            .get());
        if (!from) throw new Error("Missing thread revision");
        const carried = carriedByThread.get(thread.id);
        if (!carried && previous && from.seq < previous.seq) {
          if (!history.length)
            history = await q
              .select()
              .from(revisions)
              .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, thread.reviewId)))
              .orderBy(revisions.seq);
          for (const revision of history) if (revision.seq >= from.seq) needed.add(revision.id);
        }
        const location = latest?.placement.location ?? thread.target;
        const anchor =
          location.kind === "lines" || location.kind === "source-lines"
            ? await q
                .select({ oldBlob: files.oldBlob, newBlob: files.newBlob })
                .from(files)
                .where(
                  and(
                    eq(files.ownerId, ownerId),
                    eq(files.revisionId, from.id),
                    eq(files.role, location.kind === "source-lines" ? "doc" : "diff"),
                    eq(files.mediaType, "text/plain"),
                    eq(files.path, location.path),
                    isNull(files.flag),
                  ),
                )
                .get()
            : undefined;
        threadSnapshots.push({ thread, latest, from, carried, anchor });
      }
      const previousFiles = new Map<string, FileRow[]>();
      for (const revisionId of needed)
        previousFiles.set(
          revisionId,
          await q
            .select()
            .from(files)
            .where(and(eq(files.ownerId, ownerId), eq(files.revisionId, revisionId))),
        );
      const writeup = previous
        ? await q
            .select()
            .from(writeups)
            .where(and(eq(writeups.ownerId, ownerId), eq(writeups.revisionId, previous.id)))
            .get()
        : undefined;
      return { review, history, previous, sizes, threadSnapshots, previousFiles, writeup };
    });
    const { history, previous, sizes, threadSnapshots, previousFiles, writeup } = snapshot;
    const getFiles = (id: string) => previousFiles.get(id) ?? [];
    const read = async (sha: string): Promise<ArrayBuffer> => {
      const bytes = await deps.blobs.get(ownerId, sha);
      if (!bytes) throw new ApiError("blob_missing");
      if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
        return bytes.buffer;
      return Uint8Array.from(bytes).buffer;
    };
    if (
      [...sizes.values()].reduce((sum, size) => sum + size, Buffer.byteLength(JSON.stringify(input.writeup))) >
      LIMITS.revisionBytes
    )
      throw new ApiError("too_large");
    // Inspect metadata before reading any referenced blob, including cumulative HTML assets.
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
      for (const sha of [file.oldBlob, file.newBlob])
        if (sha) {
          const size = sizes.get(sha);
          if (size === undefined) throw new ApiError("blob_missing");
          if (size > limit) throw new ApiError("too_large");
        }
    }
    const assets = new Map(input.files.filter((file) => file.role === "asset").map((file) => [file.path, file]));
    for (const file of input.files)
      if (isRenderedHtmlDoc(file)) {
        let size = sizes.get(file.newBlob ?? "") ?? 0;
        for (const path of file.assets ?? []) {
          const asset = assets.get(path);
          if (!asset?.newBlob) throw new ApiError("invalid_request");
          size += sizes.get(asset.newBlob) ?? 0;
        }
        if (size > LIMITS.htmlDocWithAssetsBytes) throw new ApiError("too_large");
      }
    const checkedSources = new Set<string>();
    if (!prepared)
      for (const file of input.files) {
        if (file.role !== "doc" || docViewOf(file) !== "source" || !file.newBlob || checkedSources.has(file.newBlob))
          continue;
        const bytes = await read(file.newBlob);
        try {
          decodeText(new Uint8Array(bytes));
          checkedSources.add(file.newBlob);
        } catch {
          throw new ApiError("invalid_request");
        }
      }
    if (!prepared) await validateNoteRanges(input.files, read, execute);
    prepared ??= await renderRevision(
      input,
      execute,
      read,
      (bytes) => deps.blobs.put(ownerId, bytes, "application/json"),
      deps.signal,
    );
    const { ids, renderedBlob, sourceBlob, docBlobs, unrendered, metadata, sourceBlobs, sourceMetadata } = prepared;
    const sideTexts = new Map<string, ArrayBuffer>();
    const sideText = async (sha: string) => {
      let value = sideTexts.get(sha);
      if (value === undefined) {
        value = await read(sha);
        sideTexts.set(sha, value);
      }
      return value;
    };
    const sources = new Map<string, string>();
    const docs: Extract<Work, { kind: "place" }>["docs"] = new Map();
    const docTargets = new Set(
      threadSnapshots.flatMap(({ thread, latest }) => {
        const target = latest?.placement.location ?? thread.target;
        return target.kind === "doc-span" || target.kind === "html-span" ? [target.path] : [];
      }),
    );
    for (const file of input.files)
      if (file.role === "doc" && file.newBlob) {
        if (docViewOf(file) === "source") {
          if (
            threadSnapshots.some(
              ({ thread }) => thread.target.kind === "source-lines" && thread.target.path === file.path,
            )
          ) {
            await sideText(file.newBlob);
            sources.set(file.path, file.newBlob);
          }
        } else if (isRenderedHtmlDoc(file)) {
          if (docTargets.has(file.path)) {
            await sideText(file.newBlob);
            docs.set(file.path, { kind: "html", hash: file.newBlob });
          }
        } else {
          if (docTargets.has(file.path)) {
            const blob = docBlobs.get(file.path);
            if (blob) await sideText(blob);
            docs.set(file.path, { kind: "markdown", hash: blob ?? null });
          }
        }
      }
    const sides = async (
      file: { oldBlob: string | null; newBlob: string | null } | undefined,
      side: "old" | "new",
    ): Promise<SharedSides> => {
      const hash = side === "old" ? file?.oldBlob : file?.newBlob;
      if (!hash) return {};
      await sideText(hash);
      return side === "old" ? { oldHash: hash } : { newHash: hash };
    };
    const currentSides = new Map<string, SharedSides>();
    for (const file of input.files) currentSides.set(file.path, {});
    const workThreads: Extract<Work, { kind: "place" }>["threads"] = [];
    // Build each revision transition once. Only pre-carried rows need the legacy walk.
    const transitions = new Map<string, Map<string, string | null>>();
    for (let i = 1; i < history.length; i++) {
      const before = history[i - 1];
      const after = history[i];
      if (before && after)
        transitions.set(after.id, revisionTransition(getFiles(before.id), getFiles(after.id), before.base, after.base));
    }
    const nextTransition = revisionTransition(
      previous ? getFiles(previous.id) : [],
      input.files,
      previous?.base ?? null,
      input.base,
    );
    const carriedRows = new Map<string, NonNullable<typeof placements.$inferSelect.carried>>();
    for (const { thread, latest, from, carried, anchor } of threadSnapshots) {
      let last: WorkLast = latest?.placement.location ? { location: latest.placement.location } : null;
      if (thread.target.kind === "source-lines") {
        const location = last?.location.kind === "source-lines" ? last.location : thread.target;
        last = { location, sides: await sides(anchor, "new") };
      }
      if (thread.target.kind === "lines") {
        const location = last?.location.kind === "lines" ? last.location : thread.target;
        last = { location, sides: await sides(anchor, location.side) };
      }
      const steps: Map<string, string | null>[] = [];
      if (thread.target.kind === "lines" || thread.target.kind === "file") {
        if (!carried)
          for (const revision of history)
            if (revision.seq > from.seq) {
              const transition = transitions.get(revision.id);
              if (transition) steps.push(transition);
            }
        steps.push(nextTransition);
      }
      const location = last?.location ?? thread.target;
      const start = carried ?? {
        path: "path" in location ? location.path : null,
        ...(location.kind === "lines" ? { side: location.side } : {}),
      };
      const transition = steps.length === 1 ? steps[0] : composeRenames(steps);
      const mapped = start.path === null ? null : transition?.get(start.path);
      const next = { ...start, path: mapped === undefined ? start.path : mapped };
      carriedRows.set(thread.id, next);
      if (thread.target.kind === "lines" && next.path !== null) {
        const file = input.files.find((f) => f.role === "diff" && f.path === next.path && !f.flag);
        if (file)
          currentSides.set(file.path, {
            ...currentSides.get(file.path),
            ...(await sides(file, next.side ?? thread.target.side)),
          });
      }
      workThreads.push({ id: thread.id, target: thread.target, last, renames: steps, carried: start });
    }
    let placedRows: Extract<Awaited<ReturnType<Executor>>, { kind: "place" }>["placements"] = [];
    if (workThreads.length) {
      const needsWriteup = workThreads.some(({ target }) => target.kind === "writeup-span");
      if (needsWriteup) await sideText(renderedBlob);
      try {
        const result = await execute({
          kind: "place",
          writeup: needsWriteup ? renderedBlob : null,
          docs,
          sources,
          texts: sideTexts,
          files: currentSides,
          topics: new Set(input.topics.map((t) => t.slug)),
          threads: workThreads,
        });
        if (result.kind !== "place") throw new Error("wrong result");
        placedRows = result.placements;
      } catch (error) {
        if (error instanceof WorkTimeout) throw new ApiError("too_large", "placement_timeout");
        throw new ApiError("invalid_request", "placement_failed");
      }
    }
    let changedBytes: ArrayBuffer | undefined;
    if (previous) {
      const previousBlobs: Extract<Work, { kind: "changed" }>["previous"] = [];
      if (writeup) previousBlobs.push({ format: "writeup", bytes: await read(writeup.renderedBlob) });
      for (const file of getFiles(previous.id))
        if (file.renderedBlob && file.mediaType === "text/markdown")
          previousBlobs.push({ format: "doc", bytes: await read(file.renderedBlob) });
      // Rendering survives retries. Copy only the packed IDs before transferring them;
      // previous rendered bytes are read fresh from the current snapshot each attempt.
      const changed = await execute({
        kind: "changed",
        previous: previousBlobs,
        next: ids.map((bytes) => bytes.slice(0)),
      });
      if (changed.kind !== "changed") throw new Error("wrong result");
      changedBytes = changed.bytes;
    }
    checkPublishSignal(deps.signal);
    return deps.db.transaction(
      async (q) => {
        checkPublishSignal(deps.signal);
        const review = await findReview(ownerId, instanceId, input, q);
        if (!review) throw new Error("Missing review");
        const newest = await q
          .select()
          .from(revisions)
          .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, review.id)))
          .orderBy(desc(revisions.seq))
          .get();
        const currentThreads = await q
          .select({ id: threads.id })
          .from(threads)
          .where(and(eq(threads.ownerId, ownerId), eq(threads.reviewId, review.id)));
        const expectedIds = new Set(threadSnapshots.map(({ thread }) => thread.id));
        if (
          (newest?.id ?? null) !== (previous?.id ?? null) ||
          currentThreads.length !== expectedIds.size ||
          currentThreads.some((t) => !expectedIds.has(t.id))
        )
          throw new PublishConflict();
        const revision = {
          id: randomUUID(),
          ownerId,
          reviewId: review.id,
          seq: (previous?.seq ?? 0) + 1,
          base: input.base,
          head: input.head,
          main: input.main ?? null,
          writeupEmpty,
          contentKey: randomBytes(32).toString("base64url"),
        };
        await q.insert(revisions).values(revision);
        for (const topic of input.topics)
          await q.insert(topics).values({
            ownerId,
            revisionId: revision.id,
            slug: topic.slug,
            title: topic.title,
            importance: topic.importance,
            summary: topic.summary,
            attention: topic.attention,
            door: topic.door,
            blastScope: topic.blastRadius?.scope,
            blastNote: topic.blastRadius?.note,
          });
        await q.insert(writeups).values({
          ownerId,
          revisionId: revision.id,
          sourceBlob,
          renderedBlob,
        });
        const fileKey = (file: { role: string; path: string; view?: DocView }) =>
          `${file.role === "diff" ? "diff" : file.role === "doc" && docViewOf(file) === "source" ? "source" : "doc"}:${file.path}`;
        const ids = new Map(input.files.map((file) => [fileKey(file), randomUUID()]));
        const ordered = input.files
          .map((file, ord) => ({ file, ord }))
          .sort((a, b) => Number(a.file.role === "asset") - Number(b.file.role === "asset"));
        let inserted = 0;
        for (const { file, ord } of ordered) {
          checkPublishSignal(deps.signal);
          const fileId = ids.get(fileKey(file));
          if (!fileId) throw new Error("Missing file id");
          await q.insert(files).values({
            id: fileId,
            ownerId,
            revisionId: revision.id,
            path: file.path,
            oldPath: file.oldPath,
            role: file.role,
            status: file.status,
            topicSlug: file.topic,
            ord,
            mediaType: fileMediaType(file),
            oldBlob: file.oldBlob,
            newBlob: file.newBlob,
            flag: file.flag,
            parentDocId: file.parent ? ids.get(`doc:${file.parent}`) : null,
            title:
              file.role === "doc"
                ? ((docViewOf(file) === "source" ? sourceMetadata : metadata).get(file.path)?.title ?? null)
                : null,
            headings:
              file.role === "doc"
                ? ((docViewOf(file) === "source" ? sourceMetadata : metadata).get(file.path)?.headings ?? null)
                : null,
            renderedBlob:
              file.role === "doc"
                ? ((docViewOf(file) === "source" ? sourceBlobs : docBlobs).get(file.path) ?? null)
                : null,
          });
          for (const [noteOrd, note] of (file.notes ?? []).entries())
            await q.insert(agentNotes).values({
              ownerId,
              fileId,
              side: note.side,
              startLine: note.start,
              endLine: note.end,
              summary: note.summary,
              rationale: note.rationale,
              ref: note.ref,
              ord: noteOrd,
            });
          if (++inserted % 100 === 0) await yieldToLoop("publish-files");
        }
        let associations: (typeof docAssets.$inferInsert)[] = [];
        for (const file of input.files) {
          if (!isRenderedHtmlDoc(file)) continue;
          const docId = ids.get(fileKey(file));
          if (!docId) throw new Error("Missing doc id");
          for (const path of file.assets ?? []) {
            const assetId = ids.get(`doc:${path}`);
            if (!assetId) throw new Error("Missing asset id");
            associations.push({ ownerId, revisionId: revision.id, docId, assetId });
            if (associations.length === 500) {
              checkPublishSignal(deps.signal);
              await q.insert(docAssets).values(associations);
              associations = [];
              await yieldToLoop("publish-doc-assets");
            }
          }
        }
        if (associations.length) await q.insert(docAssets).values(associations);
        if (changedBytes) await insertChangedBlocks(q, ownerId, revision.id, changedBytes, deps.signal);
        for (const { id, placement } of placedRows) {
          checkPublishSignal(deps.signal);
          await q.insert(placements).values({
            ownerId,
            reviewId: review.id,
            threadId: id,
            revisionId: revision.id,
            status: placement.status,
            location: placement.status === "placed" ? placement.location : null,
            reason: placement.status === "unplaced" ? placement.reason : null,
            carried: carriedRows.get(id),
          });
          if (++inserted % 100 === 0) await yieldToLoop("publish-placements");
        }
        // A new revision reopens the review and ends any snooze; released_at stays as history.
        await q
          .update(reviews)
          .set({
            state: "open",
            approvedRevision: null,
            snoozedAt: null,
            snoozedUntil: null,
            title: input.title,
            branch: input.branch,
            updatedAt: Date.now(),
          })
          .where(and(eq(reviews.ownerId, ownerId), eq(reviews.id, review.id)));
        await yieldToLoop("publish-finalize");
        checkPublishSignal(deps.signal);
        return {
          reviewId: review.id,
          revision: revision.seq,
          url: `${deps.baseUrl}/r/${review.id}`,
          placed: placedRows.filter((p) => p.placement.status === "placed").length,
          unplaced: placedRows.filter((p) => p.placement.status === "unplaced").length,
          unrendered,
        };
      },
      { offThread: true },
    );
  };
  try {
    for (let tries = 0; tries < 3; tries++) {
      try {
        return await attempt();
      } catch (error) {
        if (
          !(error instanceof PublishConflict) &&
          !(error instanceof DuplicateReviewKeyError) &&
          !sequenceConflict(error) &&
          // A delete removed a blob between the snapshot and the commit; the retry re-reads the blobs.
          !foreignKeyFailure(error)
        )
          throw error;
        // The rendered and source blobs may be the ones the delete removed: render and put them again.
        if (foreignKeyFailure(error)) prepared = undefined;
      }
    }
    throw new ApiError("publish_conflict");
  } finally {
    deps.signal?.removeEventListener("abort", stop);
    await worker?.close();
  }
}
class PublishConflict extends Error {}
function foreignKeyFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /FOREIGN KEY constraint failed/.test(error.message) || foreignKeyFailure(error.cause);
}
function sequenceConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /UNIQUE constraint failed: revisions\.review_id, revisions\.seq|revisions_review_seq_unique/.test(error.message) ||
    sequenceConflict(error.cause)
  );
}
