import {
  type DocHeading,
  type Placement,
  type PlacementLocation,
  type PublishLinks,
  PublishMeta,
  type Target,
  type TopicMeta,
  WriteupInput,
} from "@emend/contract";
import {
  type Block,
  blockHash,
  composeRenames,
  DIFF_COUNT_TIMEOUT_MS,
  type DocLinks,
  decodeText,
  diffLineCounts,
  docText,
  type FileSides,
  htmlHeadings,
  inferDocTitle,
  markdownHeadings,
  markdownTitle,
  type PlaceContext,
  placeThread,
  type RenderedWriteup,
  renderCommentHtml,
  renderDoc,
  renderMetadataBlocks,
  renderSource,
  renderWriteup,
  resectionBlocks,
} from "@emend/core";
import { type ImageSize, imageSize } from "./image-size.ts";

/** One comment's rendered HTML is at most this many characters; a larger one is null. */
export const COMMENT_HTML_CHARS = 262144;

export type SharedSides = { oldHash?: string; newHash?: string };
export type WorkLast = { location: PlacementLocation; sides?: SharedSides } | null;
export type PlacementDoc = PlaceContext["docs"] extends Map<string, infer T> ? T : never;
/** Import caches opaque worker output; parsed content never crosses by structured clone. */
export type EncodedPlacementDoc = { bytes: ArrayBuffer; textBytes: number; encodedBytes: number };
export type Work =
  | { kind: "diff-counts"; old: ArrayBuffer | null; next: ArrayBuffer | null }
  | { kind: "source"; path: string; source: ArrayBuffer; highlight?: boolean }
  | { kind: "doc-metadata"; format: "html" | "markdown"; bytes: ArrayBuffer }
  | { kind: "line-count"; bytes: ArrayBuffer }
  | { kind: "writeup-source"; bytes: ArrayBuffer }
  | { kind: "placement-doc"; format: "html" | "markdown" | "writeup"; bytes: ArrayBuffer }
  | {
      kind: "writeup";
      source: WriteupInput;
      topics: TopicMeta[];
      links?: PublishLinks;
      repoUrl?: string;
      media: [string, string][];
      /** Each distinct media blob's SHA-256 and its first bytes, for reading image sizes in the worker. */
      mediaHeads?: [string, ArrayBuffer][];
      docs?: DocLinks;
    }
  | { kind: "doc"; path: string; source: ArrayBuffer; repoUrl?: string; docs?: DocLinks }
  | { kind: "resection"; path: string; bytes: ArrayBuffer }
  | { kind: "comment-md"; bodies: string[]; repoUrl?: string }
  | { kind: "changed"; previous: { format: "writeup" | "doc"; bytes: ArrayBuffer }[]; next: ArrayBuffer[] }
  | {
      kind: "place";
      writeup: string | null;
      docs: Map<string, { kind: "markdown"; hash: string | null } | { kind: "html"; hash: string }>;
      sources?: Map<string, string>;
      parsedDocs?: Map<string, EncodedPlacementDoc>;
      parsedWriteup?: EncodedPlacementDoc;
      texts: Map<string, ArrayBuffer>;
      files: Map<string, SharedSides>;
      topics: Set<string>;
      topicText?: ReadonlyMap<string, { title: string; summary: string }>;
      threads: {
        id: string;
        target: Target;
        last: WorkLast;
        topicAnchor?: PlaceContext["topicAnchor"];
        renames: Map<string, string | null>[];
        carried?: { path: string | null; side?: "old" | "new" };
      }[];
    };
export type DocMetadata = { title?: string; headings: DocHeading[] };
export type WorkResult =
  | { kind: "diff-counts"; counts: { additions: number; deletions: number } | null }
  | ({ kind: "doc-metadata" } & DocMetadata)
  | { kind: "line-count"; count: number }
  | { kind: "writeup-source"; source: WriteupInput; links?: PublishLinks; repoUrl?: string }
  | ({ kind: "placement-doc" } & EncodedPlacementDoc)
  | ({ kind: "writeup" | "doc" | "source" } & RenderedBytes)
  | { kind: "changed"; bytes: ArrayBuffer }
  | { kind: "comment-md"; html: (string | null)[] }
  | { kind: "place"; placements: { id: string; placement: Placement }[] };
