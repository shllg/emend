import { afterEach, describe, expect, test, vi } from "vitest";
import { renderMarkdown } from "../render/markdown.ts";
import { normalizeText } from "../render/normalize.ts";
import { placeHtmlSpan } from "./html.ts";
import * as search from "./search.ts";
import { makeSpan, placeSpan } from "./span.ts";

afterEach(() => vi.restoreAllMocks());

async function block(text: string, section = "overview") {
  const [result] = await renderMarkdown(text, section);
  if (!result) throw new Error("Expected a synthetic block");
  return result;
}

describe("makeSpan", () => {
  test("uses normalized UTF-16 offsets and clips context to 32 code units", async () => {
    const input = await block(`${"a".repeat(40)}   🪴 Cafe\u0301 ${"z".repeat(40)}`);
    const text = normalizeText(input.text);
    const start = text.indexOf("Café");
    expect(makeSpan(input, start, start + 4)).toEqual({
      blockId: input.id,
      quote: "Café",
      prefix: text.slice(start - 32, start),
      suffix: text.slice(start + 4, start + 36),
    });
  });

  test("cuts context at both block edges", async () => {
    const input = await block("Sprout keeps seeds.");
    expect(makeSpan(input, 0, 6)).toEqual({ blockId: input.id, quote: "Sprout", prefix: "", suffix: " keeps seeds." });
    expect(makeSpan(input, 13, 19)).toEqual({
      blockId: input.id,
      quote: "seeds.",
      prefix: "Sprout keeps ",
      suffix: "",
    });
  });

  test.each([
    [-1, 2],
    [0, 0],
    [2, 1],
    [0, 99],
    [0.5, 2],
    [0, Number.NaN],
  ])("rejects invalid offsets %s..%s", async (start, end) => {
    const input = await block("seed");
    expect(() => makeSpan(input, start, end)).toThrow(RangeError);
  });

  test("rejects selections larger than the contract quote limit", async () => {
    const input = await block("a".repeat(2001));
    expect(() => makeSpan(input, 0, 2001)).toThrow(RangeError);
  });
});

