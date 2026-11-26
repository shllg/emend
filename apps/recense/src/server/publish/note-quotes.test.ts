import type { PublishFile } from "@recense/contract";
import { expect, test, vi } from "vitest";
import { matchNoteQuote, matchNoteQuotes, type QuoteMatch } from "./note-quotes.ts";
import { resolveNoteRanges } from "./notes.ts";
import { executeWork } from "./work.ts";

test("whole-line matching splits on LF, trims margins and includes a final line without LF", () => {
  const bytes = new TextEncoder().encode("one\rtwo\r\n  keep\t\r\n \t\r\n  final value").buffer;
  const quote = "\r\nkeep\n\n final value\r\n\t";
  expect(matchNoteQuotes(bytes, [quote, "final", "final  value", "two"])).toEqual({
    count: 4,
    matches: new Map<string, QuoteMatch>([
      [quote, { start: 2, end: 4 }],
      ["final", "quote_missing"],
      ["final  value", "quote_missing"],
      ["two", "quote_missing"],
    ]),
  });
});

test("the search stops at the second match even when matches overlap", () => {
  const lines = ["a", "a", "a"];
  Object.defineProperty(lines, 3, {
    get() {
      throw new Error("read beyond the second match");
    },
  });
  expect(matchNoteQuote(lines, "a\na")).toBe("quote_ambiguous");
  expect(matchNoteQuote(["a", "a", "a", "b"], "a\na\nb")).toEqual({ start: 2, end: 4 });
});

test("range and quote notes across files share a single content read and worker job", async () => {
  const file: PublishFile = {
    role: "diff",
    path: "a.ts",
    flag: null,
    oldPath: null,
    oldBlob: null,
    newBlob: "a".repeat(64),
    notes: [{ side: "new", start: 1, end: 1, summary: "First" }],
  };
  const other: PublishFile = { ...file, path: "b.ts", notes: [{ side: "new", quote: "two", summary: "Second" }] };
  const read = vi.fn(async () => new TextEncoder().encode("one\ntwo\n").buffer);
  const execute = vi.fn(executeWork);
  const resolved = await resolveNoteRanges([file, other], read, execute);
  expect(read).toHaveBeenCalledExactlyOnceWith(file.newBlob);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(resolved.get(other)).toEqual([{ side: "new", start: 2, end: 2, summary: "Second" }]);
  expect(other.notes?.[0]).not.toHaveProperty("start");
});
