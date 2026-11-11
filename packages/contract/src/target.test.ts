import { describe, expect, test } from "vitest";
import { BlockId, Target } from "./index.ts";

test.each(["outOfScope", "whereToLook", "context"])("accepts block ids for %s", (section) => {
  for (const suffix of ["", "-2", "-10"]) {
    const id = `${section}-1234abcd${suffix}`;
    expect(BlockId.parse(id)).toBe(id);
  }
  expect(BlockId.safeParse(`${section}-not-a-hash`).success).toBe(false);
});

const span = { blockId: "overview-1234abcd", quote: "route", prefix: "", suffix: "" };
const lines = {
  kind: "lines",
  path: "src/router.ts",
  side: "new",
  start: 2,
  end: 3,
  lines: ["first", "second"],
  before: [""],
  after: [],
};

describe("targets", () => {
  test.each([
    { kind: "writeup-span", ...span },
    { kind: "doc-span", path: "docs/plan.md", ...span, blockId: "doc-1234abcd-5678abcd-2" },
    { kind: "html-span", path: "docs/demo.html", quote: "route", prefix: "", suffix: "" },
    lines,
    { kind: "file", path: "src/router.ts" },
    { kind: "topic", slug: "other" },
    { kind: "review" },
  ])("accepts a %s target and strips unknown keys", (target) => {
    expect(Target.parse({ ...target, extra: true })).toEqual(target);
  });

  test.each(["writeup-span", "doc-span", "html-span"])("enforces quote and context limits for %s", (kind) => {
    const target = { kind, path: "docs/plan.md", ...span };
    for (const change of [
      { quote: "" },
      { quote: "x".repeat(2001) },
      { prefix: "x".repeat(33) },
      { suffix: "x".repeat(33) },
    ]) {
      expect(Target.safeParse({ ...target, ...change }).success).toBe(false);
    }
    expect(
      Target.safeParse({ ...target, quote: "x".repeat(2000), prefix: "x".repeat(32), suffix: "x".repeat(32) }).success,
    ).toBe(true);
  });

  test.each([
    { end: 1 },
    { start: 0 },
    { start: 1.5 },
    { end: 3.5 },
    { lines: ["first"] },
    { lines: [] },
    { before: ["a", "b", "c", "d"] },
    { after: ["a", "b", "c", "d"] },
  ])("rejects invalid inclusive line ranges or context: %j", (change) => {
    expect(Target.safeParse({ ...lines, ...change }).success).toBe(false);
  });

  test("accepts a single blank line and three lines of context per side", () => {
    expect(
      Target.safeParse({ ...lines, start: 1, end: 1, lines: [""], before: ["a", "b", "c"], after: ["d", "e", "f"] })
        .success,
    ).toBe(true);
  });

  test.each(["../secret", "/absolute", "a/../b", "a\\b", "C:/absolute", "a\u0000b", "a\nb", "a//b", "./a"])(
    "rejects unsafe content path %j",
    (path) => {
      expect(Target.safeParse({ kind: "file", path }).success).toBe(false);
    },
  );

  test.each(["overview-1234abcd", "t-routing-why-1234abcd-12", "doc-1234abcd-5678abcd-2"])(
    "accepts block id %s",
    (blockId) => {
      expect(Target.safeParse({ kind: "writeup-span", ...span, blockId }).success).toBe(true);
    },
  );

  test.each([
    "unknown-1234abcd",
    "overview-1234abc",
    "overview-1234abcd-1",
    "overview-1234abcd-02",
    "overview-1234abcd\n",
  ])("rejects malformed block id %s", (blockId) => {
    expect(Target.safeParse({ kind: "writeup-span", ...span, blockId }).success).toBe(false);
  });
});
