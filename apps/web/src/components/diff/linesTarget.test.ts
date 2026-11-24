import { type FileView, LIMITS, LinesTarget } from "@recense/contract";
import { expect, test } from "vitest";
import { linesTarget } from "./linesTarget.ts";

const file = { path: "new.ts", oldPath: "old.ts" } as FileView;
const text = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\r\n")}\r\n`;
test("inclusive side numbers and nearest context use core CRLF/trailing-newline semantics", () => {
  const target = linesTarget(file, "new", 10, 12, text);
  expect(target).toEqual({
    kind: "lines",
    path: "new.ts",
    side: "new",
    start: 10,
    end: 12,
    lines: ["line 10", "line 11", "line 12"],
    before: ["line 7", "line 8", "line 9"],
    after: ["line 13", "line 14", "line 15"],
  });
  expect(LinesTarget.safeParse(target).success).toBe(true);
  expect(linesTarget(file, "old", 20, 20, text)).toMatchObject({ path: "old.ts", side: "old", after: [] });
  expect(linesTarget({ ...file, oldPath: null }, "old", 1, 1, "\n")).toMatchObject({ path: "new.ts", lines: [""] });
});
test("refuses oversized selections without clipping", () => {
  expect(linesTarget(file, "new", 1, 1001, "x\n".repeat(1001))).toEqual({ error: "too-many-lines" });
  expect(linesTarget(file, "new", 1, 1, "x".repeat(LIMITS.targetTextChars + 1))).toEqual({ error: "too-long" });
  expect(LinesTarget.safeParse(linesTarget(file, "new", 1, 1000, "x\n".repeat(1000))).success).toBe(true);
});
test("context stops at the first long or over-budget line without skipping nearer lines", () => {
  expect(
    linesTarget(
      file,
      "new",
      4,
      4,
      ["far", "x".repeat(2001), "near", "selected", "next", "x".repeat(2001), "far"].join("\n"),
    ),
  ).toMatchObject({ before: ["near"], after: ["next"] });
  const target = linesTarget(
    file,
    "new",
    4,
    4,
    ["far", "near", "a", "x".repeat(LIMITS.targetTextChars - 2), "b", "next"].join("\n"),
  );
  expect(target).toMatchObject({ before: ["a"], after: ["b"] });
  expect(LinesTarget.safeParse(target).success).toBe(true);
});
test.each([
  [0, 1],
  [2, 1],
  [1, 2],
  [1.5, 2],
  [NaN, 1],
])("invalid range %s–%s is refused", (start, end) => {
  expect(linesTarget(file, "new", start, end, "one")).toEqual({ error: "invalid-range" });
});
