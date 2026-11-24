import { expect, test } from "vitest";
import { revisionTransition } from "./transitions.ts";

const file = (path: string, oldPath: string | null = null) => ({ path, oldPath, role: "diff" });
test("a surviving renamed path keeps its identity when its old base path is recreated", () => {
  expect(revisionTransition([file("b.ts", "a.ts")], [file("a.ts"), file("b.ts")], "base", "base")).toEqual(new Map());
});
test("different bases only preserve surviving paths", () => {
  expect(
    revisionTransition(
      [file("b.ts", "a.ts"), file("keep.ts")],
      [file("c.ts", "a.ts"), file("keep.ts")],
      "before",
      "after",
    ),
  ).toEqual(new Map([["b.ts", null]]));
});
