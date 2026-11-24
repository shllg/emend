import type { LinesTarget } from "@recense/contract";
import { expect, test } from "vitest";
import { placeHtmlSpan } from "./html.ts";
import { placeLines } from "./lines.ts";
import { placeSpan } from "./span.ts";

test.each(["writeup", "html"] as const)("span-missing-context-%s", (kind) => {
  const text = "a".repeat(8 * 1024 * 1024);
  const target = { blockId: "overview-00000000", quote: "a".repeat(2000), prefix: "x", suffix: "" };
  const block = { id: target.blockId, section: "overview", kind: "paragraph" as const, text, html: "" };
  const start = performance.now();
  const result =
    kind === "writeup"
      ? placeSpan([block], { ...target, kind: "writeup-span" })
      : placeHtmlSpan(text, { ...target, kind: "html-span", path: "docs/seed.html" });
  const ms = performance.now() - start;
  expect(result).toEqual({ status: "unplaced", reason: "block-gone" });
  process.stdout.write(
    `${JSON.stringify({ bench: `span-missing-context-${kind}`, ms, inputChars: text.length, quoteChars: target.quote.length })}\n`,
  );
});

test("span-ambiguous", () => {
  const block = {
    id: "overview-00000000",
    section: "overview",
    kind: "paragraph" as const,
    text: "a".repeat(1024 * 1024),
    html: "",
  };
  const target = { kind: "writeup-span" as const, blockId: block.id, quote: "a".repeat(2000), prefix: "", suffix: "" };
  const start = performance.now();
  const result = placeSpan([block], target);
  const ms = performance.now() - start;
  expect(result).toEqual({ status: "unplaced", reason: "ambiguous" });
  process.stdout.write(
    `${JSON.stringify({ bench: "span-ambiguous", ms, inputChars: block.text.length, quoteChars: target.quote.length })}\n`,
  );
});

test("lines-complete-replacement", () => {
  const old = Array.from({ length: 20000 }, (_, index) => `old${index}`).join("\n");
  const next = Array.from({ length: 20000 }, (_, index) => `new${index}`).join("\n");
  const target: LinesTarget = {
    kind: "lines",
    path: "src/seeds.ts",
    side: "new",
    start: 1,
    end: 1,
    lines: ["old0"],
    before: [],
    after: ["old1"],
  };
  const start = performance.now();
  const result = placeLines(target, { start: 1, end: 1, sides: { newText: old } }, { newText: next });
  const ms = performance.now() - start;
  expect(result).toEqual({ status: "unplaced", reason: "lines-gone" });
  process.stdout.write(
    `${JSON.stringify({ bench: "lines-complete-replacement", ms, oldLines: 20000, newLines: 20000 })}\n`,
  );
});

test.each([true, false])("lines-repeated (matching context: %s)", (matching) => {
  const lineCount = Math.ceil((1024 * 1024) / 5);
  const repeated = "seed\n".repeat(lineCount);
  const target: LinesTarget = {
    kind: "lines",
    path: "src/seeds.ts",
    side: "new",
    start: 1,
    end: 200,
    lines: Array<string>(200).fill("seed"),
    before: [],
    after: matching ? [] : ["weed"],
  };
  const start = performance.now();
  const result = placeLines(target, { start: 1, end: 200, sides: {} }, { newText: repeated });
  const ms = performance.now() - start;
  expect(result).toEqual({ status: "unplaced", reason: matching ? "ambiguous" : "lines-gone" });
  process.stdout.write(
    `${JSON.stringify({ bench: matching ? "lines-repeated-ambiguous" : "lines-repeated-missing-context", ms, inputLines: lineCount, quoteLines: target.lines.length })}\n`,
  );
});
