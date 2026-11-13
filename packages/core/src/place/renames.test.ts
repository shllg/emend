import { expect, test } from "vitest";
import { type PlaceContext, placeThread } from "./place.ts";
import { composeRenames } from "./renames.ts";

const target = {
  kind: "lines" as const,
  path: "src/a.ts",
  side: "new" as const,
  start: 1,
  end: 1,
  lines: ["seed"],
  before: [],
  after: [],
};
function context(): PlaceContext {
  return {
    writeup: [],
    docs: new Map(),
    topics: new Set(),
    files: new Map(),
    renamedFrom: new Map(),
    last: { location: { kind: "lines", path: target.path, side: "new", start: 1, end: 1 }, sides: { newText: "seed" } },
  };
}

test("restores a quote after an unplaced revision that renamed its file", () => {
  const renamed = new Map([["src/a.ts", "src/b.ts"]]);
  const ctx = context();
  ctx.renamedFrom = composeRenames([renamed]);
  ctx.files.set("src/b.ts", { newText: "weed" });
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "lines-gone" });
  ctx.renamedFrom = composeRenames([renamed, new Map()]);
  ctx.files.set("src/b.ts", { newText: "seed" });
  expect(placeThread(target, ctx)).toEqual({
    status: "placed",
    location: { kind: "lines", path: "src/b.ts", side: "new", start: 1, end: 1 },
  });
  ctx.last = null;
  expect(placeThread(target, ctx)).toMatchObject({ status: "placed", location: { path: "src/b.ts" } });
  expect(renamed).toEqual(new Map([["src/a.ts", "src/b.ts"]]));
});

test("composes chains across revisions but applies simultaneous swaps atomically", () => {
  expect(composeRenames([new Map([["a", "b"]]), new Map([["b", "c"]])]).get("a")).toBe("c");
  const swap = new Map([
    ["a", "b"],
    ["b", "a"],
  ]);
  expect(composeRenames([swap])).toEqual(swap);
  const twice = composeRenames([swap, swap]);
  expect(twice.get("a")).toBe("a");
  expect(twice.get("b")).toBe("b");
  const after = composeRenames([swap, new Map([["b", "c"]])]);
  expect(after.get("a")).toBe("c");
  expect(after.get("b")).toBe("a");
});

test("a renamed then deleted path stays gone, including when the name is reused", () => {
  const ctx = context();
  ctx.renamedFrom = composeRenames([new Map([["src/a.ts", "src/b.ts"]]), new Map([["src/b.ts", null]])]);
  expect(ctx.renamedFrom.get("src/a.ts")).toBeNull();
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "file-gone" });
  ctx.files.set("src/b.ts", { newText: "seed" });
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "file-gone" });
});