export type RenderedBytes = {
  bytes: ArrayBuffer;
  ids: ArrayBuffer;
  count: number;
  pathDependent?: boolean;
  selfDependent?: boolean;
};
const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);
const parse = (bytes: ArrayBuffer, format: "writeup" | "doc"): Block[] => {
  const value = JSON.parse(decode(bytes));
  return format === "writeup" ? (value as RenderedWriteup).sections.flatMap((s) => s.blocks) : (value as Block[]);
};
export function serializeRendered(value: RenderedWriteup | Block[], pathDependent = false): RenderedBytes {
  const blocks = Array.isArray(value) ? value : value.sections.flatMap((s) => s.blocks);
  return {
    bytes: new TextEncoder().encode(JSON.stringify(value)).buffer,
    ids: new TextEncoder().encode(blocks.map(({ id }) => id).join("\n")).buffer,
    count: blocks.length,
    pathDependent,
  };
}
export type Executor = (work: Work) => Promise<WorkResult>;
export const executeWork: Executor = async (work) => {
  if (work.kind === "diff-counts")
    return {
      kind: "diff-counts",
      counts: diffLineCounts(work.old === null ? "" : decode(work.old), work.next === null ? "" : decode(work.next), {
        timeout: DIFF_COUNT_TIMEOUT_MS,
      }),
    };
  if (work.kind === "source") {
    const content = await renderSource(decodeText(new Uint8Array(work.source)), work.path, work.highlight);
    return {
      kind: "source",
      bytes: new TextEncoder().encode(JSON.stringify(content)).buffer,
      ids: new ArrayBuffer(0),
      count: 0,
    };
  }
  if (work.kind === "doc-metadata") {
    if (work.format === "html")
      return {
        kind: "doc-metadata",
        title: await inferDocTitle("html", new Uint8Array(work.bytes)),
        headings: htmlHeadings(decode(work.bytes)),
      };
    const blocks = await renderMetadataBlocks(decode(work.bytes));
    return { kind: "doc-metadata", title: markdownTitle(blocks), headings: markdownHeadings(blocks) };
  }
  if (work.kind === "line-count") {
    // Count LF only (including CRLF): lone CR must not invent selectable lines beyond the diff's LF-based lines.
    const bytes = new Uint8Array(work.bytes);
    let count = bytes.length && bytes.at(-1) !== 10 ? 1 : 0;
    for (const byte of bytes) if (byte === 10) count++;
    return { kind: "line-count", count };
  }
  if (work.kind === "writeup-source") {
    // The source blob is the writeup plus the publish-level links; WriteupInput ignores the extras.
    const json: unknown = JSON.parse(decode(work.bytes));
    const meta = PublishMeta.parse(json);
    return {
      kind: "writeup-source",
      source: WriteupInput.parse(json),
      ...(meta.links ? { links: meta.links } : {}),
      ...(meta.repoUrl ? { repoUrl: meta.repoUrl } : {}),
    };
  }
  if (work.kind === "placement-doc") {
    const doc: PlacementDoc =
      work.format === "html"
        ? { kind: "html", text: docText(decode(work.bytes)) }
        : { kind: "markdown", blocks: parse(work.bytes, work.format === "writeup" ? "writeup" : "doc") };
    const encoder = new TextEncoder();
    const textBytes =
      doc.kind === "html"
        ? encoder.encode(doc.text ?? "").byteLength
        : doc.blocks.reduce((total, block) => total + encoder.encode(block.text).byteLength, 0);
    const bytes = encoder.encode(JSON.stringify(doc)).buffer;
    return { kind: "placement-doc", bytes, textBytes, encodedBytes: bytes.byteLength };
  }
  if (work.kind === "writeup") {
    const effects: { docBaseUsed?: boolean } = {};
    const mediaSizes = new Map<string, ImageSize>();
    for (const [sha, head] of work.mediaHeads ?? []) {
      const size = imageSize(new Uint8Array(head));
      if (size) mediaSizes.set(sha, size);
    }
    const rendered = await renderWriteup(work.source, work.topics, {
      links: work.links,
      repoUrl: work.repoUrl,
      media: new Map(work.media),
      mediaSizes,
      docs: work.docs,
      effects,
    });
    return {
      kind: "writeup",
      ...serializeRendered(rendered, effects.docBaseUsed),
    };
  }
  if (work.kind === "doc") {
    const effects: { docBaseUsed?: boolean; docPathUsed?: boolean } = {};
    const blocks = await renderDoc(decode(work.source), work.path, work.repoUrl, work.docs, effects);
    return {
      kind: "doc",
      ...serializeRendered(blocks, effects.docBaseUsed),
      selfDependent: effects.docPathUsed,
    };
  }
  if (work.kind === "comment-md") {
    // One failing comment gives null for that comment alone.
    const html: (string | null)[] = [];
    for (const body of work.bodies) {
      const rendered = await renderCommentHtml(body, work.repoUrl).catch(() => null);
      // Reference links can multiply a short body; a result this large is not sent to the main thread.
      html.push(rendered !== null && rendered.length > COMMENT_HTML_CHARS ? null : rendered);
    }
    return { kind: "comment-md", html };
  }
  if (work.kind === "resection")
    return {
      kind: "doc",
      ...serializeRendered(resectionBlocks(parse(work.bytes, "doc"), `doc-${await blockHash(work.path)}`)),
    };
  if (work.kind === "changed") {
    const seen = new Set<string>();
    for (const blob of work.previous) for (const block of parse(blob.bytes, blob.format)) seen.add(block.id);
    const changed: string[] = [];
    for (const packed of work.next)
      for (const id of decode(packed).split("\n"))
        if (id && !seen.has(id)) {
          seen.add(id);
          changed.push(id);
        }
    // Newline-delimited JSON strings allow bounded JSON-array inserts without per-id
    // objects or escaping on the main thread. Block IDs never contain newlines.
    return {
      kind: "changed",
      bytes: new TextEncoder().encode(changed.map((id) => JSON.stringify(id)).join("\n")).buffer,
    };
  }
  const parsed = new Map<ArrayBuffer, PlacementDoc>();
  const placementDoc = ({ bytes }: EncodedPlacementDoc): PlacementDoc => {
    let doc = parsed.get(bytes);
    if (!doc) {
      doc = JSON.parse(decode(bytes)) as PlacementDoc;
      parsed.set(bytes, doc);
    }
    return doc;
  };
  const docs: PlaceContext["docs"] = new Map();
  for (const [path, encoded] of work.parsedDocs ?? []) docs.set(path, placementDoc(encoded));
  const decoded = new Map<string, string>();
  const text = (hash: string) => {
    const cached = decoded.get(hash);
    if (cached !== undefined) return cached;
    const source = work.texts.get(hash);
    if (source === undefined) throw new Error("Missing placement text");
    const value = decode(source);
    decoded.set(hash, value);
    return value;
  };
  const sourceText = (hash: string) => {
    const bytes = work.texts.get(hash);
    if (!bytes) throw new Error("Missing source text");
    return decodeText(new Uint8Array(bytes));
  };
  const sources = new Map([...(work.sources ?? [])].map(([path, hash]) => [path, { text: sourceText(hash), hash }]));
  const sides = (value: SharedSides, source = false): FileSides =>
    ({
      ...(value.oldHash ? { oldHash: value.oldHash, oldText: text(value.oldHash) } : {}),
      ...(value.newHash
        ? { newHash: value.newHash, newText: source ? sourceText(value.newHash) : text(value.newHash) }
        : {}),
    }) as FileSides;
  const htmlTexts = new Map<string, string | null>();
  for (const [path, doc] of work.docs) {
    if (doc.kind === "html") {
      if (!htmlTexts.has(doc.hash)) htmlTexts.set(doc.hash, docText(text(doc.hash)));
      docs.set(path, { kind: "html", text: htmlTexts.get(doc.hash) ?? null });
    } else
      docs.set(path, {
        kind: "markdown",
        blocks: doc.hash ? parse(work.texts.get(doc.hash) ?? new ArrayBuffer(0), "doc") : [],
      });
  }
  const parsedWriteup = work.parsedWriteup ? placementDoc(work.parsedWriteup) : undefined;
  const writeup =
    parsedWriteup?.kind === "markdown"
      ? parsedWriteup.blocks
      : work.writeup
        ? parse(work.texts.get(work.writeup) ?? new ArrayBuffer(0), "writeup")
        : [];
  const files = new Map([...work.files].map(([path, value]) => [path, sides(value)]));
  return {
    kind: "place",
    placements: work.threads.map((thread) => {
      if ("path" in thread.target && thread.carried?.path === null)
        return { id: thread.id, placement: { status: "unplaced" as const, reason: "file-gone" as const } };
      const target =
        "path" in thread.target && thread.carried?.path
          ? { ...thread.target, path: thread.carried.path }
          : thread.target;
      const location = thread.last?.location;
      const carriedLocation =
        location && "path" in location && thread.carried?.path ? { ...location, path: thread.carried.path } : location;
      return {
        id: thread.id,
        placement: placeThread(target, {
          writeup,
          docs,
          sources,
          files,
          topics: work.topics,
          topicText: work.topicText,
          topicAnchor: thread.topicAnchor,
          last:
            thread.last && carriedLocation
              ? {
                  location: carriedLocation,
                  sides: thread.last.sides
                    ? sides(thread.last.sides, thread.target.kind === "source-lines")
                    : undefined,
                }
              : null,
          renamedFrom: thread.renames.length === 1 ? (thread.renames[0] ?? new Map()) : composeRenames(thread.renames),
        }),
      };
    }),
  };
};
