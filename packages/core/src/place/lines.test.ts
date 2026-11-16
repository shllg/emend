import type { LinesTarget } from "@emend/contract";
import * as diff from "diff";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LINE_MAP_MAX_EDIT_LENGTH, lineMap } from "./linemap.ts";
import { placeLines } from "./lines.ts";
import * as search from "./search.ts";

vi.mock("diff", async (original) => ({ ...(await original<typeof import("diff")>()) }));
afterEach(() => vi.restoreAllMocks());

const target: LinesTarget = {
  kind: "lines",
  path: "src/seeds.ts",
  side: "new",
  start: 2,
  end: 3,
  lines: ["plant();", "water();"],
  before: ["begin();"],
  after: ["end();"],
};
const text = "begin();\nplant();\nwater();\nend();\n";
const last = { start: 2, end: 3, sides: { newHash: "a", newText: text } };
const location = (start: number, end: number) => ({
  status: "placed",
  location: { kind: "lines", path: target.path, side: "new", start, end },
});

describe("lineMap", () => {
  test("maps 2000 lines with 50 scattered edits through tier 1", () => {
    const old = Array.from({ length: 2000 }, (_, index) => `line${index}`);
    const next = old.map((line, index) => (index % 40 === 0 ? `edit${index}` : line));
    const map = lineMap(old.join("\n"), next.join("\n"));
    for (let index = 0; index < old.length; index++) {
      expect(map(index + 1)).toBe(index % 40 === 0 ? null : index + 1);
    }
    const selected = { ...target, start: 2, end: 2, lines: ["line1"], before: ["line0"], after: ["line2"] };
    expect(
      placeLines(selected, { start: 2, end: 2, sides: { newText: old.join("\n") } }, { newText: next.join("\n") }),
    ).toEqual(location(2, 2));
  });

  test("maps unchanged lines and refuses changed or removed lines", () => {
    const map = lineMap("one\ntwo\nthree\nfour\n", "intro\none\nchanged\nfour\n");
    expect([1, 2, 3, 4].map(map)).toEqual([2, null, null, 4]);
    expect([0, -1, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map(map)).toEqual(Array(6).fill(null));
  });

  test("treats CRLF and LF and the final newline as equivalent, not other whitespace", () => {
    expect(lineMap("one\r\ntwo\r\n", "one\ntwo")(2)).toBe(2);
    expect(lineMap(" one\n", "one\n")(1)).toBeNull();
    expect(lineMap("one\r", "one")(1)).toBeNull();
  });

  test("does not invent an empty trailing line, but preserves actual blank lines", () => {
    expect(lineMap("", "one\n")(1)).toBeNull();
    expect(lineMap("one\n", "one\n")(2)).toBeNull();
    expect(lineMap("one\n\n", "intro\none\n\n")(2)).toBe(3);
    expect(lineMap("\n", "intro\n\n")(1)).toBe(2);
  });
});

describe("placeLines", () => {
  test("missing hashes do not count as an unchanged blob", () => {
    expect(placeLines(target, { ...last, sides: { newText: text } }, { newText: `intro\n${text}` })).toEqual(
      location(3, 4),
    );
  });

  test("tier 0 verifies text when supplied rather than trusting inconsistent hashes", () => {
    expect(placeLines(target, last, { newHash: "a", newText: text.replace("water();", "weed();") })).toEqual({
      status: "unplaced",
      reason: "lines-gone",
    });
  });

  test("tier 1 can place unchanged lines when their surrounding context changed", () => {
    expect(placeLines(target, last, { newHash: "b", newText: text.replace("begin();", "prepare();") })).toEqual(
      location(2, 3),
    );
  });

  test("tier 1 refuses an insertion that splits the selected range", () => {
    expect(placeLines(target, last, { newText: text.replace("water();", "pause();\nwater();") })).toEqual({
      status: "unplaced",
      reason: "lines-gone",
    });
  });

  test("tier 1 compares mapped text to the quote, not just the previous revision", () => {
    const altered = text.replace("water();", "weed();");
    expect(placeLines(target, { ...last, sides: { newText: altered } }, { newText: `intro\n${altered}` })).toEqual({
      status: "unplaced",
      reason: "lines-gone",
    });
  });

  test("tier 2 works without the previous revision's text", () => {
    expect(placeLines(target, { ...last, sides: {} }, { newText: `intro\n${text}` })).toEqual(location(3, 4));
  });

  test("tier 2 uses the available context at either file edge", () => {
    expect(
      placeLines(
        { ...target, start: 1, before: [] },
        { start: 1, end: 2, sides: {} },
        {
          newText: "intro\nplant();\nwater();\nend();\n",
        },
      ),
    ).toEqual(location(2, 3));
    expect(
      placeLines(
        { ...target, after: [] },
        { ...last, sides: {} },
        {
          newText: "intro\nbegin();\nplant();\nwater();",
        },
      ),
    ).toEqual(location(3, 4));
  });

  test("tier 2 requires an exact line sequence including whitespace and Unicode", () => {
    expect(placeLines(target, { ...last, sides: {} }, { newText: text.replace("begin();", " begin();") })).toEqual({
      status: "unplaced",
      reason: "lines-gone",
    });
    const unicode = { ...target, start: 1, end: 1, lines: ["Café"], before: [], after: [] };
    expect(placeLines(unicode, { start: 1, end: 1, sides: {} }, { newText: "Cafe\u0301\n" })).toEqual({
      status: "unplaced",
      reason: "lines-gone",
    });
  });

  test("tier 2 counts overlapping line sequences", () => {
    expect(
      placeLines(
        { ...target, lines: ["seed", "seed"], before: [], after: [] },
        { ...last, sides: {} },
        {
          newText: "seed\nseed\nseed\n",
        },
      ),
    ).toEqual({ status: "unplaced", reason: "ambiguous" });
  });

  test("never substitutes the other side when the target side is unavailable", () => {
    expect(placeLines(target, last, { oldText: text, oldHash: "a" })).toEqual({
      status: "unplaced",
      reason: "file-gone",
    });
    expect(placeLines(target, last, null)).toEqual({ status: "unplaced", reason: "file-gone" });
  });

  test("a deleted side is file-gone even if the file entry remains", () => {
    expect(placeLines(target, last, {})).toEqual({ status: "unplaced", reason: "file-gone" });
  });

  test("bounds a 20000-line complete replacement and falls back to exact context", () => {
    const compare = vi.spyOn(diff, "diffLines");
    const old = Array.from({ length: 20000 }, (_, index) => `old${index}`).join("\n");
    const next = Array.from({ length: 20000 }, (_, index) => `new${index}`).join("\n");
    const selected = { ...target, start: 1, end: 1, lines: ["old0"], before: [], after: ["old1"] };
    expect(placeLines(selected, { start: 1, end: 1, sides: { newText: old } }, { newText: next })).toEqual({
      status: "unplaced",
      reason: "lines-gone",
    });
    expect(compare).toHaveBeenCalledExactlyOnceWith(old, next, {
      stripTrailingCr: true,
      ignoreNewlineAtEof: true,
      maxEditLength: LINE_MAP_MAX_EDIT_LENGTH,
    });
    expect(compare.mock.results[0]?.value).toBeUndefined();
  });

  test("tier 2 can recover a quote when the diff exceeds its budget", () => {
    const old = Array.from({ length: 1000 }, (_, index) => `old${index}`).join("\n");
    const next = Array.from({ length: 1000 }, (_, index) => `new${index}`).join("\n");
    const selected = { ...target, start: 1, end: 1, lines: ["old0"], before: [], after: ["old1"] };
    expect(
      placeLines(selected, { start: 1, end: 1, sides: { newText: old } }, { newText: `${next}\nold0\nold1\n` }),
    ).toEqual(location(1001, 1001));
  });

  test.each([true, false])("searches identical lines in a 1 MiB file (matching context: %s)", (matching) => {
    const find = vi.spyOn(search, "firstTwoMatches");
    const repeated = "seed\n".repeat(Math.ceil((1024 * 1024) / 5));
    const selected = {
      ...target,
      start: 1,
      end: 200,
      lines: Array<string>(200).fill("seed"),
      before: [],
      after: matching ? [] : ["weed"],
    };
    expect(placeLines(selected, { start: 1, end: 200, sides: {} }, { newText: repeated })).toEqual({
      status: "unplaced",
      reason: matching ? "ambiguous" : "lines-gone",
    });
    expect(find).toHaveBeenCalledOnce();
    expect(find.mock.calls[0]?.[0].length).toBe(Math.ceil((1024 * 1024) / 5));
    expect(find.mock.calls[0]?.[1]).toEqual([...selected.lines, ...selected.after]);
    expect(find.mock.results[0]?.value).toHaveLength(matching ? 2 : 0);
  });
});
