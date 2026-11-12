import { expect, test } from "vitest";
import { FileView, LIMITS } from "./index.ts";

const file = {
  id: "11111111-1111-4111-8111-111111111111",
  path: "a.ts",
  oldPath: null,
  role: "diff",
  status: "modified",
  topic: null,
  order: 0,
  mediaType: "text/plain",
  flag: null,
  hasOld: true,
  hasNew: true,
};

test("file counts are optional and accept bounded nonnegative integers", () => {
  expect(FileView.parse(file)).toEqual(file);
  for (const counts of [
    { additions: 3, deletions: 2 },
    { additions: 0, deletions: LIMITS.diffSideBytes },
  ])
    expect(FileView.parse({ ...file, counts }).counts).toEqual(counts);
});

test("file counts reject negatives, fractions and values beyond the side limit", () => {
  for (const field of ["additions", "deletions"])
    for (const value of [-1, 1.5, LIMITS.diffSideBytes + 1, "1", null, undefined])
      expect(FileView.safeParse({ ...file, counts: { additions: 0, deletions: 0, [field]: value } }).success).toBe(
        false,
      );
});
