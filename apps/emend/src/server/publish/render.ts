import { docViewOf, isRenderedHtmlDoc, LIMITS, type PublishRequest } from "@emend/contract";
import {
  cleanDocTitle,
  type DocLinks,
  decodeText,
  HIGHLIGHT_SOURCE_BYTES,
  HIGHLIGHT_SOURCE_REVISION_BYTES,
  headingLookups,
  sourceLanguage,
} from "@emend/core";
import { ApiError } from "../http/errors.ts";
import { yieldToLoop } from "../pacing.ts";
import { WorkTimeout } from "./executor.ts";
import { IMAGE_HEAD_BYTES } from "./image-size.ts";
import { checkPublishSignal } from "./lifecycle.ts";
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
  const sourceMetadata = new Map<string, DocMetadata>();
  const sourceBlobs = new Map<string, string>();
  const metadata = new Map<string, DocMetadata>();
  const metadataCache = new Map<string, DocMetadata>();
  let metadataBytes = 0;
  for (const file of input.files) {
    checkPublishSignal(signal);
    if (file.role !== "doc") continue;
    const source = docViewOf(file) === "source";
    const format = isRenderedHtmlDoc(file) ? "html" : "markdown";
    const key = `${format}:${file.newBlob}`;
    let own = source ? { headings: [] } : metadataCache.get(key);
    if (!own) {
      own = { headings: [] };
      if (file.newBlob && !source)
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
    (source ? sourceMetadata : metadata).set(file.path, doc);
    await yieldToLoop("publish-render");
  }
  const lookupCache = new Map<DocMetadata["headings"], ReadonlyMap<string, string>>();
  const docs = new Map<string, ReadonlyMap<string, string>>() satisfies DocLinks;
  let lookupBytes = 0;
  for (const [path, doc] of metadata) {
    checkPublishSignal(signal);
    let names = lookupCache.get(doc.headings);
    if (!names) {
      names = headingLookups(doc.headings);
      for (const [name, id] of names) {
        lookupBytes += Buffer.byteLength(name) + Buffer.byteLength(id) + 32;
        if (lookupBytes > LIMITS.headingLookupBytesPerRevision) throw new ApiError("too_large");
      }
      lookupCache.set(doc.headings, names);
    }
    docs.set(path, names);
    await yieldToLoop("publish-render");
  }
  const media: [string, string][] = [];
  for (const file of input.files)
    if (file.role === "asset" && file.parent === undefined && file.newBlob) media.push([file.path, file.newBlob]);
  // Only the first bytes of each distinct blob cross to the worker, which reads the image sizes.
  const mediaHeads: [string, ArrayBuffer][] = [];
  for (const sha of new Set(media.map(([, blob]) => blob))) {
    checkPublishSignal(signal);
    mediaHeads.push([sha, (await read(sha)).slice(0, IMAGE_HEAD_BYTES)]);
    await yieldToLoop("publish-render");
  }
  let rendered: RenderedBytes;
  try {
    const result = await execute({
      kind: "writeup",
      source: input.writeup,
      topics: input.topics,
      links: input.links,
      repoUrl: input.repoUrl,
      media,
      mediaHeads,
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
  const sourceCounts = new Map<string, { lines: number; bytes: number }>();
  const sourceCache = new Map<string, { blob: string; bytes: number } | null>();
  let sourceLines = 0;
  let sourceBytes = 0;
  let highlightBytes = 0;
  let exhausted = false;
  for (const file of input.files) {
    checkPublishSignal(signal);
    if (file.role !== "doc" || !file.newBlob || isRenderedHtmlDoc(file)) continue;
    if (docViewOf(file) === "source") {
      if (exhausted) {
        unrendered.push(file.path);
        continue;
      }
      let key: string | undefined;
      try {
        let content: ArrayBuffer | undefined;
        let size = sourceCounts.get(file.newBlob);
        if (!size) {
          content = await read(file.newBlob);
          const text = decodeText(new Uint8Array(content));
          let lines = text.length && !text.endsWith("\n") ? 1 : 0;
          for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
          size = { lines, bytes: Buffer.byteLength(text) };
          sourceCounts.set(file.newBlob, size);
        }
        if (
          sourceLines + size.lines > LIMITS.sourceLinesPerRevision ||
          sourceBytes + size.bytes > LIMITS.sourceBytesPerRevision
        ) {
          unrendered.push(file.path);
          continue;
        }
        const language = sourceLanguage(file.path);
        const highlight =
          language !== "text" &&
          size.bytes <= HIGHLIGHT_SOURCE_BYTES &&
          highlightBytes + size.bytes <= HIGHLIGHT_SOURCE_REVISION_BYTES;
        key = `${language}:${file.newBlob}:${highlight}`;
        let shared = sourceCache.get(key);
        if (shared === null) {
          unrendered.push(file.path);
          continue;
        }
        // Charge before dispatch: failed/timed-out work consumes the budget too.
        // Successful aliases still count per row, even when reusing cached tokens.
        if (highlight) highlightBytes += size.bytes;
        let json: Buffer | undefined;
        if (!shared) {
          const result = await execute({
            kind: "source",
            path: file.path,
            source: content ?? (await read(file.newBlob)),
            highlight,
          });
          if (result.kind !== "source") throw new Error("wrong result");
          json = Buffer.from(result.bytes);
        }
        const renderedSize = shared?.bytes ?? json?.length ?? 0;
        onRendered?.(renderedSize);
        if (bytes + renderedSize > LIMITS.renderedBytesPerRevision) {
          exhausted = true;
          unrendered.push(file.path);
          continue;
        }
        bytes += renderedSize;
        sourceLines += size.lines;
        sourceBytes += size.bytes;
        await yieldToLoop("publish-render");
        checkPublishSignal(signal);
        if (!shared && json) {
          shared = { blob: await put(json), bytes: renderedSize };
          sourceCache.set(key, shared);
        }
        if (shared) sourceBlobs.set(file.path, shared.blob);
      } catch (error) {
        checkPublishSignal(signal);
        if (error instanceof ApiError) throw error;
        if (key) sourceCache.set(key, null);
        unrendered.push(file.path);
      }
      continue;
    }
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
  return { ids, renderedBlob, sourceBlob, docBlobs, count, unrendered, metadata, sourceMetadata, sourceBlobs };
}
