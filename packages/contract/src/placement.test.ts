import { expect, test } from "vitest";
import { Placement, UnplacedReason } from "./index.ts";

test.each([
  { kind: "writeup-span", blockId: "overview-1234abcd", start: 0, end: 5 },
  { kind: "doc-span", path: "docs/plan.md", blockId: "doc-1234abcd-5678abcd", start: 0, end: 5 },
  { kind: "html-span", path: "docs/demo.html", start: 0, end: 5 },
  { kind: "lines", path: "src/router.ts", side: "new", start: 1, end: 1 },
  { kind: "file", path: "src/router.ts" },
  { kind: "topic", slug: "routing" },
  { kind: "topic", slug: "routing", part: "title", start: 0, end: 5 },
  { kind: "topic", slug: "routing", part: "summary", start: 1, end: 5 },
  { kind: "review" },
])("describes a placed location: %j", (location) => {
  expect(Placement.parse({ status: "placed", location, extra: true })).toEqual({ status: "placed", location });
});

test("accepts the placement reasons and the missing-row fallback", () => {
  const reasons = ["block-gone", "ambiguous", "topic-gone", "file-gone", "lines-gone", "not-placed"];
  expect(UnplacedReason.options).toEqual(reasons);
  for (const reason of reasons)
    expect(Placement.parse({ status: "unplaced", reason })).toEqual({ status: "unplaced", reason });
  expect(Placement.safeParse({ status: "unplaced", reason: "unknown" }).success).toBe(false);
});

test("topic locations require a complete part and valid span range", () => {
  const fields = Object.entries({ part: "title", start: 0, end: 5 });
  for (let mask = 0; mask < 8; mask++) {
    const location = { kind: "topic", slug: "garden", ...Object.fromEntries(fields.filter((_, i) => mask & (1 << i))) };
    expect(Placement.safeParse({ status: "placed", location }).success, `field mask ${mask}`).toBe(
      mask === 0 || mask === 7,
    );
  }
  for (const change of [
    { start: -1 },
    { start: 0.5 },
    { end: 0 },
    { end: 0.5 },
    { start: 5 },
    { start: 6 },
    { part: "blast" },
  ]) {
    expect(
      Placement.safeParse({
        status: "placed",
        location: { kind: "topic", slug: "garden", part: "title", start: 0, end: 5, ...change },
      }).success,
    ).toBe(false);
  }
  expect(
    Placement.parse({
      status: "placed",
      location: {
        kind: "topic",
        slug: "garden",
        part: "title",
        start: 0,
        end: 5,
        quote: "seed",
        prefix: "",
        suffix: "",
      },
    }),
  ).toEqual({ status: "placed", location: { kind: "topic", slug: "garden", part: "title", start: 0, end: 5 } });
});

test("rejects missing locations and invalid span offsets", () => {
  expect(Placement.safeParse({ status: "placed" }).success).toBe(false);
  for (const range of [
    { start: -1, end: 2 },
    { start: 1, end: 1 },
    { start: 2, end: 1 },
    { start: 0.5, end: 2 },
  ]) {
    expect(
      Placement.safeParse({ status: "placed", location: { kind: "html-span", path: "docs/demo.html", ...range } })
        .success,
    ).toBe(false);
  }
});
