import type { Placement, Target } from "@emend/contract";
import type { files, placements, revisions, writeups } from "../../db/schema.ts";
import type { BlobStore } from "../../store/blobs.ts";
import { ApiError } from "../http/errors.ts";
import { WorkTimeout, workerExecutor } from "../publish/executor.ts";
import { abortable, checkPublishSignal } from "../publish/lifecycle.ts";
import { revisionTransition } from "../publish/transitions.ts";
import type { Executor, SharedSides, Work, WorkLast } from "../publish/work.ts";

export type PlacementDeps = { blobs: BlobStore; executor?: Executor; signal?: AbortSignal };
type Snapshot = {
  revision: typeof revisions.$inferSelect;
  files: (typeof files.$inferSelect)[];
  topics: { slug: string; title?: string; summary?: string }[];
  writeup: typeof writeups.$inferSelect | undefined;
};
type Carried = NonNullable<typeof placements.$inferSelect.carried>;

function originalLocation(target: Target, placement: Placement) {
  if (placement.status !== "placed") return false;
  const location = placement.location;
  if (target.kind !== location.kind) return false;
  for (const key of ["path", "blockId", "side", "slug", "part", "start", "end"] as const)
    if (key in target && (!(key in location) || Reflect.get(target, key) !== Reflect.get(location, key))) return false;
  return true;
}

export async function computePlacements(
  ownerId: string,
  threadId: string,
  target: Target,
  snapshots: Snapshot[],
  deps: PlacementDeps,
) {
  const worker = deps.executor ? undefined : workerExecutor();
  const run = deps.executor ?? worker;
  if (!run) throw new Error("Missing executor");
  const stop = () => {
    void worker?.close();
  };
  deps.signal?.addEventListener("abort", stop, { once: true });
  let carried: Carried = {
    path: "path" in target ? target.path : null,
    ...(target.kind === "lines" ? { side: target.side } : {}),
  };
  let last: WorkLast = null;
  let anchor: typeof files.$inferSelect | undefined;
  const result: Pick<typeof placements.$inferInsert, "revisionId" | "status" | "location" | "reason" | "carried">[] =
    [];
  try {
    for (const [index, snapshot] of snapshots.entries()) {
      checkPublishSignal(deps.signal);
      const previous = snapshots[index - 1];
      const transition =
        previous && (target.kind === "lines" || target.kind === "file")
          ? revisionTransition(previous.files, snapshot.files, previous.revision.base, snapshot.revision.base)
          : new Map<string, string | null>();
      const mapped = carried.path === null ? null : transition.get(carried.path);
      const next = { ...carried, path: mapped === undefined ? carried.path : mapped };
      const texts = new Map<string, ArrayBuffer>();
      const read = async (hash: string) => {
        if (texts.has(hash)) return;
        const bytes = await deps.blobs.get(ownerId, hash);
        if (!bytes) throw new ApiError("blob_missing");
        texts.set(hash, Uint8Array.from(bytes).buffer);
      };
      const sides = async (file: typeof files.$inferSelect | undefined): Promise<SharedSides> => {
        if ((target.kind !== "lines" && target.kind !== "source-lines") || file?.flag) return {};
        const hash = target.kind === "lines" && target.side === "old" ? file?.oldBlob : file?.newBlob;
        if (!hash) return {};
        await read(hash);
        return target.kind === "lines" && target.side === "old" ? { oldHash: hash } : { newHash: hash };
      };
      const current = snapshot.files.find(
        (f) =>
          (target.kind === "source-lines" ? f.role === "doc" && f.mediaType === "text/plain" : f.role === "diff") &&
          f.path === next.path,
      );
      if (index === 0 && (target.kind === "lines" || target.kind === "source-lines")) {
        last = {
          location:
            target.kind === "lines"
              ? { kind: "lines", path: target.path, side: target.side, start: target.start, end: target.end }
              : { kind: "source-lines", path: target.path, start: target.start, end: target.end },
          sides: await sides(current),
        };
        anchor = current;
      } else if (last?.location.kind === "lines" || last?.location.kind === "source-lines")
        last = { location: last.location, sides: await sides(anchor) };
      const fileMap = new Map<string, SharedSides>(snapshot.files.map((f) => [f.path, {}]));
      if (current) fileMap.set(current.path, await sides(current));
      const sources = new Map<string, string>();
      if (target.kind === "source-lines" && current?.newBlob) {
        await read(current.newBlob);
        sources.set(current.path, current.newBlob);
      }
      const docs: Extract<Work, { kind: "place" }>["docs"] = new Map();
      if (target.kind === "doc-span" || target.kind === "html-span") {
        const doc = snapshot.files.find(
          (f) => f.role === "doc" && f.mediaType !== "text/plain" && f.path === target.path,
        );
        if (doc?.mediaType === "text/html" && doc.newBlob) {
          await read(doc.newBlob);
          docs.set(doc.path, { kind: "html", hash: doc.newBlob });
        } else if (doc) {
          if (doc.renderedBlob) await read(doc.renderedBlob);
          docs.set(doc.path, { kind: "markdown", hash: doc.renderedBlob });
        }
      }
      const writeup = target.kind === "writeup-span" ? (snapshot.writeup?.renderedBlob ?? null) : null;
      if (writeup) await read(writeup);
      const topicText =
        target.kind === "topic" && target.part
          ? new Map(
              snapshot.topics.map((t) => {
                if (t.title === undefined || t.summary === undefined) throw new Error("Missing topic placement text");
                return [t.slug, { title: t.title, summary: t.summary }];
              }),
            )
          : undefined;
      let placed: Awaited<ReturnType<Executor>>;
      try {
        placed = await abortable(deps.signal, () =>
          run({
            kind: "place",
            writeup,
            docs,
            sources,
            texts,
            files: fileMap,
            topics: new Set(snapshot.topics.map((t) => t.slug)),
            ...(topicText ? { topicText } : {}),
            threads: [{ id: threadId, target, last, renames: [transition], carried }],
          }),
        );
      } catch (error) {
        if (error instanceof WorkTimeout) throw new ApiError("too_large", "placement_timeout");
        throw new ApiError("invalid_request", "placement_failed");
      }
      if (placed.kind !== "place" || !placed.placements[0]) throw new ApiError("invalid_request", "placement_failed");
      const placement = placed.placements[0].placement;
      if (index === 0 && !originalLocation(target, placement)) throw new ApiError("invalid_target");
      result.push({
        revisionId: snapshot.revision.id,
        status: placement.status,
        location: placement.status === "placed" ? placement.location : null,
        reason: placement.status === "unplaced" ? placement.reason : null,
        carried: next,
      });
      if (placement.status === "placed") {
        last = { location: placement.location };
        anchor = current;
      }
      carried = next;
    }
    checkPublishSignal(deps.signal);
    return result;
  } finally {
    deps.signal?.removeEventListener("abort", stop);
    await worker?.close();
  }
}