describe("placeSpan", () => {
  test("same-id diagrams place the whole normalized block regardless of quote or context", async () => {
    const diagram = await block("```mermaid\nflowchart LR\nA[flowchart LR]\n```");
    for (const quote of ["flowchart LR", "old quote"])
      expect(
        placeSpan([diagram], { kind: "writeup-span", blockId: diagram.id, quote, prefix: "", suffix: "" }),
      ).toEqual({
        status: "placed",
        location: { kind: "writeup-span", blockId: diagram.id, start: 0, end: normalizeText(diagram.text).length },
      });
    const edited = await block("```mermaid\nflowchart  LR\n\nA[flowchart LR]\n```");
    expect(edited.id).toBe(diagram.id);
    expect(
      placeSpan([edited], {
        kind: "doc-span",
        path: "plan.md",
        blockId: diagram.id,
        quote: "flowchart LR",
        prefix: "old",
        suffix: "context",
      }),
    ).toEqual({
      status: "placed",
      location: {
        kind: "doc-span",
        path: "plan.md",
        blockId: diagram.id,
        start: 0,
        end: normalizeText(diagram.text).length,
      },
    });
  });
  test("diagram search in a new section keeps ordinary B5 matching and ambiguity", async () => {
    const diagram = await block("```mermaid\nflowchart LR\nA[flowchart LR]\n```", "t-garden-body");
    const target = {
      kind: "writeup-span" as const,
      blockId: "overview-12345678",
      quote: "A[flowchart LR]",
      prefix: "",
      suffix: "",
    };
    expect(placeSpan([diagram], target)).toEqual({
      status: "placed",
      location: { kind: "writeup-span", blockId: diagram.id, start: 13, end: 28 },
    });
    expect(placeSpan([diagram], { ...target, quote: "flowchart LR" })).toEqual({
      status: "unplaced",
      reason: "ambiguous",
    });
    expect(placeSpan([diagram], { ...target, quote: "flowchart  LR" })).toEqual({
      status: "unplaced",
      reason: "block-gone",
    });
    expect(
      placeSpan([{ ...diagram, kind: "paragraph" }], { ...target, blockId: diagram.id, quote: "flowchart LR" }),
    ).toEqual({ status: "unplaced", reason: "ambiguous" });
  });
  test("a truncated diagram quote still places the entire long source", async () => {
    const diagram = await block(`\`\`\`mermaid\nflowchart LR\n${"A --> B\n".repeat(300)}\`\`\``);
    const text = normalizeText(diagram.text);
    expect(
      placeSpan([diagram], {
        kind: "writeup-span",
        blockId: diagram.id,
        quote: text.slice(0, 2000),
        prefix: "",
        suffix: "",
      }),
    ).toEqual({
      status: "placed",
      location: { kind: "writeup-span", blockId: diagram.id, start: 0, end: text.length },
    });
  });
  test("rejects a 2000-character quote with missing context in 8 MiB of repeated text", () => {
    const find = vi.spyOn(search, "firstTwoMatches");
    const text = "a".repeat(8 * 1024 * 1024);
    const target = {
      kind: "writeup-span" as const,
      blockId: "overview-00000000",
      quote: "a".repeat(2000),
      prefix: "x",
      suffix: "",
    };
    const input = { id: target.blockId, section: "overview", kind: "paragraph" as const, text, html: "" };
    expect(placeSpan([input], target)).toEqual({ status: "unplaced", reason: "block-gone" });
    expect(find.mock.calls).toEqual([
      [text, target.quote],
      [text, target.prefix + target.quote],
      [text, target.prefix + target.quote],
    ]);
    find.mockClear();
    expect(placeHtmlSpan(text, { ...target, kind: "html-span", path: "docs/seed.html" })).toEqual({
      status: "unplaced",
      reason: "block-gone",
    });
    expect(find).toHaveBeenCalledExactlyOnceWith(text, target.prefix + target.quote);
  });

  test("detects ambiguous quotes in a 1 MiB repeated block", () => {
    // The synchronous ambiguous scan is measured only by the benchmark.
    const input = {
      id: "overview-00000000",
      section: "overview",
      kind: "paragraph" as const,
      text: "a".repeat(1024 * 1024),
      html: "",
    };
    expect(
      placeSpan([input], { kind: "writeup-span", blockId: input.id, quote: "a".repeat(2000), prefix: "", suffix: "" }),
    ).toEqual({ status: "unplaced", reason: "ambiguous" });
  });

  test("keeps the same id's unique quote even if generated surrounding text changed", async () => {
    const original = await block("Seeds [1] grow.");
    const target = { kind: "writeup-span" as const, ...makeSpan(original, 0, 5) };
    const next = { ...original, text: "Seeds [2] grow." };
    expect(placeSpan([next], target)).toEqual({
      status: "placed",
      location: { kind: "writeup-span", blockId: original.id, start: 0, end: 5 },
    });
  });

  test("uses context to distinguish repeated quotes in the same block", async () => {
    const original = await block("red seed then blue seed");
    const target = { kind: "writeup-span" as const, ...makeSpan(original, 19, 23) };
    expect(placeSpan([original], target)).toEqual({
      status: "placed",
      location: { kind: "writeup-span", blockId: original.id, start: 19, end: 23 },
    });
  });

  test("counts overlapping occurrences as distinct candidates", async () => {
    const original = await block("aaa");
    expect(
      placeSpan([original], { kind: "writeup-span", blockId: original.id, quote: "aa", prefix: "", suffix: "" }),
    ).toEqual({ status: "unplaced", reason: "ambiguous" });
  });

  test("falls back across the surface if the same id has no matching repeated occurrence", async () => {
    const original = await block("red seed then blue seed");
    const target = { kind: "writeup-span" as const, ...makeSpan(original, 19, 23) };
    const sameId = { ...original, text: "seed then seed" };
    const moved = await block(original.text, "t-garden-body");
    expect(placeSpan([sameId, moved], target)).toEqual({
      status: "placed",
      location: { kind: "writeup-span", blockId: moved.id, start: 19, end: 23 },
    });
  });

  test("a unique stable-id candidate takes precedence over copies elsewhere", async () => {
    const original = await block("Sprout keeps seeds.");
    const copy = await block(original.text, "t-garden-body");
    expect(placeSpan([original, copy], { kind: "writeup-span", ...makeSpan(original, 0, 6) })).toEqual({
      status: "placed",
      location: { kind: "writeup-span", blockId: original.id, start: 0, end: 6 },
    });
  });
});
