import {
  type DocSpanTarget,
  type HtmlSpanTarget,
  type LinesTarget,
  Placement,
  Target,
  type WriteupSpanTarget,
} from "@emend/contract";
import { expect, test } from "vitest";
import type { Block } from "../render/blocks.ts";
import { renderMarkdown } from "../render/markdown.ts";
import { normalizeText } from "../render/normalize.ts";
import htmlCases from "./corpus/html.json" with { type: "json" };
import lineCases from "./corpus/lines.json" with { type: "json" };
import spanCases from "./corpus/spans.json" with { type: "json" };
import { docText } from "./html.ts";
import type { FileSides } from "./lines.ts";
import { type PlaceContext, placeThread } from "./place.ts";
import { makeSpan } from "./span.ts";

type Section = { section: string; text: string };
type Case = { name: string; expected: Placement } & (
  | { surface: "writeup" | "markdown"; old: Section[]; target: WriteupSpanTarget | DocSpanTarget; new: Section[] }
  | { surface: "html"; old: string; target: HtmlSpanTarget; new: string }
  | { surface: "lines"; old: FileSides; target: LinesTarget; new: FileSides | null; renamedTo?: string }
);

const cases = [...spanCases, ...htmlCases, ...lineCases] as Case[];

function fileLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

async function render(sections: Section[]): Promise<Block[]> {
  return (await Promise.all(sections.map(({ section, text }) => renderMarkdown(text, section)))).flat();
}

test.each(cases)("synthetic corpus: $name", async (entry) => {
  const ctx: PlaceContext = {
    writeup: [],
    docs: new Map(),
    files: new Map(),
    renamedFrom: new Map(),
    topics: new Map(),
    last: null,
  };
  Target.parse(entry.target);
  Placement.parse(entry.expected);
  if (entry.surface === "writeup" || entry.surface === "markdown") {
    const old = await render(entry.old);
    const block = old.find((block) => block.id === entry.target.blockId);
    if (!block) throw new Error("Corpus target must belong to an old block");
    const start = normalizeText(block.text).indexOf(entry.target.quote);
    if (block.kind === "diagram") {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(entry.target.prefix).toBe("");
      expect(entry.target.suffix).toBe("");
    } else
      expect(makeSpan(block, start, start + entry.target.quote.length)).toEqual({
        blockId: entry.target.blockId,
        quote: entry.target.quote,
        prefix: entry.target.prefix,
        suffix: entry.target.suffix,
      });
    const blocks = await render(entry.new);
    if (entry.target.kind === "doc-span") ctx.docs.set(entry.target.path, { kind: "markdown", blocks });
    else ctx.writeup = blocks;
    ctx.last = {
      location:
        entry.target.kind === "doc-span"
          ? {
              kind: "doc-span",
              path: entry.target.path,
              blockId: block.id,
              start,
              end: start + entry.target.quote.length,
            }
          : { kind: "writeup-span", blockId: block.id, start, end: start + entry.target.quote.length },
    };
  } else if (entry.surface === "html") {
    const old = docText(entry.old);
    if (old === null) throw new Error("Corpus original document must be parseable");
    const start = old.indexOf(entry.target.quote);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(old.slice(0, start).endsWith(entry.target.prefix)).toBe(true);
    expect(old.slice(start + entry.target.quote.length).startsWith(entry.target.suffix)).toBe(true);
    ctx.docs.set(entry.target.path, { kind: "html", text: docText(entry.new) });
  } else if (entry.surface === "lines") {
    const old = entry.old[entry.target.side === "old" ? "oldText" : "newText"];
    if (old === undefined) throw new Error("Corpus must include the original side");
    expect(fileLines(old).slice(entry.target.start - 1, entry.target.end)).toEqual(entry.target.lines);
    const { kind, path, side, start, end } = entry.target;
    ctx.last = { location: { kind, path, side, start, end }, sides: entry.old };
    if (entry.new !== null) ctx.files.set(entry.renamedTo ?? path, entry.new);
    if (entry.renamedTo) ctx.renamedFrom.set(path, entry.renamedTo);
  }

  const result = placeThread(entry.target, ctx);
  Placement.parse(result);
  expect(result).toEqual(entry.expected);
  // Same-id diagrams place whole; all searched spans must still equal the saved quote.
  if (result.status !== "placed") return;
  const loc = result.location;
  if (loc.kind === "writeup-span" || loc.kind === "doc-span") {
    const doc = loc.kind === "doc-span" ? ctx.docs.get(loc.path) : undefined;
    const blocks = loc.kind === "writeup-span" ? ctx.writeup : doc?.kind === "markdown" ? doc.blocks : [];
    const block = blocks.find((block) => block.id === loc.blockId);
    if (!block || !("quote" in entry.target)) throw new Error("Expected the placed quote's block");
    if (block.kind === "diagram" && "blockId" in entry.target && block.id === entry.target.blockId) {
      expect(loc.start).toBe(0);
      expect(loc.end).toBe(normalizeText(block.text).length);
    } else expect(normalizeText(block.text).slice(loc.start, loc.end)).toBe(entry.target.quote);
  } else if (loc.kind === "html-span") {
    const doc = ctx.docs.get(loc.path);
    if (doc?.kind !== "html" || doc.text === null || !("quote" in entry.target))
      throw new Error("Expected an HTML quote");
    expect(doc.text.slice(loc.start, loc.end)).toBe(entry.target.quote);
  } else if (loc.kind === "lines") {
    const side = ctx.files.get(loc.path)?.[loc.side === "old" ? "oldText" : "newText"];
    if (side === undefined || entry.target.kind !== "lines") throw new Error("Expected the placed side");
    expect(fileLines(side).slice(loc.start - 1, loc.end)).toEqual(entry.target.lines);
  } else throw new Error("Every corpus case must assert a text placement");
});
