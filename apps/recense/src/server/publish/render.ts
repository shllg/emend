import { docViewOf, type GlossaryTerm, isRenderedHtmlDoc, LIMITS, type PublishRequest } from "@recense/contract";
import {
  blockHash,
  cleanDocTitle,
  type DocLinks,
  decodeText,
  HIGHLIGHT_SOURCE_BYTES,
  HIGHLIGHT_SOURCE_REVISION_BYTES,
  headingLookups,
  sourceLanguage,
} from "@recense/core";
import { ApiError } from "../http/errors.ts";
import { yieldToLoop } from "../pacing.ts";
import { WorkTimeout } from "./executor.ts";
import { IMAGE_HEAD_BYTES, type ImageSize } from "./image-size.ts";
import { checkPublishSignal } from "./lifecycle.ts";
import type { DocMetadata, Executor, RenderedBytes } from "./work.ts";

export type HtmlPartBudget = { count: number; exhausted: boolean; limit: number };

export function chargeHtmlParts(budgets: readonly HtmlPartBudget[], own: DocMetadata): string[] | undefined {
  const parts = own.parts;
  if (parts === undefined) return;
  // Across all retained revisions, cache plus stored docs stay within the operation's budget:
  // htmlPartsPerRevision for publish, htmlPartsPerImport for import. Only the current worker
  // result (at most htmlPartsPerDoc) is extra. After exhaustion, later docs are not hashed.
  let cut = false;
  for (const budget of budgets) {
    if (budget.exhausted || budget.count + parts.length > budget.limit) {
      budget.exhausted = true;
      cut = true;
    }
  }
  if (cut) {
    delete own.parts;
    return;
  }
  for (const budget of budgets) budget.count += parts.length;
  return parts;
}

