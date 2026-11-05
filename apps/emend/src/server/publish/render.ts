import { LIMITS, type PublishRequest } from "@emend/contract";
import { cleanDocTitle, type DocLinks } from "@emend/core";
import { ApiError } from "../http/errors.ts";
import { yieldToLoop } from "../pacing.ts";
import { WorkTimeout } from "./executor.ts";
import { checkPublishSignal } from "./lifecycle.ts";
import { mediaType } from "./media.ts";
import type { DocMetadata, Executor, RenderedBytes } from "./work.ts";

export async function renderRevision(
  input: PublishRequest,
  execute: Executor,
  read: (hash: string) => Promise<ArrayBuffer>,
  put: (bytes: Buffer) => Promise<string>,
  signal?: AbortSignal,
  onRendered?: (bytes: number) => void,
) {
  // Two passes let forward links resolve headings before any writeup/doc is rendered.
  // The worker parses hostile sources; only bounded metadata crosses back to the server.
  const metadata = new Map<string, DocMetadata>();
  const metadataCache = new Map<string, DocMetadata>();
  let metadataBytes = 0;
  for (const file of input.files) {
    checkPublishSignal(signal);
    if (file.role !== "doc") continue;
    const format = mediaType(file.path) === "text/html" ? "html" : "markdown";
    const key = `${format}:${file.newBlob}`;
    let own = metadataCache.get(key);
    if (!own) {
      own = { headings: [] };
      if (file.newBlob)
        try {
          const result = await execute({ kind: "doc-metadata", format, bytes: await read(file.newBlob) });
          if (result.kind !== "doc-metadata") throw new Error("wrong result");
          own = { title: result.title, headings: result.headings };
        } catch {
          checkPublishSignal(signal);
        }
      metadataCache.set(key, own);
    }
    const doc = {
      title:
        cleanDocTitle(file.title ?? "") || own.title || cleanDocTitle(file.path.split("/").at(-1) ?? "") || "Document",
      headings: own.headings,
    };
    const size = Buffer.byteLength(JSON.stringify(doc));
    metadataBytes += size;
    onRendered?.(size);
    if (metadataBytes > LIMITS.renderedBytesPerRevision) throw new ApiError("too_large");
    metadata.set(file.path, doc);
    await yieldToLoop("publish-render");
  }
  const headingIds = new Map<DocMetadata["headings"], ReadonlySet<string>>();
  const docs: DocLinks = new Map(
    [...metadata].map(([path, doc]) => {
      let ids = headingIds.get(doc.headings);
      if (!ids) {
        ids = new Set(doc.headings.flatMap((h) => (h.id ? [h.id] : [])));
        headingIds.set(doc.headings, ids);
      }
      return [path, ids];
    }),
  );
  let rendered: RenderedBytes;
  try {
    const media: [string, string][] = [];
    for (const file of input.files)
      if (file.role === "asset" && file.parent === undefined && file.newBlob) media.push([file.path, file.newBlob]);
    const result = await execute({
      kind: "writeup",
      source: input.writeup,
      topics: input.topics,
      links: input.links,
      repoUrl: input.repoUrl,
      media,
      docs,
    });
    if (result.kind !== "writeup") throw new Error("wrong result");
    rendered = result;
  } catch (error) {
    checkPublishSignal(signal);
    if (error instanceof WorkTimeout) throw new ApiError("too_large", "writeup_timeout");
    throw new ApiError("invalid_request", "writeup_failed");
  }
  const ids = [rendered.ids];
  const renderedBytes = Buffer.from(rendered.bytes);
  onRendered?.(renderedBytes.length);
  let count = rendered.count;
  let bytes = renderedBytes.length + metadataBytes;
  if (count > LIMITS.blocksPerRevision || bytes > LIMITS.renderedBytesPerRevision)
    throw new ApiError("too_large", "writeup_blocks");
  // Give the worker reply's allocation/GC turn back before hashing and persisting
  // its bytes; those two individually bounded stretches must not run together.
  await yieldToLoop("publish-render");
  checkPublishSignal(signal);
  const renderedBlob = await put(renderedBytes);
  await yieldToLoop("publish-render");
  checkPublishSignal(signal);
  // The source blob keeps the publish-level fields beside the writeup so an export and import carry them.
  const sourceBlob = await put(
    Buffer.from(
      JSON.stringify({
        ...input.writeup,
        ...(input.links?.length ? { links: input.links } : {}),
        ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
      }),
    ),
  );
  const cache = new Map<string, string | null>();
  const folderCache = new Map<string, string>();
  const docBlobs = new Map<string, string>();
  const unrendered: string[] = [];
  const markUnrendered = (path: string) => {
    unrendered.push(path);
    const doc = metadata.get(path);
    if (doc) doc.headings = [];
  };
  let exhausted = false;
  for (const file of input.files) {
    checkPublishSignal(signal);
    if (file.role !== "doc" || !file.newBlob || mediaType(file.path) !== "text/markdown") continue;
    if (exhausted) {
      markUnrendered(file.path);
      continue;
    }
    let result: RenderedBytes;
    const folderKey = `${file.newBlob}:${file.path.slice(0, file.path.lastIndexOf("/") + 1)}`;
    const source = cache.get(file.newBlob);
    const shared = source === undefined ? folderCache.get(folderKey) : source;
    if (shared === null) {
      markUnrendered(file.path);
      continue;
    }
    try {
      const rendered = await execute(
        shared === undefined
          ? { kind: "doc", path: file.path, source: await read(file.newBlob), repoUrl: input.repoUrl, docs }
          : { kind: "resection", path: file.path, bytes: await read(shared) },
      );
      if (rendered.kind !== "doc") throw new Error("wrong result");
      result = rendered;
    } catch {
      checkPublishSignal(signal);
      // A source that fails once is intentionally unrendered in every folder, even if resection failed.
      cache.set(file.newBlob, null);
      markUnrendered(file.path);
      continue;
    }
    const json = Buffer.from(result.bytes);
    onRendered?.(json.length);
    if (count + result.count > LIMITS.blocksPerRevision || bytes + json.length > LIMITS.renderedBytesPerRevision) {
      exhausted = true;
      markUnrendered(file.path);
      continue;
    }
    count += result.count;
    bytes += json.length;
    await yieldToLoop("publish-render");
    checkPublishSignal(signal);
    const blob = await put(json);
    docBlobs.set(file.path, blob);
    if (shared === undefined) {
      if (!result.pathDependent) cache.set(file.newBlob, blob);
      else if (!result.selfDependent) folderCache.set(folderKey, blob);
    }
    ids.push(result.ids);
  }
  return { ids, renderedBlob, sourceBlob, docBlobs, count, unrendered, metadata };
}
