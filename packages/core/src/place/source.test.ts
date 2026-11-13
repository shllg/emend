import type { SourceLinesTarget } from "@emend/contract";
import { expect, it } from "vitest";
import { type PlaceContext, placeThread } from "./place.ts";

const target: SourceLinesTarget = {
  kind: "source-lines",
  path: "old.ts",
  start: 2,
  end: 2,
  lines: ["selected"],
  before: ["before"],
  after: ["after"],
};
function context(text: string): PlaceContext {
  return {
    writeup: [],
    docs: new Map(),
    sources: new Map([["new.ts", { text, hash: "new" }]]),
    files: new Map(),
    topics: new Map(),
    renamedFrom: new Map([["old.ts", "new.ts"]]),
    last: {
      location: { kind: "source-lines", path: "old.ts", start: 2, end: 2 },
      sides: { newText: "before\nselected\nafter\n", newHash: "old" },
    },
  };
}
it("reuses the previous source location and text mapping after a rename and changed context", () => {
  expect(placeThread(target, context("insert\nchanged\nselected\nafter\n"))).toEqual({
    status: "placed",
    location: { kind: "source-lines", path: "new.ts", start: 3, end: 3 },
  });
});
it("never places a source target on a rendered doc or diff of the same path", () => {
  const ctx = context("");
  ctx.sources = new Map();
  ctx.docs.set("new.ts", { kind: "markdown", blocks: [] });
  ctx.files.set("new.ts", { newText: "before\nselected\nafter\n" });
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "file-gone" });
});
it("requires the quote even with equal hashes and reports ambiguous source matches", () => {
  const ctx = context("before\nchanged\nafter\n");
  ctx.sources?.set("new.ts", { text: "before\nchanged\nafter\n", hash: "old" });
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "lines-gone" });
  ctx.last = null;
  ctx.sources?.set("new.ts", { text: "before\nselected\nafter\nbefore\nselected\nafter\n" });
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "ambiguous" });
});
