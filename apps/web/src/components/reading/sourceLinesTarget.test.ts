import { LIMITS, SourceLinesTarget } from "@emend/contract";
import { expect, test } from "vitest";
import { splitLines } from "../../../../../packages/core/src/place/linemap.ts";
import { sourceLinesTarget } from "./sourceLinesTarget.ts";

test("source targets keep core CRLF, trailing newline, blank and lone CR line coordinates", () => {
  const lines = splitLines("first\r\n\r\nthird\rfourth\r\n");
  expect(lines).toEqual(["first", "", "third\rfourth"]);
  expect(sourceLinesTarget("config.txt", lines, 2, 3)).toEqual({
    kind: "source-lines",
    path: "config.txt",
    start: 2,
    end: 3,
    lines: ["", "third\rfourth"],
    before: ["first"],
    after: [],
  });
  expect(sourceLinesTarget("config.txt", lines, 4, 4)).toEqual({ error: "invalid-range" });
});

test("source context stops at long lines and shares its remaining budget on both sides", () => {
  const target = sourceLinesTarget(
    "config.txt",
    ["far", "x".repeat(LIMITS.contextLineChars + 1), "a", "x".repeat(LIMITS.targetTextChars - 2), "b", "next"],
    4,
    4,
  );
  expect(target).toMatchObject({ before: ["a"], after: ["b"] });
  expect(SourceLinesTarget.safeParse(target).success).toBe(true);
});
