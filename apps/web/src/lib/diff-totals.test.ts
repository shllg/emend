import type { FileView, RevisionView } from "@emend/contract";
import { expect, test } from "vitest";
import { diffGroups } from "./diff-groups.ts";
import { lineTotals, reviewLineTotals } from "./diff-totals.ts";

const file = (values: Partial<FileView> = {}): FileView => ({
  id: crypto.randomUUID(),
  path: "a.ts",
  oldPath: null,
  role: "diff",
  status: "modified",
  topic: "first",
  order: 0,
  mediaType: "text/plain",
  flag: null,
  hasOld: true,
  hasNew: true,
  ...values,
});

test("sums counted diff files and ignores documents and absent counts", () => {
  expect(
    lineTotals([
      file({ counts: { additions: 2, deletions: 3 } }),
      file({ counts: { additions: 7, deletions: 1 } }),
      file(),
      file({ flag: "binary" }),
      file({ flag: "oversized" }),
      file({ role: "doc", counts: { additions: 999, deletions: 999 } }),
    ]),
  ).toEqual({ additions: 9, deletions: 4 });
});

test("no counted diff is null, while a counted unchanged file is zero", () => {
  for (const files of [[], [file()], [file({ role: "doc" })], [file({ flag: "binary" })]])
    expect(lineTotals(files)).toBeNull();
  expect(lineTotals([file({ counts: { additions: 0, deletions: 0 } })])).toEqual({ additions: 0, deletions: 0 });
});

test("the review is the sum of its topic totals, including unassigned files", () => {
  const revision: RevisionView = {
    seq: 1,
    base: null,
    head: null,
    main: null,
    writeupEmpty: true,
    topics: [
      { slug: "first", title: "First", importance: 10, summary: "" },
      { slug: "empty", title: "Empty", importance: 20, summary: "" },
    ],
    files: [
      file({ counts: { additions: 2, deletions: 3 } }),
      file({ topic: null, counts: { additions: 4, deletions: 5 } }),
      file({ topic: "unknown", counts: { additions: 1, deletions: 1 } }),
    ],
    docs: [],
    threads: [],
    writeup: { sections: [] },
    changedBlocks: [],
  };
  expect([...diffGroups(revision).values()].map(({ files }) => lineTotals(files))).toEqual([
    { additions: 2, deletions: 3 },
    null,
    { additions: 5, deletions: 6 },
  ]);
  expect(reviewLineTotals(revision)).toEqual({ additions: 7, deletions: 9 });
  expect(reviewLineTotals({ ...revision, files: [] })).toBeNull();
});
