import { expect, test } from "vitest";
import { diffLineCounts } from "./diff-counts.ts";

test.each([
  ["modified", "keep\nold\n", "keep\nnew\nextra\n", 2, 1],
  ["added", "", "one\ntwo\n", 2, 0],
  ["deleted", "one\ntwo\n", "", 0, 2],
  ["identical", "same\n", "same\n", 0, 0],
  ["empty", "", "", 0, 0],
  ["gains final newline", "one", "one\n", 1, 1],
  ["loses final newline", "one\n", "one", 1, 1],
  ["CRLF", "keep\r\nold\r\n", "keep\r\nnew\r\n", 1, 1],
  ["CRLF to LF", "one\r\ntwo\r\n", "one\ntwo\n", 2, 2],
])("counts %s lines", (_name, old, next, additions, deletions) => {
  expect(diffLineCounts(old, next)).toEqual({ additions, deletions });
});

test("a large rewrite stops at the timeout", () => {
  const old = Array.from({ length: 20000 }, (_, i) => `old ${i}\n`).join("");
  const next = Array.from({ length: 20000 }, (_, i) => `new ${i}\n`).join("");
  expect(diffLineCounts(old, next, { timeout: 1 })).toBeNull();
});