export async function renderRevision(
  input: PublishRequest,
  execute: Executor,
  read: (hash: string) => Promise<ArrayBuffer>,
  readHead: (hash: string) => Promise<ArrayBuffer>,
  put: (bytes: Buffer) => Promise<string>,
  signal?: AbortSignal,
  onRendered?: (bytes: number) => void,
  options: { refuseUnlistedMedia?: boolean; htmlParts?: HtmlPartBudget } = {},
) {
  const assets = new Map(input.files.filter((file) => file.role === "asset").map((file) => [file.path, file.newBlob]));
  const mediaByDoc = new Map<string, [string, string][]>();
  for (const file of input.files) {
    if (file.role !== "doc" || docViewOf(file) === "source" || isRenderedHtmlDoc(file)) continue;
    const folder = file.path.slice(0, file.path.lastIndexOf("/") + 1);
    const media: [string, string][] = [];
    for (const path of file.assets ?? []) {
      const sha = assets.get(path);
      if (sha) media.push([path.slice(folder.length), sha]);
    }
    mediaByDoc.set(file.path, media);
  }
  // Two passes let forward links resolve headings before any writeup/doc is rendered.
  // The worker parses hostile sources; only bounded metadata crosses back to the server.
  const sourceMetadata = new Map<string, DocMetadata>();
  const sourceBlobs = new Map<string, string>();
  const metadata = new Map<string, DocMetadata>();
  const htmlParts = new Map<string, string[]>();
  const metadataCache = new Map<string, DocMetadata>();
  const failedMetadata = new Set<string>();
  const unrendered: string[] = [];
  let metadataBytes = 0;
  const revisionBudget = { count: 0, exhausted: false, limit: LIMITS.htmlPartsPerRevision };
  const htmlPartBudgets = [revisionBudget, ...(options.htmlParts ? [options.htmlParts] : [])];
  for (const file of input.files) {
    checkPublishSignal(signal);
    if (file.role !== "doc") continue;
    const source = docViewOf(file) === "source";
    const format = isRenderedHtmlDoc(file) ? "html" : "markdown";
    const media = mediaByDoc.get(file.path);
    // Exhaustion never resets within this call, so the cache key need not include the parts request.
    const key = JSON.stringify([format, file.newBlob, media]);
    let own = source ? { headings: [] } : metadataCache.get(key);
    if (!own) {
      own = { headings: [] };
      if (file.newBlob && !source)
        try {
          const result = await execute({
            kind: "doc-metadata",
            format,
            bytes: await read(file.newBlob),
            media,
            parts: format === "html" && !htmlPartBudgets.some((budget) => budget.exhausted),
          });
          if (result.kind !== "doc-metadata") throw new Error("wrong result");
          own = {
            title: result.title,
            headings: result.headings,
            parts: result.parts,
            look: result.look,
            legacyLook: result.legacyLook,
            colorScheme: result.colorScheme,
          };
        } catch {
          checkPublishSignal(signal);
          failedMetadata.add(key);
        }
      metadataCache.set(key, own);
    }
    if (format === "html" && failedMetadata.has(key)) unrendered.push(file.path);
    const parts = format === "html" ? chargeHtmlParts(htmlPartBudgets, own) : undefined;
    const doc = {
      title:
        cleanDocTitle(file.title ?? "") || own.title || cleanDocTitle(file.path.split("/").at(-1) ?? "") || "Document",
      headings: own.headings,
      ...(parts !== undefined ? { parts } : {}),
      ...(format === "html" && own.look ? { look: own.look } : {}),
      ...(format === "html" && own.legacyLook ? { legacyLook: own.legacyLook } : {}),
      ...(format === "html" && own.colorScheme ? { colorScheme: own.colorScheme } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(doc));
    metadataBytes += size;
    onRendered?.(size);
    if (metadataBytes > LIMITS.renderedBytesPerRevision) throw new ApiError("too_large");
    (source ? sourceMetadata : metadata).set(file.path, doc);
    if (format === "html" && doc.parts !== undefined) {
      const prefix = `doc-${await blockHash(file.path)}-`;
      htmlParts.set(
        file.path,
        doc.parts.map((hash) => `${prefix}${hash}`),
      );
    }
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
  // Writeup media stays on its bounded head path (at most 50 images).
  const writeupHeads = new Map<string, ArrayBuffer>();
  for (const sha of new Set(media.map(([, sha]) => sha))) {
    checkPublishSignal(signal);
    const head = await readHead(sha);
    writeupHeads.set(sha, head.byteLength > IMAGE_HEAD_BYTES ? head.slice(0, IMAGE_HEAD_BYTES) : head);
    await yieldToLoop("publish-render");
  }
  // Docs retain sizes only. Transfer and release each bounded batch before reading the next.
  const imageSizes = new Map<string, ImageSize>();
  const batchLimit = 16 * 1024 * 1024;
  let batch: [string, ArrayBuffer][] = [];
  let batchBytes = 0;
  const flushSizes = async () => {
    if (!batch.length) return;
    try {
      const result = await execute({ kind: "image-sizes", heads: batch });
      if (result.kind !== "image-sizes") throw new Error("wrong result");
      for (const [sha, size] of result.sizes) imageSizes.set(sha, size);
    } catch {
      checkPublishSignal(signal);
      // Images still render without dimensions when the size worker fails.
    } finally {
      batch = [];
      batchBytes = 0;
    }
  };
  const docImages = new Set([...mediaByDoc.values()].flatMap((images) => images.map(([, sha]) => sha)));
  for (const sha of docImages) {
    checkPublishSignal(signal);
    if (batchBytes + IMAGE_HEAD_BYTES > batchLimit) await flushSizes();
    try {
      const head = writeupHeads.get(sha)?.slice(0) ?? (await readHead(sha));
      const bounded = head.byteLength > IMAGE_HEAD_BYTES ? head.slice(0, IMAGE_HEAD_BYTES) : head;
      batch.push([sha, bounded]);
      batchBytes += bounded.byteLength;
    } catch {
      checkPublishSignal(signal);
      // A failed head read leaves this image renderable without dimensions.
    }
    await yieldToLoop("publish-render");
  }
  await flushSizes();
  const mediaHeads = [...writeupHeads];
  writeupHeads.clear();
  let rendered: RenderedBytes;
  let unlistedMedia: string[];
  try {
    const result = await execute({
      kind: "writeup",
      source: input.writeup,
      topics: input.topics,
      links: input.links,
      repoUrl: input.repoUrl,
      issueRefs: input.issueRefs,
      media,
      mediaHeads,
      docs,
    });
    if (result.kind !== "writeup") throw new Error("wrong result");
    rendered = result;
    unlistedMedia = result.unlistedMedia ?? [];
  } catch (error) {
    checkPublishSignal(signal);
    if (error instanceof WorkTimeout) throw new ApiError("too_large", "writeup_timeout");
    throw new ApiError("invalid_request", "writeup_failed");
  }
  if (options.refuseUnlistedMedia && unlistedMedia.length) throw new ApiError("invalid_request", "media_unlisted");
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
        ...(input.issueRefs?.length ? { issueRefs: input.issueRefs } : {}),
      }),
    ),
  );
  const cache = new Map<string, string | null>();
  const folderCache = new Map<string, string>();
  const docBlobs = new Map<string, string>();
  // Terms belong to a stored blob: same blocks, same terms. A resection rewrites both together.
  const termsByBlob = new Map<string, GlossaryTerm[]>();
  const markUnrendered = (path: string) => {
    unrendered.push(path);
    const doc = metadata.get(path);
    if (doc) {
      doc.headings = [];
      delete doc.terms;
    }
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
    const folder = file.path.slice(0, file.path.lastIndexOf("/") + 1);
    const docMedia = mediaByDoc.get(file.path) ?? [];
    const cacheKey = JSON.stringify([file.newBlob, docMedia]);
    const folderKey = JSON.stringify([cacheKey, folder]);
    const source = cache.get(cacheKey);
    const shared = source === undefined ? folderCache.get(folderKey) : source;
    if (shared === null) {
      markUnrendered(file.path);
      continue;
    }
    try {
      const rendered = await execute(
        shared === undefined
          ? {
              kind: "doc",
              path: file.path,
              source: await read(file.newBlob),
              repoUrl: input.repoUrl,
              docs,
              media: docMedia,
              mediaSizes: [...new Set(docMedia.map(([, sha]) => sha))].flatMap((sha): [string, ImageSize][] => {
                const size = imageSizes.get(sha);
                return size ? [[sha, size]] : [];
              }),
            }
          : { kind: "resection", path: file.path, bytes: await read(shared), terms: termsByBlob.get(shared) },
      );
      if (rendered.kind !== "doc") throw new Error("wrong result");
      result = rendered;
    } catch {
      checkPublishSignal(signal);
      // A source with this image map that fails once stays unrendered in every folder.
      cache.set(cacheKey, null);
      markUnrendered(file.path);
      continue;
    }
    const json = Buffer.from(result.bytes);
    const termsBytes = result.terms ? Buffer.byteLength(JSON.stringify(result.terms)) : 0;
    onRendered?.(json.length + termsBytes);
    if (
      count + result.count > LIMITS.blocksPerRevision ||
      bytes + json.length + termsBytes > LIMITS.renderedBytesPerRevision
    ) {
      exhausted = true;
      markUnrendered(file.path);
      continue;
    }
    count += result.count;
    bytes += json.length + termsBytes;
    await yieldToLoop("publish-render");
    checkPublishSignal(signal);
    const blob = await put(json);
    docBlobs.set(file.path, blob);
    if (result.terms?.length) {
      termsByBlob.set(blob, result.terms);
      const own = metadata.get(file.path);
      if (own) own.terms = result.terms;
    }
    if (shared === undefined) {
      if (!result.pathDependent) cache.set(cacheKey, blob);
      else if (!result.selfDependent) folderCache.set(folderKey, blob);
    }
    ids.push(result.ids);
  }
  return {
    ids,
    htmlParts,
    renderedBlob,
    sourceBlob,
    docBlobs,
    count,
    unrendered,
    unlistedMedia,
    metadata,
    sourceMetadata,
    sourceBlobs,
  };
}
