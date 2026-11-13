import type { Placement, PlacementLocation, Target } from "@emend/contract";
import type { Block } from "../render/blocks.ts";
import { placeHtmlSpan } from "./html.ts";
import { type FileSides, placeLines } from "./lines.ts";
import { placeSpan, placeTextSpan } from "./span.ts";

/**
 * renamedFrom covers the entire interval from last's revision (or the target's original
 * revision when last is null) to the new revision. The caller uses composeRenames on those
 * per-revision maps, including revisions where this thread was unplaced. A null destination
 * records deletion. Each revision's entries are simultaneous, so apply the composed map once.
 */
export type PlaceContext = {
  writeup: Block[];
  docs: Map<string, { kind: "markdown"; blocks: Block[] } | { kind: "html"; text: string | null }>;
  sources?: Map<string, { text: string; hash?: string }>;
  files: Map<string, FileSides>;
  renamedFrom: Map<string, string | null>;
  topics: ReadonlyMap<string, { title: string; summary: string }>;
  last: { location: PlacementLocation; sides?: FileSides } | null;
};

export function placeThread(target: Target, ctx: PlaceContext): Placement {
  const last = ctx.last?.location;
  switch (target.kind) {
    case "review":
      return { status: "placed", location: { kind: "review" } };
    case "topic": {
      const topic = ctx.topics.get(target.slug);
      if (!topic) return { status: "unplaced", reason: "topic-gone" };
      if (target.part === undefined) return { status: "placed", location: { kind: "topic", slug: target.slug } };
      const result = placeTextSpan(
        (["title", "summary"] as const).map((part) => ({ id: part, text: topic[part] })),
        {
          blockId: last?.kind === "topic" && last.part ? last.part : target.part,
          quote: target.quote ?? "",
          prefix: target.prefix ?? "",
          suffix: target.suffix ?? "",
        },
      );
      return result.status === "unplaced"
        ? result
        : {
            status: "placed",
            location: { kind: "topic", slug: target.slug, part: result.block.id, ...result.range },
          };
    }
    case "writeup-span":
      return placeSpan(ctx.writeup, {
        ...target,
        blockId: last?.kind === "writeup-span" ? last.blockId : target.blockId,
      });
    default: {
      const previousPath = last?.kind === target.kind && "path" in last ? last.path : target.path;
      const renamed = ctx.renamedFrom.get(previousPath);
      if (renamed === null) return { status: "unplaced", reason: "file-gone" };
      const path = renamed ?? previousPath;
      if (target.kind === "file") {
        return ctx.files.has(path)
          ? { status: "placed", location: { kind: "file", path } }
          : { status: "unplaced", reason: "file-gone" };
      }
      if (target.kind === "source-lines") {
        const previous = last?.kind === "source-lines" ? last : target;
        const source = ctx.sources?.get(path);
        return placeLines(
          { ...target, path },
          { start: previous.start, end: previous.end, sides: ctx.last?.sides ?? {} },
          source ? { newText: source.text, newHash: source.hash } : null,
        );
      }
      if (target.kind === "lines") {
        const previous = last?.kind === "lines" && last.side === target.side ? last : target;
        return placeLines(
          { ...target, path },
          {
            start: previous.start,
            end: previous.end,
            sides: ctx.last?.sides ?? {},
          },
          ctx.files.get(path) ?? null,
        );
      }
      const doc = ctx.docs.get(path);
      if (!doc) return { status: "unplaced", reason: "file-gone" };
      if (target.kind === "html-span") {
        return doc.kind === "html"
          ? placeHtmlSpan(doc.text, { ...target, path })
          : { status: "unplaced", reason: "block-gone" };
      }
      return doc.kind === "markdown"
        ? placeSpan(doc.blocks, { ...target, path, blockId: last?.kind === "doc-span" ? last.blockId : target.blockId })
        : { status: "unplaced", reason: "block-gone" };
    }
  }
}
