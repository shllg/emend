import { expect, test } from "vitest";
import { hidesWriteupBlock } from "./hidden-writeup.ts";

test.each([
  ["review-12345678", true],
  ["review-12345678-2", true],
  ["overview-12345678", false],
  ["t-seed-why-12345678", false],
  ["checked-12345678", false],
] as const)("hidesWriteupBlock(%s) is %s", (blockId, hidden) => {
  expect(hidesWriteupBlock(blockId)).toBe(hidden);
});
